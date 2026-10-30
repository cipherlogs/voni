"""AssemblyAI streaming synthesis: connect, the Begin echo, keepalive, expiry.

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

Each ``FlushDone`` is an audio-integrity checkpoint: its
``audio_duration_ms`` must agree with the bytes received for that request at
the session's own rate and sample width, or the call fails as audio loss and
the delta is recorded. The rate is the one ``Begin`` echoed and the width is
the encoding's, so the phone leg is measured as 8 kHz mu-law rather than as the
browser's 24 kHz 16-bit; an ``Audio`` frame that ends mid-sample is refused.

One socket carries one synthesis session; a dropped one is replaced at most
once per call. ``speak`` sends one request per sentence and flushes the first
sentence immediately; ``Cancel`` stops in-flight synthesis, drops the old
request's frames until the vendor acknowledges, and reads the next ``flush_id``
from the wire; ``terminate`` takes the implicit flush and the billing record;
and ``handle_close`` turns a close code into a failure reconnect that resumes
from the first unheard point, a planned reconnect between turns, or a visible
call failure. There is no second voice vendor.

A caller pause between turns sends no audio, and an idle session closes after
the registry's idle timeout. ``keepalive_if_idle`` is the idle seam the turn
loop ticks: it sends one ``KeepAlive`` per interval (never while a reply is in
flight, never during audio), spends it from the session's own control-frame
budget, sheds it rather than tripping a pacing close, and reports a missed one
as the voice failure it is instead of a silent gap. ``Begin.expires_at`` is
armed as a deadline: a session that reaches it hands over at a sentence
boundary — the reply in flight drains and the new session opens between turns,
never mid-sentence.
"""

from __future__ import annotations

import base64
import json
import math
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

from cascade.failures import (
    SESSION_LIMIT,
    FailureClass,
    FailureVerdict,
    classify_tts,
)
from cascade.reconnect import ReconnectAction, ReconnectBudget
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

#: The idle-keepalive cadence, from the one threshold registry: a ``KeepAlive``
#: this often keeps a paused session inside the vendor's idle timer, and the
#: interval sits strictly below that timer. The number is never restated here.
KEEPALIVE_INTERVAL_S = float(require_bound("tts.keepalive_interval_ms")) / 1000.0

#: The vendor's idle close: a session with no frame in either direction for
#: this long is gone. A keepalive that misses it is a voice failure, never a
#: silent gap.
IDLE_TIMEOUT_S = float(require_bound("tts.idle_timeout_ms")) / 1000.0

#: How far the vendor's reported flush duration may sit from the duration the
#: received bytes actually are, from the one threshold registry.
AUDIO_LOSS_TOLERANCE_MS = float(require_bound("tts.audio_loss_tolerance_ms"))

#: Bytes per sample for every encoding a transport carries. ``pcm_mulaw`` is
#: one byte per sample, so an even byte count is not what makes it whole.
ENCODING_SAMPLE_BYTES: Mapping[str, int] = MappingProxyType(
    {"pcm_s16le": 2, "pcm_mulaw": 1}
)

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

    @property
    def bytes_per_sample(self) -> int:
        """The sample width the encoding implies, never an assumed 16-bit."""
        try:
            return ENCODING_SAMPLE_BYTES[self.encoding]
        except KeyError:
            raise UnknownEncodingError(self.encoding) from None


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


class UnknownEncodingError(LookupError):
    """No sample width is defined for the encoding."""

    def __init__(self, encoding: str) -> None:
        self.encoding = encoding
        known = ", ".join(sorted(ENCODING_SAMPLE_BYTES))
        super().__init__(
            f'unknown synthesis encoding "{encoding}": no sample width is '
            f"defined for it (known encodings: {known})"
        )


class SynthesisHandshakeError(RuntimeError):
    """The session did not open with a ``Begin`` frame."""


class SynthesisProtocolError(RuntimeError):
    """A frame that cannot be read, or a socket that closed mid-request."""


