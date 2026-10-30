"""Browser transport: WebSocket <-> the cascade call lifecycle.

Wire protocol (JSON text frames), ticket 65's token-only contract:
  browser -> server: {"type": "config", "protocolVersion": int,
                      "agentId": str, "callToken": str}
                      {"type": "audio", "data": base64 pcm16 mono}
                      {"type": "context", "role": "system", "content": str}
                      {"type": "stop"}
  server -> browser: {"type": "caption", "role": "user"|"agent",
                      "text": str, "final": bool}
                      {"type": "audio", "seq": int, "sample_rate": int,
                       "data": base64}
                      {"type": "interrupted"}
                      {"type": "end", ...}
                      {"type": "error", "code"?: str, "message": str}

The config frame carries **identity only**. The prompt and the tool list come
from the stored body the app assembles and signs (ticket 64); this module
claims that verified body from :class:`cascade.token.StoredBodyChannel` by the
browser's call token and reads it through :func:`cascade.body_map.adapt_body`.
There is no code path left that reads a prompt, a tool list or a pipeline off
the socket: :func:`cascade.token.parse_browser_config` refuses those keys by
name before a backend can open.

The call is served by :class:`cascade.call.CallLifecycle` and
:class:`cascade.turn_stream.CascadeTurnStream` — Meta speech, the body's model
(or BYO client) and AssemblyAI synthesis — never by the managed
``TurnOrchestrator``. The routing switch is read exactly once, before the first
vendor socket: a managed decision answers ``code: "managed"`` with its named
reason and opens no leg. The app routes managed calls itself, so this service
refusing them is the whole contract.

The socket only needs send_json/receive_json, so FastAPI WebSockets and fakes
interchange. Audio decoding never raises into the loop; a stop or a dropped
socket ends the call with the lifecycle's one end message.
"""

from __future__ import annotations

import base64
import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from cascade.admission import admit_new_call
from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.body_map import BodyFieldError, CascadeBody, adapt_body
from cascade.call import (
    AudioFrame,
    BrowserStop,
    CallLifecycle,
    ContextUpdate,
    OpenedLeg,
    OutboundAudio,
)
from cascade.cost import RateTable
from cascade.events import OperationalEvents
from cascade.meta_llm import MetaLLM, construct_byo_model
from cascade.meta_stt import MetaStreamingSTT
from cascade.reconnect import ReconnectBudget
from cascade.routing import CallSubject, RoutingSwitch
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
from cascade.tools import ToolExecutor
from cascade.turn_stream import CascadeTurnStream
from cascade.usage import UsageMeter
from cascade.version import build_version
from cascade.voice_binding import VoiceBindingError
from metrics import TimingLedger

#: The browser leg's PCM format; 24 kHz s16le mono both ways.
SAMPLE_RATE = 24000

#: Service settings the Standard model rung reads. Model ids are host settings,
#: never browser input; reasoning effort is M03's measurement and is never
#: defaulted here.
LLM_MODEL_ENV = "VOICE_PIPELINE_LLM_MODEL"
REASONING_EFFORT_ENV = "META_REASONING_EFFORT"
TOOL_BASE_URL_ENV = "VOICE_PIPELINE_TOOL_BASE_URL"


class CascadeLegs:
    """One call's legs, constructed but not yet opened.

    Construction of a vendor client opens no socket, so this object exists
    before the lifecycle starts and the stream can hold the very sessions the
    lifecycle will open. ``open_*`` is the lifecycle's ``LegFactory``: it opens
    the leg and returns the ``OpenedLeg`` the end message attributes.
    """

    def __init__(
        self,
        *,
        speech: Any,
        voice: Any,
        model: Any | None,
        stt_languages: Sequence[str] = (),
        sample_rate: int = SAMPLE_RATE,
        model_provider: str = "spark",
        model_rung: str = "primary",
        model_reason: str = "",
    ) -> None:
        self.speech = speech
        self.voice = voice
        self.model = model
        self.stt_languages = tuple(stt_languages)
        self.sample_rate = sample_rate
        self.model_provider = model_provider
        self.model_rung = model_rung
        self.model_reason = model_reason

    async def open_speech(self, body: CascadeBody) -> OpenedLeg:
        await self.speech.open(
            language_codes=list(self.stt_languages), sample_rate=self.sample_rate
        )
        return OpenedLeg(
            "stt", "meta", "primary", "Meta realtime speech is the cascade's speech rung",
            self.speech,
        )

    async def open_voice(self, body: CascadeBody) -> OpenedLeg:
        await self.voice.open()
        return OpenedLeg(
            "tts", "assemblyai", "primary", "one synthesis rung serves the call",
            self.voice,
        )

    async def open_model(self, body: CascadeBody) -> OpenedLeg:
        if self.model is None:
            raise RuntimeError("this call has no model client to open")
        return OpenedLeg(
            "llm",
            self.model_provider,
            self.model_rung,
            self.model_reason or "the call's one model client",
            self.model,
        )


