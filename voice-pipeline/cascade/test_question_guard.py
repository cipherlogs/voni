"""The unanswered-question guard: no second question until the caller answers.

Seam: :meth:`cascade.turn_stream.CascadeTurnStream._speak`, the same point
between a complete sentence and its synthesis request that withholds a repeat.
The rule is behavioural, not lexical: after Voni asks a question, the caller's
next final is an answer only when it shares at least one content word with that
question. If it does not, every question sentence in the next reply is
withheld before synthesis, and one bounded repair is asked when nothing else
was left to say.

The tests drive the public event seam and assert what the caller hears, the
metric counters and the trace row.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_turn_stream import FakeTTS, RecordingAudio, ScriptedLLM
from cascade.testing import FakeClock
from cascade.turn_stream import CascadeTurnStream, ReplyQuestionOnly
from metrics import TimingLedger

FIRST_QUESTION = "What does your business do?"
SECOND_QUESTION = "Which business are we looking at today?"
REPAIR_STATEMENT = "That's okay. We can go slow."

#: The live transcript's caller lines: both leave the question unanswered.
OVERWHELMED = "I am a bit overwhelmed."
STILL_UNANSWERED = "There are so many things maybe the thing from last time?"

#: The measured hostile call (71d37258): neither agent sentence carries a "?".
HOSTILE_INTRO = "This is ridiculous. Your service is useless."
HOSTILE_AGAIN = "Do not give me that scripted rubbish. Just fix it."
HOSTILE_FIRST = (
    "Tell me what just went wrong and I'll sort what I can from here"
)
HOSTILE_SECOND = (
    "What exactly needs fixing right now so I can get it done"
)


class RecordingTurnLedger:
    """A turn ledger that keeps every row the stream writes."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)

        def record(*args, **kwargs):
            self.rows.append((name, args, kwargs))

        return record

    def only(self, name: str) -> list[tuple[str, tuple, dict]]:
        return [row for row in self.rows if row[0] == name]


