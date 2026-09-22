"""Cartesia streaming TTS backend: sentence-chunked speech (P1).

Implements the P0 StreamingTTS contract. Text splits into sentences; each
sentence is synthesized via its own SSE request, all fired concurrently and
yielded strictly in sentence order — first-sentence audio arrives after one
round trip plus short-text synthesis (the first-playout metric), with no
per-sentence gaps afterwards.

Wire protocol verified live (Sep 2026): /tts/sse with X-API-Key and
Cartesia-Version 2024-06-10, raw s16le output shape, chunk events carrying
base64 PCM in "data". First audio 0.91s on a two-sentence reply.
Key management: CARTESIA_API_KEY from host env, passed in for tests, never
logged. HTTP seam mirrors gateway_llm.py (injected session factory).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from collections.abc import AsyncIterator
from typing import Any, Optional

from providers import SentenceAudio, StreamingTTS

CARTESIA_BASE_URL = "https://api.cartesia.ai"
# Verified live Sep 2026.
TTS_PATH = "/tts/sse"
CARTESIA_VERSION = "2024-06-10"

_SENTENCE_END_RE = re.compile(r"(.+?[.!?…]+)(?=\s+|$)")


def split_sentences(text: str) -> list[str]:
    """Split reply text into speakable sentences, delimiters kept."""
    matches = _SENTENCE_END_RE.findall(text)
    sentences = [m.strip() for m in matches if m.strip()]
    consumed = sum(len(m) for m in matches)
    tail = text[consumed:].strip()
    if tail:
        sentences.append(tail)
    return sentences


class _AiohttpResponse:
    def __init__(self, resp: Any) -> None:
        self._resp = resp
        self.status: int = resp.status

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        async for chunk in self._resp.content.iter_chunked(4096):
            yield chunk


class _AiohttpPost:
    def __init__(self, session: Any, url: str, headers: dict, payload: dict) -> None:
        self._session = session
        self._args = (url, headers, payload)
        self._cm: Any = None

    async def __aenter__(self) -> _AiohttpResponse:
        url, headers, payload = self._args
        self._cm = self._session.post(url, headers=headers, json=payload)
        return _AiohttpResponse(await self._cm.__aenter__())

    async def __aexit__(self, *args: Any) -> bool:
        if self._cm is not None:
            await self._cm.__aexit__(*args)
        return False


class _AiohttpSession:
    def __init__(self, timeout_s: float) -> None:
        import aiohttp

        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout_s)
        )

    async def __aenter__(self) -> "_AiohttpSession":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._session.close()

    def post(self, url: str, *, headers: dict, json: dict) -> _AiohttpPost:
        return _AiohttpPost(self._session, url, headers=headers, payload=json)


class CartesiaTTS(StreamingTTS):
    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        voice_id: str = "",
        model_id: str = "",
        language: str = "en",
        sample_rate: int = 24000,
        base_url: str = CARTESIA_BASE_URL,
        session_factory: Any = None,
        timeout_s: float = 30.0,
    ) -> None:
        self._api_key = api_key or os.environ.get("CARTESIA_API_KEY")
        self._voice_id = voice_id
        self._model_id = model_id
        self._language = language
        self._sample_rate = sample_rate
        self._base_url = base_url.rstrip("/")
        self._session_factory = session_factory or _AiohttpSession
        self._timeout_s = timeout_s

    def _check_config(self) -> None:
        if not self._api_key:
            raise RuntimeError("CARTESIA_API_KEY is not configured")
        if not self._voice_id:
            raise RuntimeError("Cartesia voice_id is required")
        if not self._model_id:
            raise RuntimeError("Cartesia model_id is required")

    async def speak(self, text: str) -> AsyncIterator[SentenceAudio]:
        self._check_config()
        sentences = split_sentences(text)
        if not sentences:
            return
        # One session for all sentences: no per-sentence handshake latency.
        # Requests fire together; results yield strictly in sentence order.
        session = self._session_factory(timeout_s=self._timeout_s)
        async with session as active:
            tasks = [
                asyncio.get_running_loop().create_task(self._fetch_sentence(active, s))
                for s in sentences
            ]
            try:
                for sentence, task in zip(sentences, tasks):
                    pcm = await task
                    yield SentenceAudio(
                        pcm=pcm, sample_rate=self._sample_rate, text=sentence
                    )
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()

    async def _fetch_sentence(self, active: Any, sentence: str) -> bytes:
        payload: dict[str, Any] = {
            "model_id": self._model_id,
            "transcript": sentence,
            "voice": {"mode": "id", "id": self._voice_id},
            # Verified live: raw s16le container at the requested rate.
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": self._sample_rate,
            },
            "language": self._language,
        }
        headers = {
            "X-API-Key": self._api_key or "",
            # Verified live Sep 2026.
            "Cartesia-Version": CARTESIA_VERSION,
            "content-type": "application/json",
        }
        url = f"{self._base_url}{TTS_PATH}"
        chunks: list[bytes] = []
        async with active.post(url, headers=headers, json=payload) as response:
            if response.status != 200:
                raise RuntimeError(f"cartesia {response.status} for {sentence!r}")
            async for audio in self._parse_audio(response):
                chunks.append(audio)
        return b"".join(chunks)

    async def _parse_audio(self, response: Any) -> AsyncIterator[bytes]:
        buffer = b""
        async for chunk in response.iter_bytes():
            buffer += chunk
            while b"\n" in buffer:
                raw_line, buffer = buffer.split(b"\n", 1)
                line = raw_line.strip()
                if not line.startswith(b"data:"):
                    continue
                data = line[len(b"data:") :].strip()
                if data == b"[DONE]":
                    return
                try:
                    payload = json.loads(data)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                # Verified live: chunk events carry base64 PCM in "data"
                # ({"type": "chunk", "done": false, ...}). Done markers and
                # any event without audio bytes are skipped.
                if payload.get("done") is True:
                    continue
                audio_b64 = payload.get("data")
                if audio_b64:
                    try:
                        yield base64.b64decode(audio_b64)
                    except (ValueError, TypeError):
                        continue
