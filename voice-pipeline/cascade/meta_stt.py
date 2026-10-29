"""Meta realtime speech-to-text backend: session handshake (ticket 26).

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
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from cascade.failures import FailureVerdict, classify_stt
from cascade.testing.clock import RealClock
from cascade.thresholds import require_bound
from cascade.voice_binding import LOCALES
from providers import FinalTranscript, PartialTranscript, StreamingSTT

_log = logging.getLogger(__name__)

#: The registry bound that caps the wait for the acknowledgement (ticket 27).
HANDSHAKE_BOUND = "stt.handshake_ms"

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

SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]


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
    """``speechStart``: a provider turn opened, named by the vendor's turn id."""

    turn_id: str


@dataclass(frozen=True)
class SpeechEnd:
    """``speechEnd``: the provider's boundary. Records, never finalises."""

    turn_id: str


@dataclass(frozen=True)
class SpeechComplete(FinalTranscript):
    """``speechComplete``: the authoritative turn text.

    A ``FinalTranscript`` so existing turn handling reads it as the one final,
    with the provider ``turn_id`` added for the logical-turn store.
    """

    turn_id: str = ""


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
    ) -> None:
        self._call_id = call_id
        self._api_key = api_key or os.environ.get(API_KEY_ENV)
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
        self._latest_turn: str | None = None
        self._clock = clock if clock is not None else RealClock()
        self._audio_end = 0.0
        self._dropped_frames = 0

    @property
    def dropped_frames(self) -> int:
        """Frames the audio path refused to forward (malformed or over lead)."""
        return self._dropped_frames

    @property
    def acked(self) -> bool:
        """Whether the current session's acknowledgement was received."""
        return self._acked

    @property
    def failure_reason(self) -> str | None:
        """The recorded reason the last session could not be established."""
        return self._failure_reason

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
        The 10 s ack deadline (``stt.handshake_ms``) and its failure
        classification belong to ticket 27.
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
        session = session_id(self._call_id, self._epoch)
        self._session = session
        self._latest_turn = None
        self._audio_end = float(self._clock())
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
        """
        if self._socket is None or not self._acked:
            raise RuntimeError("meta speech session has no acknowledgement yet")
        async for raw in self._frames:
            mapped = self._map_frame(raw)
            if mapped is not None:
                yield mapped

    def _map_frame(self, raw: Any) -> Any:
        """Map one inbound frame; ``None`` means ignore it."""
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
            self._latest_turn = turn_id
            return SpeechStart(turn_id)

        if kind == "transcript":
            text = message.get("text")
            if self._latest_turn is None:
                _log.warning(
                    "meta speech session %s: ignoring a partial with no "
                    "preceding speechStart",
                    self._session,
                )
                return None
            if not isinstance(text, str) or not text:
                return None
            return PartialTranscript(text)

        if kind == "speechEnd":
            turn_id = _turn_id(message)
            if turn_id is None:
                _log.warning(
                    "meta speech session %s: speechEnd without a turnId",
                    self._session,
                )
                return None
            return SpeechEnd(turn_id)

        if kind == "speechComplete":
            turn_id = _turn_id(message)
            if turn_id is None:
                _log.warning(
                    "meta speech session %s: speechComplete without a turnId",
                    self._session,
                )
                return None
            text = message.get("text")
            return SpeechComplete(
                text=text if isinstance(text, str) else "", turn_id=turn_id
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
        """Close the socket. ``endStream`` and close-code handling land in ticket 30."""
        socket, self._socket = self._socket, None
        self._frames = None
        self._acked = False
        if socket is not None:
            await _close_quietly(socket)


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