class QuestionGuardTests(unittest.TestCase):
    def make(self, replies, *, history=(), turn_events=None):
        self.clock = FakeClock()
        self.audio = RecordingAudio()
        self.llm = ScriptedLLM(replies)
        self.tts = FakeTTS()
        self.ledger = TimingLedger(now=self.clock)
        self.stream = CascadeTurnStream(
            llm=self.llm,
            tts=self.tts,
            tools=(),
            emit_audio=self.audio,
            ledger=self.ledger,
            clock=self.clock,
            history=history,
            turn_events=turn_events,
        )
        return self.stream

    async def settle(self, stream: CascadeTurnStream, turns: int) -> None:
        for _ in range(1000):
            if stream.turn_count() >= turns:
                return
            await asyncio.sleep(0)
        self.fail(f"the stream only completed {stream.turn_count()} of {turns} turns")

    def run_turns(self, stream: CascadeTurnStream, texts) -> None:
        async def run():
            await stream.start()
            for number, text in enumerate(texts, 1):
                await stream.event(SpeechStart(f"t{number}"))
                await stream.event(SpeechComplete(text, turn_id=f"t{number}"))
                await self.settle(stream, number)
            await stream.drain()

        asyncio.run(run())

    def test_an_unanswered_question_is_withheld_and_repaired(self):
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [SECOND_QUESTION]},
                {"deltas": [REPAIR_STATEMENT]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        # The caller hears the first question and the repair; the second
        # question is never synthesized.
        self.assertEqual([FIRST_QUESTION, REPAIR_STATEMENT], self.tts.spoken)
        self.assertEqual(1, stream.question_withheld)
        self.assertEqual(1, stream.question_repair)
        self.assertEqual(3, stream.request_count())
        self.assertEqual(2, stream.turn_count())
        counts = self.ledger.summary()["counts"]
        self.assertEqual(1, counts["question_withheld"])
        self.assertEqual(1, counts["question_repair"])

    def test_the_measured_hostile_question_without_a_mark_is_withheld(self):
        repaired = "We can take this one step at a time."
        stream = self.make(
            replies=[
                {"deltas": [HOSTILE_FIRST]},
                {"deltas": [HOSTILE_SECOND]},
                {"deltas": [repaired]},
            ]
        )

        self.run_turns(stream, [HOSTILE_INTRO, HOSTILE_AGAIN])

        # The first question is heard; the second, with no "?", is withheld
        # because the caller still has not answered the first.
        self.assertEqual([HOSTILE_FIRST, repaired], self.tts.spoken)
        self.assertEqual(1, stream.question_withheld)
        self.assertEqual(1, stream.question_repair)
        self.assertEqual(3, stream.request_count())
        self.assertEqual(2, stream.turn_count())

    def test_a_statement_starting_with_a_normal_word_is_not_a_question(self):
        statement = "Your service is covered."
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [statement]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        self.assertEqual([FIRST_QUESTION, statement], self.tts.spoken)
        self.assertEqual(0, stream.question_withheld)

    def test_an_answered_question_allows_the_next_question_without_a_mark(self):
        answer = "We run a plumbing business on Main Street."
        next_question = "Which plumbing jobs do you take"
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [next_question]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, answer])

        self.assertEqual([FIRST_QUESTION, next_question], self.tts.spoken)
        self.assertEqual(0, stream.question_withheld)

    def test_the_repair_request_tells_the_model_not_to_ask_again(self):
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [SECOND_QUESTION]},
                {"deltas": [REPAIR_STATEMENT]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        repair_system = [
            message["content"]
            for message in self.llm.requests[2]
            if message["role"] == "system"
        ]
        self.assertIn(
            "They did not answer your last question. Respond to what they just "
            "said; do not ask another question.",
            repair_system,
        )

    def test_an_answer_sharing_a_content_word_allows_the_next_question(self):
        answer = "We run a plumbing business on Main Street."
        next_question = "Which plumbing jobs do you take?"
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [next_question]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, answer])

        self.assertEqual([FIRST_QUESTION, next_question], self.tts.spoken)
        self.assertEqual(0, stream.question_withheld)
        self.assertEqual(0, stream.question_repair)
        self.assertEqual(2, stream.request_count())

    def test_a_statement_reply_after_an_unanswered_question_is_untouched(self):
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [REPAIR_STATEMENT]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        self.assertEqual([FIRST_QUESTION, REPAIR_STATEMENT], self.tts.spoken)
        self.assertEqual(0, stream.question_withheld)
        self.assertEqual(0, stream.question_repair)
        self.assertEqual(2, stream.request_count())

    def test_the_guard_stays_until_the_caller_answers(self):
        third_question = "Which business is this appointment for?"
        calm = "We can take this one step at a time."
        later_question = "Which plumbing appointment do you mean?"
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [SECOND_QUESTION]},
                {"deltas": [REPAIR_STATEMENT]},
                {"deltas": [third_question]},
                {"deltas": [calm]},
                {"deltas": [later_question]},
            ]
        )

        # The live transcript's third paraphrase: the caller still has not
        # answered, so the question is withheld again. Only after a shared
        # content word ("business") is a new question allowed.
        self.run_turns(
            stream,
            [
                OVERWHELMED,
                STILL_UNANSWERED,
                "The appointment. The one I missed.",
                "It is a plumbing business.",
            ],
        )

        self.assertEqual(
            [FIRST_QUESTION, REPAIR_STATEMENT, calm, later_question],
            self.tts.spoken,
        )
        self.assertEqual(2, stream.question_withheld)
        self.assertEqual(2, stream.question_repair)
        self.assertEqual(6, stream.request_count())
        self.assertEqual(4, stream.turn_count())

    def test_a_repair_keeps_its_statement_and_drops_its_question(self):
        mixed = "That's okay. What is your business called?"
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [SECOND_QUESTION]},
                {"deltas": [mixed]},
            ]
        )

        self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        # The repair's question is withheld; its statement is the remainder.
        self.assertEqual([FIRST_QUESTION, "That's okay."], self.tts.spoken)
        self.assertEqual(2, stream.question_withheld)
        self.assertEqual(1, stream.question_repair)
        self.assertEqual(3, stream.request_count())
        self.assertEqual(2, stream.turn_count())

    def test_a_repair_that_only_asks_fails_the_turn_and_is_recorded(self):
        again = "What is your business called?"
        turn_events = RecordingTurnLedger()
        stream = self.make(
            replies=[
                {"deltas": [FIRST_QUESTION]},
                {"deltas": [SECOND_QUESTION]},
                {"deltas": [again]},
            ],
            turn_events=turn_events,
        )

        with self.assertRaises(ReplyQuestionOnly):
            self.run_turns(stream, [OVERWHELMED, STILL_UNANSWERED])

        # The caller heard the first turn only; neither question was spoken
        # and the turn was not looped.
        self.assertEqual([FIRST_QUESTION], self.tts.spoken)
        self.assertEqual(2, stream.question_withheld)
        self.assertEqual(1, stream.question_repair)
        self.assertEqual(3, stream.request_count())
        self.assertEqual(2, stream.turn_count())
        failed = turn_events.only("turn_failed")
        self.assertEqual(1, len(failed))
        _, _, fields = failed[0]
        self.assertEqual("ReplyQuestionOnly", fields["name"])
        self.assertEqual(
            "the reply only asked a question the caller did not answer",
            fields["reason"],
        )

    def test_a_hold_return_is_not_treated_as_an_unanswered_question(self):
        stream = self.make(
            replies=[{"deltas": [SECOND_QUESTION]}],
            history=[{"role": "assistant", "content": FIRST_QUESTION}],
        )

        self.run_turns(stream, [STILL_UNANSWERED])

        self.assertEqual([SECOND_QUESTION], self.tts.spoken)
        self.assertEqual(0, stream.question_withheld)
        self.assertEqual(0, stream.question_repair)


if __name__ == "__main__":
    unittest.main()
