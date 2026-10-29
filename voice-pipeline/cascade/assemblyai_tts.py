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

import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any
from urllib.parse import urlencode

from providers import SentenceAudio, StreamingTTS

from cascade.voice_binding import VoiceBinding, bind_voice

TTS_BASE_URL = "wss://tts.us.assemblyai.com/v1/ws"
MODEL_ID = "assemblyai-tts-1"

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
    ) -> None:
        self.binding: VoiceBinding = bind_voice(voice_id)
        self.format: TransportFormat = transport_format(transport)
        self.model_id = MODEL_ID
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        self._socket_factory = socket_factory or _default_socket_factory
        self._socket: Any = None
        self.begin: Mapping[str, Any] | None = None
        # The call's own record of the session it got (ticket 48).
        self.configuration: Mapping[str, Any] = MappingProxyType({})
        self.limits: Mapping[str, Any] = MappingProxyType({})
        self.expires_at: int | None = None
        self.begin_id: str | None = None
        self.unknown_params: tuple[str, ...] = ()
        self.begin_mismatches: tuple[EchoMismatch, ...] = ()

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
        try:
            self.begin = self._read_begin(await self._first_frame(socket))
            self._record_begin(self.begin)
            self._assert_begin()
        except BaseException:
            await _close_quietly(socket)
            self._socket = None
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
        """Not this ticket: sentence scheduling and Flush land with ticket 49."""
        raise NotImplementedError(
            "synthesis requests land with sentence scheduling (ticket 49)"
        )
        yield  # pragma: no cover - keeps this an async generator

    async def _first_frame(self, socket: Any) -> Any:
        async for raw in socket:
            return raw
        raise SynthesisHandshakeError(
            "synthesis socket closed before the Begin frame"
        )

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
