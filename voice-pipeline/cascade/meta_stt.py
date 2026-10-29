"""Meta realtime speech-to-text backend: handshake, audio, events, end (26-30).

The credential travels inside the handshake frame (``authorization.accessToken``)
because the vendor ignores the ``Authorization`` header; the handshake also
declares the one encoding, model, endpointing mode and partial shape the cascade
reads. The socket factory is injected, so every test replays recorded frames and
no test opens a real socket.

Session identity is a query parameter built from the call id and a local session
epoch, never a secret. The acknowledgement is a text frame without a ``type``
field; any other frame arriving before it is a protocol error, and no audio
leaves the client before the ack. The wait for that acknowledgement is bounded
by ``stt.handshake_ms`` (the registry, not a literal); a missing ack fails
visibly and records the reason, and a close during the wait is classified
through the shared speech-leg table so the caller can open the leg.

Audio is raw s16le mono at 24 kHz only, paced by a 5 s lead budget with PCM
silence filling the gaps, and never awaits a vendor reply. Events map onto
distinct start/partial/end/complete types; only ``endStream`` may follow the
handshake, at a deliberate end that drains and waits for the normal close.

A close on an established session is classified by the shared speech-leg table
(:mod:`cascade.failures`) and acted on by :meth:`MetaStreamingSTT.handle_close`:
``1000`` is normal, ``1008`` fails the call visibly and alerts without touching
the leg's breaker, ``1011`` (and a close with no code, which is the same thing)
retries once with a new session, and ``1013`` refuses to retry, opens the
speech leg through the ticket-22 ``CallRungs`` seam and fails visibly. A
``1011`` whose reason is the vendor's max session duration is a planned
reconnect: a new session, no failure recorded, no retry budget spent.

Session lifetime belongs to the vendor: a realtime session runs up to
``stt.session_max_ms`` (60 minutes) and has no resume token. The adapter
replaces the socket before that bound at a ``speechComplete`` boundary, and the
replacement handshake (bounded by ``stt.handshake_ms``) is the margin, so no
second number is invented. An idle-input close is a session end too, never an
audio-path error; the client's PCM silence is what normally prevents it. Every
session end — normal, lifetime, idle, dropped, deliberate or failed — is
recorded in the speech-session ledger (:class:`SessionEnding`), because a
dropped socket and our deliberate end both stop input but only the deliberate
end drains, sends ``endStream`` and reads to the vendor's ``1000``.

Turns can overlap: a later ``speechStart`` may arrive before an earlier
``speechComplete``. The adapter keeps one :class:`cascade.turn_state.TurnState`
per ``(session epoch, provider turnId)``, so both turns stay distinct and a
partial — which carries no ``turnId`` — lands on the most recent start. Every
event is stamped with the local session epoch, which the adapter owns and bumps
on every new socket. A late event from a replaced session is counted and logged,
then ignored; a vendor ``turnId`` reused after a reconnect cannot collide with
the old turn.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol
from urllib.parse import urlencode

from cascade.failures import (
    SESSION_LIMIT,
    FailureClass,
    FailureVerdict,
    classify_stt,
)
from cascade.testing.clock import RealClock
from cascade.thresholds import require_bound
from cascade.turn_state import TurnPhase, TurnState, TurnStateStore
from cascade.voice_binding import LOCALES
from providers import FinalTranscript, PartialTranscript, StreamingSTT

_log = logging.getLogger(__name__)

#: The registry bound that caps the wait for the acknowledgement (ticket 27).
HANDSHAKE_BOUND = "stt.handshake_ms"

#: The vendor's realtime session length (ticket 32). A planned reconnect must
#: land before it; there is no resume token, so a new socket is a new session.
SESSION_MAX_BOUND = "stt.session_max_ms"

REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime"
MODEL = "muse-voice-transcribe-1.0"
AUDIO_ENCODING = "PCM_24KHZ"
MODE = "ENDPOINTING"
PARTIAL_MODE = "CUMULATIVE"
EMIT_AUDIO_PROGRESS = False
SAMPLE_RATE = 24000
API_KEY_ENV = "META_API_KEY"

BYTES_PER_SAMPLE = 2
BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE

#: A silence frame is one 20 ms tick at the declared rate. This is the frame
#: quantum, not a tunable bound: the browser and phone transports tick in 20 ms
#: frames and the vendor's idle close fires on a stream with no frames at all.
SILENCE_FRAME_MS = 20.0
SILENCE_FRAME_BYTES = int(BYTES_PER_SECOND * SILENCE_FRAME_MS / 1000)

#: The spec's hard audio lead: "Never run more than 5 s ahead of processing"
#: (`.scratch/meta-cascade/spec.md`, Meta speech-to-text backend). A backlog
#: beyond this is the vendor's 1008 close, so the client sheds before it.
MAX_LEAD_S = 5.0

#: Container signatures that are never raw PCM. A text payload (JSON/base64)
#: is refused by type before this check.
_CONTAINERS = (
    (b"RIFF", "WAV/AVI"),
    (b"OggS", "Ogg"),
    (b"fLaC", "FLAC"),
    (b"ID3", "MP3/ID3"),
    (b"\x1aE\xdf\xa3", "Matroska/WebM"),
)

#: The only client text frame after the handshake (spec, Meta STT: "Text
#: frames"). There is no ForceEndpoint, no UpdateConfiguration and no per-turn
#: commit, so nothing else may be built here.
END_STREAM_FRAME = json.dumps({"type": "endStream"})

#: Close reasons that mean the 60-minute session limit, not an outage. The
#: vendor sends a free-text reason, so this is the one place the text is read;
#: the code itself is still classified by :func:`cascade.failures.classify_stt`.
_MAX_DURATION_REASONS = (
    "max session duration",
    "maximum session duration",
    "max duration",
    "session duration limit",
    "session duration exceeded",
)

#: Close reasons that mean the vendor ended a session for lack of input. The
#: client sends PCM silence during a pause so this should not fire; when it
#: does, it is a session end, never an audio-path error.
_IDLE_REASONS = (
    "idle",
    "no audio",
    "no input",
    "inactivity",
)

SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]


class SpeechLegFailures(Protocol):
    """The live call's breaker seam (``cascade.ladders.CallRungs``).

    Structurally what :meth:`cascade.ladders.CallRungs.failed` exposes: a
    durable write for the speech leg, frozen for this call. The backend never
    learns the ladder or the store.
    """

    async def failed(
        self,
        leg: str,
        *,
        verdict: FailureVerdict,
        phase: str,
        turn: int | None = None,
    ) -> Any: ...


class CloseAction(str, Enum):
    """What one speech close means for the call."""

    CLEAN = "clean"
    RETRY = "retry"
    PLANNED_RECONNECT = "planned_reconnect"
    FAIL = "fail"


@dataclass(frozen=True)
class CloseDecision:
    """A close that a new session survived, and why."""

    verdict: FailureVerdict
    action: CloseAction
    retried: bool = False
    backoff: bool = False


class SessionEndKind(str, Enum):
    """Why a speech session stopped taking input.

    A planned reconnect (the 60-minute limit) and an idle close are session
    ends, never failures. A dropped socket also ends input, but it is not our
    deliberate end: no ``endStream`` could be sent on it. The difference has to
    survive the call, so it is recorded rather than inferred later.
    """

    NORMAL = "normal"
    LIFETIME = "lifetime"
    IDLE = "idle"
    DROPPED = "dropped"
    DELIBERATE = "deliberate"
    FAILED = "failed"


@dataclass(frozen=True)
class SessionEnding:
    """One entry in the speech-session ledger.

    ``planned`` is true for a session end that must not count as a failure:
    the lifetime limit and the idle close. ``end_stream_sent`` is true only
    when the deliberate end drained, sent ``endStream`` and read the vendor's
    close on this session.
    """

    epoch: int
    kind: SessionEndKind
    code: int | str | None
    reason: str
    at: float
    planned: bool = False
    end_stream_sent: bool = False


class SpeechCallFailure(RuntimeError):
    """A speech failure that ends the call, visibly.

    There is no mid-call handover to the other rung, so ``fallback`` is always
    ``None`` and ``call_ended`` is always true. ``backoff`` is set for rate
    limiting (``1013``): the adapter will not reconnect immediately, and the
    next Meta session waits for the reconnect policy's backoff.
    """

    fallback = None

    def __init__(
        self,
        *,
        verdict: FailureVerdict,
        stage: str,
        reason: str,
        backoff: bool = False,
    ) -> None:
        self.verdict = verdict
        self.stage = stage
        self.reason = reason
        self.backoff = backoff
        self.visible = True
        self.call_ended = True
        super().__init__(
            f"{stage} speech failed ({verdict.failure_class.value}): {reason}"
        )


def _default_socket_factory(url: str, extra_headers: dict[str, str]) -> Awaitable[Any]:
    import websockets

    return websockets.connect(url, additional_headers=extra_headers)  # type: ignore[no-any-return]


class MetaHandshakeError(RuntimeError):
    """The speech session could not be established."""

    def __init__(self, session_id: str, reason: str) -> None:
        self.session_id = session_id
        self.reason = reason
        super().__init__(f"meta speech session {session_id}: {reason}")


class MetaHandshakeProtocolError(MetaHandshakeError):
    """A frame arrived before the acknowledgement that cannot be the ack."""


class MetaHandshakeTimeout(MetaHandshakeError):
    """No acknowledgement arrived inside the bounded handshake wait."""

    def __init__(self, session_id: str, timeout_s: float) -> None:
        self.timeout_s = timeout_s
        super().__init__(
            session_id,
            f"no acknowledgement within {timeout_s:g} s "
            f"(bound {HANDSHAKE_BOUND!r})",
        )


class MetaHandshakeClosed(MetaHandshakeError):
    """The socket closed while the session was still waiting for the ack."""

    def __init__(self, session_id: str, verdict: FailureVerdict) -> None:
        self.verdict = verdict
        code = "no code" if verdict.code is None else f"code {verdict.code}"
        super().__init__(
            session_id,
            f"socket closed during the handshake with {code} "
            f"({verdict.failure_class.value}: {verdict.reason})",
        )


class UnknownLanguageCodeError(ValueError):
    """A language code has no Locale, so it has no vendor language name."""

    def __init__(self, code: str) -> None:
        self.code = code
        known = ", ".join(sorted(LOCALES))
        super().__init__(
            f'unknown language code "{code}": the Locale catalogue speaks {known}'
        )


class UnsupportedSampleRateError(ValueError):
    """The client's sample rate does not match the declared audio encoding."""

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        super().__init__(
            f"meta speech session declares {AUDIO_ENCODING} and accepts "
            f"{SAMPLE_RATE} Hz frames, not {sample_rate} Hz"
        )


