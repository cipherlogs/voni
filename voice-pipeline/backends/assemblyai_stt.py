"""AssemblyAI universal-streaming STT backend (P1).

Implements the P0 StreamingSTT contract over wss://streaming.assemblyai.com/v3/ws.
Key management: the API key is passed in (host env ASSEMBLYAI_API_KEY), never
logged, never stored. The socket factory is injected so tests run offline.

Wire protocol verified live (Sep 2026) against real credits: handshake with
sample_rate, bare Authorization key, binary PCM frames, Begin/SpeechStarted/
Turn/Termination messages, ForceEndpoint produces an end_of_turn Turn,
Terminate closes cleanly. Sample greeting transcribed exactly.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional
from urllib.parse import urlencode

from providers import FinalTranscript, PartialTranscript, StreamingSTT

# Verified against the published universal-streaming docs (Sep 2026):
# wss://streaming.assemblyai.com/v3/ws, key in Authorization (no Bearer
# prefix), Begin/Turn/Termination messages, mono 16-bit PCM by default with
# sample_rate matching the source.
STREAMING_BASE_URL = "wss://streaming.assemblyai.com/v3/ws"
ENCODING = "pcm_s16le"

SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]


def _default_socket_factory(url: str, extra_headers: dict[str, str]) -> Awaitable[Any]:
    import websockets

    return websockets.connect(url, additional_headers=extra_headers)  # type: ignore[no-any-return]


def _streaming_url(*, language_codes: list[str], sample_rate: int) -> str:
    # language_codes is accepted for contract symmetry (the Deepgram backend
    # will use it) but intentionally NOT sent: v3 universal auto-detects and
    # documents no language pin parameter. sample_rate must match the source.
    params: dict[str, str] = {"sample_rate": str(sample_rate)}
    return f"{STREAMING_BASE_URL}?{urlencode(params)}"


class AssemblyAIStreamingSTT(StreamingSTT):
    def __init__(
        self,
        api_key: Optional[str] = None,
        socket_factory: SocketFactory | None = None,
    ) -> None:
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        self._socket_factory = socket_factory or _default_socket_factory
        self._socket: Any = None

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        if not self._api_key:
            raise RuntimeError("ASSEMBLYAI_API_KEY is not configured")
        url = _streaming_url(language_codes=language_codes, sample_rate=sample_rate)
        self._socket = await self._socket_factory(url, {"Authorization": self._api_key})

    async def send_audio(self, pcm: bytes) -> None:
        # Binary frames of raw PCM (docs: never JSON, never base64). ~50ms
        # chunks keep server buffering healthy; faster than realtime is fine.
        if self._socket is None:
            raise RuntimeError("STT session is not open")
        await self._socket.send(pcm)

    async def events(self) -> AsyncIterator[PartialTranscript | FinalTranscript]:
        if self._socket is None:
            raise RuntimeError("STT session is not open")
        async for raw in self._socket:
            event = self._parse_message(raw)
            if event is None:
                continue
            if event == "terminal":
                return
            yield event

    def _parse_message(
        self, raw: str
    ) -> PartialTranscript | FinalTranscript | None | str:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        msg_type = msg.get("type")
        if msg_type == "Error":
            # Session errors must fail loudly: the server closes right after,
            # and a silent skip would read as "no speech detected".
            raise RuntimeError(
                f"assemblyai session error {msg.get('error_code')}: {msg.get('error')}"
            )
        # Verified live: Turn carries transcript/end_of_turn; Termination ends.
        if msg_type == "Turn":
            text = msg.get("transcript") or ""
            if not text:
                return None
            if msg.get("end_of_turn"):
                return FinalTranscript(text=text)
            return PartialTranscript(text=text)
        if msg_type == "Termination":
            return "terminal"
        return None

    async def force_endpoint(self) -> None:
        """End the current turn immediately (docs: ForceEndpoint).

        This is the protocol-level early decision: the commit gate calls it
        the moment intent is complete instead of waiting out turn silence.
        """
        if self._socket is None:
            raise RuntimeError("STT session is not open")
        await self._socket.send(json.dumps({"type": "ForceEndpoint"}))

    async def close(self) -> None:
        socket, self._socket = self._socket, None
        if socket is not None:
            try:
                await socket.send(json.dumps({"type": "Terminate"}))
            except Exception:
                pass
            try:
                await socket.close()
            except Exception:
                pass
