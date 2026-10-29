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

Stream parsing lives in :class:`MetaLLMTurn` and the SSE reader: content deltas
are the only speech, ``reasoning_content`` is recorded for usage and telemetry
and never yielded, and the first content delta marks ``first_token``. Tool-call
accumulation, argument validation, usage recording, finish reasons and the
failure policy are tickets 38-45; ``_stream_events`` leaves their seams open.

The per-turn record is how a caller reads what the stream produced without
re-parsing it: pass a :class:`MetaLLMTurn` to ``complete()`` (or read
``last_turn`` afterwards). A record is never shared between turns.
"""

from __future__ import annotations

import codecs
import json
import os
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any

from cascade.model_guard import resolve_model
from providers import LLMStream, PrefetchHandle, TokenDelta, ToolCallRequest

META_BASE_URL = "https://api.meta.ai/v1"

CHAT_COMPLETIONS_PATH = "/chat/completions"

#: Spark always reasons; asking it not to is a vendor 400, not a speed knob.
UNAVAILABLE_REASONING_EFFORT = "none"

#: The SSE terminator; everything after it is not part of this completion.
SSE_DONE = "[DONE]"

#: The ledger mark the first *content* delta records (never reasoning).
FIRST_TOKEN_MARK = "first_token"


class MetaLLMConfigError(RuntimeError):
    """A required piece of backend configuration is missing."""


class MetaLLMStreamError(RuntimeError):
    """The vendor sent a stream frame this backend cannot read.

    A malformed frame is a provider contract violation, not a token: parsing it
    as text would put vendor noise in the caller's ear.
    """


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


@dataclass(slots=True)
class MetaLLMTurn:
    """Everything one completion produced, held apart from the wire.

    Created per ``complete()`` call. Nothing here is shared between turns, and
    ``close()`` is idempotent so an early exit (a barge-in cancelling the
    stream) records the same facts as a normal finish.

    ``reasoning_text`` is the model's private reasoning. It is recorded for
    usage and telemetry; it is never yielded to synthesis.
    """

    reasoning_text: str = ""
    reasoning_deltas: int = 0
    content_text: str = ""
    finish_reason: str | None = None
    closed: bool = False

    def close(self) -> None:
        """Finalise the record; safe to call more than once."""
        if self.closed:
            return
        self.closed = True


class _SSEParser:
    """Incremental Server-Sent Events reader over a stream of byte chunks.

    A chunk boundary is a *byte* boundary, so UTF-8 decoding is incremental: a
    multi-byte character may be split across two chunks and must still arrive
    whole. A line boundary is a newline; a blank line dispatches one event.
    Comments (``:`` heartbeat) and non-``data`` fields carry no payload.
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._data: list[str] = []
        self.done = False

    def feed(self, chunk: bytes) -> list[str]:
        return self._lines(self._decoder.decode(chunk))

    def close(self) -> list[str]:
        """Flush a final line and any trailing event the vendor did not end."""
        payloads = self._lines(self._decoder.decode(b"", final=True))
        if self.done:
            return payloads
        if self._buffer:
            payload = self._line(self._buffer)
            self._buffer = ""
            if payload is not None:
                payloads.append(payload)
        payload = self._line("")
        if payload is not None:
            payloads.append(payload)
        return payloads

    def _lines(self, text: str) -> list[str]:
        self._buffer += text
        payloads: list[str] = []
        while not self.done and "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            payload = self._line(line)
            if payload is not None:
                payloads.append(payload)
        if self.done:
            self._buffer = ""
        return payloads

    def _line(self, raw: str) -> str | None:
        line = raw.rstrip("\r")
        if not line:
            if not self._data:
                return None
            payload = "\n".join(self._data)
            self._data = []
            if payload.strip() == SSE_DONE:
                self.done = True
                return None
            return payload
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        if field != "data":
            return None
        self._data.append(value[1:] if value.startswith(" ") else value)
        return None


