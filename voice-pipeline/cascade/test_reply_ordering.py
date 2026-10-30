"""Ticket 69: reply ordering and the bounded stall guard.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Reply ordering. A later turn's final is answered
only after every earlier logical turn has settled, because answering turn 2
before turn 1 inverts the conversation. The wait is bounded by the named
``turn.stall_guard_ms`` bound: an earlier turn that never finishes is closed
with no reply, recorded, and the later turn is still answered. The guard is
measured on the injected clock — these tests move a ``FakeClock`` and never
sleep — and a non-advancing clock must not fire it.

Seams under test:

* ``EventRules.apply`` -> the reply sink's call order and the logical turn the
  sink received. Catches an out-of-order reply, a reply invented for an
  abandoned turn and a lost later turn.
* ``EventRules.tick`` -> the abandonment record (turn id, waited gap, guard
  value, close reason). Catches a guard that never fires, fires early, or
  closes a turn without recording it.
* ``EventRules.settle`` -> the point a finished reply stops blocking the next
  final. Catches a queue that answers two replies at once.
"""

import asyncio
import unittest
from unittest import mock

from cascade.event_rules import EventRules, STALL_GUARD_BOUND
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.testing.clock import FakeClock, FrozenClock
from cascade.thresholds import UnsetBoundError, bound
from cascade.turn_state import LogicalTurnId, TurnPhase, TurnStateStore


class RecordingSink:
    """The reply seam: one recorded call per reply actually requested."""

    def __init__(self):
        self.turns = []

    async def __call__(self, turn):
        self.turns.append(turn.id)


def t(key: str) -> LogicalTurnId:
    return LogicalTurnId(0, key)


class ReplyOrderingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.sink = RecordingSink()
        self.rules = EventRules(turns=self.turns, on_reply=self.sink)

    def apply(self, event):
        return asyncio.run(self.rules.apply(event))

    def open_turn(self, key: str, advance: float = 0.0):
        if advance:
            self.clock.advance(advance)
        return self.apply(SpeechStart(key))

    def complete(self, key: str, text: str, advance: float = 0.0):
        if advance:
            self.clock.advance(advance)
        return self.apply(SpeechComplete(turn_id=key, text=text))

    # -- AC1: a later final waits for the earlier turn --------------------

    def test_a_later_final_waits_for_the_earlier_open_turn(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)

        outcome = self.complete("t2", "the second thing", advance=0.1)

        self.assertFalse(outcome.reply_requested)
        self.assertTrue(outcome.held)
        self.assertEqual([], self.sink.turns)
        self.assertEqual([t("t2")], [held.id for held in self.rules.reply_order.held])
        self.assertEqual(TurnPhase.FINALISED, self.turns.get(t("t2")).phase)

    def test_the_earlier_final_is_answered_before_the_held_one(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)

        first = self.complete("t1", "the first thing", advance=0.3)

        self.assertTrue(first.reply_requested)
        self.assertEqual([t("t1")], self.sink.turns)
        asyncio.run(self.rules.settle("t1"))
        self.assertEqual([t("t1"), t("t2")], self.sink.turns)

    # -- AC4: turn 2 finishes first; order and the recorded gap ----------

    def test_turn_two_finishing_first_is_answered_second_with_the_recorded_gap(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)  # held at t=0.2
        self.complete("t1", "the first thing", advance=0.3)  # answered at t=0.5
        self.clock.advance(0.1)
        delivery = asyncio.run(self.rules.settle("t1"))  # settles at t=0.6

        self.assertEqual([t("t1"), t("t2")], self.sink.turns)
        self.assertEqual([t("t2")], [record.turn_id for record in delivery.answered])
        record = self.rules.reply_order.answered[-1]
        self.assertEqual(t("t2"), record.turn_id)
        self.assertEqual(400.0, record.waited_ms)
        self.assertEqual((t("t1"),), record.blocked_by)

    # -- AC2 + AC3: the guard, the record, and the later reply -----------

    def test_the_guard_closes_the_abandoned_turn_and_answers_the_later_one(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)  # wait starts at 0.2

        self.clock.advance_ms(2_499)
        early = asyncio.run(self.rules.tick())
        self.assertEqual((), early.abandoned)
        self.assertEqual([], self.sink.turns)
        self.clock.advance_ms(1)  # exactly 2,500 ms of waiting
        fired = asyncio.run(self.rules.tick())

        self.assertEqual(1, len(fired.abandoned))
        abandoned = fired.abandoned[0]
        self.assertEqual(t("t1"), abandoned.turn_id)
        self.assertEqual(2_500.0, abandoned.guard_ms)
        self.assertEqual(2_500.0, abandoned.waited_ms)
        self.assertEqual("abandoned", self.turns.get(t("t1")).close_reason)
        self.assertEqual(TurnPhase.CLOSED, self.turns.get(t("t1")).phase)
        self.assertEqual("", self.turns.get(t("t1")).final_text)
        self.assertEqual([t("t2")], [record.turn_id for record in fired.answered])
        self.assertEqual([t("t2")], self.sink.turns)

    def test_the_later_turn_is_answered_exactly_once_after_the_guard(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)
        asyncio.run(self.rules.tick())

        duplicate = self.complete("t2", "the second thing")

        self.assertFalse(duplicate.reply_requested)
        self.assertEqual(1, len(self.sink.turns))
        self.assertEqual(1, self.turns.get(t("t2")).duplicate_finals)

    def test_a_late_final_from_the_abandoned_turn_is_never_answered(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)
        asyncio.run(self.rules.tick())

        late = self.complete("t1", "the first thing")

        self.assertFalse(late.reply_requested)
        self.assertEqual([t("t2")], self.sink.turns)
        self.assertEqual("", self.turns.get(t("t1")).final_text)

    def test_the_abandonment_is_recorded_and_visible_on_the_guard_outcome(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)

        asyncio.run(self.rules.tick())

        self.assertEqual(1, len(self.rules.reply_order.abandonments))
        record = self.rules.reply_order.abandonments[0]
        self.assertEqual(t("t1"), record.turn_id)
        self.assertEqual("no reply: the caller never finished the turn", record.reason)
        self.assertEqual(("turn.stall_guard_ms",), (record.bound,))

    def test_a_new_final_after_the_deadline_triggers_the_guard_first(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)
        self.open_turn("t3", advance=0.0)

        outcome = self.complete("t3", "the third thing")

        # The guard abandoned t1 and answered the final that was waiting for
        # it; the new final still waits for that reply to settle.
        self.assertEqual(1, len(outcome.abandoned))
        self.assertEqual(t("t1"), outcome.abandoned[0].turn_id)
        self.assertTrue(outcome.held)
        self.assertEqual([t("t2")], self.sink.turns)

        self.clock.advance(0.1)
        delivery = asyncio.run(self.rules.settle("t2"))

        self.assertEqual([t("t2"), t("t3")], self.sink.turns)
        self.assertEqual([t("t3")], [record.turn_id for record in delivery.answered])

    # -- the clock and the bound, never a number in this module ----------

    def test_a_non_advancing_clock_never_fires_the_guard(self):
        self.clock = FrozenClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.sink = RecordingSink()
        self.rules = EventRules(turns=self.turns, on_reply=self.sink)
        self.open_turn("t1")
        self.open_turn("t2")
        self.complete("t2", "the second thing")

        for _ in range(5):
            delivery = asyncio.run(self.rules.tick())

        self.assertEqual((), delivery.abandoned)
        self.assertEqual([], self.sink.turns)
        self.assertEqual(TurnPhase.SPEAKING, self.turns.get(t("t1")).phase)

    def test_the_guard_never_sleeps(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)

        with mock.patch("asyncio.sleep", side_effect=AssertionError("the guard slept")):
            delivery = asyncio.run(self.rules.tick())

        self.assertEqual(1, len(delivery.abandoned))

    def test_the_guard_reads_the_named_bound_from_the_registry(self):
        self.assertEqual("turn.stall_guard_ms", STALL_GUARD_BOUND)
        self.assertEqual(2_500.0, self.rules.reply_order.guard_ms)

        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        with mock.patch(
            "cascade.event_rules.require_bound", return_value=10
        ) as require:
            self.clock.advance_ms(10)
            delivery = asyncio.run(self.rules.tick())

        require.assert_called_with(STALL_GUARD_BOUND)
        self.assertEqual(1, len(delivery.abandoned))

    def test_an_unset_bound_refuses_by_name_instead_of_defaulting(self):
        self.open_turn("t1")
        self.open_turn("t2", advance=0.1)
        self.complete("t2", "the second thing", advance=0.1)
        self.clock.advance_ms(2_500)

        with mock.patch(
            "cascade.event_rules.require_bound",
            side_effect=UnsetBoundError(bound(STALL_GUARD_BOUND)),
        ):
            with self.assertRaises(UnsetBoundError) as caught:
                asyncio.run(self.rules.tick())

        self.assertEqual("turn.stall_guard_ms", caught.exception.name)
        self.assertEqual([], self.sink.turns)


if __name__ == "__main__":
    unittest.main()
