"""Breaker transitions: trigger, probe due, hysteresis, canary, pin, write failure.

The clock is always the ticket-01 ``FakeClock``; no test sleeps. The probe
interval is always injected; no test relies on the spec's 30 s literal.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ManualOverrideRefused,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.failures import classify
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock

INTERVAL_S = 30.0


def run(coro):
    return asyncio.run(coro)


def closed_record(**changes):
    fields = {"leg": "stt", "provider": "meta", "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def open_record(**changes):
    fields = {
        "leg": "stt",
        "provider": "assemblyai",
        "state": "open",
        "opened_at": 0.0,
        "last_failure_at": 0.0,
        "trigger": BreakerTrigger(kind="failure", code=1013, phase="stream", turn=2),
        "reason": "stt 1013 rate limited",
    }
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
    """A seeded store, a breaker, and the transition engine on one fake clock."""
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


class TriggerOpensTest(unittest.TestCase):
    def test_a_trigger_failure_opens_a_closed_leg_with_trigger_reason_and_phase(self):
        transitions, breaker, store, clock = harness(closed_record())
        clock.advance(5.0)

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream", turn=2
            )
        )

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(outcome.record.opened_at, 5.0)
        self.assertEqual(outcome.record.last_failure_at, 5.0)
        self.assertEqual(outcome.record.trigger.code, 1013)
        self.assertEqual(outcome.record.trigger.phase, "stream")
        self.assertEqual(outcome.record.trigger.turn, 2)
        self.assertEqual(outcome.event.from_state, "closed")
        self.assertEqual(outcome.event.to_state, "open")
        self.assertEqual(outcome.event.phase, "stream")
        self.assertIn("rate limited", outcome.event.reason)
        self.assertIn("1013", str(outcome.record.trigger.code))

        persisted = run(breaker.read("stt"))
        self.assertEqual(persisted.state, "open")
        self.assertEqual(persisted.record_version, 2)

    def test_a_bug_class_failure_leaves_a_closed_leg_closed_and_writes_nothing(self):
        transitions, breaker, store, clock = harness(closed_record())

        outcome = run(
            transitions.record_failure("stt", verdict=classify("stt", 1008), phase="stream")
        )

        self.assertFalse(outcome.written)
        self.assertIsNone(outcome.event)
        self.assertEqual(outcome.record.state, "closed")
        self.assertEqual(run(breaker.read("stt")).record_version, 1)

    def test_a_failure_verdict_for_another_leg_is_refused_by_name(self):
        transitions, _, _, _ = harness(closed_record())
        with self.assertRaises(ValueError) as refused:
            run(transitions.record_failure("stt", verdict=classify("llm", 500), phase="turn"))
        self.assertIn("llm", str(refused.exception))


class ProbeDueTest(unittest.TestCase):
    def test_an_open_leg_stays_open_before_the_probe_interval(self):
        transitions, breaker, store, clock = harness(open_record())
        clock.advance(INTERVAL_S - 0.001)

        outcome = run(transitions.settle("stt"))

        self.assertFalse(outcome.written)
        self.assertIsNone(outcome.event)
        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(run(breaker.read("stt")).record_version, 1)

    def test_an_open_leg_becomes_half_open_when_a_probe_is_due(self):
        transitions, breaker, _, clock = harness(open_record())
        clock.advance(INTERVAL_S)

        outcome = run(transitions.settle("stt"))

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "half_open")
        self.assertEqual(outcome.event.from_state, "open")
        self.assertEqual(outcome.event.to_state, "half_open")
        self.assertEqual(outcome.event.phase, "probe")
        self.assertEqual(run(breaker.read("stt")).state, "half_open")

    def test_the_probe_interval_is_the_injected_one_not_a_constant(self):
        transitions, _, _, clock = harness(open_record(), interval_s=10.0)
        clock.advance(9.0)
        self.assertFalse(run(transitions.settle("stt")).written)
        clock.advance(1.0)
        self.assertEqual(run(transitions.settle("stt")).record.state, "half_open")

    def test_a_stale_closed_record_reads_half_open_and_settles_into_it(self):
        transitions, breaker, _, clock = harness(closed_record(last_probe_at=0.0))
        clock.advance(2 * INTERVAL_S + 1.0)

        self.assertEqual(transitions.read_state(closed_record(last_probe_at=0.0)), "half_open")
        outcome = run(transitions.settle("stt"))

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "half_open")
        self.assertEqual(outcome.event.from_state, "closed")
        self.assertEqual(outcome.event.to_state, "half_open")
        self.assertEqual(outcome.event.phase, "read")
        self.assertEqual(outcome.record.trigger.kind, "stale")
        self.assertEqual(run(breaker.read("stt")).state, "half_open")

    def test_a_closed_record_at_exactly_twice_the_interval_is_not_stale(self):
        transitions, _, _, clock = harness(closed_record(last_probe_at=0.0))
        clock.advance(2 * INTERVAL_S)

        self.assertEqual(transitions.read_state(closed_record(last_probe_at=0.0)), "closed")
        self.assertFalse(run(transitions.settle("stt")).written)

    def test_settling_a_half_open_leg_writes_nothing(self):
        transitions, breaker, _, clock = harness(half_open_record())
        clock.advance(100.0)

        outcome = run(transitions.settle("stt"))

        self.assertFalse(outcome.written)
        self.assertIsNone(outcome.event)
        self.assertEqual(run(breaker.read("stt")).record_version, 1)


    def test_a_probe_outcome_before_the_interval_does_not_move_an_open_leg(self):
        transitions, breaker, _, clock = harness(open_record())
        clock.advance(1.0)

        success = run(transitions.record_probe_success("stt", latency_ms=10.0))
        failure = run(
            transitions.record_probe_failure("stt", verdict=classify("stt", 1011))
        )

        self.assertFalse(success.written)
        self.assertIsNone(success.event)
        self.assertFalse(failure.written)
        self.assertIsNone(failure.event)
        self.assertEqual(success.record.state, "open")
        self.assertEqual(run(breaker.read("stt")).record_version, 1)


class HysteresisTest(unittest.TestCase):
    def test_three_probe_successes_one_interval_apart_close_the_leg(self):
        transitions, breaker, _, clock = harness(half_open_record())
        for _ in range(3):
            outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(INTERVAL_S)

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "closed")
        self.assertEqual(outcome.event.from_state, "half_open")
        self.assertEqual(outcome.event.to_state, "closed")
        self.assertEqual(outcome.event.phase, "probe")
        self.assertEqual(len(outcome.record.probe_successes), 3)
        self.assertEqual(run(breaker.read("stt")).state, "closed")

    def test_two_probe_successes_do_not_close_the_leg(self):
        transitions, _, _, clock = harness(half_open_record())
        run(transitions.record_probe_success("stt", latency_ms=20.0))
        clock.advance(INTERVAL_S)
        outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))

        self.assertEqual(outcome.record.state, "half_open")
        self.assertEqual(outcome.event.to_state, "half_open")

    def test_three_probe_successes_in_a_row_too_soon_do_not_close_the_leg(self):
        transitions, _, _, clock = harness(half_open_record())
        for _ in range(3):
            outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(1.0)
        self.assertEqual(outcome.record.state, "half_open")

        clock.advance(INTERVAL_S)
        run(transitions.record_probe_success("stt", latency_ms=20.0))
        clock.advance(INTERVAL_S)
        outcome = run(transitions.record_probe_success("stt", latency_ms=20.0))

        # Only a window of three spaced successes may close the leg.
        self.assertEqual(outcome.record.state, "closed")
        self.assertEqual(outcome.record.probe_successes[-1].at, clock.now())

    def test_one_probe_failure_reopens_a_half_open_leg(self):
        transitions, breaker, _, clock = harness(half_open_record())
        clock.advance(INTERVAL_S)

        outcome = run(
            transitions.record_probe_failure("stt", verdict=classify("stt", 1011))
        )

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(outcome.event.from_state, "half_open")
        self.assertEqual(outcome.event.phase, "probe")
        self.assertEqual(outcome.record.trigger.kind, "probe_failure")
        self.assertEqual(outcome.record.trigger.code, 1011)
        self.assertEqual(outcome.record.probe_successes, ())
        self.assertEqual(run(breaker.read("stt")).state, "open")

    def test_a_probe_failure_while_closed_opens_only_on_a_trigger(self):
        transitions, _, _, _ = harness(closed_record())
        bug = run(transitions.record_probe_failure("stt", verdict=classify("stt", 1008)))
        self.assertFalse(bug.written)
        trigger = run(transitions.record_probe_failure("stt", verdict=classify("stt", 1013)))
        self.assertEqual(trigger.record.state, "open")

    def test_a_probe_success_on_a_routine_closed_leg_does_not_close_anything(self):
        transitions, breaker, _, clock = harness(closed_record(last_probe_at=0.0))
        clock.advance(10.0)

        outcome = run(transitions.record_probe_success("stt", latency_ms=12.0))

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "closed")
        self.assertEqual(outcome.event.from_state, "closed")
        self.assertEqual(outcome.event.to_state, "closed")
        self.assertFalse(outcome.event.changed_state)
        self.assertEqual(outcome.record.last_probe_at, 10.0)


class CanaryTest(unittest.TestCase):
    def test_the_first_real_call_after_a_probe_close_canaries_one_failure_back_open(self):
        transitions, _, _, clock = harness(half_open_record())
        for _ in range(3):
            run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(INTERVAL_S)
        self.assertEqual(run(transitions.breaker.read("stt")).state, "closed")

        clock.advance(5.0)
        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1011), phase="stream", turn=4
            )
        )

        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(outcome.event.from_state, "closed")
        self.assertEqual(outcome.record.trigger.code, 1011)
        self.assertEqual(outcome.record.last_failure_at, clock.now())

    def test_a_real_call_failure_in_half_open_reopens_immediately(self):
        transitions, _, _, clock = harness(half_open_record())
        clock.advance(INTERVAL_S)
        run(transitions.record_probe_success("stt", latency_ms=20.0))

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1008), phase="stream"
            )
        )

        # The leg was never proven healthy, so even our own bug reopens it.
        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(outcome.record.trigger.code, 1008)

    def test_a_real_call_success_records_the_watch_without_closing_a_half_open_leg(self):
        transitions, breaker, _, clock = harness(half_open_record())
        clock.advance(7.0)

        outcome = run(transitions.record_real_call_success("stt", phase="turn"))

        self.assertTrue(outcome.written)
        self.assertEqual(outcome.record.state, "half_open")
        self.assertEqual(outcome.record.last_success_at, 7.0)
        self.assertFalse(outcome.event.changed_state)
        self.assertEqual(outcome.event.phase, "turn")
        self.assertEqual(run(breaker.read("stt")).last_success_at, 7.0)


class ManualPinTest(unittest.TestCase):
    def test_a_pin_forces_fallback_and_survives_probe_hysteresis(self):
        transitions, breaker, _, clock = harness(half_open_record())
        clock.advance(5.0)

        pinned = run(transitions.pin("stt", actor="ana", why="vendor incident"))

        self.assertTrue(pinned.written)
        self.assertEqual(pinned.record.manual_override, "fallback")
        self.assertEqual(pinned.record.state, "half_open")
        self.assertEqual(pinned.event.actor, "ana")
        self.assertEqual(pinned.event.phase, "manual")
        self.assertIn("vendor incident", pinned.event.reason)

        for _ in range(3):
            closed = run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(INTERVAL_S)

        self.assertEqual(closed.record.state, "closed")
        self.assertEqual(closed.record.manual_override, "fallback")

    def test_staleness_and_probe_failure_do_not_clear_a_pin(self):
        pinned = closed_record(last_probe_at=0.0, manual_override="fallback")
        transitions, _, _, clock = harness(pinned)
        clock.advance(2 * INTERVAL_S + 1.0)

        settled = run(transitions.settle("stt"))
        reopened = run(
            transitions.record_probe_failure("stt", verdict=classify("stt", 1013))
        )

        self.assertEqual(settled.record.manual_override, "fallback")
        self.assertEqual(reopened.record.state, "open")
        self.assertEqual(reopened.record.manual_override, "fallback")

    def test_a_human_write_is_the_only_thing_that_clears_the_pin(self):
        transitions, breaker, _, _ = harness(
            half_open_record(manual_override="fallback")
        )

        cleared = run(transitions.clear_pin("stt", actor="ana", why="vendor recovered"))

        self.assertTrue(cleared.written)
        self.assertEqual(cleared.record.manual_override, "none")
        self.assertEqual(cleared.event.actor, "ana")
        self.assertIn("vendor recovered", cleared.event.reason)
        self.assertEqual(run(breaker.read("stt")).manual_override, "none")

    def test_clearing_an_unpinned_leg_is_a_no_op(self):
        transitions, breaker, _, _ = harness(closed_record())

        outcome = run(transitions.clear_pin("stt", actor="ana", why="nothing pinned"))

        self.assertFalse(outcome.written)
        self.assertIsNone(outcome.event)
        self.assertEqual(run(breaker.read("stt")).record_version, 1)

    def test_a_pin_needs_a_named_actor_and_a_stated_reason(self):
        transitions, _, _, _ = harness(closed_record())
        with self.assertRaises(ManualOverrideRefused) as no_actor:
            run(transitions.pin("stt", actor=" ", why="incident"))
        self.assertIn("who", str(no_actor.exception))
        with self.assertRaises(ManualOverrideRefused) as no_why:
            run(transitions.pin("stt", actor="ana", why=""))
        self.assertIn("why", str(no_why.exception))

    def test_a_primary_pin_is_refused_by_name(self):
        transitions, _, _, _ = harness(closed_record())
        with self.assertRaises(ManualOverrideRefused) as refused:
            run(transitions.pin("stt", target="primary", actor="ana", why="probe primary"))
        self.assertIn("primary", str(refused.exception))
        self.assertIn("fallback", str(refused.exception))


class LosingStore(MemoryStore):
    """A store where every compare-and-set loses to an imaginary writer."""

    async def compare_and_set(self, key, expected_version, stored):
        return False


class BreakerWriteFailureTest(unittest.TestCase):
    def test_a_failed_breaker_write_never_raises_and_keeps_the_selected_rung(self):
        transitions, breaker, store, clock = harness(closed_record())
        store.fail_writes = True

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        self.assertFalse(outcome.written)
        self.assertIn("write failed", outcome.error)
        self.assertIsNotNone(outcome.event)
        self.assertEqual(outcome.record.state, "open")
        self.assertEqual(run(breaker.read("stt")).state, "closed")

    def test_a_lost_compare_and_set_is_retried_then_reported_not_raised(self):
        record = closed_record()
        store = LosingStore(
            {
                breaker_key("stt"): StoredDocument(
                    version=record.record_version, document=record.to_document()
                )
            }
        )
        breaker = Breaker(store, probe_interval_s=INTERVAL_S, now=FakeClock())
        transitions = BreakerTransitions(breaker)

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        self.assertFalse(outcome.written)
        self.assertIn("compare-and-set", outcome.error)
        self.assertEqual(outcome.record.state, "open")

    def test_a_failed_read_is_reported_and_does_not_raise(self):
        transitions, _, store, _ = harness(closed_record())
        store.fail_reads = True

        outcome = run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        self.assertFalse(outcome.written)
        self.assertIsNone(outcome.record)
        self.assertIn("read failed", outcome.error)


if __name__ == "__main__":
    unittest.main()
