"""Browser transport: WebSocket <-> cascade orchestrator (P1).

Wire protocol (JSON text frames), ticket 65's token-only contract:
  browser -> server: {"type": "config", "protocolVersion": int,
                      "agentId": str, "callToken": str}
                      {"type": "audio", "data": base64 pcm16 mono}
                      {"type": "context", "role": "system", "content": str}
                      {"type": "stop"}
  server -> browser: {"type": "caption", "role": "user"|"agent",
                      "text": str, "final": bool}
                      {"type": "audio", "data": base64, "sample_rate": int}
                      {"type": "interrupted"}
                      {"type": "end", "metrics": {...}, "turns": int,
                       "protocolVersion": int}
                      {"type": "error", "message": str}

The config frame carries **identity only**. The prompt and the tool list come
from the stored body the app assembles and signs (ticket 64); this module
claims that verified body from :class:`cascade.token.StoredBodyChannel` by the
browser's call token and reads it through :func:`cascade.body_map.adapt_body`.
There is no code path left that reads a prompt, a tool list or a pipeline off
the socket: :func:`cascade.token.parse_browser_config` refuses those keys by
name before a backend can open. The pipeline's model ids are host settings
(:func:`pipeline_config_for_body`), never browser input.

The socket only needs send_json/receive_json, so FastAPI WebSockets and fakes
interchange. Audio decoding never raises into the loop; a stop or a dropped
socket ends the call with metrics.
"""

from __future__ import annotations

import asyncio
import base64
import os
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any, Optional

from cascade.body_map import BodyFieldError, CascadeBody, adapt_body
from cascade.token import (
    PROTOCOL_VERSION,
    CallTokenCallMismatch,
    CallTokenError,
    CallTokenRegistry,
    CallTokenSubjectMismatch,
    ClientConfigError,
    StoredBodyChannel,
    parse_browser_config,
)
from config import PipelineConfig
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


def pipeline_config_for_body(
    body: CascadeBody,
    *,
    environ: Mapping[str, str] | None = None,
) -> PipelineConfig:
    """The cascade pipeline for one call: host settings plus the signed body.

    Model ids are service settings, not per-call browser input — the stored
    body carries no ``llm`` override (ticket 60 refuses one). Everything the
    body *does* decide (voice, Locale, keyterms, greeting seed) comes from the
    adapter, never from the config frame.
    """
    env = os.environ if environ is None else environ

    def setting(name: str) -> str:
        return str(env.get(name, "")).strip()

    missing = [
        name
        for name in ("VOICE_PIPELINE_LLM_MODEL", "VOICE_PIPELINE_TTS_MODEL")
        if not setting(name)
    ]
    if missing:
        raise ValueError(
            "the cascade service settings are incomplete: set "
            f"{', '.join(missing)} in the service host's environment; the "
            "browser cannot supply a model"
        )

    return PipelineConfig(
        stt_provider=setting("VOICE_PIPELINE_STT_PROVIDER") or "assemblyai",
        stt_mode=setting("VOICE_PIPELINE_STT_MODE") or "balanced",
        llm_model=setting("VOICE_PIPELINE_LLM_MODEL"),
        tts_voice=body.voice_id,
        tts_model=setting("VOICE_PIPELINE_TTS_MODEL"),
        transport="browser",
        language_codes=(body.language_code,),
        keyterms_prompt=body.keyterms,
        agent_context=body.greeting,
        fallback_mode="cascade",
    )