class MetaStreamError(RuntimeError):
    """The vendor reported an error on an established session."""

    def __init__(self, session_id: str, reason: str) -> None:
        self.session_id = session_id
        self.reason = reason
        super().__init__(f"meta speech session {session_id}: {reason}")


class AudioFrameRejected(ValueError):
    """A payload that must never reach the vendor as audio."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class SpeechStart:
    """``speechStart``: a provider turn opened, named by the vendor's turn id.

    ``session_epoch`` is the adapter's local session counter; with ``turn_id``
    it forms the logical turn identity a reconnect cannot reuse.
    """

    turn_id: str
    session_epoch: int = 0


@dataclass(frozen=True)
class SpeechEnd:
    """``speechEnd``: the provider's boundary. Records, never finalises."""

    turn_id: str
    session_epoch: int = 0


@dataclass(frozen=True)
class SpeechPartial(PartialTranscript):
    """``transcript``: cumulative text for the most recent start, epoch-stamped.

    It deliberately has no ``turnId``: the vendor does not send one, and the
    turn it belongs to is the adapter's most recent ``speechStart``.
    """

    session_epoch: int = 0


@dataclass(frozen=True)
class SpeechComplete(FinalTranscript):
    """``speechComplete``: the authoritative turn text.

    A ``FinalTranscript`` so existing turn handling reads it as the one final,
    with the provider ``turn_id`` and the local ``session_epoch`` added for the
    logical-turn store.
    """

    turn_id: str = ""
    session_epoch: int = 0


