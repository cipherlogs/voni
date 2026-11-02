"""The repeat guard: a reply line already spoken is never spoken again.

Seam: :meth:`cascade.turn_stream.CascadeTurnStream._speak`, which is the point
between a complete sentence and its synthesis request. The guard remembers the
last two replies the caller heard, withholds a duplicate sentence before any
audio is generated, and asks one bounded repair when a whole reply was a
repeat. The tests drive the public event seam and assert what the caller hears.
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

    def run_turns(self, stream: CascadeTurnStream, turns: int) -> None:
        async def run():
            await stream.start()
            for number in range(1, turns + 1):
                await stream.event(SpeechStart(f"t{number}"))
                await stream.event(
                    SpeechComplete(f"turn {number}", turn_id=f"t{number}")
                )
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
                {"deltas": ["Fair enough. ", "What went wrong?"]},
                {"deltas": ["Fair enough. ", "What went wrong?"]},
                {"deltas": [repair]},
            ]
        )

        self.run_turns(stream, 2)

        # The whole second reply was the measured loop; the caller hears the
        # first turn and the one repair, never the pair again.
        self.assertEqual(
            ["Fair enough.", "What went wrong?", repair], self.tts.spoken
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
            "You already said, verbatim: 'Fair enough.'. Do not repeat it; "
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

    def test_a_line_three_replies_back_is_allowed(self):
        stream = self.make(
            replies=[
                {"deltas": [QUESTION]},
                {"deltas": ["I can check that now for you."]},
                {"deltas": ["Let me look at that booking."]},
                {"deltas": [QUESTION]},
            ]
        )

        self.run_turns(stream, 4)

        self.assertEqual(QUESTION, self.tts.spoken[0])
        self.assertEqual(QUESTION, self.tts.spoken[-1])
        self.assertEqual(0, stream.repeat_dropped)
        self.assertEqual(0, stream.repeat_repair)


if __name__ == "__main__":
    unittest.main()