#: Builds one call's legs from the adapted body and the raw signed body.
LegBuilder = Callable[[CascadeBody, Mapping[str, Any]], CascadeLegs]


def _stt_languages(raw_body: Mapping[str, Any]) -> tuple[str, ...]:
    """The body's fixed language codes, or ``()`` for Meta auto-detect.

    An absent or empty list is auto-detect and must send no ``languageBias``;
    it is never turned into a guessed language. The STT adapter maps our codes
    to the vendor's language names.
    """
    section = raw_body.get("input")
    if not isinstance(section, Mapping):
        return ()
    codes = section.get("language_codes")
    if not isinstance(codes, (list, tuple)):
        return ()
    return tuple(code for code in codes if isinstance(code, str) and code.strip())


def build_cascade_legs(
    *,
    call_id: str,
    ledger: TimingLedger,
    budget: ReconnectBudget,
    environ: Mapping[str, str] | None = None,
    stt_socket_factory: Any = None,
    llm_session_factory: Any = None,
    tts_socket_factory: Any = None,
) -> LegBuilder:
    """The production leg builder: Meta speech, the body's model, AssemblyAI.

    A body with an ``llm`` entry constructs the tenant's own client through
    :func:`cascade.meta_llm.construct_byo_model`; the Meta key is never
    substituted for it. A body with no entry uses the Standard Spark rung, with
    the model id and the measured reasoning effort read from the host env.
    """
    env = os.environ if environ is None else environ

    def build(body: CascadeBody, raw_body: Mapping[str, Any]) -> CascadeLegs:
        speech = MetaStreamingSTT(
            call_id=call_id,
            api_key=str(env.get("META_API_KEY", "")).strip() or None,
            keyterms=body.keyterms,
            ledger=ledger,
            budget=budget,
            socket_factory=stt_socket_factory,
        )
        voice = AssemblyAIStreamingTTS(
            voice_id=body.voice_id,
            transport="browser",
            api_key=str(env.get("ASSEMBLYAI_API_KEY", "")).strip() or None,
            ledger=ledger,
            budget=budget,
            socket_factory=tts_socket_factory,
        )
        factory_kwargs: dict[str, Any] = {}
        if llm_session_factory is not None:
            factory_kwargs["session_factory"] = llm_session_factory
        if body.llm is not None:
            built = construct_byo_model(
                body.llm,
                system_prompt=body.system_prompt,
                ledger=ledger,
                budget=budget,
                **factory_kwargs,
            )
            model = built.client
            model_provider = built.provider
            model_reason = (
                "the stored body's LLM override names this provider and model"
            )
        else:
            model = MetaLLM(
                model=str(env.get(LLM_MODEL_ENV, "")).strip() or None,
                reasoning_effort=env.get(REASONING_EFFORT_ENV),
                api_key=str(env.get("META_API_KEY", "")).strip() or None,
                system_prompt=body.system_prompt,
                internal_id=call_id,
                identifier_salt=str(env.get("META_IDENTIFIER_SALT", "")).strip()
                or None,
                ledger=ledger,
                budget=budget,
                **factory_kwargs,
            )
            model_provider = "spark"
            model_reason = (
                "no body override; the Standard Spark rung serves this call"
            )
        return CascadeLegs(
            speech=speech,
            voice=voice,
            model=model,
            stt_languages=_stt_languages(raw_body),
            model_provider=model_provider,
            model_reason=model_reason,
        )

    return build


# ---------------------------------------------------------------------------
# The browser side of the call
# ---------------------------------------------------------------------------


