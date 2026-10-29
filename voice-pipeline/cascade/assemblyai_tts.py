"""AssemblyAI streaming synthesis: connect and the Begin echo (tickets 47, 48).

One synthesis socket per call, opened at call start before the first user
frame. The connection is built from exactly two authorities and nothing else:

- the voice binding owns ``voice_id`` and the vendor language name
  (``cascade.voice_binding``), never our two-letter code;
- the transport owns ``sample_rate`` and ``encoding``: the browser gets
  24 kHz ``pcm_s16le``, the phone leg gets 8 kHz ``pcm_mulaw``.

``model_id`` (``assemblyai-tts-1``) and ``word_boundaries`` are fixed for the
cascade. No constructor or connect argument can override any of them, so a
request cannot mix a voice with another language or a rate the transport does
not carry. An unknown voice or transport refuses by name before a socket is
opened.

The opening ``Begin`` frame is the session's own record of what it got, and it
is an assertion: the echoed voice, language, sample rate, encoding and model
are compared with the request, and any mismatch fails the call before a single
frame is sent or played. A non-empty ``unknown_params`` list is a configuration
bug. The session's ``expires_at`` and ``configuration.limits`` are recorded as
call facts.

One socket carries the whole call. ``speak`` sends one request per sentence and
flushes the first sentence immediately; ``Cancel`` stops in-flight synthesis,
drops the old request's frames until the vendor acknowledges, and reads the
next ``flush_id`` from the wire; ``terminate`` takes the implicit flush and the
billing record; and ``handle_close`` turns a close code into a retry, a planned
reconnect, or a visible call failure. There is no second voice vendor.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any
from urllib.parse import urlencode

from providers import SentenceAudio, StreamingTTS

from cascade.failures import FailureClass, FailureVerdict, classify_tts
from cascade.thresholds import require_bound
from cascade.voice_binding import VoiceBinding, bind_voice

TTS_BASE_URL = "wss://tts.us.assemblyai.com/v1/ws"
MODEL_ID = "assemblyai-tts-1"

#: The vendor's per-``Generate`` ceiling, from the one threshold registry.
GENERATE_CHAR_CAP = int(require_bound("tts.generate_char_cap"))

#: What "per second" means for the control-frame budget. A window length, not
#: a budget: the budget itself is the ``max_control_frames_per_sec`` the
#: session announced in ``Begin``.
CONTROL_WINDOW_S = 1.0

#: A sentence ends after its closing punctuation and the whitespace that
#: follows it; the whitespace stays in the piece because ``Generate`` frames
#: are joined by the vendor with no separator.
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")
#: A clause ends after ``,``, ``;`` or ``:`` and the whitespace that follows.
_CLAUSE_END = re.compile(r"[,;:]\s+")

SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]


def _default_socket_factory(url: str, extra_headers: dict[str, str]) -> Awaitable[Any]:
    import websockets

    return websockets.connect(url, additional_headers=extra_headers)  # type: ignore[no-any-return]


@dataclass(frozen=True)
class TransportFormat:
    """The audio format one transport carries."""

    transport: str
    sample_rate: int
    encoding: str


# The transport chooses the format; the voice and the request do not.
# `telnyx` is the phone leg: the carrier carries 8 kHz mu-law.
TRANSPORT_FORMATS: Mapping[str, TransportFormat] = MappingProxyType(
    {
        "browser": TransportFormat("browser", 24000, "pcm_s16le"),
        "telnyx": TransportFormat("telnyx", 8000, "pcm_mulaw"),
    }
)


class UnknownTransportError(LookupError):
    """No synthesis format is defined for the transport."""

    def __init__(self, transport: str) -> None:
        self.transport = transport
        known = ", ".join(sorted(TRANSPORT_FORMATS))
        super().__init__(
            f'unknown transport "{transport}": no synthesis sample rate and encoding '
            f"are defined for it (known transports: {known})"
        )


class SynthesisHandshakeError(RuntimeError):
    """The session did not open with a ``Begin`` frame."""


class SynthesisProtocolError(RuntimeError):
    """A frame that cannot be read, or a socket that closed mid-request."""


class SynthesisCallFailure(RuntimeError):
    """A synthesis failure that ends the call, visibly.

    There is no second voice vendor, so ``fallback`` is always ``None`` and
    ``call_ended`` is always true. ``visible`` is what the browser needs in
    order to show the failure instead of an opening that never speaks.
    """

    fallback = None

    def __init__(self, *, verdict: FailureVerdict, stage: str, reason: str) -> None:
        self.verdict = verdict
        self.stage = stage
        self.reason = reason
        self.visible = True
        self.call_ended = True
        super().__init__(
            f"{stage} synthesis failed ({verdict.failure_class.value}): {reason}"
        )


class ControlFramePacingError(SynthesisCallFailure):
    """The client sent control frames faster than the session accepts them.

    This is our bug (close ``3010``), not an outage: the vendor would close the
    session, so the adapter refuses the frame instead of tripping it. It fails
    the call visibly and alerts; it never opens the voice leg's breaker.
    """

    def __init__(self, limit: float, count: int, at: float) -> None:
        self.limit = limit
        self.count = count
        self.at = at
        super().__init__(
            verdict=classify_tts(3010),
            stage="reply",
            reason=(
                f"control frames exceeded the session's {limit:g}/s budget "
                f"({count} sent in the last second at {at:.3f}s): 3010 "
                "text/control pacing bug — do not retry blindly"
            ),
        )


class CloseAction(str, Enum):
    """What one close means for the call."""

    CLEAN = "clean"
    RETRY = "retry"
    PLANNED_RECONNECT = "planned_reconnect"
    FAIL = "fail"


@dataclass(frozen=True)
class CloseDecision:
    """A close that does not end the call, and why."""

    verdict: FailureVerdict
    action: CloseAction
    retried: bool = False

    @property
    def fallback(self) -> None:
        """Synthesis has no second rung: a close never hands over to managed."""
        return None



@dataclass(frozen=True)
class EchoMismatch:
    """One ``Begin`` field that disagrees with what the request asked for."""

    field: str
    requested: Any
    echoed: Any


class SynthesisEchoError(SynthesisHandshakeError):
    """The session is not the session the request asked for.

    Fails the call visibly before any audio exists: a voice, language, rate,
    encoding or model that differs from the request is a configuration bug,
    not a session to use anyway.
    """

    def __init__(self, mismatches: tuple[EchoMismatch, ...]) -> None:
        self.mismatches = mismatches
        detail = "; ".join(
            f"{mismatch.field} requested {mismatch.requested!r}, "
            f"session echoed {mismatch.echoed!r}"
            for mismatch in mismatches
        )
        super().__init__(f"synthesis Begin disagrees with the request: {detail}")


class SynthesisConfigurationError(SynthesisHandshakeError):
    """The vendor ignored a query parameter we sent; that is our bug."""

    def __init__(self, unknown_params: tuple[str, ...]) -> None:
        self.unknown_params = unknown_params
        super().__init__(
            "synthesis Begin reports unknown query parameters "
            f"{', '.join(repr(name) for name in unknown_params)}: a configuration "
            "bug, not a warning to ignore"
        )


#: The five ``Begin.configuration`` fields the echo assertion compares.
ECHO_FIELDS: tuple[str, ...] = (
    "voice_id",
    "language",
    "sample_rate",
    "encoding",
    "model",
)


def _normalise(field: str, value: Any) -> Any:
    """Compare in the shape the vendor echoes: strings lowercased, rate as int.

    The vendor normalizes ``language`` and ``voice_id`` to lowercase and
    reports the rate as an integer; a case difference is not a mismatch.
    """
    if isinstance(value, str):
        return value.strip().lower()
    if field == "sample_rate":
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    return value


def echo_mismatches(
    begin_frame: Mapping[str, Any],
    *,
    voice_id: str,
    language: str,
    sample_rate: int,
    encoding: str,
    model: str,
) -> tuple[EchoMismatch, ...]:
    """Compare the session's echo with the request, field by field."""
    configuration = begin_frame.get("configuration")
    if not isinstance(configuration, Mapping):
        configuration = {}
    requested = {
        "voice_id": voice_id,
        "language": language,
        "sample_rate": sample_rate,
        "encoding": encoding,
        "model": model,
    }
    mismatches: list[EchoMismatch] = []
    for field in ECHO_FIELDS:
        echoed = configuration.get(field)
        if _normalise(field, echoed) != _normalise(field, requested[field]):
            mismatches.append(
                EchoMismatch(
                    field=field, requested=requested[field], echoed=echoed
                )
            )
    return tuple(mismatches)


