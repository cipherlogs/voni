"""Speech close-code policy: clean, retry once, planned reconnect, fail (31).

Every close is classified through ``cascade.failures.classify_stt`` (ticket
16); this adapter owns only the action. ``1000`` is normal completion.
``1008`` is our bug: the call fails visibly and an alert fires, but the leg's
breaker is left for a human. ``1011`` (and a close with no code, which is the
same thing) retries once with a new session, and a ``1011`` whose reason is the
vendor's max session duration is a planned reconnect instead — a new session
with no failure recorded. ``1013`` is rate limiting: no retry storm, the
speech leg's durable record opens through the ticket-22 ``CallRungs`` seam, and
the call fails visibly.

The tests replay scripted frames through the injected socket factory; the
breaker test uses the real ``Breaker``/``CallRungs`` pair over a
``MemoryStore``, so "opens the leg" is a durable record assertion, not a local
counter.
"""

import asyncio
import json
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.failures import FailureClass
from cascade.ladders import STT_LADDER, CallRungs, read_choices
from cascade.meta_stt import (
    CloseAction,
    MetaStreamingSTT,
    SpeechCallFailure,
    is_max_duration,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory

INTERVAL_S = 30.0


def ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def backend_over(plans, **kwargs):
    factory = ScriptedSocketFactory(plans)
    backend = MetaStreamingSTT(
        call_id="call-123",
        api_key="test-key",
        socket_factory=factory,
        clock=FakeClock(),
        **kwargs,
    )
    return backend, factory


def drain(backend):
    """Open, then consume the event stream to its end (or its failure)."""

    async def run():
        await backend.open(language_codes=[], sample_rate=24000)
        return [mapped async for mapped in backend.events()]

    return asyncio.run(run())


class RecordingLegFailures:
    """The ticket-22 seam the composition root passes in production."""

    def __init__(self) -> None:
        self.calls = []

    async def failed(self, leg, *, verdict, phase, turn=None):
        self.calls.append({"leg": leg, "verdict": verdict, "phase": phase, "turn": turn})


class RecordingAlert:
    def __init__(self) -> None:
        self.calls = []

    def __call__(self, verdict, reason) -> None:
        self.calls.append((verdict, reason))


def closed_stt_record() -> ProviderBreakerRecord:
    return ProviderBreakerRecord(leg="stt", provider="meta", state="closed")


def real_rungs():
    """The durable speech leg a live call reads, plus the breaker behind it."""
    clock = FakeClock(0.0)
    record = closed_stt_record()
    store = MemoryStore(
        {
            breaker_key("stt"): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
        }
    )
    breaker = Breaker(store, probe_interval_s=INTERVAL_S, now=clock)
    transitions = BreakerTransitions(breaker)
    choices = asyncio.run(read_choices(breaker, ladders=(STT_LADDER,)))
    return CallRungs(choices, transitions=transitions), breaker


class CleanCloseTest(unittest.TestCase):
    def test_1000_is_normal_completion(self):
        backend, factory = backend_over([[ack(), Frame(close_code=1000, reason="done")]])

        events = drain(backend)

        self.assertEqual(events, [])
        self.assertEqual(backend.last_close_code, 1000)
        self.assertEqual(len(factory.connections), 1)
        self.assertEqual(backend.reconnects, 0)
        self.assertEqual(backend.failures, ())
        self.assertEqual(backend.breaker_opens, ())
        self.assertEqual(backend.alerts, ())


class BugCloseTest(unittest.TestCase):
    def test_1008_fails_the_call_alerts_and_is_not_retried(self):
        alert = RecordingAlert()
        leg_failures = RecordingLegFailures()
        backend, factory = backend_over(
            [[ack(), Frame(close_code=1008, reason="invalid pacing")]],
            alert=alert,
            leg_failures=leg_failures,
        )

        with self.assertRaises(SpeechCallFailure) as raised:
            drain(backend)

        failure = raised.exception
        self.assertIs(failure.verdict.failure_class, FailureClass.BUG)
        self.assertTrue(failure.visible)
        self.assertTrue(failure.call_ended)
        self.assertFalse(failure.backoff)
        self.assertEqual(len(factory.connections), 1)
        self.assertEqual(backend.reconnects, 0)
        self.assertEqual(backend.alerts, ((failure.verdict, str(failure)),))
        self.assertEqual(alert.calls, [(failure.verdict, str(failure))])
        self.assertEqual(backend.breaker_opens, ())
        self.assertEqual(leg_failures.calls, [])
        self.assertIn("1008", str(failure))
        self.assertIn("invalid request or pacing", str(failure))

    def test_1008_leaves_the_durable_speech_leg_closed(self):
        rungs, breaker = real_rungs()
        backend, _ = backend_over(
            [[ack(), Frame(close_code=1008, reason="bad frame")]],
            leg_failures=rungs,
        )

        with self.assertRaises(SpeechCallFailure):
            drain(backend)

        stored = asyncio.run(breaker.read("stt"))
        self.assertEqual(stored.state, "closed")
        self.assertEqual(stored.record_version, 1)


class RetryableCloseTest(unittest.TestCase):
    def test_1011_retries_once_with_a_new_session(self):
        backend, factory = backend_over(
            [
                [ack(), event("speechStart", turnId="turn-1"), Frame(close_code=1011)],
                [ack(), event("speechStart", turnId="turn-2"), Frame(close_code=1000)],
            ]
        )

        events = drain(backend)

        self.assertEqual([mapped.turn_id for mapped in events], ["turn-1", "turn-2"])
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.reconnects, 1)
        self.assertIn("call-123%3A0", factory.connections[0]["url"])
        self.assertIn("call-123%3A1", factory.connections[1]["url"])
        self.assertEqual(backend.breaker_opens, (), "one retry is not yet a trip")
        self.assertIn(1011, [verdict.code for verdict in backend.failures])

    def test_the_retry_happens_once_then_the_call_fails_and_opens_the_leg(self):
        leg_failures = RecordingLegFailures()
        backend, factory = backend_over(
            [
                [ack(), Frame(close_code=1011, reason="internal")],
                [ack(), Frame(close_code=1011, reason="internal")],
                [ack()],
            ],
            leg_failures=leg_failures,
        )

        with self.assertRaises(SpeechCallFailure) as raised:
            drain(backend)

        failure = raised.exception
        self.assertIs(failure.verdict.failure_class, FailureClass.TRIGGER)
        self.assertEqual(len(factory.connections), 2, "one retry, never two")
        self.assertEqual(backend.reconnects, 1)
        self.assertEqual(backend.breaker_opens, (failure.verdict,))
        self.assertEqual([call["verdict"] for call in leg_failures.calls], [failure.verdict])
        self.assertEqual(leg_failures.calls[0]["leg"], "stt")
        self.assertEqual(leg_failures.calls[0]["phase"], "stream")

    def test_a_close_with_no_code_is_treated_as_1011(self):
        backend, factory = backend_over(
            [
                [ack(), Frame(exc=ConnectionError("socket vanished"))],
                [ack(), Frame(close_code=1000)],
            ]
        )

        drain(backend)

        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.reconnects, 1)
        self.assertIsNone(backend.failures[0].code)
        self.assertIs(backend.failures[0].failure_class, FailureClass.TRIGGER)