class BrowserCallTransport:
    """The ``CallTransport`` seam over one browser WebSocket.

    ``receive`` decodes the browser's frames into the lifecycle's inputs and
    returns ``None`` when the socket dropped. ``send`` carries the one end
    message and adds the pair's versions, so a half-deployed app and service
    are visible in the call record.
    """

    def __init__(self, ws: Any) -> None:
        self._ws = ws

    async def receive(self) -> object | None:
        while True:
            try:
                message = await self._ws.receive_json()
            except Exception:
                return None
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "audio" and isinstance(message.get("data"), str):
                try:
                    return AudioFrame(base64.b64decode(message["data"]))
                except Exception:
                    continue
            if (
                kind == "context"
                and message.get("role") == "system"
                and isinstance(message.get("content"), str)
            ):
                return ContextUpdate(message["content"])
            if kind == "stop":
                return BrowserStop()

    async def send(self, message: Mapping[str, Any]) -> None:
        document = dict(message)
        document.setdefault("protocolVersion", PROTOCOL_VERSION)
        document.setdefault("buildVersion", build_version())
        await _send(self._ws, document)

    async def close(self) -> None:
        """The lifecycle owns no socket close; the server owns the WebSocket."""
        return None

    async def send_audio(self, audio: OutboundAudio) -> None:
        """One call-sequenced playout frame."""
        await _send(
            self._ws,
            {
                "type": "audio",
                "seq": audio.seq,
                "sample_rate": audio.sample_rate,
                "data": base64.b64encode(audio.pcm).decode(),
            },
        )

    async def caption(self, role: str, text: str, final: bool) -> None:
        await _send(
            self._ws, {"type": "caption", "role": role, "text": text, "final": final}
        )

    async def interrupted(self) -> None:
        await _send(self._ws, {"type": "interrupted"})


@dataclass
class _PreparedCall:
    """One admitted call's lifecycle, its turn stream and its live-socket claim."""

    lifecycle: CallLifecycle
    stream: CascadeTurnStream
    claim: Any = None


def _call_error(stage: str, error: BaseException) -> str:
    """A setup failure's name and message; never a credential value."""
    return f"{stage} failed: {type(error).__name__}: {error}"


def _usage_meter_for(factory: Any) -> UsageMeter:
    if factory is None:
        return UsageMeter()
    if isinstance(factory, UsageMeter):
        return factory
    return factory()


def _events_for(
    factory: Any, *, call_id: str, subject: str
) -> OperationalEvents | None:
    if factory is None:
        return None
    if isinstance(factory, OperationalEvents):
        return factory
    return factory(call_id, subject)


