"""Tests for logical turn identity and keyed turn state (ticket 66).

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" and the turn-overlap rules in the Meta speech
backend. The identity is ``(sessionEpoch, providerTurnId)`` because the vendor
reuses a ``turnId`` after a reconnect, and turns may overlap.
"""

import unittest

from cascade.testing.clock import FakeClock
from cascade.turn_state import LogicalTurnId, TurnPhase, TurnStateStore


class LogicalTurnIdentityTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")

    def test_a_logical_turn_is_the_epoch_plus_the_provider_turn_id(self):
        turn = self.turns.open("t1")
        self.assertEqual(
            LogicalTurnId(session_epoch=0, provider_turn_id="t1"), turn.id
        )

    def test_a_reused_provider_turn_id_in_a_new_epoch_is_a_distinct_turn(self):
        first = self.turns.open("t1")
        self.turns.finalise("book a demo", turn="t1")
        self.turns.close(first, reason="replied")

        self.clock.advance(60)
        self.turns.new_epoch()
        second = self.turns.open("t1")

        self.assertNotEqual(first.id, second.id)
        self.assertIsNot(first, second)
        self.assertEqual("book a demo", first.final_text)
        self.assertEqual("", second.partial_text)
        self.assertEqual("", second.final_text)
        self.assertEqual(2, len(self.turns.turns()))

    def test_events_from_a_replaced_epoch_are_ignored(self):
        old = self.turns.open("t1")
        self.turns.new_epoch()

        self.assertIsNone(self.turns.partial("late words", epoch=0))
        self.assertIsNone(self.turns.finalise("late words", turn="t1", epoch=0))
        self.assertEqual("", old.partial_text)
        self.assertEqual("", old.final_text)

    def test_an_unknown_turn_and_a_replaced_epoch_are_different_answers(self):
        self.turns.open("t1")

        self.assertEqual(LogicalTurnId(0, "t1"), self.turns.resolve("t1"))
        self.assertIsNone(self.turns.resolve("never-seen"))

        self.turns.new_epoch()
        self.assertIsNone(self.turns.resolve("t1", epoch=0))

    def test_two_turns_open_at_once_never_share_state(self):
        one = self.turns.open("t1")
        self.turns.partial("I want a demo", epoch=0)

        two = self.turns.open("t2")
        self.turns.partial("no wait", epoch=0)

        self.assertEqual("I want a demo", one.partial_text)
        self.assertEqual("no wait", two.partial_text)
        self.assertLess(one.seq, two.seq)
        self.assertEqual((one, two), self.turns.open_turns())

    def test_a_late_completion_lands_in_its_own_turn(self):
        one = self.turns.open("t1")
        two = self.turns.open("t2")
        self.turns.partial("second caller words", epoch=0)

        self.turns.finalise("first caller words", turn="t1")

        self.assertEqual("first caller words", one.final_text)
        self.assertEqual("", two.final_text)
        self.assertEqual("second caller words", two.partial_text)


class TurnLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")

    def test_the_speech_start_comes_from_the_injected_clock(self):
        self.clock.advance(3.25)
        turn = self.turns.open("t1")
        self.assertEqual(3.25, turn.speech_start)

    def test_a_partial_with_no_start_is_not_attributed_to_any_turn(self):
        self.assertIsNone(self.turns.partial("hello"))
        self.assertEqual((), self.turns.turns())

    def test_speech_end_records_the_boundary_without_a_final(self):
        turn = self.turns.open("t1")
        self.clock.advance(0.4)

        ended = self.turns.end(turn="t1")

        self.assertIs(turn, ended)
        self.assertEqual(0.4, turn.speech_end)
        self.assertEqual(TurnPhase.ENDPOINTED, turn.phase)
        self.assertFalse(turn.is_finalised)
        self.assertEqual("", turn.final_text)

    def test_the_final_text_is_authoritative_over_the_last_partial(self):
        turn = self.turns.open("t1")
        self.turns.partial("book a", epoch=0)
        self.clock.advance(0.4)
        self.turns.end(turn="t1")
        self.clock.advance(0.2)

        self.turns.finalise("book a demo please", turn="t1")

        self.assertEqual("book a demo please", turn.final_text)
        self.assertEqual("book a", turn.partial_text)
        self.assertEqual(0.4, turn.speech_end)
        self.assertAlmostEqual(0.6, turn.finalised_at)
        self.assertEqual(TurnPhase.FINALISED, turn.phase)

    def test_a_duplicate_completion_keeps_the_first_text(self):
        turn = self.turns.open("t1")
        self.turns.finalise("first", turn="t1")
        self.clock.advance(1.0)

        self.turns.finalise("different second text", turn="t1")

        self.assertEqual("first", turn.final_text)
        self.assertEqual(0.0, turn.finalised_at)
        self.assertEqual(1, turn.duplicate_finals)

    def test_close_records_the_phase_and_the_reason(self):
        turn = self.turns.open("t1")
        self.clock.advance(2.0)

        self.turns.close(turn, reason="abandoned")

        self.assertEqual(TurnPhase.CLOSED, turn.phase)
        self.assertEqual("abandoned", turn.close_reason)
        self.assertEqual(2.0, turn.closed_at)
        self.assertEqual((), self.turns.open_turns())

    def test_a_start_after_close_does_not_reopen_the_same_turn(self):
        turn = self.turns.open("t1")
        self.turns.close(turn, reason="replied")

        self.assertIsNone(self.turns.open("t1"))
        self.assertEqual(TurnPhase.CLOSED, turn.phase)

        later = self.turns.open("t2")
        self.assertIsNot(turn, later)


class KeyedTurnStateTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")

    def test_every_piece_of_turn_state_hangs_off_its_logical_turn(self):
        one = self.turns.open("t1")
        two = self.turns.open("t2")

        self.turns.partial("first words", turn=one)
        one.tool_loop.calls.append("lookup(id=1)")
        one.tool_loop.memo[("lookup", '{"id": 1}')] = "found"
        one.reply.text = "Here it is"
        self.clock.advance(0.5)
        self.turns.cut(one)

        self.assertEqual("first words", one.partial_text)
        self.assertEqual(["lookup(id=1)"], one.tool_loop.calls)
        self.assertEqual("found", one.tool_loop.memo[("lookup", '{"id": 1}')])
        self.assertEqual("Here it is", one.reply.text)
        self.assertEqual(0.5, one.cut_point)
        self.assertEqual("meta", one.attribution.source)

        self.assertEqual("", two.partial_text)
        self.assertEqual([], two.tool_loop.calls)
        self.assertEqual({}, two.tool_loop.memo)
        self.assertEqual("", two.reply.text)
        self.assertIsNone(two.cut_point)
        self.assertIsNot(one.tool_loop.calls, two.tool_loop.calls)
        self.assertIsNot(one.reply, two.reply)

    def test_the_audio_cut_point_is_first_write_wins(self):
        turn = self.turns.open("t1")
        self.clock.advance(0.5)
        self.turns.cut(turn)
        self.clock.advance(0.5)

        self.turns.cut(turn)

        self.assertEqual(0.5, turn.cut_point)

    def test_a_reconnect_maps_a_new_provider_turn_id_to_the_existing_logical_turn(
        self,
    ):
        turn = self.turns.open("t1", source="meta")
        self.turns.partial("book a", epoch=0)
        self.clock.advance(120)

        epoch = self.turns.new_epoch(source="meta")
        self.assertEqual(1, epoch)
        self.assertEqual(turn.id, self.turns.bind("t9", turn, epoch=epoch))

        replayed = self.turns.open("t9", epoch=epoch)
        self.assertIs(turn, replayed)
        self.turns.finalise("book a demo", turn="t9", epoch=epoch)

        self.assertEqual("book a demo", turn.final_text)
        self.assertEqual(LogicalTurnId(0, "t1"), turn.id)
        self.assertEqual(1, turn.attribution.session_epoch)
        self.assertEqual("t9", turn.attribution.provider_turn_id)
        self.assertEqual(["t1"], [a.provider_turn_id for a in turn.attribution_history])
        self.assertEqual(1, len(self.turns.turns()))


if __name__ == "__main__":
    unittest.main()