def split_sentences(text: str) -> tuple[str, ...]:
    """Split at sentence ends, keeping each piece's trailing whitespace."""
    pieces: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(text):
        pieces.append(text[start : match.end()])
        start = match.end()
    if start < len(text):
        pieces.append(text[start:])
    return tuple(piece for piece in pieces if piece)


def _clause_cut(window: str) -> int | None:
    cuts = [match.end() for match in _CLAUSE_END.finditer(window)]
    return cuts[-1] if cuts else None


def _space_cut(window: str) -> int | None:
    cut = window.rfind(" ")
    return cut + 1 if cut > 0 else None


def _split_under_cap(text: str, cap: int) -> list[str]:
    """Split one over-cap sentence at a clause, then whitespace, then the cap."""
    pieces: list[str] = []
    rest = text
    while len(rest) > cap:
        window = rest[:cap]
        cut = _clause_cut(window) or _space_cut(window) or cap
        pieces.append(rest[:cut])
        rest = rest[cut:]
    if rest:
        pieces.append(rest)
    return pieces


def schedule(text: str) -> tuple[str, ...]:
    """The ``Generate`` texts for one reply: one per sentence, each under cap.

    The first piece is the first sentence alone, so the caller's first
    ``Flush`` does not wait for the rest of the reply. A sentence longer than
    the Generate cap is split at a clause boundary; a clause with no boundary
    splits at whitespace; an unbroken run is cut under the cap. Nothing is
    dropped: ``"".join(schedule(text)) == text`` for any non-blank text.
    """
    if not text.strip():
        return ()
    chunks: list[str] = []
    for sentence in split_sentences(text):
        chunks.extend(_split_under_cap(sentence, GENERATE_CHAR_CAP))
    return tuple(chunks)


