"""Voice close policy: trigger, bug or planned reconnect (ticket 55).

A synthesis failure is visible, never papered over. A retryable close gets the
one failure reconnect from the ticket-94 budget — including after audio was
delivered, because ticket 97 resumes the reply from its first unheard point
rather than replaying it — then a second failure fails the call and opens the
voice leg's breaker. Configuration and pacing closes are our bug: they fail
the call and alert without opening the leg. ``3008`` and the session's
``expires_at`` are planned reconnects. There is no second voice vendor, so
nothing here hands over to managed — a failure ends the call visibly.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    CloseAction,
    SynthesisCallFailure,
)
from cascade.failures import SESSION_LIMIT, FailureClass
from cascade.tts_support import (
    audio_ms,
    begin,
    error,
    flush_done,
    make_session,
    open_session,
)
from cascade.testing import ScriptedSocketFactory


def retrying_session():
    """A session whose factory can open twice: the first socket plus its retry."""
    factory = ScriptedSocketFactory([[begin()], [begin()]])
    tts, factory = make_session([], socket_factory=factory)
    asyncio.run(tts.open())
    return tts, factory


class TriggerTests(unittest.TestCase):
    def test_a_trigger_close_is_retried_once_with_a_new_session(self):
        tts, factory = retrying_session()

        decision = asyncio.run(tts.handle_close(1011))

        self.assertIs(decision.action, CloseAction.RETRY)
        self.assertTrue(decision.retried)
        self.assertIs(decision.verdict.failure_class, FailureClass.TRIGGER)
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(tts.reconnects, 1)
        self.assertEqual(tts.breaker_opens, [])

    def test_the_retry_is_one_only_then_the_call_fails_and_opens_the_leg(self):
        tts, _ = retrying_session()
        asyncio.run(tts.handle_close(1011))

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(tts.handle_close(1011))

        failure = raised.exception
        self.assertIs(failure.verdict.failure_class, FailureClass.TRIGGER)
        self.assertEqual(tts.breaker_opens, [failure.verdict])
        self.assertTrue(failure.visible)
        self.assertTrue(failure.call_ended)

    def test_a_trigger_close_after_audio_was_delivered_still_gets_the_one_retry(self):
        # Ticket 97: a mid-reply close resumes from the first unheard point
        # instead of failing, so delivered audio no longer refuses the retry.
        # The one-per-call budget still bounds it.
        tts, factory = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
            ]
        )

        async def drain():
            return [chunk async for chunk in tts.speak("Hello there.")]

        asyncio.run(drain())

        decision = asyncio.run(tts.handle_close(1006))

        self.assertIs(decision.action, CloseAction.RETRY)
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(tts.breaker_opens, [])
        with self.assertRaises(SynthesisCallFailure):
            asyncio.run(tts.handle_close(1006))
        self.assertEqual(tts.breaker_opens[-1].failure_class, FailureClass.TRIGGER)

    def test_a_close_without_a_code_is_a_trigger(self):
        tts, factory = retrying_session()

        decision = asyncio.run(tts.handle_close(None))

        self.assertIs(decision.action, CloseAction.RETRY)
        self.assertEqual(len(factory.connections), 2)


class BugTests(unittest.TestCase):
    def assert_bug(self, code):
        tts, factory = open_session([begin()])

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(tts.handle_close(code))

        failure = raised.exception
        self.assertIs(failure.verdict.failure_class, FailureClass.BUG)
        self.assertTrue(failure.visible)
        self.assertEqual(tts.alerts, [(failure.verdict, str(failure))])
        self.assertEqual(tts.breaker_opens, [])
        self.assertEqual(len(factory.connections), 1)
        self.assertFalse(tts.needs_reconnect)

    def test_an_invalid_parameter_close_fails_and_alerts_without_opening(self):
        self.assert_bug(3006)

    def test_a_pacing_close_fails_and_alerts_without_opening(self):
        self.assert_bug(3010)

    def test_an_unread_audio_close_fails_and_alerts_without_opening(self):
        self.assert_bug(3011)

    def test_a_message_too_large_close_fails_and_alerts_without_opening(self):
        self.assert_bug(1009)


class PlannedReconnectTests(unittest.TestCase):
    def test_session_expiry_is_a_planned_reconnect_never_a_trigger(self):
        tts, factory = open_session([begin()])

        decision = asyncio.run(tts.handle_close(3008))

        self.assertIs(decision.action, CloseAction.PLANNED_RECONNECT)
        self.assertFalse(decision.verdict.opens_breaker)
        self.assertTrue(tts.needs_reconnect)
        self.assertEqual(tts.breaker_opens, [])
        self.assertEqual(tts.failures, [])
        self.assertEqual(tts.alerts, [])
        self.assertEqual(len(factory.connections), 1)

    def test_the_expiry_sentinel_is_also_a_planned_reconnect(self):
        tts, _ = open_session([begin()])

        decision = asyncio.run(tts.handle_close(SESSION_LIMIT))

        self.assertIs(decision.action, CloseAction.PLANNED_RECONNECT)
        self.assertFalse(decision.verdict.opens_breaker)

    def test_a_clean_close_is_not_a_failure(self):
        tts, _ = open_session([begin()])

        decision = asyncio.run(tts.handle_close(1000))

        self.assertIs(decision.action, CloseAction.CLEAN)
        self.assertEqual(tts.failures, [])
        self.assertEqual(tts.breaker_opens, [])

    def test_an_unlisted_close_fails_visibly_without_opening_the_leg(self):
        tts, _ = open_session([begin()])

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(tts.handle_close(1002))

        self.assertFalse(raised.exception.verdict.opens_breaker)
        self.assertEqual(tts.breaker_opens, [])
        self.assertTrue(raised.exception.visible)


class NoFallbackTests(unittest.TestCase):
    def test_a_voice_failure_ends_the_call_with_no_managed_handover(self):
        tts, _ = retrying_session()
        asyncio.run(tts.handle_close(1011))

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(tts.handle_close(1011))

        failure = raised.exception
        self.assertIsNone(failure.fallback)
        self.assertTrue(failure.call_ended)
        self.assertTrue(failure.visible)


class GreetingFailureTests(unittest.TestCase):
    def test_a_greeting_failure_is_browser_visible_never_a_silent_opening(self):
        tts, _ = open_session([begin(), error(3006, "invalid parameter")])

        async def greet():
            return [chunk async for chunk in tts.speak_greeting("Hi there.")]

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(greet())

        failure = raised.exception
        self.assertEqual(failure.stage, "greeting")
        self.assertTrue(failure.visible)
        self.assertIsNone(failure.fallback)
        self.assertIs(failure.verdict.failure_class, FailureClass.BUG)
        self.assertTrue(tts.alerts)

    def test_a_reply_failure_names_the_reply_stage(self):
        tts, _ = open_session([begin(), error(1011, "internal")])

        async def reply():
            return [chunk async for chunk in tts.speak("Hello there.")]

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(reply())

        self.assertEqual(raised.exception.stage, "reply")
        self.assertTrue(raised.exception.visible)


if __name__ == "__main__":
    unittest.main()
