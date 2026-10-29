"""Meta realtime speech-to-text backend: session handshake (ticket 26).

The credential travels inside the handshake frame (``authorization.accessToken``)
because the vendor ignores the ``Authorization`` header; the handshake also
declares the one encoding, model, endpointing mode and partial shape the cascade
reads. The socket factory is injected, so every test replays recorded frames and
no test opens a real socket.

Session identity is a query parameter built from the call id and a local session
epoch, never a secret. The acknowledgement is a text frame without a ``type``
field; any other frame arriving before it is a protocol error, and no audio
leaves the client before the ack.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from typing import Any
from urllib.parse import urlencode

from cascade.voice_binding import LOCALES
from providers import StreamingSTT

REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime"
MODEL = "muse-voice-transcribe-1.0"
AUDIO_ENCODING = "PCM_24KHZ"
MODE = "ENDPOINTING"
PARTIAL_MODE = "CUMULATIVE"
EMIT_AUDIO_PROGRESS = False
SAMPLE_RATE = 24000
API_KEY_ENV = "META_API_KEY"

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


class MetaStreamingSTT(StreamingSTT):
    """StreamingSTT over Meta's realtime ASR endpoint."""

    def __init__(
        self,
        *,
        call_id: str,
        api_key: str | None = None,
        socket_factory: SocketFactory | None = None,
        keyterms: Iterable[str] = (),
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

    @property
    def acked(self) -> bool:
        """Whether the current session's acknowledgement was received."""
        return self._acked

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
        """Consume exactly the acknowledgement frame.

        A text JSON object without ``type`` is the ack. A typed frame may not
        arrive first, and a binary or non-JSON frame can never be the ack; both
        fail by session name. The bounded wait and its classification are
        ticket 27's.
        """
        try:
            raw = await self._frames.__anext__()
        except StopAsyncIteration:
            raise MetaHandshakeError(
                session_id, "socket closed before the acknowledgement"
            ) from None
        ack = _json_object(raw)
        if ack is None:
            raise MetaHandshakeProtocolError(
                session_id, "a non-JSON frame arrived before the acknowledgement"
            )
        if "type" in ack:
            raise MetaHandshakeProtocolError(
                session_id,
                f"a frame of type {ack['type']!r} arrived before the acknowledgement",
            )

    async def send_audio(self, pcm: bytes) -> None:
        """Forward one binary PCM frame; pacing and framing land in ticket 28."""
        if self._socket is None or not self._acked:
            raise RuntimeError("meta speech session has no acknowledgement yet")
        raise NotImplementedError("audio path lands in ticket 28")

    async def events(self) -> AsyncIterator[Any]:
        """Read vendor events; the mapping lands in ticket 29."""
        raise NotImplementedError("event mapping lands in ticket 29")

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


async def _close_quietly(socket: Any) -> None:
    try:
        await socket.close()
    except Exception:
        pass