class SynthesisSocketClosed(SynthesisProtocolError):
    """The socket ended while a request was in flight: a dropped session.

    A dropped session is retryable (the reply resumes from the first unheard
    point); a frame the adapter cannot read is not. The two are separate types
    so a malformed frame can never be retried as an outage.
    """

    def __init__(self, code: Any = None, reason: str = "") -> None:
        self.code = code
        self.reason = reason
        detail = "" if code is None else f" (code {code!r}: {reason})"
        super().__init__(
            f"synthesis socket closed while a request was in flight{detail}"
        )


class PartialSampleError(SynthesisProtocolError):
    """An ``Audio`` frame that ends in the middle of a sample.

    Whole samples only: a trailing half sample is a corrupt frame, not audio to
    decode leniently.
    """

    def __init__(
        self, *, byte_count: int, bytes_per_sample: int, encoding: str
    ) -> None:
        self.byte_count = byte_count
        self.bytes_per_sample = bytes_per_sample
        self.encoding = encoding
        super().__init__(
            f"Audio frame carries {byte_count} bytes, which is not a whole "
            f"number of {bytes_per_sample}-byte {encoding} samples: whole "
            "samples only"
        )


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


@dataclass(frozen=True)
class AudioLoss:
    """One request whose received bytes disagree with the vendor's duration.

    ``delta_ms`` is derived minus reported: negative means audio is missing,
    positive means more bytes arrived than the vendor accounted for.
    """

    flush_id: int | None
    reported_ms: int
    derived_ms: float
    delta_ms: float
    tolerance_ms: float
    audio_bytes: int


class AudioLossError(SynthesisCallFailure):
    """The bytes received for one flush are not the audio the vendor reported.

    Dropped audio is a fact once the two accounts disagree, so the call fails
    visibly instead of playing a reply with a hole in it. The delta is recorded
    on the call (``audio_losses``) and on the error.
    """

    def __init__(
        self, *, loss: AudioLoss, verdict: FailureVerdict, stage: str
    ) -> None:
        self.loss = loss
        super().__init__(
            verdict=verdict,
            stage=stage,
            reason=(
                f"audio loss at flush {loss.flush_id}: the vendor reported "
                f"{loss.reported_ms} ms, but {loss.audio_bytes} bytes are "
                f"{loss.derived_ms:.3f} ms at the session's rate and sample "
                f"width (delta {loss.delta_ms:+.3f} ms, tolerance "
                f"{loss.tolerance_ms:g} ms): the call ends rather than plays "
                "audio with a hole in it"
            ),
        )


class CloseAction(str, Enum):
    """What one close means for the call."""

    CLEAN = "clean"
    RETRY = "retry"
    PLANNED_RECONNECT = "planned_reconnect"
    FAIL = "fail"


class KeepaliveAction(str, Enum):
    """What one idle tick did, or refused to do.

    ``BUSY`` is a reply in flight: its own frames are traffic, so a keepalive
    would be both unnecessary and an interleaved control frame. ``SHED`` is a
    keepalive the session's control-frame budget could not carry; it is retried
    on the next tick, never sent blindly. ``MISSED`` is an idle past the
    vendor's close: the one failure reconnect has already been taken. ``EXPIRED``
    means there is no live session to keep alive — the next turn opens one.
    """

    SENT = "sent"
    NOT_DUE = "not_due"
    BUSY = "busy"
    SHED = "shed"
    MISSED = "missed"
    EXPIRED = "expired"


@dataclass(frozen=True)
class CloseDecision:
    """A close that does not end the call, and why.

    ``resume`` is the session's located point when the close happened during a
    reply, and ``resume_text`` is exactly what remains to be synthesized: the
    unheard tail of the request at the cut plus every sentence not yet sent.
    """

    verdict: FailureVerdict
    action: CloseAction
    retried: bool = False
    resume: ResumePoint | None = None
    resume_text: str = ""

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
    derived_audio_duration_ms: float | None = None
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


