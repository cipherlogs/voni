"""The offer guard: a test/invite offer is spoken only on a willing turn.

Seam: :meth:`cascade.turn_stream.CascadeTurnStream._speak`, the same sentence
boundary that withholds a repeat, an unanswered question or an acknowledgement
opener. A sentence that carries the product's offer vocabulary is withheld
unless the caller's final accepts the test or asks what Voni can do. A
complaint, a neutral turn, small talk or a challenge is not willing, so no
offer sentence is heard on it. The rest of the reply still speaks; a reply that
was only an offer fails the turn by name and is never repaired into a loop.

The live call that produced the rule (37d14805) heard the model's own offer over
a complaint: "That's fair, sounds frustrating. I'm here if you want to give it
a shot." The prompt-level rule already said not to; this seam makes it code.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_turn_stream import FakeTTS, RecordingAudio, ScriptedLLM
from cascade.testing import FakeClock
from cascade.turn_stream import CascadeTurnStream, ReplyOfferOnly
from metrics import TimingLedger

#: The live call's complaint and the model's own offer.
COMPLAINT = "This is ridiculous. Your service is useless."
UPSELL = "That's fair, sounds frustrating. I'm here if you want to give it a shot."
REST = "That's fair, sounds frustrating."
OFFER = "I'm here if you want to give it a shot."

#: A non-offer sentence, so a reply can speak something while its offer is
#: withheld and the turn stays short of an offer-only failure.
NEWS = "Good to know."
AN_OFFER = "I can run a live test on your screen."


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


class OfferGateTests(unittest.TestCase):
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

    def test_a_complaint_withholds_the_offer_and_speaks_the_rest(self):
        stream = self.make(replies=[{"deltas": [UPSELL]}])

        self.run_turns(stream, [COMPLAINT])

        # The caller hears the answer to the complaint, never the offer.
        self.assertEqual([REST], self.tts.spoken)
        self.assertEqual(1, stream.offer_withheld)
        self.assertEqual(1, self.ledger.summary()["counts"]["offer_withheld"])

    def test_a_willing_acceptance_speaks_the_offer(self):
        for final in (
            "Yes, let's do it.",
            "Sure, go ahead.",
            "Okay, try it.",
        ):
            with self.subTest(final=final):
                stream = self.make(replies=[{"deltas": [AN_OFFER]}])

                self.run_turns(stream, [final])

                self.assertEqual([AN_OFFER], self.tts.spoken)
                self.assertEqual(0, stream.offer_withheld)

    def test_a_product_question_speaks_the_offer(self):
        for final in (
            "What can you do?",
            "How does it work?",
            "Tell me what you do.",
            "Show me.",
        ):
            with self.subTest(final=final):
                stream = self.make(replies=[{"deltas": [AN_OFFER]}])

                self.run_turns(stream, [final])

                self.assertEqual([AN_OFFER], self.tts.spoken)
                self.assertEqual(0, stream.offer_withheld)

    def test_a_neutral_turn_or_small_talk_withholds_the_offer(self):
        for final in ("Nice weather today.", "How are you?"):
            with self.subTest(final=final):
                stream = self.make(
                    replies=[{"deltas": [f"{NEWS} {OFFER}"]}]
                )

                self.run_turns(stream, [final])

                self.assertEqual([NEWS], self.tts.spoken)
                self.assertEqual(1, stream.offer_withheld)

    def test_a_challenge_withholds_the_offer(self):
        stream = self.make(
            replies=[{"deltas": [f"Yes, I'm real. {AN_OFFER}"]}]
        )

        self.run_turns(stream, ["Are you a real person?"])

        self.assertEqual(["Yes, I'm real."], self.tts.spoken)
        self.assertEqual(1, stream.offer_withheld)

    def test_a_reply_that_is_only_an_offer_fails_by_name_without_a_loop(self):
        turn_events = RecordingTurnLedger()
        stream = self.make(
            replies=[{"deltas": [OFFER]}],
            turn_events=turn_events,
        )

        with self.assertRaises(ReplyOfferOnly):
            self.run_turns(stream, [COMPLAINT])

        # Nothing was spoken and no repair was asked: one request, one turn.
        self.assertEqual([], self.tts.spoken)
        self.assertEqual(1, stream.request_count())
        self.assertEqual(1, stream.turn_count())
        failed = turn_events.only("turn_failed")
        self.assertEqual(1, len(failed))
        _, _, fields = failed[0]
        self.assertEqual("ReplyOfferOnly", fields["name"])
        self.assertEqual(
            "the reply was only a test offer the caller did not invite",
            fields["reason"],
        )

    def test_a_batched_statement_and_offer_are_split(self):
        stream = self.make(
            replies=[{"deltas": [f"{REST} {OFFER}"]}]
        )

        self.run_turns(stream, [COMPLAINT])

        self.assertEqual([REST], self.tts.spoken)
        self.assertEqual(1, stream.offer_withheld)

    def test_the_caption_carries_the_spoken_rest_not_the_offer(self):
        captions: list[tuple[str, str, bool]] = []

        async def collect(role, text, final):
            captions.append((role, text, final))

        stream = self.make(replies=[{"deltas": [UPSELL]}], on_caption=collect)

        self.run_turns(stream, [COMPLAINT])

        finals = [text for role, text, final in captions if role == "agent" and final]
        self.assertEqual([REST], finals)


if __name__ == "__main__":
    unittest.main()