class MetaStreamingSTT(StreamingSTT):
    """StreamingSTT over Meta's realtime ASR endpoint."""

    def __init__(
        self,
        *,
        call_id: str,
        api_key: str | None = None,
        socket_factory: SocketFactory | None = None,
        keyterms: Iterable[str] = (),
        handshake_timeout_s: float | None = None,
        clock: Any = None,
        ledger: Any = None,
        leg_failures: SpeechLegFailures | None = None,
        alert: Callable[[FailureVerdict, str], None] | None = None,
    ) -> None:
        self._call_id = call_id
        self._api_key = api_key or os.environ.get(API_KEY_ENV)
        self._session_started_at: float | None = None
        self._session_endings: list[SessionEnding] = []
        self._socket_factory = socket_factory or _default_socket_factory
        self._keywords = keywords(keyterms)
        self._language_bias: tuple[str, ...] | None = None
        self._socket: Any = None
        self._frames: Any = None
        self._epoch = -1
        self._acked = False
        self._session = ""
        self._handshake_timeout_s = handshake_timeout_s
        self._failure_reason: str | None = None
        self._clock = clock if clock is not None else RealClock()
        self._ledger = ledger
        # The adapter owns the epoch; the store starts one below the first
        # session so ``open()`` advances both in lockstep to 0.
        self._turns = TurnStateStore(
            clock=self._clock, source="meta", start_epoch=-1
        )
        self._stale_events = 0
        self._audio_end = 0.0
        self._dropped_frames = 0
        self._last_close_code: int | None = None
        self._leg_failures = leg_failures
        self._alert_sink = alert
        self._retry_used = False
        self._needs_reconnect = False
        self._reconnects = 0
        self._failures: list[FailureVerdict] = []
        self._breaker_opens: list[FailureVerdict] = []
        self._alerts: list[tuple[FailureVerdict, str]] = []

    @property
    def dropped_frames(self) -> int:
        """Frames the audio path refused to forward (malformed or over lead)."""
        return self._dropped_frames

    @property
    def last_close_code(self) -> int | None:
        """The vendor's close code on the most recent session, if it sent one."""
        return self._last_close_code

    @property
    def epoch(self) -> int:
        """The current session epoch; every yielded event is stamped with it."""
        return self._epoch

    @property
    def turns(self) -> tuple[TurnState, ...]:
        """The adapter's logical turn state, in the order the provider opened it."""
        return self._turns.turns()

    @property
    def stale_events(self) -> int:
        """Events from a replaced session that were marked, logged and ignored."""
        return self._stale_events

    @property
    def failures(self) -> tuple[FailureVerdict, ...]:
        """Every classified failure this call saw, in order."""
        return tuple(self._failures)

    @property
    def breaker_opens(self) -> tuple[FailureVerdict, ...]:
        """The verdicts that asked the speech leg's durable record to open."""
        return tuple(self._breaker_opens)

    @property
    def alerts(self) -> tuple[tuple[FailureVerdict, str], ...]:
        """Bug-class failures a human must see (``1008`` and friends)."""
        return tuple(self._alerts)

    @property
    def reconnects(self) -> int:
        """New sessions opened after the first: a retry or a planned reconnect."""
        return self._reconnects

    @property
    def retry_used(self) -> bool:
        """Whether the one retryable close allowed per call has been spent."""
        return self._retry_used

    @property
    def needs_reconnect(self) -> bool:
        """True when a planned reconnect could not open a session immediately."""
        return self._needs_reconnect

    @property
    def retry_allowed(self) -> bool:
        """One retryable close may open a new session; a second one fails."""
        return not self._retry_used and self._socket is not None and self._acked

    @property
    def acked(self) -> bool:
        """Whether the current session's acknowledgement was received."""
        return self._acked

    @property
    def failure_reason(self) -> str | None:
        """The recorded reason the last session could not be established."""
        return self._failure_reason

    @property
    def session_ledger(self) -> tuple[SessionEnding, ...]:
        """How each speech session ended, in order (ticket 32).

        This is the speech half of the call ledger: it keeps the difference
        between a planned reconnect, an idle close, a dropped socket and our
        deliberate end, which the call-level counters do not carry.
        """
        return tuple(self._session_endings)

    @property
    def session_limit_s(self) -> float:
        """The vendor's session length, read from ``stt.session_max_ms``."""
        return float(require_bound(SESSION_MAX_BOUND)) / 1000.0

    @property
    def session_elapsed_s(self) -> float:
        """Seconds since the current session connected, on the injected clock."""
        if self._session_started_at is None:
            return 0.0
        return max(0.0, float(self._clock()) - self._session_started_at)

    @property
    def session_remaining_s(self) -> float:
        """Seconds left before the vendor's session limit."""
        return max(0.0, self.session_limit_s - self.session_elapsed_s)

    @property
    def turn_in_flight(self) -> bool:
        """Whether a provider turn has started and not yet been finalised.

        Turns may overlap, so a completed turn is not a boundary while a later
        ``speechStart`` still has no ``speechComplete``. A planned reconnect
        waits for that one too; cutting it would lose its audio mid-speech.
        """
        return any(
            state.phase in (TurnPhase.SPEAKING, TurnPhase.ENDPOINTED)
            for state in self._turns.turns()
        )

    @property
    def reconnect_due(self) -> bool:
        """Whether a planned reconnect can no longer wait for another turn.

        The margin is the bounded handshake (``stt.handshake_ms``): replacing
        the session only helps if the new one can be acknowledged before the
        old one's limit. No separate margin number exists, so none is invented.
        """
        return self._acked and self.session_remaining_s <= self.handshake_timeout_s

    @property
    def handshake_timeout_s(self) -> float:
        """The bounded wait for the ack: the registry bound, in seconds.

        Tests may inject a shorter bound, never a default. Production always
        reads ``stt.handshake_ms`` (ticket 27).
        """
        if self._handshake_timeout_s is not None:
            return float(self._handshake_timeout_s)
        return float(require_bound(HANDSHAKE_BOUND)) / 1000.0

    def __repr__(self) -> str:
        # The credential is deliberately absent from every representation.
        return (
            f"MetaStreamingSTT(call_id={self._call_id!r}, "
            f"epoch={self._epoch!r}, acked={self._acked!r})"
        )

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        """Connect, send the handshake as the first text frame, then wait for the ack.

        Nothing is awaited between connecting and sending, so the frame can never
        be delayed by the client. ``language_codes`` and ``keyterms`` are frozen
        on the first session start and reused on a later session (a reconnect is
        the same call, and the body is frozen for it); no method retunes them.
        The ack wait is bounded by ``stt.handshake_ms`` (ticket 27).
        """
        if self._socket is not None:
            raise RuntimeError("meta speech session is already open")
        if not self._api_key:
            raise RuntimeError(f"{API_KEY_ENV} is not configured")
        if sample_rate != SAMPLE_RATE:
            raise UnsupportedSampleRateError(sample_rate)

        if self._language_bias is None:
            self._language_bias = language_bias(language_codes)

        self._epoch += 1
        # The store's epoch is the logical-id half; the adapter decides when it
        # moves (a new socket, never a vendor frame).
        self._turns.new_epoch()
        session = session_id(self._call_id, self._epoch)
        self._session = session
        self._audio_end = float(self._clock())
        self._last_close_code = None
        url = f"{REALTIME_URL}?{urlencode({'sessionId': session})}"
        frame = {
            "authorization": {"accessToken": f"Bearer {self._api_key}"},
            "audioEncoding": AUDIO_ENCODING,
            "model": MODEL,
            "mode": MODE,
            "partialMode": PARTIAL_MODE,
            "emitAudioProgress": EMIT_AUDIO_PROGRESS,
            "languageBias": list(self._language_bias),
            "keywords": list(self._keywords),
        }

        socket = await self._socket_factory(url, {})
        # The vendor's limit counts from the connection, not from the ack.
        self._session_started_at = float(self._clock())
        try:
            await socket.send(json.dumps(frame))
            self._frames = socket.__aiter__()
            await self._await_ack(session)
        except BaseException:
            await _close_quietly(socket)
            raise
        self._socket = socket
        self._acked = True

    async def _await_ack(self, session_id: str) -> None:
        """Consume exactly the acknowledgement frame inside the bounded wait.

        A text JSON object without ``type`` is the ack. A typed frame may not
        arrive first, a binary or non-object frame can never be the ack, and a
        socket that ends first fails by name. The wait is bounded by
        ``stt.handshake_ms``; a close during the wait is classified through the
        shared speech-leg table so the caller can open the leg.
        """
        timeout_s = self.handshake_timeout_s
        try:
            raw = await asyncio.wait_for(
                self._frames.__anext__(), timeout=timeout_s
            )
        except StopAsyncIteration:
            self._record_failure(session_id, "socket closed before the acknowledgement")
            raise MetaHandshakeError(
                session_id, "socket closed before the acknowledgement"
            ) from None
        except TimeoutError:
            reason = (
                f"no acknowledgement within {timeout_s:g} s "
                f"(bound {HANDSHAKE_BOUND!r})"
            )
            self._record_failure(session_id, reason)
            raise MetaHandshakeTimeout(session_id, timeout_s) from None
        except Exception as error:
            code = getattr(error, "code", None)
            verdict = classify_stt(code if isinstance(code, int) else None)
            self._record_failure(
                session_id,
                f"socket closed during the handshake with code "
                f"{verdict.code!r} ({verdict.failure_class.value}: {verdict.reason})",
            )
            raise MetaHandshakeClosed(session_id, verdict) from error

        ack = _json_object(raw)
        if ack is None:
            self._record_failure(
                session_id, "a non-object frame arrived before the acknowledgement"
            )
            raise MetaHandshakeProtocolError(
                session_id,
                "a frame that is not a JSON object arrived before the acknowledgement",
            )
        if "type" in ack:
            self._record_failure(
                session_id,
                f"a frame of type {ack['type']!r} arrived before the acknowledgement",
            )
            raise MetaHandshakeProtocolError(
                session_id,
                f"a frame of type {ack['type']!r} arrived before the acknowledgement",
            )

    def _record_failure(self, session_id: str, reason: str) -> None:
        """Record why a session could not be established, without the credential."""
        self._failure_reason = f"meta speech session {session_id}: {reason}"
        _log.warning("%s", self._failure_reason)

    async def send_audio(self, pcm: bytes) -> None:
        """Forward one raw PCM frame; never await a vendor reply.

        Only signed 16-bit little-endian mono at 24 kHz reaches the vendor. A
        text payload, a JSON object or a container is refused locally by type
        or signature; a malformed binary frame is dropped and logged. Silence
        is filled up to the injected clock before the frame, and nothing is
        sent once the audio is more than ``MAX_LEAD_S`` ahead of processing.
        """
        self._require_acked()
        payload = _pcm_payload(pcm)
        if payload is None:
            self._drop("a malformed PCM frame")
            return

        await self._fill_silence()
        duration = len(payload) / BYTES_PER_SECOND
        if self._lead() + duration > MAX_LEAD_S:
            self._drop(f"a frame {MAX_LEAD_S:g} s or more ahead of processing")
            return

        await self._socket.send(payload)
        self._audio_end += duration

    async def send_silence(self, seconds: float | None = None) -> None:
        """Send PCM silence for ``seconds`` (default one 20 ms frame).

        Used by a quiet audio tick so the vendor's idle-input close does not
        fire. Duration is quantised down to whole silence frames and bounded by
        the lead budget.
        """
        self._require_acked()
        frames = 1 if seconds is None else _silence_frames_for(seconds)
        await self._send_silence_frames(frames)

    async def _fill_silence(self) -> None:
        """Fill the gap between the audio timeline and the clock with silence."""
        gap = float(self._clock()) - self._audio_end
        if gap <= 0:
            return
        await self._send_silence_frames(_silence_frames_for(gap))

    async def _send_silence_frames(self, frames: int) -> None:
        capacity = _silence_frames_for(max(0.0, MAX_LEAD_S - self._lead()))
        silence = b"\x00" * SILENCE_FRAME_BYTES
        for _ in range(min(frames, capacity)):
            await self._socket.send(silence)
            self._audio_end += SILENCE_FRAME_MS / 1000.0

    def _lead(self) -> float:
        """How far the audio timeline is ahead of the injected clock."""
        return self._audio_end - float(self._clock())

    def _require_acked(self) -> None:
        if self._socket is None or not self._acked:
            raise RuntimeError("meta speech session has no acknowledgement yet")

    def _drop(self, reason: str) -> None:
        self._dropped_frames += 1
        _log.warning(
            "meta speech session %s: dropped audio (%s)",
            self._session,
            reason,
        )

    async def events(self) -> AsyncIterator[Any]:
        """Yield the vendor's events mapped onto the internal vocabulary.

        ``speechStart`` → :class:`SpeechStart`, ``transcript`` →
        :class:`providers.PartialTranscript` (no id, latest start),
        ``speechEnd`` → :class:`SpeechEnd`, ``speechComplete`` →
        :class:`SpeechComplete`, ``error`` → :class:`MetaStreamError`.
        Unknown types, server binary frames and non-JSON text are ignored.

        A socket close is handed to :meth:`handle_close`. A retry or a planned
        reconnect replaces the session and the stream continues from the new
        one; a clean ``1000`` ends the iterator; a call-ending failure raises
        :class:`SpeechCallFailure` (or the vendor's :class:`MetaStreamError`).
        """
        if self._socket is None or not self._acked:
            raise RuntimeError("meta speech session has no acknowledgement yet")
        while True:
            frames = self._frames
            source_epoch = self._epoch
            if frames is None:
                return
            try:
                raw = await frames.__anext__()
            except StopAsyncIteration:
                return
            except Exception as error:
                decision = await self.handle_close(
                    getattr(error, "code", None),
                    reason=getattr(error, "reason", "") or "",
                )
                if decision.action in (
                    CloseAction.RETRY,
                    CloseAction.PLANNED_RECONNECT,
                ):
                    continue
                return
            # A vendor ``error`` event is not a close: ``map_event`` raises
            # ``MetaStreamError`` and it propagates untouched.
            mapped = self.map_event(raw, epoch=source_epoch)
            if mapped is None:
                continue
            yield mapped
            # A turn boundary is the only safe place to replace a session:
            # ``speechEnd`` does not carry the final text, so the planned
            # reconnect waits for ``speechComplete``.
            if (
                isinstance(mapped, SpeechComplete)
                and self.reconnect_due
                and not self.turn_in_flight
            ):
                await self._planned_reconnect(
                    classify_stt(SESSION_LIMIT),
                    kind=SessionEndKind.LIFETIME,
                )

    async def handle_close(self, code: Any = None, *, reason: str = "") -> CloseDecision:
        """Classify one close and act on it, once.

        ``1000`` is clean. ``1008`` is our bug: the call fails, an alert fires,
        and the speech leg's breaker is left closed. ``1011`` — and a close with
        no code, which the shared table treats as ``1011`` — retries once with
        a new session; the retry is spent on that close and the second one
        fails visibly and opens the leg. ``1013`` never retries: it fails with
        ``backoff`` set and opens the leg, so the reconnect policy cannot start
        an immediate retry storm. A ``1011`` whose reason is the max session
        duration is a planned reconnect instead: a new session, no failure.
        """
        verdict = classify_stt(code)
        if isinstance(code, int):
            self._last_close_code = code

        # The vendor's reason names the cause. Idle input ends the session; it
        # is not our pacing bug (1008) and not a dropped socket (no code), so
        # it is handled before the code table can call it either.
        if is_idle_close(reason):
            return await self._planned_reconnect(verdict, kind=SessionEndKind.IDLE)

        # A close with no code is a dropped socket: input ends here, and no
        # end-of-stream could have been sent on it. The retry policy below
        # still applies; the ledger keeps the two facts apart.
        if code is None:
            self._record_ending(
                SessionEndKind.DROPPED, None, "socket dropped without a close code"
            )

        if verdict.failure_class is FailureClass.DO_NOT_OPEN:
            if code == 1000:
                # The vendor closed normally. The socket is left for the
                # deliberate ``close()`` to make its one end-of-stream attempt.
                self._record_ending(SessionEndKind.NORMAL, code, verdict.reason)
                return CloseDecision(verdict=verdict, action=CloseAction.CLEAN)
            await self._close_socket()
            raise await self._fail(
                verdict, f"speech close {code!r}: {verdict.reason}"
            )

        if verdict.failure_class is FailureClass.BUG:
            await self._close_socket()
            raise await self._fail(
                verdict, f"speech close {code!r}: {verdict.reason}"
            )

        if verdict.failure_class is FailureClass.PLANNED_RECONNECT:
            return await self._planned_reconnect(verdict)

        if code in (1011, None) and is_max_duration(reason):
            return await self._planned_reconnect(verdict)

        if code == 1013:
            await self._close_socket()
            raise await self._fail(
                verdict,
                f"speech close {code!r}: {verdict.reason}; no immediate retry",
                backoff=True,
            )

        if self.retry_allowed:
            self._retry_used = True
            self._failures.append(verdict)
            await self._reopen()
            return CloseDecision(
                verdict=verdict, action=CloseAction.RETRY, retried=True
            )

        await self._close_socket()
        raise await self._fail(
            verdict, f"speech close {code!r}: {verdict.reason}"
        )

    async def _planned_reconnect(
        self,
        verdict: FailureVerdict,
        *,
        kind: SessionEndKind = SessionEndKind.LIFETIME,
    ) -> CloseDecision:
        """A session limit, not a failure: open a new session with no penalty."""
        await self._close_socket()
        self._record_ending(kind, verdict.code, verdict.reason, planned=True)
        if self._ledger is not None:
            # The call ledger's one reconnect mark; the session ledger above
            # carries every entry, including the ones a mark cannot count.
            self._ledger.mark("reconnect")
        if self._language_bias is None:  # pragma: no cover - close implies open
            self._needs_reconnect = True
            return CloseDecision(
                verdict=verdict, action=CloseAction.PLANNED_RECONNECT
            )
        await self._reopen()
        return CloseDecision(verdict=verdict, action=CloseAction.PLANNED_RECONNECT)

    def _record_ending(
        self,
        kind: SessionEndKind,
        code: int | str | None,
        reason: str,
        *,
        planned: bool = False,
        end_stream_sent: bool = False,
    ) -> None:
        """Append one speech-session ledger entry, stamped by the call clock."""
        self._session_endings.append(
            SessionEnding(
                epoch=self._epoch,
                kind=kind,
                code=code,
                reason=reason,
                at=float(self._clock()),
                planned=planned,
                end_stream_sent=end_stream_sent,
            )
        )

    async def _reopen(self) -> None:
        """Replace the dead session with a new one, never with ``endStream``."""
        await self._close_socket()
        self._needs_reconnect = False
        self._reconnects += 1
        await self.open(language_codes=[], sample_rate=SAMPLE_RATE)

    async def _close_socket(self) -> None:
        """Detach and close the current socket; ``close()`` is the deliberate end."""
        socket, self._socket = self._socket, None
        self._frames = None
        self._acked = False
        if socket is not None:
            await _close_quietly(socket)

    async def _fail(
        self, verdict: FailureVerdict, reason: str, *, backoff: bool = False
    ) -> SpeechCallFailure:
        """Record one call-ending failure: breaker for triggers, alert for bugs."""
        failure = SpeechCallFailure(
            verdict=verdict, stage="stream", reason=reason, backoff=backoff
        )
        self._failures.append(verdict)
        self._record_ending(SessionEndKind.FAILED, verdict.code, reason)
        if verdict.opens_breaker:
            self._breaker_opens.append(verdict)
            if self._leg_failures is not None:
                await self._leg_failures.failed(
                    "stt", verdict=verdict, phase="stream"
                )
        if verdict.failure_class is FailureClass.BUG:
            self._alert(verdict, str(failure))
        return failure

    def _alert(self, verdict: FailureVerdict, reason: str) -> None:
        self._alerts.append((verdict, reason))
        if self._alert_sink is not None:
            self._alert_sink(verdict, reason)

    def map_event(self, raw: Any, *, epoch: int | None = None) -> Any:
        """Map one inbound frame; ``None`` means ignore it.

        ``epoch`` is the session the frame came from (the current one when
        omitted). A frame from a replaced session is marked — counted in
        :attr:`stale_events` and logged — and ignored before it can touch turn
        state, so an old ``turnId`` can never be read as the new epoch's turn.
        """
        source_epoch = self._epoch if epoch is None else epoch
        if source_epoch != self._epoch:
            self._stale_events += 1
            _log.warning(
                "meta speech session %s: ignoring a late event from session "
                "epoch %s (current epoch %s)",
                self._session,
                source_epoch,
                self._epoch,
            )
            return None

        if not isinstance(raw, str):
            # The vendor's binary frames carry no transcript.
            return None
        message = _json_object(raw)
        if message is None:
            _log.warning(
                "meta speech session %s: ignoring a non-JSON text frame",
                self._session,
            )
            return None

        kind = message.get("type")
        if kind == "speechStart":
            turn_id = _turn_id(message)
            if turn_id is None:
                _log.warning(
                    "meta speech session %s: speechStart without a turnId",
                    self._session,
                )
                return None
            state = self._turns.open(turn_id, epoch=source_epoch)
            if state is None:
                _log.warning(
                    "meta speech session %s: speechStart for closed turn %r",
                    self._session,
                    turn_id,
                )
                return None
            return SpeechStart(turn_id=turn_id, session_epoch=source_epoch)

        if kind == "transcript":
            text = message.get("text")
            if not isinstance(text, str) or not text:
                return None
            state = self._turns.partial(text, epoch=source_epoch)
            if state is None:
                _log.warning(
                    "meta speech session %s: ignoring a partial that belongs "
                    "to no open turn",
                    self._session,
                )
                return None
            return SpeechPartial(text=text, session_epoch=source_epoch)

        if kind == "speechEnd":
            turn_id = _turn_id(message)
            if turn_id is None:
                _log.warning(
                    "meta speech session %s: speechEnd without a turnId",
                    self._session,
                )
                return None
            state = self._turns.end(turn=turn_id, epoch=source_epoch)
            if state is None:
                _log.warning(
                    "meta speech session %s: speechEnd for unknown or closed "
                    "turn %r",
                    self._session,
                    turn_id,
                )
                return None
            return SpeechEnd(turn_id=turn_id, session_epoch=source_epoch)

        if kind == "speechComplete":
            turn_id = _turn_id(message)
            if turn_id is None:
                _log.warning(
                    "meta speech session %s: speechComplete without a turnId",
                    self._session,
                )
                return None
            text = message.get("text")
            authored = text if isinstance(text, str) else ""
            before = self._turns.get(turn_id)
            was_finalised = before is not None and before.is_finalised
            state = self._turns.finalise(
                authored, turn=turn_id, epoch=source_epoch
            )
            if state is None:
                _log.warning(
                    "meta speech session %s: speechComplete for unknown or "
                    "closed turn %r",
                    self._session,
                    turn_id,
                )
                return None
            if was_finalised:
                _log.warning(
                    "meta speech session %s: ignoring a duplicate "
                    "speechComplete for turn %r",
                    self._session,
                    turn_id,
                )
                return None
            return SpeechComplete(
                text=authored, turn_id=turn_id, session_epoch=source_epoch
            )

        if kind == "error":
            reason = _error_reason(message)
            self._failure_reason = (
                f"meta speech session {self._session}: {reason}"
            )
            _log.error("%s", self._failure_reason)
            raise MetaStreamError(self._session, reason)

        _log.debug(
            "meta speech session %s: ignoring event type %r",
            self._session,
            kind,
        )
        return None

    async def close(self) -> None:
        """End the call deliberately: drain, ``endStream``, wait for the close.

        Idempotent. The audio timeline is drained first (bounded by
        ``MAX_LEAD_S``) so the vendor has the frames it was sent, then the one
        permitted text frame goes up, and the socket is read until the vendor
        closes. Classification of a non-normal close belongs to ticket 31.
        """
        socket, self._socket = self._socket, None
        frames, self._frames = self._frames, None
        was_acked, self._acked = self._acked, False
        if socket is None:
            return
        if not was_acked:
            await _close_quietly(socket)
            return

        end_stream_sent = False
        try:
            await self._drain_audio()
            await socket.send(END_STREAM_FRAME)
            end_stream_sent = True
        except Exception as error:
            _log.warning(
                "meta speech session %s: endStream could not be sent (%s)",
                self._session,
                error,
            )
        await self._await_vendor_close(frames)
        await _close_quietly(socket)
        self._record_ending(
            SessionEndKind.DELIBERATE,
            self._last_close_code,
            "deliberate end: drained, endStream, read to the vendor close",
            end_stream_sent=end_stream_sent,
        )

    async def _drain_audio(self) -> None:
        """Wait out the audio already handed to the vendor, bounded by the lead."""
        lead = self._lead()
        if lead > 0:
            await self._clock.sleep(min(lead, MAX_LEAD_S))

    async def _await_vendor_close(self, frames: Any) -> None:
        """Discard events after ``endStream`` until the vendor closes."""
        if frames is None:
            return
        while True:
            try:
                await frames.__anext__()
            except StopAsyncIteration:
                return
            except Exception as error:
                self._record_close(error)
                return

    def _record_close(self, error: BaseException) -> bool:
        """Record a close code; ``True`` when it is the normal completion.

        This is the deliberate-end path only: :meth:`close` has already sent
        ``endStream``, so a non-``1000`` close is recorded and never acted on
        (a retry during shutdown would be wrong). Live closes go through
        :meth:`handle_close`.
        """
        code = getattr(error, "code", None)
        if isinstance(code, int):
            self._last_close_code = code
        return code == 1000


