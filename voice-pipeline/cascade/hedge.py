"""One bounded hedge for the demo's model turn.

Meta's first token is bursty: the same request measures p50 ~2.0 s and p90
~2.5 s, with a 4 s tail. A second, identical request started after the
registry's bound turns that tail into a race: the first stream to produce an
event wins, the other is cancelled. A fast first request is never hedged.

This is not a retry and not a fallback: the loser is cancelled, never spoken.
The winner's record is adopted onto the caller's ``MetaLLMTurn`` so the turn's
content, tool calls and usage are the ones that were actually served. The two
ledger counters (``hedge_started``, ``hedge_won``) make the extra request
visible on the same call artifact as the reply gap.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from cascade.meta_llm import MetaLLMTurn
from cascade.thresholds import require_bound
from providers import TokenDelta, ToolCallRequest

#: The registry bound that says how long the primary may stay silent before a
#: duplicate is allowed. Never restated here.
HEDGE_DELAY_BOUND = "llm.hedge_delay_ms"


async def _next(iterator: AsyncIterator[Any]) -> Any | None:
    """One item, or ``None`` for a stream that ended without producing one."""
    try:
        return await iterator.__anext__()
    except StopAsyncIteration:
        return None


async def _cancel(iterator: AsyncIterator[Any] | None, task: asyncio.Task | None) -> None:
    """Cancel a losing stream and close its generator, swallowing its teardown."""
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    close = getattr(iterator, "aclose", None)
    if close is not None:
        try:
            await close()
        except Exception:  # pragma: no cover - a closed vendor socket is clean
            pass


class HedgedLLM:
    """Wrap one ``LLMStream`` with the demo's single bounded hedge.

    ``delay_ms`` is injectable for tests; production reads the registry bound.
    The wrapper delegates every other attribute (``prefetch``, ``model``,
    ``provider``) to the wrapped client, so it is a drop-in ``LLMStream``.
    """

    def __init__(
        self,
        inner: Any,
        *,
        delay_ms: float | None = None,
        ledger: Any = None,
    ) -> None:
        self._inner = inner
        delay = float(require_bound(HEDGE_DELAY_BOUND)) if delay_ms is None else float(delay_ms)
        if delay <= 0:
            raise ValueError(f"a hedge delay must be positive, got {delay:g} ms")
        self._delay_s = delay / 1000.0
        self._ledger = ledger

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def prefetch(self, *, messages: list[dict[str, Any]]) -> Any:
        return self._inner.prefetch(messages=messages)

    def _count(self, name: str) -> None:
        count = getattr(self._ledger, "count", None)
        if callable(count):
            count(name)

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        turn: MetaLLMTurn | None = None,
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        first_record = turn if turn is not None else MetaLLMTurn()
        first = self._inner.complete(messages=messages, tools=tools, turn=first_record)
        first_iter = first.__aiter__()
        first_task = asyncio.ensure_future(_next(first_iter))
        timer = asyncio.ensure_future(asyncio.sleep(self._delay_s))

        winner_iter: AsyncIterator[Any] = first_iter
        winner_record = first_record
        loser_iter: AsyncIterator[Any] | None = None
        loser_task: asyncio.Task | None = None
        event: Any = None
        try:
            done, _ = await asyncio.wait(
                {first_task, timer}, return_when=asyncio.FIRST_COMPLETED
            )
            if first_task in done:
                timer.cancel()
                await asyncio.gather(timer, return_exceptions=True)
                event = first_task.result()
            else:
                self._count("hedge_started")
                hedge_record = MetaLLMTurn()
                hedge = self._inner.complete(
                    messages=messages, tools=tools, turn=hedge_record
                )
                hedge_iter = hedge.__aiter__()
                hedge_task = asyncio.ensure_future(_next(hedge_iter))
                done, _ = await asyncio.wait(
                    {first_task, hedge_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if hedge_task in done:
                    try:
                        event = hedge_task.result()
                    except Exception:
                        # A failed speculation is not the call: fall back to
                        # the primary request, which is still in flight.
                        event = await first_task
                    else:
                        winner_iter, winner_record = hedge_iter, hedge_record
                        loser_iter, loser_task = first_iter, first_task
                        self._count("hedge_won")
                else:
                    event = first_task.result()
                    loser_iter, loser_task = hedge_iter, hedge_task
                if winner_iter is hedge_iter:
                    await _cancel(loser_iter, loser_task)
                else:
                    await _cancel(hedge_iter, hedge_task)
            if event is None:
                return
            yield event
            async for item in winner_iter:
                yield item
        finally:
            timer.cancel()
            if loser_iter is not None:
                await _cancel(loser_iter, loser_task)
            # The caller holds the first record; make it the served one.
            if first_record is not winner_record:
                first_record.adopt(winner_record)
