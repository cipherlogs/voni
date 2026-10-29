"""Probe hysteresis and the real-call canary (ticket 18).

The state machine is ticket 17's ``BreakerTransitions``; this file adds no
second machine. What it proves:

* the probe interval is the registry bound (30 s from the spec), not a literal
  a caller may pick;
* three probe successes each at least one interval apart close a leg, two or a
  too-soon run do not;
* one probe failure at any point reopens it;
* the first real call after a probe close is the canary: one trigger failure
  reopens immediately, is attributed as a canary failure, and the window lasts
  until a real call succeeds.

Time is always the ticket-01 ``FakeClock``; no test sleeps.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ProviderBreakerRecord,
    breaker_key,
    canary_pending,
    probe_interval_s,
)
from cascade.failures import classify
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock
from cascade.thresholds import UnsetBoundError, require_bound

INTERVAL_S = 30.0


def run(coro):
    return asyncio.run(coro)


def closed_record(**changes):
    fields = {"leg": "stt", "provider": "meta", "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def half_open_record(**changes):
    fields = {
        "leg": "stt",
        "provider": "assemblyai",
        "state": "half_open",
        "opened_at": 0.0,
        "last_failure_at": 0.0,
        "trigger": BreakerTrigger(kind="failure", code=1013, phase="stream", turn=2),
        "reason": "stt 1013 rate limited",
    }
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def harness(record, *, interval_s=INTERVAL_S, start=0.0):
    clock = FakeClock(start)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
        }
    )
    breaker = Breaker(store, probe_interval_s=interval_s, now=clock)
    return BreakerTransitions(breaker), breaker, store, clock


def probe_close(transitions, clock, *, leg="stt"):
    """Run the three spaced probe successes that close a leg."""
    for _ in range(3):
        outcome = run(transitions.record_probe_success(leg, latency_ms=20.0))
        clock.advance(INTERVAL_S)
    return outcome


class ProbeIntervalBoundTest(unittest.TestCase):
    def test_the_probe_interval_is_the_registry_bound_from_the_spec(self):
        self.assertEqual(float(require_bound("breaker.probe_interval_ms")), 30_000.0)
        self.assertEqual(probe_interval_s(), INTERVAL_S)

    def test_a_breaker_built_from_the_registry_enforces_the_registry_interval(self):
        record = half_open_record()
        clock = FakeClock(0.0)
        store = MemoryStore(
            {
                breaker_key(record.leg): StoredDocument(
                    version=record.record_version, document=record.to_document()
                )
            }
        )
        breaker = Breaker.from_registry(store, now=clock)
        transitions = BreakerTransitions(breaker)

        for _ in range(3):
            run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(INTERVAL_S)
        self.assertEqual(run(breaker.read("stt")).state, "closed")

        # An unproven leg is not closed by two successes, and 29.999 s between
        # successes is not "each at least 30 s apart".
        reopened = run(
            transitions.record_probe_failure("stt", verdict=classify("stt", 1011))
        )
        self.assertEqual(reopened.record.state, "open")
        clock.advance(INTERVAL_S)
        run(transitions.settle("stt"))
        run(transitions.record_probe_success("stt", latency_ms=20.0))
        clock.advance(INTERVAL_S - 0.001)
        run(transitions.record_probe_success("stt", latency_ms=20.0))
        clock.advance(INTERVAL_S)
        outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))
        self.assertEqual(outcome.record.state, "half_open")

    def test_an_unset_interval_bound_raises_by_name_rather_than_defaulting(self):
        from dataclasses import replace

        from cascade import thresholds

        original = thresholds.REGISTRY
        try:
            thresholds.REGISTRY = thresholds.Registry(
                {
                    entry.name: (
                        replace(entry, value=None, source="", date="")
                        if entry.name == "breaker.probe_interval_ms"
                        else entry
                    )
                    for entry in original.bounds()
                }
            )
            with self.assertRaises(UnsetBoundError) as raised:
                probe_interval_s()
        finally:
            thresholds.REGISTRY = original
        self.assertIn("breaker.probe_interval_ms", str(raised.exception))
        self.assertIn("18", str(raised.exception))


class HysteresisTest(unittest.TestCase):
    def test_three_probe_successes_one_interval_apart_close_the_leg(self):
        transitions, breaker, _, clock = harness(half_open_record())

        outcome = probe_close(transitions, clock)

        self.assertEqual(outcome.record.state, "closed")
        self.assertEqual(outcome.event.to_state, "closed")
        self.assertEqual(len(outcome.record.probe_successes), 3)
        self.assertEqual(run(breaker.read("stt")).state, "closed")

    def test_two_probe_successes_do_not_close_the_leg(self):
        transitions, _, _, clock = harness(half_open_record())
        run(transitions.record_probe_success("stt", latency_ms=20.0))
        clock.advance(INTERVAL_S)
        outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))

        self.assertEqual(outcome.record.state, "half_open")

    def test_three_probe_successes_in_a_row_too_soon_do_not_close_the_leg(self):
        transitions, _, _, clock = harness(half_open_record())
        for _ in range(3):
            outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(1.0)

        self.assertEqual(outcome.record.state, "half_open")

    def test_one_probe_failure_at_any_point_reopens_the_leg(self):
        for successes_before in (0, 1, 2):
            transitions, breaker, _, clock = harness(half_open_record())
            for _ in range(successes_before):
                run(transitions.record_probe_success("stt", latency_ms=20.0))
                clock.advance(INTERVAL_S)

            outcome = run(
                transitions.record_probe_failure(
                    "stt", verdict=classify("stt", 1011)
                )
            )

            self.assertEqual(outcome.record.state, "open", successes_before)
            self.assertEqual(outcome.event.trigger.kind, "probe_failure")
            self.assertEqual(outcome.record.probe_successes, ())
            self.assertEqual(run(breaker.read("stt")).state, "open")


class CanaryTest(unittest.TestCase):
    def test_the_first_real_call_after_a_probe_close_is_the_canary(self):
        transitions, _, _, clock = harness(half_open_record())
        probe_close(transitions, clock)
        self.assertTrue(canary_pending(run(transitions.breaker.read("stt"))))

        run(transitions.record_real_call_success("stt", phase="turn"))

        self.assertFalse(canary_pending(run(transitions.breaker.read("stt"))))

    def test_a_canary_failure_reopens_immediately_and_is_attributed_as_one(self):
        transitions, breaker, _, clock = harness(half_open_record())
        probe_close(transitions, clock)
        closed_at = clock.now()

        clock.advance(1.0)  # no probe is due: the canary needs no ritual
        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1011), phase="stream", turn=4
            )
        )

        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(outcome.record.opened_at, closed_at + 1.0)
        self.assertEqual(outcome.event.from_state, "closed")
        self.assertEqual(outcome.event.to_state, "open")
        self.assertEqual(outcome.record.trigger.kind, "canary_failure")
        self.assertIn("canary", outcome.event.reason)
        self.assertIn("1011", outcome.event.reason)
        self.assertEqual(run(breaker.read("stt")).state, "open")

    def test_a_routine_probe_on_a_healthy_leg_does_not_arm_a_canary(self):
        transitions, _, _, clock = harness(half_open_record())
        probe_close(transitions, clock)
        clock.advance(5.0)
        run(transitions.record_real_call_success("stt", phase="turn"))

        clock.advance(5.0)
        run(transitions.record_probe_success("stt", latency_ms=15.0))

        self.assertFalse(canary_pending(run(transitions.breaker.read("stt"))))

    def test_a_bug_class_canary_failure_still_does_not_open_the_leg(self):
        transitions, breaker, _, clock = harness(half_open_record())
        probe_close(transitions, clock)

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1008), phase="stream"
            )
        )

        # A deterministic request error is our bug: it fails the call visibly
        # and leaves the breaker to a human, canary window or not.
        self.assertFalse(outcome.written)
        self.assertEqual(run(breaker.read("stt")).state, "closed")


if __name__ == "__main__":
    unittest.main()