def session_id(call_id: str, epoch: int) -> str:
    """The vendor session id: the call id plus a local session epoch.

    The id is a query parameter, so it is visible in the connection record; it
    never carries a credential.
    """
    if not call_id.strip():
        raise ValueError("a meta speech session needs a call id")
    if epoch < 0:
        raise ValueError(f"session epoch cannot be negative: {epoch!r}")
    return f"{call_id}:{epoch}"


def language_bias(codes: Iterable[str]) -> tuple[str, ...]:
    """Map Locale codes to the vendor's language names, deduplicated in order."""
    names: list[str] = []
    for code in codes:
        locale = LOCALES.get(code)
        if locale is None:
            raise UnknownLanguageCodeError(code)
        if locale.language not in names:
            names.append(locale.language)
    return tuple(names)


def is_idle_close(reason: str) -> bool:
    """Whether a close reason names the vendor's idle-input session end.

    Like the duration limit, the vendor sends free text, so the match is
    case- and whitespace-insensitive. A reason that does not name idle input
    is an ordinary close and is never guessed into a session end.
    """
    text = " ".join(str(reason).lower().split())
    return any(phrase in text for phrase in _IDLE_REASONS)


def is_max_duration(reason: str) -> bool:
    """Whether a close reason names the vendor's 60-minute session limit.

    The vendor sends free text, so the comparison is case- and
    whitespace-insensitive. A reason that does not name the limit is an
    ordinary close and is never guessed into a planned reconnect.
    """
    text = " ".join(str(reason).lower().split())
    return any(phrase in text for phrase in _MAX_DURATION_REASONS)


