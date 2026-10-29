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

Sentence scheduling (``speak``) is ticket 49; word boundaries, cancel,
termination and the close policy follow at their own seams.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any
from urllib.parse import urlencode

from providers import SentenceAudio, StreamingTTS

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


class ControlFramePacingError(RuntimeError):
    """The client sent control frames faster than the session accepts them.

    This is our bug (close ``3010``), not an outage: the vendor would close the
    session, so the adapter refuses the frame instead of tripping it.
    """

    def __init__(self, limit: float, count: int, at: float) -> None:
        self.limit = limit
        self.count = count
        self.at = at
        super().__init__(
            f"synthesis control frames exceeded the session's {limit:g}/s budget "
            f"({count} sent in the last second at {at:.3f}s): 3010 text/control "
            "pacing bug — do not retry blindly"
        )


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
    ) -> None:
        self.binding: VoiceBinding = bind_voice(voice_id)
        self.format: TransportFormat = transport_format(transport)
        self.model_id = MODEL_ID
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        self._socket_factory = socket_factory or _default_socket_factory
        self._clock = clock or time.monotonic
        self._socket: Any = None
        self._frames: Any = None
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
        self.flush_id: int | None = None
        self.audio_bytes: int = 0
        self.termination: Mapping[str, Any] | None = None

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
        index = 0
        await self._send_request(chunks[index])
        while True:
            frame = await self._read_frame()
            kind = frame.get("type")
            if kind == "Audio":
                pcm = self._decode_audio(frame)
                self.audio_bytes += len(pcm)
                yield SentenceAudio(
                    pcm=pcm,
                    sample_rate=self.audio_sample_rate,
                    text=chunks[index],
                )
            elif kind == "FlushDone":
                self._record_flush_done(frame)
                index += 1
                if index >= len(chunks):
                    return
                await self._send_request(chunks[index])
            elif kind == "Termination":
                self._record_termination(frame)
                return

    async def speak_greeting(self, text: str) -> AsyncIterator[SentenceAudio]:
        """Speak the body's greeting line, first sentence flushed immediately.

        A greeting goes through the same scheduler as a reply: one
        ``Generate`` + ``Flush``, split at sentence boundaries. A greeting that
        is never flushed is a bug, so there is no separate unflushed path.
        """
        async for audio in self.speak(text):
            yield audio

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

    def _check_control_budget(self) -> None:
        """Refuse to send a frame the session would answer with ``3010``."""
        limit = self.limits.get("max_control_frames_per_sec")
        if not isinstance(limit, (int, float)) or limit <= 0:
            return
        now = self._clock()
        recent = sum(
            1 for moment in self.control_frame_times if now - moment < CONTROL_WINDOW_S
        )
        if recent >= limit:
            raise ControlFramePacingError(float(limit), recent, now)

    def _record_flush_done(self, frame: Mapping[str, Any]) -> None:
        flush_id = frame.get("flush_id")
        if isinstance(flush_id, int):
            self.flush_id = flush_id

    def _record_termination(self, frame: Mapping[str, Any]) -> None:
        """Kept for the termination/billing ticket; nothing reads it yet."""
        self.termination = frame

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
            raise SynthesisProtocolError(
                "synthesis session failed: "
                f"Error {frame.get('error_code')}: {frame.get('error')}"
            )
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
