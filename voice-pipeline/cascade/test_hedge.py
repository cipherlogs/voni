"""The demo's one bounded model hedge.

Seam: :class:`cascade.hedge.HedgedLLM` wraps the one model client. A slow
primary is joined by one duplicate after the registry bound; the first stream
to produce an event wins and the loser is cancelled. The caller's
``MetaLLMTurn`` is adopted from the winner, so content, tool calls and usage
are the served request's, and the two counters make the extra request visible.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.hedge import HedgedLLM
from cascade.meta_llm import MetaLLMTurn
from providers import TokenDelta


class CountingLedger:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def count(self, name: str) -> None:
        self.counts[name] = self.counts.get(name, 0) + 1


class ScriptedHedgeLLM:
    """The first completion delays; the second answers immediately."""

    def __init__(self, *, first_delay_s: float = 0.0, first: str = "slow", second: str = "fast") -> None:
        self.first_delay_s = first_delay_s
        self.first = first
        self.second = second
        self.calls = 0
        self.cancelled: list[int] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.calls += 1
        index = self.calls
        text = self.first if index == 1 else self.second
        record = turn if turn is not None else MetaLLMTurn()
        try:
            if index == 1 and self.first_delay_s:
                await asyncio.sleep(self.first_delay_s)
            record.content_text += text
            yield TokenDelta(text=text)
            record.finished = True
        finally:
            if index == 1 and not record.finished:
                self.cancelled.append(index)

    def prefetch(self, *, messages):
        raise AssertionError("the hedge wrapper must delegate, not call this")


def collect(stream) -> list:
    async def run():
        return [item async for item in stream]

    return asyncio.run(run())


class HedgedLLMTest(unittest.TestCase):
    def test_a_slow_primary_is_joined_by_the_hedge_and_the_fast_stream_wins(self):
        ledger = CountingLedger()
        inner = ScriptedHedgeLLM(first_delay_s=0.2, first="slow", second="fast")
        hedged = HedgedLLM(inner, delay_ms=20, ledger=ledger)
        turn = MetaLLMTurn()

        events = collect(
            hedged.complete(messages=[{"role": "user", "content": "hi"}], turn=turn)
        )

        self.assertEqual(["fast"], [event.text for event in events])
        self.assertEqual(2, inner.calls, "one primary and one hedge")
        self.assertEqual([1], inner.cancelled, "the losing primary was cancelled")
        self.assertEqual(1, ledger.counts["hedge_started"])
        self.assertEqual(1, ledger.counts["hedge_won"])
        self.assertEqual("fast", turn.content_text, "the winner's record was adopted")
        self.assertTrue(turn.finished)

    def test_a_fast_primary_is_never_hedged(self):
        ledger = CountingLedger()
        inner = ScriptedHedgeLLM(first_delay_s=0.0, first="fast", second="unused")
        hedged = HedgedLLM(inner, delay_ms=50, ledger=ledger)

        events = collect(
            hedged.complete(messages=[{"role": "user", "content": "hi"}], turn=MetaLLMTurn())
        )

        self.assertEqual(["fast"], [event.text for event in events])
        self.assertEqual(1, inner.calls, "no duplicate was started")
        self.assertEqual({}, ledger.counts, "no hedge was counted")

    def test_a_failed_hedge_falls_back_to_the_primary(self):
        class FailingHedge(ScriptedHedgeLLM):
            async def complete(self, *, messages, tools=None, turn=None):
                self.calls += 1
                if self.calls == 2:
                    raise RuntimeError("hedge failed")
                await asyncio.sleep(0.08)
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "primary"
                yield TokenDelta(text="primary")
                record.finished = True

        ledger = CountingLedger()
        inner = FailingHedge(first_delay_s=0.0)
        hedged = HedgedLLM(inner, delay_ms=10, ledger=ledger)

        events = collect(
            hedged.complete(messages=[{"role": "user", "content": "hi"}], turn=MetaLLMTurn())
        )

        self.assertEqual(["primary"], [event.text for event in events])
        self.assertEqual(1, ledger.counts["hedge_started"])
        self.assertNotIn("hedge_won", ledger.counts)

    def test_a_hedge_delay_must_be_positive(self):
        with self.assertRaises(ValueError):
            HedgedLLM(ScriptedHedgeLLM(), delay_ms=0)


if __name__ == "__main__":
    unittest.main()