async def handle_browser_call(
    ws: Any,
    *,
    config_message: Optional[dict] = None,
    backend_factory: Any = None,
    body_channel: StoredBodyChannel | None = None,
    pipeline_factory: Callable[[CascadeBody], PipelineConfig] | None = None,
    call_tokens: CallTokenRegistry | None = None,
) -> None:
    """Serve one browser test call on an open socket. Returns on stop/drop.

    The call token is verified at connect (ticket 136) — signature and expiry
    first, then the call and subject bindings against the signed body — and
    only then claimed. No backend factory, and therefore no vendor socket, is
    reached until the token and the body agree. The claim is released when the
    socket ends, so a reconnect mints a new token and is accepted.
    """
    if config_message is None:
        try:
            first = await ws.receive_json()
        except Exception:
            return
        if not isinstance(first, dict) or first.get("type") != "config":
            await _send(ws, {"type": "error", "message": "first message must be config"})
            return
        config_message = first

    # Token-only contract first: an old client fails on the protocol version,
    # a client that still assembles the body fails on the field it sent.
    try:
        client = parse_browser_config(config_message)
    except ClientConfigError as exc:
        await _send(ws, {"type": "error", "message": str(exc)})
        return

    if call_tokens is None:
        await _send(
            ws,
            {
                "type": "error",
                "message": (
                    "the service has no call-token verifier configured; a call "
                    "without a verified token is refused at connect"
                ),
            },
        )
        return

    # Ticket 136: the token is checked before the body is claimed and long
    # before a vendor socket. Signature and expiry are named refusals; the
    # call and subject bindings are checked against the signed body below.
    try:
        token_claims = call_tokens.verify(client.call_token)
    except CallTokenError as exc:
        await _send(ws, {"type": "error", "message": str(exc)})
        return

    if body_channel is None:
        await _send(
            ws,
            {
                "type": "error",
                "message": (
                    "the service has no signed-body channel configured; the app "
                    "must deliver the stored body before a browser call"
                ),
            },
        )
        return

    # The body is the app's, not the browser's: claim the verified envelope
    # (ticket 64) by the browser token, once.
    verified = body_channel.claim(client.call_token)
    if verified is None:
        await _send(
            ws,
            {
                "type": "error",
                "message": (
                    "this call token has no signed body; the app delivers the "
                    "stored body before the browser connects, and the client "
                    "never sends a prompt or a tool list"
                ),
            },
        )
        return

    if verified.agent_id != client.agent_id:
        await _send(
            ws,
            {
                "type": "error",
                "message": (
                    f'the call token names agent "{client.agent_id}" but the '
                    f'signed envelope names agent "{verified.agent_id}"; the '
                    "call is refused"
                ),
            },
        )
        return

    # The token binds the call and the subject; neither may disagree with the
    # body the app signed, or a token would be replayable onto another call.
    if token_claims.call_id != verified.call_id:
        await _send(
            ws,
            {
                "type": "error",
                "message": str(
                    CallTokenCallMismatch(verified.call_id, token_claims.call_id)
                ),
            },
        )
        return
    if token_claims.subject != verified.agent_id:
        await _send(
            ws,
            {
                "type": "error",
                "message": str(
                    CallTokenSubjectMismatch(verified.agent_id, token_claims.subject)
                ),
            },
        )
        return

    try:
        body = adapt_body(verified.body)
    except BodyFieldError as exc:
        await _send(ws, {"type": "error", "message": f"stored body refused: {exc}"})
        return

    settings = pipeline_factory or pipeline_config_for_body
    try:
        pipeline = settings(body)
    except (TypeError, ValueError) as exc:
        await _send(
            ws, {"type": "error", "message": f"service pipeline settings refused: {exc}"}
        )
        return
    if not pipeline.routes_to_cascade:
        await _send(
            ws,
            {
                "type": "error",
                "message": (
                    "the service is configured for the managed path, so it "
                    "refuses to open a cascade vendor socket"
                ),
            },
        )
        return

    # One claim, one live socket per call: the token is spent here, and a
    # second concurrent socket is refused until this one closes.
    try:
        claim = call_tokens.claim(
            client.call_token,
            call_id=verified.call_id,
            subject=verified.agent_id,
        )
    except CallTokenError as exc:
        await _send(ws, {"type": "error", "message": str(exc)})
        return

    factory = backend_factory or default_backends
    try:
        stt, llm, tts = factory(pipeline)
    except Exception as exc:
        call_tokens.release(claim)
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
        system_prompt=body.system_prompt,
        tools=list(body.tools),
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
        # The socket is over: the call no longer holds the one live-socket
        # slot. The token itself stays spent.
        call_tokens.release(claim)
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
            # The service reports the protocol it speaks (M17): a half-deployed
            # pair is visible in the call record, not only in the logs.
            "protocolVersion": PROTOCOL_VERSION,
        }
        if run_error is not None:
            end_message["error"] = run_error
        await _send(ws, end_message)


async def _send(ws: Any, message: dict) -> None:
    try:
        await ws.send_json(message)
    except Exception:
        pass