def _reasoning_delta(delta: dict[str, Any]) -> str:
    """The reasoning text in one delta, under either vendor spelling."""
    for key in ("reasoning_content", "reasoning"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


class _TurnStream:
    """Turns decoded SSE payloads into provider events and one turn record.

    Content deltas are yielded as ``TokenDelta`` the moment they arrive, so
    synthesis starts on the first spoken word. Reasoning is folded into the
    record only. Anything that must wait for the whole turn (tool-call
    accumulation, usage, finish disposition) is kept here, not re-parsed later.
    """

    def __init__(self, turn: MetaLLMTurn, ledger: Any = None) -> None:
        self.turn = turn
        self._ledger = ledger

    def consume(self, payload: str) -> list[TokenDelta]:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as error:
            raise MetaLLMStreamError(
                f"Meta stream frame is not JSON: {payload[:120]!r}"
            ) from error
        if not isinstance(data, dict):
            raise MetaLLMStreamError(
                f"Meta stream frame is not an object: {payload[:120]!r}"
            )
        emitted: list[TokenDelta] = []
        for choice in data.get("choices") or ():
            delta = choice.get("delta") or {}
            self._record_reasoning(_reasoning_delta(delta))
            emitted.extend(self._content(delta.get("content")))
            finish = choice.get("finish_reason")
            if finish:
                self.turn.finish_reason = finish
        return emitted

    def _record_reasoning(self, text: str) -> None:
        if not text:
            return
        if self.turn.reasoning_deltas == 0:
            self.turn.reasoning_text = text
        else:
            self.turn.reasoning_text += text
        self.turn.reasoning_deltas += 1

    def _content(self, content: Any) -> list[TokenDelta]:
        if not isinstance(content, str) or not content:
            return []
        first_content = not self.turn.content_text
        self.turn.content_text += content
        if first_content and self._ledger is not None:
            self._ledger.mark(FIRST_TOKEN_MARK)
        return [TokenDelta(text=content)]


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
        ledger: Any = None,
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
        # Optional ``TimingLedger``-shaped sink: the first content delta marks
        # ``first_token``. Marking is first-write-wins, so an orchestrator that
        # also marks it is harmless.
        self._ledger = ledger
        self._last_turn: MetaLLMTurn | None = None

    @property
    def model(self) -> str:
        return self._model

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    @property
    def last_turn(self) -> MetaLLMTurn | None:
        """The record of the most recent ``complete()`` call, if any.

        Convenience for a caller driving one completion at a time. A caller
        that may overlap completions passes its own ``turn=`` record instead.
        """
        return self._last_turn

    def prefetch(self, *, messages: list[dict[str, Any]]) -> PrefetchHandle:
        return _NoPrefetch()

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        hidden_context: Sequence[str] = (),
        turn: MetaLLMTurn | None = None,
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
        record = turn if turn is not None else MetaLLMTurn()
        self._last_turn = record
        stream = _TurnStream(record, self._ledger)
        parser = _SSEParser()
        session = self._session_factory(timeout_s=self._timeout_s)
        try:
            async with session as active:
                async with active.post(url, headers=headers, json=payload) as response:
                    if response.status != 200:
                        raise MetaLLMRequestError(response.status)
                    async for chunk in response.iter_bytes():
                        for frame in parser.feed(chunk):
                            for event in stream.consume(frame):
                                yield event
                    for frame in parser.close():
                        for event in stream.consume(frame):
                            yield event
        finally:
            record.close()

    async def _stream_events(
        self, response: Any
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        """Chunk-level seam kept for tests of the reader itself.

        ``complete()`` drives the parser directly so it can finalise the turn
        when the caller stops consuming early.
        """
        parser = _SSEParser()
        stream = _TurnStream(MetaLLMTurn(), self._ledger)
        async for chunk in response.iter_bytes():
            for frame in parser.feed(chunk):
                for event in stream.consume(frame):
                    yield event
        for frame in parser.close():
            for event in stream.consume(frame):
                yield event


__all__ = [
    "CHAT_COMPLETIONS_PATH",
    "FIRST_TOKEN_MARK",
    "META_BASE_URL",
    "SSE_DONE",
    "UNAVAILABLE_REASONING_EFFORT",
    "MetaLLM",
    "MetaLLMConfigError",
    "MetaLLMRequestError",
    "MetaLLMStreamError",
    "MetaLLMTurn",
    "ReasoningEffortError",
    "build_chat_request",
    "build_messages",
    "resolve_reasoning_effort",
]
