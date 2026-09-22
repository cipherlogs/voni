"""Gateway LLM backend: OpenAI-compatible SSE token streaming (P1).

Token streaming verified live (Sep 2026) against the gateway; tool-call
accumulation is covered by fakes only (no live tool-call run yet).

Implements the P0 LLMStream contract against the Vercel AI Gateway
({base}/chat/completions, Bearer AI_GATEWAY_API_KEY). Tokens stream so TTS
can start on the first sentence while the model still generates; tool calls
accumulate across deltas and emit when the finish reason lands.

Prefetch runs the same fetch in background and complete() adopts it on an
exact message match — one HTTP request for speculative + committed work.
Adoption never blocks audio: queue handoff only, no new I/O. Cancel on turn
divergence; stale fetches are dropped, never reused.

HTTP seam: session_factory() returns an async context manager whose post()
returns an async-CM response with .status and .iter_bytes(). Tests inject
fakes; production uses the bundled aiohttp adapter (lazy import, so this
module stays importable without vendor SDKs).
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from typing import Any, Optional

from providers import LLMStream, PrefetchHandle, TokenDelta, ToolCallRequest

GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1"


class _End:
    pass


_END = _End()


class _Fetch:
    """One in-flight streaming request with its consumer queue."""

    def __init__(self, key: str) -> None:
        self.key = key
        self.queue: asyncio.Queue = asyncio.Queue()
        self.task: Optional[asyncio.Task] = None
        self.error: Optional[BaseException] = None


class _PrefetchHandle(PrefetchHandle):
    def __init__(self, llm: "GatewayLLM", fetch: _Fetch) -> None:
        self._llm = llm
        self._fetch = fetch

    def cancel(self) -> None:
        try:
            self._llm._cancel_fetch(self._fetch)
        except Exception:
            pass


class _AiohttpResponse:
    def __init__(self, resp: Any) -> None:
        self._resp = resp
        self.status: int = resp.status

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        async for chunk in self._resp.content.iter_chunked(1024):
            yield chunk


class _AiohttpPost:
    def __init__(self, session: Any, url: str, headers: dict, payload: dict) -> None:
        self._session = session
        self._url = url
        self._headers = headers
        self._payload = payload
        self._cm: Any = None

    async def __aenter__(self) -> _AiohttpResponse:
        self._cm = self._session.post(
            self._url, headers=self._headers, json=self._payload
        )
        resp = await self._cm.__aenter__()
        return _AiohttpResponse(resp)

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


class GatewayLLM(LLMStream):
    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: str = "",
        base_url: str = GATEWAY_BASE_URL,
        session_factory: Any = None,
        timeout_s: float = 60.0,
    ) -> None:
        self._api_key = api_key or os.environ.get("AI_GATEWAY_API_KEY")
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._session_factory = session_factory or _AiohttpSession
        self._timeout_s = timeout_s
        self._current: Optional[_Fetch] = None

    @staticmethod
    def _key(messages: list, tools: Any) -> str:
        return json.dumps({"m": messages, "t": tools}, sort_keys=True, default=str)

    def _cancel_fetch(self, fetch: _Fetch) -> None:
        if self._current is fetch:
            self._current = None
        if fetch.task is not None and not fetch.task.done():
            fetch.task.cancel()
        # Wake a consumer that may be draining this fetch right now: it ends
        # cleanly on the sentinel with whatever tokens already arrived.
        try:
            fetch.queue.put_nowait(_END)
        except Exception:
            pass

    def prefetch(
        self, *, messages: list[dict], tools: list[dict] | None = None
    ) -> PrefetchHandle:
        # Sync start by contract: the audio path never awaits us.
        self._drop_current()
        fetch = _Fetch(self._key(messages, tools))
        fetch.task = asyncio.get_running_loop().create_task(
            self._run_fetch(fetch, messages, tools)
        )
        self._current = fetch
        return _PrefetchHandle(self, fetch)

    def _drop_current(self) -> None:
        current, self._current = self._current, None
        if current is not None and current.task is not None:
            if not current.task.done():
                current.task.cancel()
            elif not current.task.cancelled():
                # Retrieve: a failed prefetch nobody adopted must not log
                # "exception was never retrieved" when dropped.
                current.task.exception()

    async def complete(
        self, *, messages: list[dict], tools: list[dict] | None = None
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        if not self._api_key:
            raise RuntimeError("AI_GATEWAY_API_KEY is not configured")
        key = self._key(messages, tools)
        fetch: Optional[_Fetch] = None
        if (
            self._current is not None
            and self._current.key == key
            and self._current.task is not None
            and not self._current.task.done()
        ):
            fetch = self._current
            self._current = None
        else:
            self._drop_current()
            fetch = _Fetch(key)
            fetch.task = asyncio.get_running_loop().create_task(
                self._run_fetch(fetch, messages, tools)
            )
        while True:
            event = await fetch.queue.get()
            if event is _END:
                break
            yield event
        if fetch.error is not None:
            raise fetch.error

    async def _run_fetch(
        self, fetch: _Fetch, messages: list[dict], tools: list[dict] | None
    ) -> None:
        try:
            async for event in self._stream(messages, tools):
                fetch.queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 - recorded, re-raised to consumer
            fetch.error = exc
        finally:
            fetch.queue.put_nowait(_END)

    async def _stream(
        self, messages: list[dict], tools: list[dict] | None
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        if not self._api_key:
            raise RuntimeError("AI_GATEWAY_API_KEY is not configured")
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        url = f"{self._base_url}/chat/completions"
        session = self._session_factory(timeout_s=self._timeout_s)
        async with session as active:
            async with active.post(url, headers=headers, json=payload) as response:
                if response.status != 200:
                    raise RuntimeError(f"gateway {response.status}")
                async for event in self._parse_sse(response):
                    yield event

    async def _parse_sse(
        self, response: Any
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        buffer = b""
        tool_accum: dict[int, dict[str, Any]] = {}
        async for chunk in response.iter_bytes():
            buffer += chunk
            while b"\n" in buffer:
                raw_line, buffer = buffer.split(b"\n", 1)
                line = raw_line.strip()
                if not line.startswith(b"data:"):
                    continue
                data = line[len(b"data:") :].strip()
                if data == b"[DONE]":
                    async for event in self._flush_tools(tool_accum):
                        yield event
                    return
                try:
                    payload = json.loads(data)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                async for event in self._handle_choices(payload, tool_accum):
                    yield event
        async for event in self._flush_tools(tool_accum):
            yield event

    async def _handle_choices(
        self, payload: dict, tool_accum: dict[int, dict[str, Any]]
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        for choice in payload.get("choices", []):
            delta = choice.get("delta", {})
            content = delta.get("content")
            if content:
                yield TokenDelta(text=content)
            for call in delta.get("tool_calls", []):
                index = call.get("index", 0)
                acc = tool_accum.setdefault(
                    index, {"id": None, "name": "", "arguments": ""}
                )
                if call.get("id"):
                    acc["id"] = call["id"]
                function = call.get("function", {})
                if function.get("name"):
                    acc["name"] += function["name"]
                if function.get("arguments"):
                    acc["arguments"] += function["arguments"]
            finish = choice.get("finish_reason")
            if finish == "tool_calls":
                async for event in self._flush_tools(tool_accum):
                    yield event
            elif finish is not None:
                async for event in self._flush_tools(tool_accum):
                    yield event
                return

    async def _flush_tools(
        self, tool_accum: dict[int, dict[str, Any]]
    ) -> AsyncIterator[ToolCallRequest]:
        for index in sorted(tool_accum):
            acc = tool_accum[index]
            arguments = self._parse_arguments(acc["arguments"])
            yield ToolCallRequest(
                name=acc["name"], arguments=arguments, call_id=acc["id"] or f"call-{index}"
            )
        tool_accum.clear()

    @staticmethod
    def _parse_arguments(raw: str) -> dict[str, Any]:
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}
        return parsed if isinstance(parsed, dict) else {"_raw": raw}