class PlannedReconnectTest(unittest.TestCase):
    def test_a_1011_for_max_session_duration_opens_a_new_session_without_a_failure(self):
        leg_failures = RecordingLegFailures()
        backend, factory = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    Frame(close_code=1011, reason="max session duration reached"),
                ],
                [ack(), event("speechStart", turnId="turn-2"), Frame(close_code=1000)],
            ],
            leg_failures=leg_failures,
        )

        events = drain(backend)

        self.assertEqual([mapped.turn_id for mapped in events], ["turn-1", "turn-2"])
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.reconnects, 1)
        self.assertEqual(backend.failures, ())
        self.assertEqual(backend.breaker_opens, ())
        self.assertEqual(leg_failures.calls, [])

    def test_a_max_duration_reconnect_does_not_spend_the_one_retry(self):
        backend, factory = backend_over(
            [
                [ack(), Frame(close_code=1011, reason="maximum session duration")],
                [ack(), Frame(close_code=1011, reason="internal")],
                [ack(), Frame(close_code=1000)],
            ]
        )

        drain(backend)

        self.assertEqual(len(factory.connections), 3)
        self.assertEqual(backend.reconnects, 2)
        self.assertEqual(backend.breaker_opens, ())

    def test_max_duration_is_read_from_the_close_reason_by_name(self):
        self.assertTrue(is_max_duration("max session duration reached"))
        self.assertTrue(is_max_duration("Maximum session duration"))
        self.assertFalse(is_max_duration("internal/backend failure"))
        self.assertFalse(is_max_duration(""))


