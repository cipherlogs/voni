"""Tests for the provider event rules: the final is the only reply trigger.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Event handling. A ``speechStart`` opens the
logical turn, a ``transcript`` only updates its cumulative text, a
``speechEnd`` records the boundary and makes no model request, and only a
``speechComplete`` may be answered.

Every test drives the public ``EventRules.apply`` seam over the ticket-01 kit
(``FakeClock`` for time, ``ScriptedLLM`` for the model), so no test reads the
wall clock or opens a network connection.
"""

import asyncio
import unittest

from cascade.event_rules import EventKind, EventRules
from cascade.meta_stt import SpeechComplete, SpeechEnd, SpeechStart
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.turn_state import LogicalTurnId, TurnPhase, TurnStateStore
from metrics import TimingLedger
from providers import FinalTranscript, PartialTranscript, TokenDelta


async def no_reply(turn):
    """Reply seam for tests that assert no reply is requested."""


class RecordingReplySink:
    """The orchestrator's reply seam: a scripted model request per reply.

    A reply is exactly one ``complete()`` call over the turn's authoritative
    text, which is what the rules under test must gate.
    """

    def __init__(self, llm):
        self.llm = llm
        self.turns = []

    async def __call__(self, turn):
        self.turns.append(turn.id)
        messages = [{"role": "user", "content": turn.final_text}]
        async for _ in self.llm.complete(messages=messages):
            pass


class SpeechStartTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.rules = EventRules(turns=self.turns, on_reply=no_reply)

    def test_a_speech_start_opens_the_logical_turn_and_marks_it_speaking(self):
        outcome = asyncio.run(self.rules.apply(SpeechStart("t1")))

        self.assertEqual(EventKind.SPEECH_START, outcome.kind)
        self.assertIsNotNone(outcome.turn)
        self.assertEqual(LogicalTurnId(0, "t1"), outcome.turn.id)
        self.assertEqual(TurnPhase.SPEAKING, outcome.turn.phase)
        self.assertEqual(0.0, outcome.turn.speech_start)
        self.assertFalse(outcome.reply_requested)

    def test_a_replayed_speech_start_refreshes_the_same_turn(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.5)

        outcome = asyncio.run(self.rules.apply(SpeechStart("t1")))

        self.assertEqual(LogicalTurnId(0, "t1"), outcome.turn.id)
        self.assertEqual(1, len(self.turns.turns()))
        self.assertEqual(2, outcome.turn.speech_starts)
        self.assertEqual(1, outcome.turn.seq)


class PartialTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.sink = RecordingReplySink(self.llm)
        self.rules = EventRules(
            turns=self.turns, ledger=self.ledger, on_reply=self.sink
        )

    def test_a_partial_only_updates_cumulative_text(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.2)

        outcome = asyncio.run(self.rules.apply(PartialTranscript("book a")))

        self.assertEqual(EventKind.PARTIAL, outcome.kind)
        self.assertEqual("book a", outcome.turn.partial_text)
        self.assertEqual("", outcome.turn.final_text)
        self.assertIsNone(outcome.user_text)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual([], self.llm.requests)
        self.assertEqual([], self.sink.turns)

    def test_cumulative_partials_replace_and_count(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        asyncio.run(self.rules.apply(PartialTranscript("book")))
        self.clock.advance(0.3)
        asyncio.run(self.rules.apply(PartialTranscript("book a demo")))

        turn = self.turns.get(LogicalTurnId(0, "t1"))
        self.assertEqual("book a demo", turn.partial_text)
        self.assertEqual(2, turn.partial_updates)

    def test_first_partial_is_marked_once_per_call(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.1)
        asyncio.run(self.rules.apply(PartialTranscript("one")))
        marked_at = self.ledger.summary()["marks"]["first_partial"]

        self.clock.advance(5)
        asyncio.run(self.rules.apply(PartialTranscript("one two")))
        asyncio.run(self.rules.apply(SpeechStart("t2")))
        asyncio.run(self.rules.apply(PartialTranscript("second turn")))

        self.assertEqual(0.1, marked_at)
        self.assertEqual(0.1, self.ledger.summary()["marks"]["first_partial"])


class SpeechEndAndCompleteTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure, happy to."))]])
        self.sink = RecordingReplySink(self.llm)
        self.rules = EventRules(
            turns=self.turns, ledger=self.ledger, on_reply=self.sink
        )

    def test_a_speech_end_records_the_boundary_and_endpointing_and_nothing_else(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.2)
        asyncio.run(self.rules.apply(PartialTranscript("book a")))

        self.clock.advance(1.0)
        outcome = asyncio.run(self.rules.apply(SpeechEnd("t1")))

        self.assertEqual(EventKind.SPEECH_END, outcome.kind)
        self.assertEqual(TurnPhase.ENDPOINTED, outcome.turn.phase)
        self.assertEqual(1.2, outcome.turn.speech_end)
        self.assertEqual(1000.0, outcome.endpointing_ms)
        self.assertEqual("", outcome.turn.final_text)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(1.2, self.ledger.summary()["marks"]["speech_end"])
        self.assertEqual([], self.llm.requests)
        self.assertEqual([], self.sink.turns)

    def test_endpointing_uses_the_speech_start_when_no_partial_arrived(self):
        self.clock.advance(2.0)
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.7)

        outcome = asyncio.run(self.rules.apply(SpeechEnd("t1")))

        self.assertEqual(700.0, outcome.endpointing_ms)
        self.assertEqual(700.0, self.rules.endpointing_ms(outcome.turn))

    def test_an_empty_completion_with_a_partial_still_produces_no_reply(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        asyncio.run(self.rules.apply(PartialTranscript("book a")))
        asyncio.run(self.rules.apply(SpeechEnd("t1")))

        outcome = asyncio.run(self.rules.apply(SpeechComplete(turn_id="t1", text=" ")))

        self.assertEqual(EventKind.NO_SPEECH, outcome.kind)
        self.assertEqual("book a", outcome.turn.partial_text)
        self.assertEqual([], self.sink.turns)
        self.assertEqual([], self.llm.requests)

    def test_no_model_request_happens_between_speech_end_and_speech_complete(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        asyncio.run(self.rules.apply(PartialTranscript("book a")))

        ended = asyncio.run(self.rules.apply(SpeechEnd("t1")))
        self.assertEqual(EventKind.SPEECH_END, ended.kind)
        self.assertEqual(TurnPhase.ENDPOINTED, ended.turn.phase)

        self.assertEqual(0, len(self.llm.requests))
        self.assertEqual(0, self.llm.responses_served)
        self.assertEqual([], self.sink.turns)

        asyncio.run(self.rules.apply(SpeechComplete(turn_id="t1", text="book a demo")))

        self.assertEqual(1, len(self.llm.requests))

    def test_a_completion_creates_the_user_message_from_its_own_text(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        asyncio.run(self.rules.apply(PartialTranscript("book a")))
        asyncio.run(self.rules.apply(SpeechEnd("t1")))
        self.clock.advance(0.2)

        outcome = asyncio.run(
            self.rules.apply(SpeechComplete(turn_id="t1", text="book a demo please"))
        )

        self.assertEqual(EventKind.SPEECH_COMPLETE, outcome.kind)
        self.assertEqual("book a demo please", outcome.user_text)
        self.assertTrue(outcome.reply_requested)
        self.assertEqual([LogicalTurnId(0, "t1")], self.sink.turns)
        self.assertEqual(
            [{"role": "user", "content": "book a demo please"}],
            self.llm.requests[0]["messages"],
        )
        self.assertEqual(0.2, self.ledger.summary()["marks"]["speech_complete"])

    def test_an_empty_completion_is_counted_and_not_answered(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        asyncio.run(self.rules.apply(SpeechEnd("t1")))

        outcome = asyncio.run(self.rules.apply(SpeechComplete(turn_id="t1", text="")))

        self.assertEqual(EventKind.NO_SPEECH, outcome.kind)
        self.assertTrue(outcome.turn.is_empty_final)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(1, self.rules.no_speech_turns)
        self.assertEqual([], self.sink.turns)
        self.assertEqual([], self.llm.requests)

    def test_unknown_event_types_are_ignored(self):
        asyncio.run(self.rules.apply(SpeechStart("t1")))
        self.clock.advance(0.4)

        outcome = asyncio.run(
            self.rules.apply(FinalTranscript(text="not a cascade event"))
        )

        self.assertEqual(EventKind.IGNORED, outcome.kind)
        turn = self.turns.get(LogicalTurnId(0, "t1"))
        self.assertEqual("", turn.final_text)
        self.assertEqual(TurnPhase.SPEAKING, turn.phase)
        self.assertEqual([], self.llm.requests)


if __name__ == "__main__":
    unittest.main()