async def handle_browser_call(
    ws: Any,
    *,
    config_message: Mapping[str, Any] | None = None,
    body_channel: StoredBodyChannel | None = None,
    call_tokens: CallTokenRegistry | None = None,
    switch: RoutingSwitch | None = None,
    counter: Any = None,
    secret: str | bytes | None = None,
    cost_table: RateTable | None = None,
    usage_meter: Any = None,
    operational_events: Any = None,
    leg_builder: LegBuilder | None = None,
    environ: Mapping[str, str] | None = None,
    clock: Callable[[], float] = time.monotonic,
    envelope_clock: Callable[[], float] = time.time,
    drain_bound_ms: float | None = None,
    bounds: Mapping[str, float] | None = None,
) -> None:
    """Serve one browser call on an open socket. Returns on stop/drop.

    The call token is verified at connect (ticket 136) — signature and expiry
    first, then the call and subject bindings against the signed body — and
    only then claimed. No leg factory, and therefore no vendor socket, is
    reached until the token and the body agree **and** the routing switch
    admits the new call. A managed refusal is one named error and zero legs.
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
        # The code is the machine-readable half: a version mismatch is
        # ``protocol_version`` so the app can fail loudly instead of hanging.
        await _send(ws, {"type": "error", "code": exc.code, "message": str(exc)})
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
    except (BodyFieldError, VoiceBindingError) as exc:
        await _send(ws, {"type": "error", "message": f"stored body refused: {exc}"})
        return

    browser = BrowserCallTransport(ws)
    env = os.environ if environ is None else environ
    executor: ToolExecutor | None = None
    tool_base_url = str(env.get(TOOL_BASE_URL_ENV, "")).strip()
    if tool_base_url:
        executor = ToolExecutor.from_verified(verified, base_url=tool_base_url)

    claim_holder: list[Any] = []

    def release_claims() -> None:
        """Release every claim this socket made; a setup failure leaves none."""
        for held in claim_holder:
            call_tokens.release(held)

    async def prepare() -> _PreparedCall:
        # One claim, one live socket per call. The claim is inside the opener so
        # a managed decision never spends the token, and a replay is refused
        # before any leg is constructed.
        claim = call_tokens.claim(
            client.call_token,
            call_id=verified.call_id,
            subject=verified.agent_id,
        )
        claim_holder.append(claim)
        ledger = TimingLedger(now=clock)
        budget = ReconnectBudget(ledger=ledger, now=clock)
        if leg_builder is None:
            legs = build_cascade_legs(
                call_id=verified.call_id,
                ledger=ledger,
                budget=budget,
                environ=env,
            )(body, verified.body)
        else:
            legs = leg_builder(body, verified.body)

        holder: dict[str, CallLifecycle] = {}

        async def emit_audio(
            audio: Any, *, kind: str = "reply", flush_id: int | None = None
        ) -> OutboundAudio:
            return await holder["lifecycle"].emit_audio(
                audio, kind=kind, flush_id=flush_id
            )

        def may_request(leg: str) -> bool:
            return holder["lifecycle"].may_request(leg)

        stream = CascadeTurnStream(
            llm=legs.model,
            tts=legs.voice,
            tools=body.tools,
            emit_audio=emit_audio,
            may_request=may_request,
            tool_executor=executor,
            locale_code=body.language_code,
            ledger=ledger,
            clock=clock,
            on_caption=browser.caption,
            on_interrupted=browser.interrupted,
        )
        lifecycle = CallLifecycle(
            message={"envelope": verified.envelope.to_dict(), "body": verified.body},
            secret=secret if secret is not None else "",
            call_id=verified.call_id,
            transport=browser,
            open_speech=legs.open_speech,
            open_voice=legs.open_voice,
            open_model=legs.open_model,
            stream=stream,
            send_audio=browser.send_audio,
            ledger=ledger,
            clock=clock,
            envelope_clock=envelope_clock,
            drain_bound_ms=drain_bound_ms,
            bounds=bounds,
            usage_meter=_usage_meter_for(usage_meter),
            cost_table=cost_table,
            operational_events=_events_for(
                operational_events, call_id=verified.call_id, subject=verified.agent_id
            ),
            reconnect_budget=budget,
        )
        holder["lifecycle"] = lifecycle
        return _PreparedCall(lifecycle=lifecycle, stream=stream, claim=claim)

    if switch is None:
        await _send(
            ws,
            {
                "type": "error",
                "code": "managed",
                "message": (
                    "the service has no durable routing switch configured; a new "
                    "call routes managed and this service opens no cascade socket"
                ),
            },
        )
        return

    try:
        admission = await admit_new_call(
            switch,
            CallSubject(subject_id=verified.agent_id),
            open_cascade=prepare,
            budget=counter,
        )
    except CallTokenError as exc:
        release_claims()
        await _send(ws, {"type": "error", "message": str(exc)})
        return
    except Exception as exc:  # a real opener failure is visible, never silent
        release_claims()
        await _send(ws, {"type": "error", "message": _call_error("call setup", exc)})
        return

    if admission.connections != 1:
        await _send(
            ws,
            {
                "type": "error",
                "code": "managed",
                "message": admission.decision.reason
                or "the routing decision routes this call managed",
            },
        )
        return

    prepared = admission.connection
    assert isinstance(prepared, _PreparedCall)
    try:
        await prepared.lifecycle.run()
    finally:
        # The socket is over: the call no longer holds the one live-socket
        # slot. The token itself stays spent.
        call_tokens.release(prepared.claim)


async def _send(ws: Any, message: Mapping[str, Any]) -> None:
    try:
        await ws.send_json(dict(message))
    except Exception:
        pass


__all__ = [
    "BrowserCallTransport",
    "CascadeLegs",
    "build_cascade_legs",
    "handle_browser_call",
]
