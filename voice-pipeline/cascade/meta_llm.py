"""Meta LLM backend: the Chat Completions request contract.

Meta's Spark model speaks OpenAI-compatible Chat Completions on Standard
``muse-spark-1.3``. This module owns exactly one boundary: *what we put on the
wire*. It builds the request from the stored body's system prompt plus the
turn's history and posts it through an injected HTTP session factory, so a test
replays the whole backend offline.

The request is deliberately narrow, because the vendor rejects or ignores
several knobs and a caller's conversation must not leak into them:

- bearer auth, the resolved Standard model, the full history, ``stream: true``,
  ``stream_options: {include_usage: true}`` and the measured
  ``reasoning_effort``;
- ``tool_choice: "auto"`` only when tools are supplied, and
  ``parallel_tool_calls`` left at the vendor default;
- never ``store``, ``stop``, penalties, ``n > 1``, ``logprobs``, temperature or
  unsupported modalities, and never a caller identifier as ``user`` or
  ``safety_identifier``.

``reasoning_effort`` has no default. ``"none"`` is unavailable on Spark (HTTP
400), so an absent or unavailable effort is refused when the backend is
constructed, before any request exists. M03 fixes the value from the spike's
measurement; this module only carries it.

Stream parsing, tool-call accumulation, argument validation, usage recording,
finish reasons and the failure policy are tickets 37-45. ``complete()`` posts
the request and hands the response to a seam those tickets fill; nothing here
interprets an event.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from typing import Any

from cascade.model_guard import resolve_model
from providers import LLMStream, PrefetchHandle, TokenDelta, ToolCallRequest

META_BASE_URL = "https://api.meta.ai/v1"

CHAT_COMPLETIONS_PATH = "/chat/completions"

#: Spark always reasons; asking it not to is a vendor 400, not a speed knob.
UNAVAILABLE_REASONING_EFFORT = "none"


class MetaLLMConfigError(RuntimeError):
    """A required piece of backend configuration is missing."""


class ReasoningEffortError(ValueError):
    """A reasoning effort the cascade refuses to construct a client without."""


class MetaLLMRequestError(RuntimeError):
    """The vendor answered the request with a non-success status.

    Failure classification and retry belong to ticket 42; this type only makes
    the status visible instead of parsing an error body as a token stream.
    """

    def __init__(self, status: int) -> None:
        super().__init__(f"Meta chat completions returned HTTP {status}")
        self.status = status


def resolve_reasoning_effort(reasoning_effort: str | None) -> str:
    """Return the configured effort, or refuse by name.

    The value is a measurement (M00/M03), so this module supplies no default of
    its own: a missing value is a configuration bug that must surface at
    construction, and ``"none"`` is refused because Spark answers it with 400.
    """
    if reasoning_effort is None or not str(reasoning_effort).strip():
        raise ReasoningEffortError(
            "reasoning_effort is not configured: Spark always reasons and has "
            "no default we may invent; set the value fixed from the spike's "
            "measurement (M03) before constructing the Meta LLM backend"
        )
    effort = str(reasoning_effort).strip()
    if effort.lower() == UNAVAILABLE_REASONING_EFFORT:
        raise ReasoningEffortError(
            f'reasoning_effort {effort!r} is unavailable on Spark: the vendor '
            "rejects it with HTTP 400; use the lowest supported effort the "
            "spike measured (M03)"
        )
    return effort


def build_messages(
    *,
    system_prompt: str = "",
    history: Sequence[dict[str, Any]] = (),
    hidden_context: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """Assemble the vendor message array for one turn.

    The stored body's ``system_prompt`` is sent unchanged and first; the
    cascade never rewrites the compiled prompt. History is replayed in order,
    including the assistant message that requested tools, because a tool
    result without it is a vendor 400. Hidden context is appended after the
    history as system message(s) whose content is exactly what was recorded -
    it is never captioned and never spoken.
    """
    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.extend(dict(message) for message in history)
    messages.extend({"role": "system", "content": item} for item in hidden_context)
    return messages


def build_chat_request(
    *,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    reasoning_effort: str,
) -> dict[str, Any]:
    """The exact JSON body for ``POST /chat/completions``.

    One function owns the shape so a test can compare the whole payload. Any
    key not listed here is intentionally unsupported by Spark; adding one is a
    review decision, not a default.
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "reasoning_effort": resolve_reasoning_effort(reasoning_effort),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


class _NoPrefetch(PrefetchHandle):
    """Prefetch speculation is ticket 72; the contract still needs a handle."""

    def cancel(self) -> None:
        return None


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
    """Production HTTP seam. Tests always inject a scripted factory instead.

    This mirrors the adapter in ``backends/gateway_llm.py``; unifying the
    vendor adapters is a separate ticket, and the cascade must stay importable
    without aiohttp installed (the import is lazy).
    """

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



class MetaLLM(LLMStream):
    """``LLMStream`` over Meta's OpenAI-compatible Chat Completions endpoint."""

    def __init__(
        self,
        *,
        reasoning_effort: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str = META_BASE_URL,
        system_prompt: str = "",
        session_factory: Any = None,
        timeout_s: float = 60.0,
    ) -> None:
        # Construction guard first: a Contributor id must fail before any
        # request field exists to leak into (ticket 35).
        self._model = resolve_model(model)
        self._reasoning_effort = resolve_reasoning_effort(reasoning_effort)
        self._api_key = api_key or os.environ.get("META_API_KEY")
        self._base_url = base_url.rstrip("/")
        self._system_prompt = system_prompt
        self._session_factory = session_factory or _AiohttpSession
        self._timeout_s = timeout_s

    @property
    def model(self) -> str:
        return self._model

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    def prefetch(self, *, messages: list[dict[str, Any]]) -> PrefetchHandle:
        return _NoPrefetch()

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        hidden_context: Sequence[str] = (),
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        if not self._api_key:
            raise MetaLLMConfigError(
                "META_API_KEY is not configured: the chat completions request "
                "needs bearer auth, and an unauthenticated request must not be "
                "sent"
            )
        payload = build_chat_request(
            model=self._model,
            messages=build_messages(
                system_prompt=self._system_prompt,
                history=messages,
                hidden_context=hidden_context,
            ),
            tools=tools,
            reasoning_effort=self._reasoning_effort,
        )
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        url = f"{self._base_url}{CHAT_COMPLETIONS_PATH}"
        session = self._session_factory(timeout_s=self._timeout_s)
        async with session as active:
            async with active.post(url, headers=headers, json=payload) as response:
                if response.status != 200:
                    raise MetaLLMRequestError(response.status)
                async for event in self._stream_events(response):
                    yield event

    async def _stream_events(
        self, response: Any
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        """Event parsing seam for tickets 37-39.

        The request contract ends at the wire; this generator yields nothing
        until the delta, reasoning, usage and tool-accumulation tickets fill
        it. Keeping the seam explicit is cheaper than guessing an event shape
        three tickets early.
        """
        return
        yield  # pragma: no cover - makes this an async generator


__all__ = [
    "CHAT_COMPLETIONS_PATH",
    "META_BASE_URL",
    "UNAVAILABLE_REASONING_EFFORT",
    "MetaLLM",
    "MetaLLMConfigError",
    "MetaLLMRequestError",
    "ReasoningEffortError",
    "build_chat_request",
    "build_messages",
    "resolve_reasoning_effort",
]
