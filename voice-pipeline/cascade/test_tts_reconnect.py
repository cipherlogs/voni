"""A dropped synthesis socket resumes from the first unheard point (ticket 97).

Spec: `.scratch/meta-cascade/spec.md` "Reconnect, sequence dedupe, partial
reply" — TTS. A socket failure mid-reply keeps the audio already played; the
remaining sentences are re-synthesized on a new session from the first unheard
point, so a sentence the caller heard is never spoken again. The one failure
reconnect is the ticket-94 budget, not a local retry counter; a second failure
ends the call visibly. ``3008`` is session expiry, a planned reconnect: the
current reply drains and the new session opens between turns, never
mid-sentence.

The synthesis session is the real ``AssemblyAIStreamingTTS`` over recorded
frames, so the scheduler, the per-request durations and the word boundaries are
the adapter's own, not a fake's.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    AssemblyAIStreamingTTS,
    CloseAction,
    SynthesisCallFailure,
)
from cascade.reconnect import ReconnectBudget
from cascade.tts_support import (
    API_KEY,
    audio_ms,
    begin,
    flush_done,
    make_session,
    sent_texts,
    word_boundaries,
    words,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory

REPLY = "Hello there. Friend. Goodbye."


def collect(tts, text=REPLY):
    """Drain one reply and return the ``SentenceAudio`` chunks in order."""

    async def run():
        return [chunk async for chunk in tts.speak(text)]

    return asyncio.run(run())


def mid_reply_kill():
    """The first session: sentence one plays, sentence two starts, socket dies."""
    return [
        begin(),
        audio_ms(700, flush_id=0),
        flush_done(flush_id=0, audio_duration_ms=700),
        audio_ms(200, flush_id=1),
        Frame(close_code=1006),
    ]


def rest_of_reply():
    """The second session: the remaining sentences, with their own flush ids."""
    return [
        begin(),
        audio_ms(400, flush_id=0),
        flush_done(flush_id=0, audio_duration_ms=400),
        audio_ms(500, flush_id=1),
        flush_done(flush_id=1, audio_duration_ms=500),
    ]


def session_with(*plans, **kwargs):
    """One session whose factory can open each plan in order."""
    factory = ScriptedSocketFactory(list(plans), clock=kwargs.pop("clock", None))
    tts, factory = make_session([], socket_factory=factory, **kwargs)
    asyncio.run(tts.open())
    return tts, factory


class MidReplyKillTests(unittest.TestCase):
    def test_a_kill_before_any_audio_re_synthesizes_the_whole_reply(self):
        first = [begin(), Frame(close_code=1006)]
        second = [
            begin(),
            audio_ms(700, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=700),
            audio_ms(400, flush_id=1),
            flush_done(flush_id=1, audio_duration_ms=400),
            audio_ms(500, flush_id=2),
            flush_done(flush_id=2, audio_duration_ms=500),
        ]
        tts, factory = session_with(first, second)

        chunks = collect(tts)

        self.assertEqual(1, tts.reconnects)
        self.assertEqual(
            ["Hello there. ", "Friend. ", "Goodbye."], sent_texts(factory)
        )
        self.assertEqual(3, len(chunks))

    def test_the_played_sentence_is_never_spoken_again(self):
        tts, factory = session_with(mid_reply_kill(), rest_of_reply())

        chunks = collect(tts)

        texts = [chunk.text for chunk in chunks]
        self.assertEqual(1, texts.count("Hello there. "))
        self.assertEqual("Friend. ", texts[-2])
        self.assertEqual("Goodbye.", texts[-1])

    def test_the_remaining_sentences_are_re_synthesized_on_a_new_session(self):
        tts, factory = session_with(mid_reply_kill(), rest_of_reply())

        collect(tts)

        self.assertEqual(2, len(factory.connections))
        self.assertEqual(1, tts.reconnects)
        self.assertEqual(["Friend. ", "Goodbye."], sent_texts(factory))

    def test_the_killed_sessions_requests_are_kept_as_history(self):
        tts, _ = session_with(mid_reply_kill(), rest_of_reply())

        collect(tts)

        self.assertEqual(1, len(tts.closed_sessions))
        self.assertEqual(
            ["Hello there. ", "Friend. "],
            [request.text for request in tts.closed_sessions[0].values()],
        )


class MidSentenceKillTests(unittest.TestCase):
    def test_a_mid_sentence_kill_resumes_from_the_first_unheard_word(self):
        # "hello" (0-300ms) was delivered; the caller never heard "there.".
        first = [
            begin(),
            audio_ms(300, flush_id=0),
            word_boundaries(
                flush_id=0,
                audio_start_ms=0,
                entries=words(("hello", 0, 300), ("there.", 300, 700)),
            ),
            Frame(close_code=1006),
        ]
        spoken_tail = [
            begin(),
            audio_ms(300, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=300),
            audio_ms(400, flush_id=1),
            flush_done(flush_id=1, audio_duration_ms=400),
            audio_ms(500, flush_id=2),
            flush_done(flush_id=2, audio_duration_ms=500),
        ]
        tts, factory = session_with(first, spoken_tail)

        chunks = collect(tts)

        self.assertEqual(
            ["there. ", "Friend. ", "Goodbye."], sent_texts(factory)
        )
        self.assertEqual(
            ["Hello there. ", "there. ", "Friend. ", "Goodbye."],
            [chunk.text for chunk in chunks],
        )


class FailureBudgetTests(unittest.TestCase):
    def test_the_failure_reconnect_is_the_one_ticket_94_budget(self):
        budget = ReconnectBudget(now=lambda: 0.0)
        factory = ScriptedSocketFactory([mid_reply_kill(), rest_of_reply()])
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
            budget=budget,
            clock=lambda: 0.0,
        )
        asyncio.run(tts.open())

        collect(tts)

        self.assertIs(tts.reconnect_budget, budget)
        counters = budget.counters("tts")
        self.assertEqual(1, counters.failures)
        self.assertEqual(1, counters.failure_reconnects)
        self.assertEqual(0, counters.budget_left)
        self.assertEqual(0, counters.planned_reconnects)

    def test_a_second_voice_failure_ends_the_call_visibly(self):
        # The resumed session also dies; there is no voice left for a goodbye.
        second = [begin(), audio_ms(100, flush_id=0), Frame(close_code=1006)]
        tts, factory = session_with(mid_reply_kill(), second)

        with self.assertRaises(SynthesisCallFailure) as raised:
            collect(tts)

        failure = raised.exception
        self.assertTrue(failure.visible)
        self.assertTrue(failure.call_ended)
        self.assertIsNone(failure.fallback)
        self.assertEqual(1, tts.reconnects)
        self.assertEqual(2, len(factory.connections))
        self.assertEqual(0, tts.reconnect_budget.counters("tts").budget_left)


class PlannedReconnectTests(unittest.TestCase):
    def test_3008_counts_apart_and_never_spends_the_failure_budget(self):
        tts, _ = session_with([begin()], [begin()])

        decision = asyncio.run(tts.handle_close(3008))

        self.assertIs(decision.action, CloseAction.PLANNED_RECONNECT)
        counters = tts.reconnect_budget.counters("tts")
        self.assertEqual(0, counters.failures)
        self.assertEqual(0, counters.failure_reconnects)
        self.assertEqual(1, counters.planned_reconnects)
        self.assertEqual(1, counters.budget_left)

        retried = asyncio.run(tts.handle_close(1011))

        self.assertIs(retried.action, CloseAction.RETRY)
        self.assertEqual(1, tts.reconnect_budget.counters("tts").failure_reconnects)

    def test_a_planned_expiry_drains_the_reply_and_never_reconnects_mid_sentence(self):
        first = [
            begin(),
            audio_ms(700, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=700),
            Frame(close_code=3008),
        ]
        second = [
            begin(),
            audio_ms(400, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=400),
        ]
        tts, factory = session_with(first, second)

        chunks = collect(tts, "Hello there. Friend.")

        # The reply drained at the sentence already played: the expiry did not
        # open a session inside the reply to re-synthesize its unheard tail.
        self.assertEqual(["Hello there. "], [chunk.text for chunk in chunks])
        self.assertEqual(1, len(factory.connections))
        self.assertTrue(tts.needs_reconnect)

        # The next turn opens its session between turns and sends only its text.
        follow_up = collect(tts, "Friend.")
        self.assertEqual(["Friend."], [chunk.text for chunk in follow_up])
        self.assertEqual(2, len(factory.connections))
        self.assertEqual(["Friend."], sent_texts(factory))

    def test_a_planned_reconnect_leaves_the_failure_budget_for_an_outage(self):
        first = [
            begin(),
            audio_ms(700, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=700),
            Frame(close_code=3008),
        ]
        second = [
            begin(),
            audio_ms(400, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=400),
        ]
        tts, _ = session_with(first, second)

        collect(tts, "Hello there. Friend.")
        collect(tts, "Friend.")

        counters = tts.reconnect_budget.counters("tts")
        self.assertEqual(1, counters.planned_reconnects)
        self.assertEqual(0, counters.failures)
        self.assertEqual(1, counters.budget_left)


if __name__ == "__main__":
    unittest.main()
