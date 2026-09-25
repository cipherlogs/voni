"""Browser transport: WebSocket <-> cascade orchestrator (P1).

Wire protocol (JSON text frames):
  browser -> server: {"type": "config", "pipeline": {...}, "system_prompt": str,
                      "tools": [...], "agent_name": str}
                      {"type": "audio", "data": base64 pcm16 mono}
                      {"type": "context", "role": "system", "content": str}
                      {"type": "stop"}
  server -> browser: {"type": "caption", "role": "user"|"agent",
                      "text": str, "final": bool}
                      {"type": "audio", "data": base64, "sample_rate": int}
                      {"type": "interrupted"}
                      {"type": "end", "metrics": {...}, "turns": int}
                      {"type": "error", "message": str}

The socket only needs send_json/receive_json, so FastAPI WebSockets and fakes
interchange. Audio decoding never raises into the loop; a stop or a dropped
socket ends the call with metrics. Managed-fallback configs are refused with
an error — the cascade must be explicitly opted in per call.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator
from typing import Any, Optional

from config import PipelineConfig, pipeline_config_from_dict
from orchestrator import TurnOrchestrator


def default_backends(config: PipelineConfig) -> tuple[Any, Any, Any]:
    """Real backends for a validated cascade config. Deepgram lands in P3."""
    if config.stt_provider == "assemblyai":
        from backends.assemblyai_stt import AssemblyAIStreamingSTT

        # voice_focus follows the mic, not the model: browser callers are
        # close-talking, PSTN callers are on handsets/speakerphone.
        voice_focus = config.voice_focus or (
            "far-field" if config.transport == "telnyx" else "near-field"
        )
        stt: Any = AssemblyAIStreamingSTT(
            speech_model=config.stt_model or "universal-3-6-pro",
            mode=config.stt_mode,
            min_turn_silence=config.min_silence_ms,
            max_turn_silence=config.max_silence_ms,
            interruption_delay=config.interruption_delay_ms,
            vad_threshold=config.vad_threshold,
            voice_focus=voice_focus,
            voice_focus_threshold=(
                config.voice_focus_threshold
                or (0.8 if config.transport == "telnyx" else 0.0)
            ),
            prompt=config.transcription_prompt,
            keyterms_prompt=config.keyterms_prompt,
            agent_context=config.agent_context,
        )
    elif config.stt_provider == "deepgram":
        raise RuntimeError("deepgram STT is not implemented yet (P3)")
    else:  # validated upstream; defensive only
        raise RuntimeError(f"unknown stt_provider: {config.stt_provider}")
    from backends.cartesia_tts import CartesiaTTS
    from backends.gateway_llm import GatewayLLM

    llm: Any = GatewayLLM(model=config.llm_model)
    tts: Any = CartesiaTTS(
        voice_id=config.tts_voice,
        model_id=config.tts_model,
        language=config.language_codes[0] if config.language_codes else "en",
        sample_rate=24000,
    )
    return stt, llm, tts


async def handle_browser_call(
    ws: Any,
    *,
    config_message: Optional[dict] = None,
    backend_factory: Any = None,
) -> None:
    """Serve one browser test call on an open socket. Returns on stop/drop."""
    if config_message is None:
        try:
            first = await ws.receive_json()
        except Exception:
            return
        if not isinstance(first, dict) or first.get("type") != "config":
            await _send(ws, {"type": "error", "message": "first message must be config"})
            return
        config_message = first
    try:
        pipeline = pipeline_config_from_dict(config_message.get("pipeline") or {})
    except ValueError as exc:
        await _send(ws, {"type": "error", "message": f"invalid pipeline config: {exc}"})
        return
    if not pipeline.routes_to_cascade:
        await _send(
            ws,
            {
                "type": "error",
                "message": "managed fallback active: route this call at the cascade pipeline to use it",
            },
        )
        return
    factory = backend_factory or default_backends
    try:
        stt, llm, tts = factory(pipeline)
    except Exception as exc:
        await _send(ws, {"type": "error", "message": f"backend setup failed: {exc}"})
        return

    audio_queue: asyncio.Queue = asyncio.Queue()

    async def audio_source() -> AsyncIterator[bytes]:
        while True:
            frame = await audio_queue.get()
            if frame is None:
                return
            yield frame

    async def on_audio(chunk: Any) -> None:
        await _send(
            ws,
            {
                "type": "audio",
                "data": base64.b64encode(chunk.pcm).decode(),
                "sample_rate": chunk.sample_rate,
            },
        )

    async def on_event(kind: str, payload: dict) -> None:
        if kind == "user_partial":
            await _send(
                ws, {"type": "caption", "role": "user", "text": payload.get("text", ""), "final": False}
            )
        elif kind == "user_final":
            await _send(
                ws, {"type": "caption", "role": "user", "text": payload.get("text", ""), "final": True}
            )
        elif kind == "agent_final":
            await _send(
                ws, {"type": "caption", "role": "agent", "text": payload.get("text", ""), "final": True}
            )
        elif kind == "agent_partial":
            await _send(
                ws, {"type": "caption", "role": "agent", "text": payload.get("text", ""), "final": False}
            )
        elif kind == "interrupted":
            await _send(ws, {"type": "interrupted"})
        elif kind == "call_end":
            await _send(ws, {"type": "end_call"})
        elif kind == "turn_failed":
            await _send(
                ws, {"type": "error", "message": f"turn failed: {payload.get('error', '')}"}
            )

    orchestrator = TurnOrchestrator(
        stt=stt,
        llm=llm,
        tts=tts,
        on_audio=on_audio,
        on_event=on_event,
        system_prompt=str(config_message.get("system_prompt") or ""),
        tools=config_message.get("tools"),
        language_codes=list(pipeline.language_codes),
        sample_rate=24000,
    )
    run_task = asyncio.get_running_loop().create_task(orchestrator.run(audio_source()))
    try:
        while True:
            try:
                message = await ws.receive_json()
            except Exception:
                break
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "audio" and isinstance(message.get("data"), str):
                try:
                    audio_queue.put_nowait(base64.b64decode(message["data"]))
                except Exception:
                    continue
            elif (
                kind == "context"
                and message.get("role") == "system"
                and isinstance(message.get("content"), str)
            ):
                orchestrator.add_context(message["content"])
            elif kind == "stop":
                break
    finally:
        cancelled_by_us = False
        if not run_task.done():
            run_task.cancel()
            cancelled_by_us = True
        run_error: Optional[str] = None
        try:
            await run_task
        except asyncio.CancelledError:
            # Ours (hangup path above) is swallowed; server shutdown must
            # propagate or connections never drain.
            if not cancelled_by_us:
                raise
        except Exception as exc:
            # Backend failures (bad key, provider outage) must be visible in
            # the transcript, not silent turns=0.
            run_error = f"{type(exc).__name__}: {exc}"
        end_message: dict[str, Any] = {
            "type": "end",
            "metrics": orchestrator.ledger.summary(),
            # Collected incrementally by the orchestrator so a hangup
            # mid-call still reports finished turns.
            "turns": len(orchestrator.turn_results),
        }
        if run_error is not None:
            end_message["error"] = run_error
        await _send(ws, end_message)


async def _send(ws: Any, message: dict) -> None:
    try:
        await ws.send_json(message)
    except Exception:
        pass