#: The only ``word_boundaries_status`` value that licenses a word-level cut.
WORD_BOUNDARIES_COMPLETE = "complete"


@dataclass(frozen=True)
class WordBoundary:
    """One word's position on the session's continuous audio timeline."""

    word: str
    start_ms: float
    end_ms: float
    confidence: float = 0.0


@dataclass
class SynthesisRequest:
    """One flushed request: its text, its audio, and what the vendor timed."""

    flush_id: int | None
    text: str = ""
    audio_start_ms: float | None = None
    audio_duration_ms: int | None = None
    audio_bytes: int = 0
    words: tuple[WordBoundary, ...] = field(default_factory=tuple)


class ResumeGranularity(str, Enum):
    """How much of the cut reply the barge-in path re-synthesizes."""

    WORD = "word"
    SENTENCE = "sentence"


@dataclass(frozen=True)
class ResumePoint:
    """Where the unheard tail starts, and how precisely that is known."""

    granularity: ResumeGranularity
    text: str
    flush_id: int | None
    word_index: int | None
    reason: str


@dataclass
class Cancellation:
    """One ``Cancel`` and what it actually stopped.

    ``next_flush_id`` is read from the first frame after ``Cancelled`` because
    the vendor may skip ids after a cancel; it stays ``None`` until such a
    frame arrives.
    """

    audio_duration_seconds: float | None = None
    dropped_audio_bytes: int = 0
    dropped_flushes: int = 0
    discarded_characters: int = 0
    next_flush_id: int | None = None
    acknowledged: bool = False


@dataclass(frozen=True)
class Billing:
    """The vendor's metered units for one call.

    ``characters`` is the billed count and ``source`` names the ``Termination``
    key it came from. A call that never produced a summary keeps
    ``characters=None`` with ``measured=False``: unknown is not zero.
    """

    characters: int | None
    measured: bool
    source: str
    total_input_char_length: int | None = None
    audio_duration_seconds: float | None = None
    session_duration_seconds: int | None = None
    audio_bytes: int = 0


@dataclass(frozen=True)
class TerminationRecord:
    """The clean end: the final flush confirmation, then the session summary."""

    final_flush: SynthesisRequest | None
    flush_done: Mapping[str, Any] | None
    termination: Mapping[str, Any]
    residual_audio: bytes
    billing: Billing







def transport_format(transport: str) -> TransportFormat:
    """The rate and encoding the transport carries, or refuse it by name."""
    try:
        return TRANSPORT_FORMATS[transport]
    except KeyError:
        raise UnknownTransportError(transport) from None