class RateLimitedCloseTest(unittest.TestCase):
    def test_1013_backs_off_opens_the_leg_and_does_not_retry(self):
        leg_failures = RecordingLegFailures()
        backend, factory = backend_over(
            [[ack(), Frame(close_code=1013, reason="rate limited")]],
            leg_failures=leg_failures,
        )

        with self.assertRaises(SpeechCallFailure) as raised:
            drain(backend)

        failure = raised.exception
        self.assertIs(failure.verdict.failure_class, FailureClass.TRIGGER)
        self.assertTrue(failure.backoff)
        self.assertEqual(len(factory.connections), 1, "no immediate retry storm")
        self.assertEqual(backend.reconnects, 0)
        self.assertEqual(backend.breaker_opens, (failure.verdict,))
        self.assertEqual([call["verdict"] for call in leg_failures.calls], [failure.verdict])
        self.assertIn("1013", str(failure))

    def test_1013_opens_the_durable_speech_leg_for_the_next_call(self):
        rungs, breaker = real_rungs()
        backend, _ = backend_over(
            [[ack(), Frame(close_code=1013, reason="rate limited")]],
            leg_failures=rungs,
        )

        with self.assertRaises(SpeechCallFailure):
            drain(backend)

        stored = asyncio.run(breaker.read("stt"))
        self.assertEqual(stored.state, "open")
        self.assertIsNotNone(stored.trigger)
        self.assertEqual(stored.trigger.code, 1013)
        self.assertEqual(stored.trigger.phase, "stream")


class CloseCodeMatrixTest(unittest.TestCase):
    """One recorded fixture per code, pinning verdict and documented action."""

    def test_each_code_produces_its_documented_action(self):
        cases = (
            (1000, CloseAction.CLEAN, FailureClass.DO_NOT_OPEN, False, 1),
            (1008, CloseAction.FAIL, FailureClass.BUG, False, 1),
            (1011, CloseAction.RETRY, FailureClass.TRIGGER, False, 2),
            (1013, CloseAction.FAIL, FailureClass.TRIGGER, True, 1),
            (None, CloseAction.RETRY, FailureClass.TRIGGER, False, 2),
        )
        for code, action, failure_class, backoff, connections in cases:
            with self.subTest(code=code):
                frame = (
                    Frame(exc=ConnectionError("gone"))
                    if code is None
                    else Frame(close_code=code)
                )
                backend, factory = backend_over(
                    [[ack(), frame], [ack(), Frame(close_code=1000)]]
                )

                async def run():
                    await backend.open(language_codes=[], sample_rate=24000)
                    return await backend.handle_close(code)

                try:
                    decision = asyncio.run(run())
                except SpeechCallFailure as failure:
                    self.assertIs(action, CloseAction.FAIL)
                    self.assertEqual(failure.verdict.failure_class, failure_class)
                    self.assertEqual(failure.backoff, backoff)
                else:
                    self.assertIs(decision.action, action)
                    self.assertEqual(decision.verdict.failure_class, failure_class)
                self.assertEqual(len(factory.connections), connections)

    def test_handle_close_returns_the_decision_before_the_retry_is_consumed(self):
        backend, factory = backend_over(
            [[ack()], [ack(), Frame(close_code=1000)]]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            return await backend.handle_close(1011)

        decision = asyncio.run(run())

        self.assertIs(decision.action, CloseAction.RETRY)
        self.assertTrue(decision.retried)
        self.assertIs(decision.verdict.failure_class, FailureClass.TRIGGER)
        self.assertEqual(len(factory.connections), 2)


if __name__ == "__main__":
    unittest.main()