def keywords(keyterms: Iterable[str]) -> tuple[str, ...]:
    """Normalise the body's keyterms into the vendor's keyword list."""
    terms: list[str] = []
    for term in keyterms:
        if not isinstance(term, str):
            raise TypeError(f"a keyterm must be a string, got {term!r}")
        cleaned = term.strip()
        if cleaned and cleaned not in terms:
            terms.append(cleaned)
    return tuple(terms)


def _json_object(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _pcm_payload(pcm: Any) -> bytes | None:
    """Raw PCM bytes, or ``None`` when a binary frame is malformed.

    A text payload (JSON audio, base64) or a container is refused loudly: it
    is a caller bug, not a recoverable frame. An empty or odd-length binary
    frame is malformed and is dropped by the caller.
    """
    if not isinstance(pcm, (bytes, bytearray, memoryview)):
        raise AudioFrameRejected(
            "audio frame must be raw binary PCM s16le mono at "
            f"{SAMPLE_RATE} Hz, not {type(pcm).__name__}"
        )
    data = bytes(pcm)
    for magic, label in _CONTAINERS:
        if data.startswith(magic):
            raise AudioFrameRejected(
                f"audio frame is a {label} container, not raw PCM s16le mono "
                f"at {SAMPLE_RATE} Hz"
            )
    if not data or len(data) % BYTES_PER_SAMPLE:
        return None
    return data


def _silence_frames_for(seconds: float) -> int:
    """Whole 20 ms silence frames that fit in ``seconds`` (rounded down)."""
    if seconds <= 0:
        return 0
    return int(seconds * 1000.0 / SILENCE_FRAME_MS + 1e-9)


def _turn_id(message: dict[str, Any]) -> str | None:
    """The vendor turn id, or ``None`` when the event does not name one."""
    value = message.get("turnId")
    if isinstance(value, str) and value.strip():
        return value
    return None


def _error_reason(message: dict[str, Any]) -> str:
    """The most specific detail an ``error`` event supplies."""
    for field in ("message", "error", "detail"):
        detail = message.get(field)
        if isinstance(detail, dict):
            return json.dumps(detail, sort_keys=True)
        if isinstance(detail, str) and detail.strip():
            return detail
    return "unspecified error"


async def _close_quietly(socket: Any) -> None:
    try:
        await socket.close()
    except Exception:
        pass