class AssemblyAIStreamingTTS(StreamingTTS):
    """One AssemblyAI synthesis session per call.

    Construction resolves the voice binding and the transport format, so a
    voice or transport that cannot be served fails before any socket exists.
    :meth:`open` then opens the single socket and reads the ``Begin`` frame.
    """

    def __init__(
        self,
        *,
        voice_id: str,
        transport: str,
        api_key: str | None = None,
        socket_factory: SocketFactory | None = None,
        clock: Callable[[], float] | None = None,
        alert: Callable[[FailureVerdict, str], None] | None = None,
    ) -> None:
        self.binding: VoiceBinding = bind_voice(voice_id)
        self.format: TransportFormat = transport_format(transport)
        self.model_id = MODEL_ID
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        self._socket_factory = socket_factory or _default_socket_factory
        self._clock = clock or time.monotonic
        self._alert_sink = alert
        self._socket: Any = None
        self._frames: Any = None
        self._stage = "reply"
        self.begin: Mapping[str, Any] | None = None
        # The call's own record of the session it got (ticket 48).
        self.configuration: Mapping[str, Any] = MappingProxyType({})
        self.limits: Mapping[str, Any] = MappingProxyType({})
        self.expires_at: int | None = None
        self.begin_id: str | None = None
        self.unknown_params: tuple[str, ...] = ()
        self.begin_mismatches: tuple[EchoMismatch, ...] = ()
        # Send-time facts the pacing guard and the call ledger read.
        self.control_frame_times: list[float] = []
        self.control_frames_sent = 0
        self.flush_id: int | None = None
        self.audio_bytes: int = 0
        self.termination: Mapping[str, Any] | None = None
        # Per-request facts (ticket 51): keyed by the flush id the vendor sent.
        self.requests: dict[int, SynthesisRequest] = {}
        self.request_order: list[int] = []
        self.word_boundaries_status: str | None = None
        # Cancel state (ticket 52).
        self.cancellations: list[Cancellation] = []
        self._cancel_generation = 0
        self._pending_cancels: deque[Cancellation] = deque()
        self._discarding = False
        self._awaiting_cancel: Cancellation | None = None
        self._pending_characters = 0
        # Billing (ticket 54): unmeasured until a Termination summary arrives.
        self.billing = Billing(
            characters=None,
            measured=False,
            source="unterminated: the session has not ended",
            audio_bytes=0,
        )
        # Close policy (ticket 55).
        self.failures: list[FailureVerdict] = []
        self.alerts: list[tuple[FailureVerdict, str]] = []
        self.breaker_opens: list[FailureVerdict] = []
        self.reconnects = 0
        self.needs_reconnect = False
        self._retry_used = False

    @property
    def url(self) -> str:
        """The connect URL: binding voice and language, transport rate and codec."""
        params = [
            ("voice_id", self.binding.voice_id),
            ("language", self.binding.language),
            ("sample_rate", str(self.format.sample_rate)),
            ("encoding", self.format.encoding),
            ("model_id", self.model_id),
            ("word_boundaries", "true"),
        ]
        return f"{TTS_BASE_URL}?{urlencode(params)}"

    async def open(self) -> None:
        """Open the call's single socket, then assert the session's ``Begin``.

        The echo is an assertion, not a log line: a mismatched voice,
        language, rate, encoding or model, or a non-empty ``unknown_params``
        list, refuses the call before any text or audio frame is sent.
        """
        if self._socket is not None:
            raise RuntimeError(
                "the synthesis session is already open: one socket per call"
            )
        if not self._api_key:
            raise RuntimeError("ASSEMBLYAI_API_KEY is not configured")
        socket = await self._socket_factory(
            self.url, {"Authorization": self._api_key}
        )
        self._socket = socket
        self._frames = socket.__aiter__()
        try:
            self.begin = self._read_begin(await self._first_frame())
            self._record_begin(self.begin)
            self._assert_begin()
        except BaseException:
            await _close_quietly(socket)
            self._socket = None
            self._frames = None
            raise

    def _record_begin(self, frame: Mapping[str, Any]) -> None:
        """Keep the session's own account of what it got as call facts."""
        configuration = frame.get("configuration")
        if not isinstance(configuration, Mapping):
            configuration = {}
        self.configuration = MappingProxyType(dict(configuration))
        limits = configuration.get("limits")
        self.limits = MappingProxyType(dict(limits) if isinstance(limits, Mapping) else {})
        expires_at = frame.get("expires_at")
        self.expires_at = expires_at if isinstance(expires_at, int) else None
        begin_id = frame.get("id")
        self.begin_id = begin_id if isinstance(begin_id, str) else None
        unknown = configuration.get("unknown_params")
        self.unknown_params = (
            tuple(str(name) for name in unknown) if isinstance(unknown, list) else ()
        )
        self.begin_mismatches = echo_mismatches(
            frame,
            voice_id=self.binding.voice_id,
            language=self.binding.language,
            sample_rate=self.format.sample_rate,
            encoding=self.format.encoding,
            model=self.model_id,
        )

    def _assert_begin(self) -> None:
        if self.unknown_params:
            raise SynthesisConfigurationError(self.unknown_params)
        if self.begin_mismatches:
            raise SynthesisEchoError(self.begin_mismatches)

    async def speak(self, text: str) -> AsyncIterator[SentenceAudio]:
        """Send one reply per sentence and yield the audio as it arrives.

        The first sentence is ``Generate`` + ``Flush`` before any later
        sentence is sent, so audio starts without waiting for the rest of the
        reply. Each later sentence is concluded with its own ``Flush`` only
        after the previous ``FlushDone``, which is what keeps the control-frame
        rate inside the session's budget and makes a per-token flush
        unexpressible.
        """
        self._require_open()
        chunks = schedule(text)
        if not chunks:
            return
        generation = self._cancel_generation
        index = 0
        self._pending_characters = sum(len(chunk) for chunk in chunks[1:])
        await self._send_request(chunks[index])
        while True:
            frame = await self._next_frame(generation)
            if frame is None:
                return
            kind = frame.get("type")
            if kind == "Audio":
                pcm = self._decode_audio(frame)
                self.audio_bytes += len(pcm)
                request = self._request_for(frame.get("flush_id"), text=chunks[index])
                request.audio_bytes += len(pcm)
                yield SentenceAudio(
                    pcm=pcm,
                    sample_rate=self.audio_sample_rate,
                    text=chunks[index],
                )
            elif kind == "FlushDone":
                self._record_flush_done(frame, text=chunks[index])
                index += 1
                if index >= len(chunks):
                    self._pending_characters = 0
                    return
                self._pending_characters = sum(
                    len(chunk) for chunk in chunks[index + 1 :]
                )
                await self._send_request(chunks[index])
            elif kind == "Termination":
                return

    async def speak_greeting(self, text: str) -> AsyncIterator[SentenceAudio]:
        """Speak the body's greeting line, first sentence flushed immediately.

        A greeting goes through the same scheduler as a reply: one
        ``Generate`` + ``Flush``, split at sentence boundaries. A greeting that
        is never flushed is a bug, so there is no separate unflushed path. A
        failure here ends the call visibly with ``stage="greeting"``; there is
        no silent opening.
        """
        previous = self._stage
        self._stage = "greeting"
        try:
            async for audio in self.speak(text):
                yield audio
        finally:
            self._stage = previous

    @property
    def audio_sample_rate(self) -> int:
        """The rate the session actually runs at, from its own ``Begin`` echo."""
        echoed = self.configuration.get("sample_rate")
        return echoed if isinstance(echoed, int) else self.format.sample_rate

    def _require_open(self) -> None:
        if self._socket is None:
            raise RuntimeError("the synthesis session is not open")

    async def _send_request(self, text: str) -> None:
        """One request: its text, then the ``Flush`` that concludes it."""
        if len(text) > GENERATE_CHAR_CAP:
            raise ValueError(
                f"a Generate carries at most {GENERATE_CHAR_CAP} characters; "
                f"refusing {len(text)}"
            )
        await self._send_control({"type": "Generate", "text": text})
        await self._send_control({"type": "Flush"})

    async def _send_control(self, frame: Mapping[str, Any]) -> None:
        self._require_open()
        self._check_control_budget()
        await self._socket.send(json.dumps(frame))
        self.control_frame_times.append(self._clock())
        self.control_frames_sent += 1

    def _check_control_budget(self) -> None:
        """Refuse to send a frame the session would answer with ``3010``."""
        limit = self.limits.get("max_control_frames_per_sec")
        if not isinstance(limit, (int, float)) or limit <= 0:
            return
        now = self._clock()
        # Keep only the window that matters: a long call must not grow this
        # list without bound, and the budget is a one-second rate.
        self.control_frame_times = [
            moment
            for moment in self.control_frame_times
            if now - moment < CONTROL_WINDOW_S
        ]
        if len(self.control_frame_times) >= limit:
            failure = ControlFramePacingError(
                float(limit), len(self.control_frame_times), now
            )
            self.failures.append(failure.verdict)
            self._alert(failure.verdict, str(failure))
            raise failure

    async def handle_close(self, code: Any = None) -> CloseDecision:
        """Classify one close and act on it.

        A retryable close is retried once, and only before any audio was
        delivered — restarting mid-reply would repeat speech. A configuration
        or pacing close is our bug: the call fails, an alert fires, and the
        voice leg's breaker is left closed. ``3008`` and the expiry sentinel are
        planned reconnects: drain this reply, open a new session next turn.
        """
        verdict = classify_tts(code)
        if verdict.failure_class is FailureClass.PLANNED_RECONNECT:
            await self._close_socket()
            self.needs_reconnect = True
            return CloseDecision(verdict=verdict, action=CloseAction.PLANNED_RECONNECT)
        if verdict.failure_class is FailureClass.DO_NOT_OPEN:
            await self._close_socket()
            if code == 1000:
                return CloseDecision(verdict=verdict, action=CloseAction.CLEAN)
            raise self._fail(
                verdict, f"synthesis close {code!r}: {verdict.reason}"
            )
        if verdict.failure_class is FailureClass.TRIGGER and self.retry_allowed:
            self._retry_used = True
            self.failures.append(verdict)
            await self._reopen()
            return CloseDecision(
                verdict=verdict, action=CloseAction.RETRY, retried=True
            )
        failure = self._fail(
            verdict, f"synthesis close {code!r}: {verdict.reason}"
        )
        await self._close_socket()
        raise failure

    @property
    def retry_allowed(self) -> bool:
        """Whether a trigger close may be retried with a new session.

        Once, and only before any audio was delivered: a retry after speech
        would repeat it. The failed attempt is still recorded.
        """
        return (
            not self._retry_used
            and self.audio_bytes == 0
            and self._socket is not None
        )

    async def _reopen(self) -> None:
        """Replace the failed session with a new one, asserting its Begin too."""
        await self._close_socket()
        self._discarding = False
        self._pending_cancels.clear()
        self._awaiting_cancel = None
        self._cancel_generation += 1
        self.needs_reconnect = False
        self.reconnects += 1
        await self.open()

    def _fail(self, verdict: FailureVerdict, reason: str) -> SynthesisCallFailure:
        """Record one call-ending failure: breaker for triggers, alert for bugs."""
        failure = SynthesisCallFailure(
            verdict=verdict, stage=self._stage, reason=reason
        )
        self.failures.append(verdict)
        if verdict.opens_breaker:
            self.breaker_opens.append(verdict)
        if verdict.failure_class is FailureClass.BUG:
            self._alert(verdict, str(failure))
        return failure

    def _alert(self, verdict: FailureVerdict, reason: str) -> None:
        self.alerts.append((verdict, reason))
        if self._alert_sink is not None:
            self._alert_sink(verdict, reason)

    async def cancel(self) -> Cancellation:
        """Stop in-flight synthesis and discard everything not yet heard.

        Returns before the vendor acknowledges: a barge-in cut is local and
        immediate, and a ``Generate`` sent after this call is not caught by it.
        The acknowledgement is consumed by the next frame read, which drops
        the old request's audio until ``Cancelled`` and reads the new
        ``flush_id`` from the first frame after it.
        """
        self._require_open()
        await self._send_control({"type": "Cancel"})
        cancellation = Cancellation(discarded_characters=self._pending_characters)
        self.cancellations.append(cancellation)
        self._pending_cancels.append(cancellation)
        self._discarding = True
        self._cancel_generation += 1
        self._pending_characters = 0
        return cancellation

    async def _next_frame(self, generation: int) -> Mapping[str, Any] | None:
        """The next frame this request may act on, or ``None`` if it was cancelled.

        Frames that arrive while a ``Cancel`` is unacknowledged belong to the
        request that was cancelled: audio is counted and dropped, flushes are
        counted and dropped, and neither reaches the caller.
        """
        if generation != self._cancel_generation:
            return None
        while True:
            frame = await self._read_frame()
            kind = frame.get("type")
            if self._discarding:
                if kind == "Audio":
                    if self._pending_cancels:
                        self._pending_cancels[0].dropped_audio_bytes += len(
                            self._decode_audio(frame)
                        )
                    continue
                if kind == "FlushDone":
                    if self._pending_cancels:
                        self._pending_cancels[0].dropped_flushes += 1
                    continue
            if kind == "Cancelled":
                self._acknowledge_cancel(frame)
                if generation != self._cancel_generation:
                    return None
                continue
            if kind == "Termination":
                self._record_termination(frame)
                return frame
            if kind in ("Audio", "FlushDone"):
                flush_id = frame.get("flush_id")
                if isinstance(flush_id, int):
                    if self._awaiting_cancel is not None:
                        self._awaiting_cancel.next_flush_id = flush_id
                        self._awaiting_cancel = None
                    self.flush_id = flush_id
            return frame

    def _acknowledge_cancel(self, frame: Mapping[str, Any]) -> None:
        if not self._pending_cancels:
            return
        cancellation = self._pending_cancels.popleft()
        duration = frame.get("audio_duration_seconds")
        cancellation.audio_duration_seconds = (
            float(duration) if isinstance(duration, (int, float)) else 0.0
        )
        cancellation.acknowledged = True
        if self._pending_cancels:
            return
        self._discarding = False
        self._awaiting_cancel = cancellation

    def _record_flush_done(self, frame: Mapping[str, Any], *, text: str = "") -> None:
        flush_id = frame.get("flush_id")
        if isinstance(flush_id, int):
            self.flush_id = flush_id
        request = self._request_for(flush_id, text=text)
        duration = frame.get("audio_duration_ms")
        if isinstance(duration, int):
            request.audio_duration_ms = duration

    def _record_termination(self, frame: Mapping[str, Any]) -> None:
        self.termination = frame
        status = frame.get("word_boundaries_status")
        if isinstance(status, str):
            self.word_boundaries_status = status

    def _request_for(
        self, flush_id: Any, *, text: str = ""
    ) -> SynthesisRequest:
        """The record for one flush id, created on its first frame.

        Frames are matched by ``flush_id`` and never by arrival order: a
        sentence's ``WordBoundaries`` may land after the next request's audio.
        """
        key = flush_id if isinstance(flush_id, int) else self.flush_id
        if key is None:
            key = -1
        request = self.requests.get(key)
        if request is None:
            request = SynthesisRequest(flush_id=key if key >= 0 else None)
            self.requests[key] = request
            self.request_order.append(key)
        if text and not request.text:
            request.text = text
        return request

    def _record_word_boundaries(self, frame: Mapping[str, Any]) -> None:
        entries = frame.get("words")
        boundaries: list[WordBoundary] = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, Mapping):
                continue
            word = entry.get("word")
            start = entry.get("start")
            end = entry.get("end")
            if (
                not isinstance(word, str)
                or not isinstance(start, (int, float))
                or not isinstance(end, (int, float))
            ):
                continue
            confidence = entry.get("confidence")
            boundaries.append(
                WordBoundary(
                    word=word,
                    start_ms=start,
                    end_ms=end,
                    confidence=(
                        float(confidence) if isinstance(confidence, (int, float)) else 0.0
                    ),
                )
            )
        request = self._request_for(frame.get("flush_id"))
        request.words = tuple(boundaries)
        start = frame.get("audio_start_ms")
        if isinstance(start, (int, float)):
            request.audio_start_ms = start

    async def terminate(self) -> TerminationRecord:
        """End the session deliberately and return its billing record.

        ``Terminate`` performs the implicit flush, so the adapter sends no
        extra ``Flush``: the vendor answers with the final ``FlushDone`` and
        then ``Termination``. Audio still owed is kept as residual audio, and
        a summary that never arrives leaves the billing unmeasured.
        """
        self._require_open()
        await self._socket.send(json.dumps({"type": "Terminate"}))
        residual = bytearray()
        flush_done: Mapping[str, Any] | None = None
        final_flush: SynthesisRequest | None = None
        summary: Mapping[str, Any] | None = None
        while True:
            frame = await self._next_frame(self._cancel_generation)
            if frame is None:
                break
            kind = frame.get("type")
            if kind == "Audio":
                pcm = self._decode_audio(frame)
                self.audio_bytes += len(pcm)
                residual.extend(pcm)
            elif kind == "FlushDone":
                flush_done = frame
                self._record_flush_done(frame)
                flush_id = frame.get("flush_id")
                if isinstance(flush_id, int):
                    final_flush = self.requests.get(flush_id)
            elif kind == "Termination":
                self._record_termination(frame)
                summary = frame
                break
        await self._close_socket()
        if summary is None:
            self.billing = self._unmeasured_billing()
            raise SynthesisProtocolError(
                "synthesis session ended without a Termination summary"
            )
        self.billing = self._billing_from(summary)
        return TerminationRecord(
            final_flush=final_flush,
            flush_done=flush_done,
            termination=summary,
            residual_audio=bytes(residual),
            billing=self.billing,
        )

    async def close(self) -> None:
        """Close the socket without a ``Terminate``: the call keeps no summary."""
        await self._close_socket()
        if self.termination is None:
            self.billing = self._unmeasured_billing()

    async def _close_socket(self) -> None:
        socket, self._socket = self._socket, None
        self._frames = None
        if socket is not None:
            await _close_quietly(socket)

    def _unmeasured_billing(self) -> Billing:
        return Billing(
            characters=None,
            measured=False,
            source="unterminated: no Termination summary was received",
            audio_bytes=self.audio_bytes,
        )

    def _billing_from(self, summary: Mapping[str, Any]) -> Billing:
        total = summary.get("total_input_char_length")
        total = total if isinstance(total, int) else None
        billed = summary.get("billed_characters")
        if isinstance(billed, int):
            characters, source = billed, "billed_characters"
        elif total is not None:
            characters, source = total, "total_input_char_length"
        else:
            characters, source = None, "unmeasured: no character count in Termination"
        audio = summary.get("audio_duration_seconds")
        session = summary.get("session_duration_seconds")
        return Billing(
            characters=characters,
            measured=characters is not None,
            source=source,
            total_input_char_length=total,
            audio_duration_seconds=(
                float(audio) if isinstance(audio, (int, float)) else None
            ),
            session_duration_seconds=session if isinstance(session, int) else None,
            audio_bytes=self.audio_bytes,
        )

    def resume_point(self, played_ms: float) -> ResumePoint:
        """Where the unheard tail starts, from the vendor's own timings.

        A word-level cut needs the vendor to report ``word_boundaries_status``
        ``complete`` (or the call to still be running, before a summary
        exists) and a ``WordBoundaries`` frame for the request at the cut.
        Anything else falls back to the first sentence not fully played, by
        name; the sentence text is never re-cut into guessed word offsets.
        """
        timeline = self._timeline()
        if not timeline:
            raise ValueError("no synthesis request is available to resume from")

        position = next(
            (
                index
                for index, (_, _, end) in enumerate(timeline)
                if played_ms < end
            ),
            None,
        )
        if position is None:
            request = timeline[-1][0]
            return ResumePoint(
                granularity=ResumeGranularity.SENTENCE,
                text="",
                flush_id=request.flush_id,
                word_index=None,
                reason="the whole reply has been played",
            )

        request = timeline[position][0]
        status = self.word_boundaries_status
        if status is not None and status != WORD_BOUNDARIES_COMPLETE:
            return self._sentence_resume(
                timeline, position, f"word_boundaries_status={status}"
            )
        if not request.words:
            return self._sentence_resume(
                timeline, position, "no WordBoundaries frame for this request"
            )

        word_index = next(
            (
                index
                for index, word in enumerate(request.words)
                if word.end_ms > played_ms
            ),
            None,
        )
        if word_index is None:
            if position + 1 < len(timeline):
                return self._sentence_resume(
                    timeline, position + 1, "every word of this request was heard"
                )
            return ResumePoint(
                granularity=ResumeGranularity.SENTENCE,
                text="",
                flush_id=request.flush_id,
                word_index=None,
                reason="the whole reply has been played",
            )

        tail = self._tail_from(timeline, position, word_index)
        if tail is None:
            return self._sentence_resume(
                timeline, position, "the word boundaries do not match the request text"
            )
        return ResumePoint(
            granularity=ResumeGranularity.WORD,
            text=tail,
            flush_id=request.flush_id,
            word_index=word_index,
            reason="word boundaries are complete",
        )

    def _timeline(self) -> list[tuple[SynthesisRequest, float, float]]:
        """Each request with its start and end on the session's audio timeline."""
        timeline: list[tuple[SynthesisRequest, float, float]] = []
        cursor = 0.0
        for key in self.request_order:
            request = self.requests[key]
            start = request.audio_start_ms
            if start is None:
                start = cursor
            end = start + (request.audio_duration_ms or 0)
            timeline.append((request, start, end))
            cursor = end
        return timeline

    def _sentence_resume(
        self,
        timeline: list[tuple[SynthesisRequest, float, float]],
        position: int,
        reason: str,
    ) -> ResumePoint:
        request = timeline[position][0]
        return ResumePoint(
            granularity=ResumeGranularity.SENTENCE,
            text=request.text,
            flush_id=request.flush_id,
            word_index=None,
            reason=reason,
        )

    def _tail_from(
        self,
        timeline: list[tuple[SynthesisRequest, float, float]],
        position: int,
        word_index: int,
    ) -> str | None:
        """The unheard text from one word on, cut from the original request text.

        The vendor guarantees one word entry per whitespace-delimited token of
        the request, in order, so the tail is the same tokens taken from the
        original text: case and punctuation survive, and nothing is guessed. A
        count that disagrees means the boundaries are unusable, not a licence
        to approximate.
        """
        parts: list[str] = []
        for offset, (request, _, _) in enumerate(timeline[position:]):
            tokens = request.text.split()
            first = word_index if offset == 0 else 0
            if offset == 0 and len(request.words) != len(tokens):
                return None
            if first > len(tokens):
                return None
            if tokens[first:]:
                parts.append(" ".join(tokens[first:]))
        return " ".join(parts)

    def _decode_audio(self, frame: Mapping[str, Any]) -> bytes:
        payload = frame.get("audio")
        if not isinstance(payload, str):
            raise SynthesisProtocolError(f"Audio frame has no audio payload: {frame!r}")
        try:
            return base64.b64decode(payload)
        except ValueError:
            raise SynthesisProtocolError(
                "Audio frame carries a payload that is not base64"
            ) from None

    async def _first_frame(self) -> Any:
        try:
            return await self._frames.__anext__()
        except StopAsyncIteration:
            raise SynthesisHandshakeError(
                "synthesis socket closed before the Begin frame"
            ) from None

    async def _read_frame(self) -> Mapping[str, Any]:
        while True:
            try:
                raw = await self._frames.__anext__()
            except StopAsyncIteration:
                raise SynthesisProtocolError(
                    "synthesis socket closed while a request was in flight"
                ) from None
            try:
                frame = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                raise SynthesisProtocolError(
                    f"synthesis session sent a non-JSON frame: {raw!r}"
                ) from None
            if not isinstance(frame, Mapping):
                raise SynthesisProtocolError(
                    f"synthesis session sent a non-object frame: {frame!r}"
                )
            if frame.get("type") == "Error":
                code = frame.get("error_code")
                raise self._fail(
                    classify_tts(code),
                    f"Error {code}: {frame.get('error')}",
                )
            if frame.get("type") == "WordBoundaries":
                self._record_word_boundaries(frame)
                continue
            return frame

    def _read_begin(self, raw: Any) -> Mapping[str, Any]:
        try:
            frame = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raise SynthesisHandshakeError(
                f"synthesis session opened with a non-JSON frame: {raw!r}"
            ) from None
        if not isinstance(frame, Mapping):
            raise SynthesisHandshakeError(
                f"synthesis session opened with a non-object frame: {frame!r}"
            )
        if frame.get("type") == "Error":
            raise SynthesisHandshakeError(
                "synthesis session refused before Begin: "
                f"Error {frame.get('error_code')}: {frame.get('error')}"
            )
        if frame.get("type") != "Begin":
            raise SynthesisHandshakeError(
                "synthesis session's first frame is not Begin: "
                f"{frame.get('type')!r}"
            )
        return frame


async def _close_quietly(socket: Any) -> None:
    """Close a socket that must not stay open; a close failure is not the story."""
    try:
        await socket.close()
    except Exception:
        pass
