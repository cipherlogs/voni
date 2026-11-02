"""The opener guard: no reply begins with an acknowledgement or filler.

Seam: :meth:`cascade.turn_stream.CascadeTurnStream._speak`, the same point
between a complete sentence and its synthesis request that withholds a repeat
or an unanswered question. A leading acknowledgement phrase and its separator
are stripped before synthesis, repeatedly, so "Right, got it — showing you
live" is heard as "showing you live". A reply that was only an opener is
withheld and one bounded repair is asked; if the repair is still only an
opener, the turn fails by name and a bare "Got it." is never spoken.

The tests drive the public event seam and assert what the caller hears, the
metric counter and the trace row.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_turn_stream import FakeTTS, RecordingAudio, ScriptedLLM
from cascade.testing import FakeClock
from cascade.turn_stream import CascadeTurnStream, ReplyFillerOnly
from metrics import TimingLedger

#: The opener forms the guard owns. Written out here so a new entry in the
#: tuple cannot ship without a red test for its own form.
OPENERS = (
    "Right",
    "Got it",
    "Okay",
    "Alright",
    "Fair enough",
    "No worries",
    "Sure",
    "Of course",
    "Absolutely",
    "I see",
    "Yeah",
    "Yep",
    "Mm-hmm",
    "Uh-huh",
    "Sounds good",
    "Cool",
)

#: What the model streams after the opener, and what the caller must hear.
SUBSTANCE = "showing you live what I can do."
SPOKEN = "Showing you live what I can do."


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


class FillerGuardTests(unittest.TestCase):
    def make(self, replies, *, turn_events=None, on_caption=None):
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
            turn_events=turn_events,
            on_caption=on_caption,
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

    def test_each_opener_form_is_stripped_and_the_rest_is_spoken(self):
        for opener in OPENERS:
            with self.subTest(opener=opener):
                stream = self.make(
                    replies=[{"deltas": [f"{opener}, {SUBSTANCE}"]}]
                )

                self.run_turns(stream, ["what can you do?"])

                self.assertEqual([SPOKEN], self.tts.spoken)
                self.assertEqual(1, stream.filler_stripped)
                self.assertEqual(
                    1, self.ledger.summary()["counts"]["filler_stripped"]
                )

    def test_every_separator_is_stripped_with_its_opener(self):
        for separator in (",", ".", " —", ":", "…", "..."):
            with self.subTest(separator=separator):
                # A full stop starts a new sentence, so the model would have
                # capitalised it; the other separators continue the sentence.
                rest = SPOKEN if separator in (".", "...") else SUBSTANCE
                stream = self.make(replies=[{"deltas": [f"Got it{separator} {rest}"]}])

                self.run_turns(stream, ["what can you do?"])

                self.assertEqual([SPOKEN], self.tts.spoken)
                self.assertEqual(1, stream.filler_stripped)

    def test_a_chain_of_openers_is_all_stripped(self):
        stream = self.make(
            replies=[{"deltas": [f"Right, got it — {SUBSTANCE}"]}]
        )

        self.run_turns(stream, ["what can you do?"])

        self.assertEqual([SPOKEN], self.tts.spoken)
        self.assertEqual(2, stream.filler_stripped)

    def test_the_caption_carries_the_substance_not_the_opener(self):
        captions: list[tuple[str, str, bool]] = []

        async def collect(role, text, final):
            captions.append((role, text, final))

        stream = self.make(
            replies=[{"deltas": [f"Got it — {SUBSTANCE}"]}],
            on_caption=collect,
        )

        self.run_turns(stream, ["what can you do?"])

        finals = [text for role, text, final in captions if role == "agent" and final]
        self.assertEqual([SPOKEN], finals)

    def test_a_reply_that_is_only_filler_is_withheld_and_repaired(self):
        repaired = "I answer every call and book the job."
        stream = self.make(
            replies=[
                {"deltas": ["Got it."]},
                {"deltas": [repaired]},
            ]
        )

        self.run_turns(stream, ["That sounds interesting."])

        # The caller hears the repair only: never the bare acknowledgement.
        self.assertEqual([repaired], self.tts.spoken)
        self.assertEqual(2, stream.request_count())
        self.assertEqual(1, stream.filler_stripped)

    def test_a_bare_opener_with_no_separator_is_also_filler_only(self):
        repaired = "I answer every call and book the job."
        stream = self.make(
            replies=[
                {"deltas": ["Got it"]},
                {"deltas": [repaired]},
            ]
        )

        self.run_turns(stream, ["That sounds interesting."])

        self.assertEqual([repaired], self.tts.spoken)
        self.assertEqual(2, stream.request_count())

    def test_the_repair_request_says_begin_with_the_substance(self):
        repaired = "I answer every call and book the job."
        stream = self.make(
            replies=[
                {"deltas": ["Got it."]},
                {"deltas": [repaired]},
            ]
        )

        self.run_turns(stream, ["That sounds interesting."])

        repair_system = [
            message["content"]
            for message in self.llm.requests[1]
            if message["role"] == "system"
        ]
        self.assertIn(
            "You said nothing but an acknowledgement. Answer what they just "
            "said with the substance itself; do not open with an "
            "acknowledgement or filler.",
            repair_system,
        )

    def test_a_repair_that_is_still_only_filler_fails_the_turn_by_name(self):
        turn_events = RecordingTurnLedger()
        stream = self.make(
            replies=[
                {"deltas": ["Got it."]},
                {"deltas": ["Right."]},
            ],
            turn_events=turn_events,
        )

        with self.assertRaises(ReplyFillerOnly):
            self.run_turns(stream, ["That sounds interesting."])

        # Neither the original nor the repair's acknowledgement was spoken.
        self.assertEqual([], self.tts.spoken)
        self.assertEqual(2, stream.request_count())
        failed = turn_events.only("turn_failed")
        self.assertEqual(1, len(failed))
        _, _, fields = failed[0]
        self.assertEqual("ReplyFillerOnly", fields["name"])
        self.assertEqual(
            "the reply was nothing but an acknowledgement", fields["reason"]
        )

    def test_a_meaning_bearing_right_inside_a_sentence_is_untouched(self):
        for sentence in (
            "The right answer is on the screen.",
            "Right answer is on the screen.",
        ):
            with self.subTest(sentence=sentence):
                stream = self.make(replies=[{"deltas": [sentence]}])

                self.run_turns(stream, ["Where do I look?"])

                self.assertEqual([sentence], self.tts.spoken)
                self.assertEqual(0, stream.filler_stripped)

    def test_an_opener_at_a_later_sentence_start_is_also_withheld(self):
        stream = self.make(
            replies=[{"deltas": ["Your page is open. Got it."]}]
        )

        self.run_turns(stream, ["Where do I look?"])

        # The filler sentence adds nothing; the substance sentence is heard.
        self.assertEqual(["Your page is open."], self.tts.spoken)
        self.assertEqual(1, stream.filler_stripped)


if __name__ == "__main__":
    unittest.main()
