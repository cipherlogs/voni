"""AssemblyAI streaming synthesis connect (ticket 47).

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

The opening ``Begin`` frame is the session's own record of what it got. It is
read here and kept on ``begin``; comparing it with the request (the echo
assertion), recording ``expires_at``/``limits`` and refusing unknown query
parameters are ticket 48's work, added at that seam. Sentence scheduling
(``speak``) is ticket 49's.
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
        """Open the call's single socket and read the session's ``Begin`` frame."""
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
        self.begin = self._read_begin(await self._first_frame(socket))
        # Ticket 48 asserts `begin` against the request here, records
        # `expires_at` and `configuration.limits`, and refuses unknown_params.

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