@dataclass
class _ReplyProgress:
    """How far one reply's audio reached the client before the session died.

    ``delivered_ms`` is the audio handed to the consumer, which is the furthest
    point the caller can have heard: it is the position a reconnect resumes
    from, never the audio the vendor merely sent. ``index`` is the sentence
    being spoken (every earlier sentence was fully delivered, because a
    ``FlushDone`` only arrives after all of its audio).
    """

    chunks: tuple[str, ...]
    index: int = 0
    sent: bool = False
    current_has_request: bool = False
    delivered_ms: float = 0.0

    @property
    def chunk(self) -> str:
        """The sentence currently being synthesized."""
        return self.chunks[self.index]


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
        wall_clock: Callable[[], float] | None = None,
        alert: Callable[[FailureVerdict, str], None] | None = None,
        ledger: Any = None,
        budget: ReconnectBudget | None = None,
    ) -> None:
        self.binding: VoiceBinding = bind_voice(voice_id)
        self.format: TransportFormat = transport_format(transport)
        self.model_id = MODEL_ID
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        self._socket_factory = socket_factory or _default_socket_factory
        # ``clock`` is the session's own (monotonic) time: pacing, intervals and
        # the expiry deadline. ``wall_clock`` only interprets the vendor's epoch
        # ``expires_at``, which is not comparable with a monotonic clock.
        self._clock = clock or time.monotonic
        self._wall_clock = wall_clock or time.time
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
        # Idle keepalive and session expiry (ticket 53): the idle timer restarts
        # on any frame in either direction, and the deadline is the session's
        # own ``expires_at`` measured from the wall clock at connect.
        self.last_frame_at: float = self._clock()
        self.keepalives_sent: int = 0
        self.expiry_deadline: float | None = None
        # Send-time facts the pacing guard and the call ledger read.
        self.control_frame_times: list[float] = []
        self.control_frames_sent = 0
        self.flush_id: int | None = None
        self.audio_bytes: int = 0
        # Audio integrity (ticket 50): every flush is checked against its bytes.
        self.audio_losses: list[AudioLoss] = []
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
        # Close policy (ticket 55) and recovery (ticket 97): the ticket-94
        # budget owns the one failure reconnect and the planned bucket, so the
        # adapter keeps no retry counter of its own.
        self._budget = budget or ReconnectBudget(ledger=ledger, now=self._clock)
        self.failures: list[FailureVerdict] = []
        self.alerts: list[tuple[FailureVerdict, str]] = []
        self.breaker_opens: list[FailureVerdict] = []
        self.reconnects = 0
        self.needs_reconnect = False
        self._reply: _ReplyProgress | None = None
        #: Requests from sessions that have ended, kept as the played record.
        #: A new session restarts ``flush_id``, so the current map cannot hold
        #: both sessions without two requests sharing one id.
        self.closed_sessions: list[dict[int, SynthesisRequest]] = []

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
        self._arm_expiry()
        self._touch()

    def _arm_expiry(self) -> None:
        """Turn ``expires_at`` into a deadline on the session's own clock.

        ``expires_at`` is epoch seconds, so it is compared with the wall clock
        exactly once, at connect, and the remaining lifetime is projected onto
        the monotonic clock every interval and expiry rule already use. An
        ``expires_at`` already behind the wall clock cannot be scheduled as a
        future deadline: the vendor's own close reports it, and inventing an
        immediate drain would cut a reply the vendor may still be serving.
        """
        if self.expires_at is None:
            self.expiry_deadline = None
            return
        remaining = float(self.expires_at) - float(self._wall_clock())
        self.expiry_deadline = (
            self._clock() + remaining if remaining > 0 else None
        )

    def _touch(self) -> None:
        """Restart the idle timer: the vendor counts frames in either direction."""
        self.last_frame_at = self._clock()

    @property
    def idle_seconds(self) -> float:
        """How long the session has been silent, in either direction."""
        return max(0.0, self._clock() - self.last_frame_at)

    @property
    def expired(self) -> bool:
        """Whether the session has reached the ``expires_at`` it announced."""
        return (
            self.expiry_deadline is not None
            and self._clock() >= self.expiry_deadline
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

        A socket that dies mid-reply is the one failure reconnect (ticket 94):
        the audio already delivered is kept and the remaining reply is spoken
        on a new session from the first unheard point, so a sentence the caller
        heard is never spoken twice. ``3008`` is not a failure: the reply
        drains and the new session opens at the next reply, never mid-sentence.
        Reaching ``Begin.expires_at`` is the same planned handover: it is
        checked between sentences, so a sentence is never cut in half.
        """
        chunks = schedule(text)
        if not chunks:
            return
        await self._expire_if_due()
        if self.needs_reconnect:
            # A planned expiry drains the current reply and opens the new
            # session between turns, never mid-sentence.
            await self._reopen()
        self._require_open()
        progress = _ReplyProgress(chunks=chunks)
        self._reply = progress
        generation = self._cancel_generation
        self._pending_characters = sum(len(chunk) for chunk in chunks[1:])
        try:
            while progress.index < len(progress.chunks):
                try:
                    if not progress.sent:
                        await self._send_request(progress.chunk)
                        progress.sent = True
                    frame = await self._next_frame(generation)
                except Exception as error:
                    if not _is_socket_close(error):
                        raise
                    resumed = await self._recover(
                        getattr(error, "code", None),
                        str(getattr(error, "reason", "") or ""),
                    )
                    if resumed is None:
                        return
                    progress = resumed
                    self._reply = progress
                    generation = self._cancel_generation
                    self._pending_characters = sum(
                        len(chunk) for chunk in progress.chunks[1:]
                    )
                    continue
                if frame is None:
                    return
                kind = frame.get("type")
                if kind == "Audio":
                    pcm = self._decode_audio(frame)
                    self.audio_bytes += len(pcm)
                    request = self._request_for(
                        frame.get("flush_id"), text=progress.chunk
                    )
                    request.audio_bytes += len(pcm)
                    progress.current_has_request = True
                    progress.delivered_ms += self.audio_duration_ms_for(len(pcm))
                    yield SentenceAudio(
                        pcm=pcm,
                        sample_rate=self.audio_sample_rate,
                        text=progress.chunk,
                    )
                elif kind == "FlushDone":
                    self._record_flush_done(frame, text=progress.chunk)
                    progress.index += 1
                    progress.sent = False
                    progress.current_has_request = False
                    if progress.index >= len(progress.chunks):
                        self._pending_characters = 0
                        return
                    self._pending_characters = sum(
                        len(chunk) for chunk in progress.chunks[progress.index + 1 :]
                    )
                    if await self._expire_if_due():
                        # This sentence is fully delivered; the handover happens
                        # before the next one is sent, never inside a sentence.
                        await self._reopen()
                        generation = self._cancel_generation
                elif kind == "Termination":
                    return
        finally:
            if self._reply is progress:
                self._reply = None

    async def speak_greeting(self, text: str) -> AsyncIterator[SentenceAudio]:
        """Speak the body's greeting line, first sentence flushed immediately.

        A greeting goes through the same scheduler as a reply: one
        ``Generate`` + ``Flush``, split at sentence boundaries. A greeting that
        is never flushed is a bug, so there is no separate unflushed path. A
        dropped session gets the one failure reconnect like a reply; a second
        failure ends the call visibly with ``stage="greeting"``, because there
        is no silent opening.
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

    @property
    def bytes_per_sample(self) -> int:
        """The session's sample width, from the encoding it was opened with.

        ``Begin`` asserts the echoed encoding equals this one (ticket 48), so
        the wire bytes and the width cannot disagree once the call is open.
        """
        return self.format.bytes_per_sample

    def audio_duration_ms_for(self, audio_bytes: int) -> float:
        """How long ``audio_bytes`` is at the session's own rate and width."""
        return audio_bytes / (self.audio_sample_rate * self.bytes_per_sample) * 1000

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
        self._touch()

    def _control_limit(self) -> float | None:
        """The session's own frame-rate budget, or ``None`` when it named none."""
        limit = self.limits.get("max_control_frames_per_sec")
        if isinstance(limit, bool) or not isinstance(limit, (int, float)):
            return None
        return float(limit) if limit > 0 else None

    def _prune_control_window(self) -> None:
        """Keep only the frames that matter: a long call must not grow unbound."""
        now = self._clock()
        self.control_frame_times = [
            moment
            for moment in self.control_frame_times
            if now - moment < CONTROL_WINDOW_S
        ]

    def _would_exceed_control_budget(self) -> bool:
        """Whether one more control frame would be the (limit+1)th in the window."""
        limit = self._control_limit()
        if limit is None:
            return False
        self._prune_control_window()
        return len(self.control_frame_times) + 1 > limit

    def _check_control_budget(self) -> None:
        """Refuse to send a frame the session would answer with ``3010``."""
        limit = self._control_limit()
        if limit is None:
            return
        self._prune_control_window()
        now = self._clock()
        if len(self.control_frame_times) >= limit:
            failure = ControlFramePacingError(
                float(limit), len(self.control_frame_times), now
            )
            self.failures.append(failure.verdict)
            self._alert(failure.verdict, str(failure))
            raise failure

    async def handle_close(
        self, code: Any = None, *, reason: str = ""
    ) -> CloseDecision:
        """Classify one close and act on it.

        ``3008`` and the expiry sentinel are planned reconnects: the current
        reply drains (its unheard tail is abandoned rather than reconnected
        mid-sentence) and the next reply opens a new session. A trigger is the
        one failure reconnect (ticket 94): the reply continues on a new session
        from the first unheard point, so audio already played is never spoken
        again, and a second trigger ends the call visibly. A configuration or
        pacing close is our bug: the call fails, an alert fires, and the voice
        leg's breaker is left closed.
        """
        verdict = classify_tts(code)
        where = f"synthesis close {code!r}" + (f" ({reason})" if reason else "")
        if verdict.failure_class is FailureClass.PLANNED_RECONNECT:
            await self._close_socket()
            # The planned bucket is separate: expiry never spends the failure
            # reconnect, so a later outage still gets its one recovery.
            self._budget.planned("tts", code=verdict.code)
            self.needs_reconnect = True
            return CloseDecision(verdict=verdict, action=CloseAction.PLANNED_RECONNECT)
        if verdict.failure_class is FailureClass.DO_NOT_OPEN:
            await self._close_socket()
            if code == 1000:
                return CloseDecision(verdict=verdict, action=CloseAction.CLEAN)
            raise self._fail(verdict, f"{where}: {verdict.reason}")
        # Capture where the reply got to before the old session is replaced.
        resume, resume_text = self._unheard_point()
        decision = self._budget.failed(verdict)
        if decision.action is ReconnectAction.RECONNECT:
            self.failures.append(verdict)
            await self._reopen()
            return CloseDecision(
                verdict=verdict,
                action=CloseAction.RETRY,
                retried=True,
                resume=resume,
                resume_text=resume_text,
            )
        failure = self._fail(
            verdict, f"{where}: {verdict.reason}; {decision.reason}"
        )
        await self._close_socket()
        raise failure

    async def _expire_if_due(self) -> bool:
        """Hand the session over at ``Begin.expires_at``, at a safe boundary.

        The expiry is a planned reconnect: the reply in flight drains (no frame
        is sent after the call site validates the boundary), the old socket is
        closed, and the next sentence or turn opens a new session. It never
        spends the failure reconnect and never opens the voice leg's breaker.
        """
        if not self.expired or self._socket is None:
            return False
        await self.handle_close(SESSION_LIMIT)
        return True

    async def keepalive_if_idle(self) -> KeepaliveAction:
        """One idle tick: keep a paused synthesis session open, or say why not.

        The idle seam the turn loop calls between turns. A ``KeepAlive`` goes
        out only when the session has been silent for the registry's interval,
        only when no reply is in flight (audio frames are themselves traffic),
        and only when the session's control-frame budget can carry it. A tick
        that finds the session idle past the vendor's close reports the missed
        keepalive through the close policy, so it is a voice failure with the
        one reconnect, never a silent gap. At ``expires_at`` the session is
        handed over instead of kept alive.
        """
        if self._socket is None:
            if self.needs_reconnect:
                return KeepaliveAction.EXPIRED
            raise RuntimeError("the synthesis session is not open")
        if self._reply is not None:
            # A reply in flight is not idle: its own frames restart the idle
            # timer, and a keepalive would interleave with audio.
            return KeepaliveAction.BUSY
        idle = self.idle_seconds
        if idle >= IDLE_TIMEOUT_S:
            await self._keepalive_missed(idle)
            return KeepaliveAction.MISSED
        if await self._expire_if_due():
            return KeepaliveAction.EXPIRED
        if idle < KEEPALIVE_INTERVAL_S:
            return KeepaliveAction.NOT_DUE
        if self._would_exceed_control_budget():
            # A housekeeping frame must not trip the session's 3010 pacing
            # close: shed it and try again on the next tick.
            return KeepaliveAction.SHED
        await self._send_control({"type": "KeepAlive"})
        self.keepalives_sent += 1
        return KeepaliveAction.SENT

    async def _keepalive_missed(self, idle: float) -> None:
        """Report an idle session past the vendor's close as the failure it is.

        The keepalive exists so this cannot happen while the tick runs. If it
        did (the loop stalled, or every keepalive was shed), the session is
        gone: go through the close policy with the abnormal close an idle
        session produces, taking the one failure reconnect, and let a second
        miss end the call visibly rather than leave a silent gap.
        """
        await self.handle_close(
            1006,
            reason=(
                f"keepalive missed: the session was idle {idle:.1f}s, past the "
                f"{IDLE_TIMEOUT_S:g}s idle close"
            ),
        )

    async def _recover(self, code: Any, reason: str = "") -> _ReplyProgress | None:
        """Act on a socket that died while synthesis was being spoken.

        The reply or greeting takes the one failure reconnect and continues
        from its first unheard point; a planned expiry returns ``None`` (the
        current synthesis drains and the next turn opens the session), and a
        second failure raises through :meth:`handle_close`.
        """
        decision = await self.handle_close(code, reason=reason)
        if decision.action is CloseAction.PLANNED_RECONNECT:
            return None
        if decision.action is CloseAction.CLEAN:
            # The vendor ended the session normally mid-call: the current
            # synthesis is over and the next turn needs a session of its own.
            self.needs_reconnect = True
            return None
        resumed = schedule(decision.resume_text)
        if not resumed:
            return None
        return _ReplyProgress(chunks=resumed)

    def _unheard_point(self) -> tuple[ResumePoint | None, str]:
        """The first point of the reply the caller has not heard, and its text.

        The position is the audio handed to the consumer, not what the vendor
        sent, so it cannot claim a word was heard because it was transmitted.
        The located point uses this session's own timings and word boundaries;
        the sentences not yet sent follow it. Empty text means the whole reply
        was delivered before the socket died.
        """
        progress = self._reply
        if progress is None:
            return None, ""
        if progress.index >= len(progress.chunks):
            return None, ""
        unsent = "".join(progress.chunks[progress.index + 1 :])
        if not progress.current_has_request:
            # No frame of this sentence arrived: the whole sentence is unheard.
            return None, "".join(progress.chunks[progress.index :])
        timeline = self._timeline()
        spoken = progress.index + 1
        start = timeline[-spoken][1] if len(timeline) >= spoken else 0.0
        try:
            point = self.resume_point(start + progress.delivered_ms)
        except ValueError:
            point = None
        tail = "" if point is None else point.text
        # The located tail is token-joined (no trailing whitespace), so each
        # piece is trimmed and the unsent sentences are separated by one space.
        text = " ".join(
            part.strip() for part in (tail, unsent) if part.strip()
        )
        return point, text

    @property
    def retry_allowed(self) -> bool:
        """Whether a trigger close may open a new session.

        One per call, from the ticket-94 budget. Audio already delivered no
        longer refuses the retry: the reply resumes from the first unheard
        point instead of replaying what was heard.
        """
        return (
            self._budget.counters("tts").budget_left > 0
            and self._socket is not None
        )

    @property
    def reconnect_budget(self) -> ReconnectBudget:
        """The call's one reconnect ledger (ticket 94); the adapter never counts."""
        return self._budget

    async def _reopen(self) -> None:
        """Replace the failed session with a new one, asserting its Begin too.

        A new session restarts its ``flush_id`` numbering, so the old session's
        requests are archived instead of being overwritten: the played record
        is kept, and the current session's timeline can never mix two sessions.
        """
        await self._close_socket()
        if self.requests:
            self.closed_sessions.append(dict(self.requests))
        self.requests = {}
        self.request_order = []
        self.flush_id = None
        self.word_boundaries_status = None
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
        return self._record_failure(verdict, failure)

    def _record_failure(
        self, verdict: FailureVerdict, failure: SynthesisCallFailure
    ) -> SynthesisCallFailure:
        """Book-keep a call-ending failure and return it for raising."""
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
        # What the request's received bytes are, at this session's own rate and
        # sample width. Recorded even when the vendor reports no duration.
        request.derived_audio_duration_ms = self.audio_duration_ms_for(
            request.audio_bytes
        )
        duration = frame.get("audio_duration_ms")
        if isinstance(duration, int):
            request.audio_duration_ms = duration
            self._assert_audio_intact(request)

    def _assert_audio_intact(self, request: SynthesisRequest) -> None:
        """Fail the call when the flush's bytes and reported duration disagree.

        The vendor's duration is the independent account; the bytes we hold are
        ours. A difference beyond the named tolerance means audio was lost (or
        duplicated), and a reply with a hole in it must not be played.
        """
        derived = request.derived_audio_duration_ms
        if request.audio_duration_ms is None or derived is None:
            return
        delta = derived - request.audio_duration_ms
        if abs(delta) <= AUDIO_LOSS_TOLERANCE_MS:
            return
        loss = AudioLoss(
            flush_id=request.flush_id,
            reported_ms=request.audio_duration_ms,
            derived_ms=derived,
            delta_ms=delta,
            tolerance_ms=AUDIO_LOSS_TOLERANCE_MS,
            audio_bytes=request.audio_bytes,
        )
        self.audio_losses.append(loss)
        # 3005 is the vendor's own "no output while a FlushDone was owed";
        # bytes missing from a flush are the same fact seen from our side.
        verdict = classify_tts(3005)
        failure = AudioLossError(loss=loss, verdict=verdict, stage=self._stage)
        raise self._record_failure(verdict, failure)

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
        self._touch()
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
                # Attribute the implicit flush's audio to its request, so the
                # final FlushDone is checked against the bytes it produced.
                self._request_for(frame.get("flush_id")).audio_bytes += len(pcm)
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
        """Each request with its start and end on the session's audio timeline.

        A request with no ``FlushDone`` yet is the session's open tip: its end
        is unknown, so it extends past every position rather than counting as
        zero-length audio. An unfinished *older* request keeps a zero length,
        because the position it would otherwise swallow belongs to a later
        reply.
        """
        timeline: list[tuple[SynthesisRequest, float, float]] = []
        cursor = 0.0
        last = len(self.request_order) - 1
        for index, key in enumerate(self.request_order):
            request = self.requests[key]
            start = request.audio_start_ms
            if start is None:
                start = cursor
            if request.audio_duration_ms is None:
                end = math.inf if index == last else start
            else:
                end = start + request.audio_duration_ms
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
            pcm = base64.b64decode(payload)
        except ValueError:
            raise SynthesisProtocolError(
                "Audio frame carries a payload that is not base64"
            ) from None
        width = self.bytes_per_sample
        if len(pcm) % width:
            raise PartialSampleError(
                byte_count=len(pcm),
                bytes_per_sample=width,
                encoding=self.format.encoding,
            )
        return pcm

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
                raise SynthesisSocketClosed() from None
            # A frame in either direction restarts the vendor's idle timer.
            self._touch()
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


def _is_socket_close(error: BaseException) -> bool:
    """Whether one error is a dropped session, not an unreadable frame.

    A vendor close (``websockets`` and the ticket-01 scripted socket both carry
    ``.code``) and a socket that simply ended are retryable; a frame the
    adapter cannot read is our bug and must never be retried as an outage.
    """
    if isinstance(error, SynthesisProtocolError):
        return isinstance(error, SynthesisSocketClosed)
    return isinstance(getattr(error, "code", None), int)


async def _close_quietly(socket: Any) -> None:
    """Close a socket that must not stay open; a close failure is not the story."""
    try:
        await socket.close()
    except Exception:
        pass
