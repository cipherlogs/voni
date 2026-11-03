"""The repeat guard: a reply line already spoken is never spoken again.

Seam: :meth:`cascade.turn_stream.CascadeTurnStream._speak`, which is the point
between a complete sentence and its synthesis request. The guard remembers
every reply the caller heard this call, withholds a duplicate sentence before
any audio is generated, and asks one bounded repair when a whole reply was a
repeat. The tests drive the public event seam and assert what the caller hears.

The exact-match guard is the backstop. The general guard is a per-turn hidden
system note that lists the last two replies verbatim and refuses to reuse them,
so the model sees the lines it must not paraphrase. That is a prompt-level
generalisation: these tests assert the note reaches the model, not that the
model obeys it.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_turn_stream import (
    FakeTTS,
    RecordingAudio,
    ScriptedLLM,
)
from cascade.testing import FakeClock
from cascade.turn_stream import CascadeTurnStream, ReplyRepeatedOnly
from metrics import TimingLedger

QUESTION = "What went wrong with the order you placed?"

#: The live call's invite sentence: the same tag, the second time.
INVITE = (
    "Send me an email from your work address with Violet 20 in the subject, "
    "and tell me when it's sent."
)

#: The general guard's closing instruction; the note lists replies above it.
NO_REUSE = (
    "Do not repeat or paraphrase any of these lines, questions or openers "
    "you already said. Answer only what the caller just said, in a new way."
)


def system_text(request: list[dict]) -> str:
    """Every system message in one request, joined for one containment check."""
    return "\n".join(
        message["content"]
        for message in request
        if message["role"] == "system"
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


class RepeatGuardTests(unittest.TestCase):
    def make(
        self,
        replies,
        *,
        history=(),
        turn_events=None,
    ):
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

    def run_turns(
        self, stream: CascadeTurnStream, turns: int, texts=None
    ) -> None:
        async def run():
            await stream.start()
            for number in range(1, turns + 1):
                text = texts[number - 1] if texts is not None else f"turn {number}"
                await stream.event(SpeechStart(f"t{number}"))
                await stream.event(SpeechComplete(text, turn_id=f"t{number}"))
                await self.settle(stream, number)
            await stream.drain()

        asyncio.run(run())

    def test_a_repeated_reply_is_not_spoken_and_one_repair_is_spoken(self):
        repair = "Let us start with the order you placed."
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": [QUESTION]},
                {"deltas": [repair]},
            ]
        )

        self.run_turns(stream, 2)

        self.assertEqual([QUESTION, repair], self.tts.spoken)
        self.assertEqual(1, stream.repeat_repair)
        self.assertEqual(1, stream.repeat_dropped)
        self.assertEqual(3, stream.request_count())
        self.assertEqual(2, stream.turn_count())
        counts = self.ledger.summary()["counts"]
        self.assertEqual(1, counts["repeat_repair"])
        self.assertEqual(1, counts["repeat_dropped"])

    def test_the_repair_request_names_the_line_already_said(self):
        repair = "Let us start with the order you placed."
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": [QUESTION]},
                {"deltas": [repair]},
            ]
        )

        self.run_turns(stream, 2)

        repair_messages = self.llm.requests[2]
        system = [
            message["content"]
            for message in repair_messages
            if message["role"] == "system"
        ]
        self.assertIn(
            "You already said, verbatim: "
            f"'{QUESTION}'. Do not repeat it; "
            "answer only what the caller just said.",
            system,
        )

    def test_the_next_turn_is_told_not_to_reuse_the_replies_already_said(self):
        second = "I can check that now for you."
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": [second]},
            ]
        )

        self.run_turns(stream, 2)

        first_request, second_request = self.llm.requests
        self.assertNotIn(NO_REUSE, system_text(first_request))
        # The model has no assistant turn in the history, so the note is where
        # it sees its own last reply: verbatim, and refused.
        self.assertIn(f"- {QUESTION}", system_text(second_request))
        self.assertIn(NO_REUSE, system_text(second_request))

    def test_the_note_lists_the_last_two_replies_verbatim(self):
        first = "What went wrong with the order you placed?"
        second = "I can check that now for you."
        third = "Let me look at that booking."
        stream = self.make(
            replies=[
                {"deltas": [first]},
                {"deltas": [second]},
                {"deltas": [third]},
            ]
        )

        self.run_turns(stream, 3)

        note = system_text(self.llm.requests[2])
        self.assertIn(f"- {first}", note)
        self.assertIn(f"- {second}", note)
        self.assertNotIn(NO_REUSE, system_text(self.llm.requests[0]))

    def test_the_repair_request_does_not_stack_a_second_note(self):
        repair = "Let us start with the order you placed."
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": [QUESTION]},
                {"deltas": [repair]},
            ]
        )

        self.run_turns(stream, 2)

        self.assertIn(NO_REUSE, system_text(self.llm.requests[1]))
        repair_system = system_text(self.llm.requests[2])
        self.assertIn("You already said, verbatim:", repair_system)
        self.assertNotIn(NO_REUSE, repair_system)

    def test_a_hold_return_is_not_told_about_speech_it_never_made(self):
        stream = self.make(
            replies=[{"deltas": [QUESTION]}],
            history=[{"role": "assistant", "content": QUESTION}],
        )

        self.run_turns(stream, 1)

        self.assertNotIn(NO_REUSE, system_text(self.llm.requests[0]))

    def test_a_repair_that_repeats_again_fails_the_turn_and_is_recorded(self):
        turn_events = RecordingTurnLedger()
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": [QUESTION]},
                {"deltas": [QUESTION]},
            ],
            turn_events=turn_events,
        )

        with self.assertRaises(ReplyRepeatedOnly):
            self.run_turns(stream, 2)

        # The caller heard the first turn only: neither the duplicate nor the
        # repair's duplicate reached synthesis, and the turn was not looped.
        self.assertEqual([QUESTION], self.tts.spoken)
        self.assertEqual(1, stream.repeat_repair)
        self.assertEqual(2, stream.repeat_dropped)
        self.assertEqual(2, stream.turn_count())
        failed = turn_events.only("turn_failed")
        self.assertEqual(1, len(failed))
        _, _, fields = failed[0]
        self.assertEqual("ReplyRepeatedOnly", fields["name"])
        self.assertEqual(
            "the reply only repeated a line already spoken", fields["reason"]
        )

    def test_the_measured_two_word_loop_is_caught_and_repaired(self):
        repair = "Let us start with the order you placed."
        stream = self.make(
            replies=[
                {"deltas": ["Not quite. ", "What went wrong?"]},
                {"deltas": ["Not quite. ", "What went wrong?"]},
                {"deltas": [repair]},
            ]
        )

        self.run_turns(stream, 2)

        # The whole second reply was the measured loop; the caller hears the
        # first turn and the one repair, never the pair again.
        self.assertEqual(
            ["Not quite.", "What went wrong?", repair], self.tts.spoken
        )
        self.assertEqual(2, stream.repeat_dropped)
        self.assertEqual(1, stream.repeat_repair)
        self.assertEqual(3, stream.request_count())
        repair_messages = self.llm.requests[2]
        system = [
            message["content"]
            for message in repair_messages
            if message["role"] == "system"
        ]
        self.assertIn(
            "You already said, verbatim: 'Not quite.'. Do not repeat it; "
            "answer only what the caller just said.",
            system,
        )

    def test_a_repeated_one_word_agreement_is_still_spoken(self):
        stream = self.make(
            replies=[
                {"deltas": ["Yes."]},
                {"deltas": ["Yes."]},
            ]
        )

        self.run_turns(stream, 2)

        self.assertEqual(["Yes.", "Yes."], self.tts.spoken)
        self.assertEqual(0, stream.repeat_dropped)
        self.assertEqual(0, stream.repeat_repair)
        self.assertEqual(2, stream.request_count())

    def test_a_hold_return_is_not_a_reply_this_call_spoke(self):
        stream = self.make(
            replies=[{"deltas": [QUESTION]}],
            history=[{"role": "assistant", "content": QUESTION}],
        )

        self.run_turns(stream, 1)

        self.assertEqual([QUESTION], self.tts.spoken)
        self.assertEqual(0, stream.repeat_dropped)
        self.assertEqual(0, stream.repeat_repair)

    def test_a_line_three_replies_back_is_still_withheld(self):
        repair = "Let us start with the order you placed."
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": ["I can check that now for you."]},
                {"deltas": ["Let me look at that booking."]},
                {"deltas": [QUESTION]},
                {"deltas": [repair]},
            ]
        )

        # The product rule is one line per call, so the exact-match guard
        # remembers every reply, not just the last two. The caller answers the
        # opening question, so the unanswered-question guard is not what
        # decides this turn.
        self.run_turns(stream, 4, ["turn 1", "the order", "turn 3", "turn 4"])

        self.assertEqual(
            [QUESTION, "I can check that now for you.", "Let me look at that booking.", repair],
            self.tts.spoken,
        )
        self.assertEqual(1, stream.repeat_dropped)
        self.assertEqual(1, stream.repeat_repair)

    def test_the_first_invite_is_spoken_once(self):
        stream = self.make(
            replies=[{"deltas": ["Let me get that test up. ", INVITE]}]
        )

        self.run_turns(stream, 1, ["Yes, let's do it."])

        self.assertEqual(1, sum(1 for line in self.tts.spoken if INVITE in line))
        self.assertEqual(0, stream.repeat_dropped)

    def test_a_sentence_repeated_inside_one_reply_is_spoken_once(self):
        repeated = "I handle calls, answer questions and follow up right away."
        invite = (
            "Send me an email from your work address with Frost 15 in the subject, "
            "and tell me when it's sent."
        )
        stream = self.make(
            replies=[{"deltas": [f"{repeated} {repeated} {invite}"]}]
        )

        self.run_turns(stream, 1, ["Fine. Then tell me what you can actually do."])

        # The first copy and the rest of the reply are heard; the second copy
        # is withheld, and a new sentence means no repair is needed.
        self.assertEqual([repeated, invite], self.tts.spoken)
        self.assertEqual(1, stream.repeat_dropped)
        self.assertEqual(0, stream.repeat_repair)

    def test_a_second_invite_three_replies_later_is_withheld(self):
        stream = self.make(
            replies=[
                {"deltas": ["Sure — I'm Voni, live on the demo. " + INVITE]},
                {"deltas": ["Fair point, can't argue much there."]},
                {"deltas": ["Nope, I'm Voni running this live demo."]},
                {"deltas": ["I handle calls, bookings and follow-ups. " + INVITE]},
            ]
        )

        self.run_turns(
            stream,
            4,
            [
                "Yes, let's do it.",
                "That is what a bot would say.",
                "Prove it.",
                "Fine. Then tell me what you can actually do.",
            ],
        )

        # The first invite is heard; the identical sentence on the fourth
        # reply is withheld, even though two other replies came between them.
        self.assertEqual(1, sum(1 for line in self.tts.spoken if INVITE in line))
        self.assertEqual(1, stream.repeat_dropped)
        self.assertEqual(0, stream.repeat_repair)


if __name__ == "__main__":
    unittest.main()
