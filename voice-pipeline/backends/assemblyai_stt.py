"""AssemblyAI universal-streaming STT backend (P1).

Implements the P0 StreamingSTT contract over the v3 universal endpoint.
Key management: the API key is passed in (host env ASSEMBLYAI_API_KEY), never
logged, never stored. The socket factory is injected so tests run offline.

LIVE-VERIFY items (each marked below): wire details taken from public docs
knowledge, to be confirmed by one live run against real credits — the P1 exit
gate. The fake-socket suite pins behavior given those assumptions, so a live
correction stays a one-spot change.
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional
from urllib.parse import urlencode

from providers import FinalTranscript, PartialTranscript, StreamingSTT

# LIVE-VERIFY: v3 universal base URL and query vocabulary.
STREAMING_BASE_URL = "wss://streaming.assemblyai.com/v3/universal"
ENCODING = "pcm_s16le"

SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]


def _default_socket_factory(url: str, extra_headers: dict[str, str]) -> Awaitable[Any]:
    import websockets

    return websockets.connect(url, additional_headers=extra_headers)  # type: ignore[no-any-return]


def _streaming_url(*, language_codes: list[str], sample_rate: int) -> str:
    params: dict[str, str] = {"sample_rate": str(sample_rate), "encoding": ENCODING}
    if language_codes:
        # LIVE-VERIFY: pinned-language parameter name for v3 universal.
        params["language_code"] = language_codes[0]
    else:
        # LIVE-VERIFY: auto-detection parameter name for v3 universal.
        params["language_detection"] = "true"
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
        if self._socket is None:
            raise RuntimeError("STT session is not open")
        await self._socket.send(
            json.dumps({"audio_data": base64.b64encode(pcm).decode()})
        )

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
        # LIVE-VERIFY: v3 Turn shape (transcript / end_of_turn / Termination).
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

    async def close(self) -> None:
        socket, self._socket = self._socket, None
        if socket is not None:
            try:
                await socket.close()
            except Exception:
                pass
