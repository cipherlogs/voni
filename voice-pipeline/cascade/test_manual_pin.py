"""The manual fallback pin: rung selection and the who/when/why audit (ticket 19).

Two seams:

* ``ladders.choose_rung`` turns one breaker record into the rung a new call
  uses. A pin forces the fallback rung on every read, whatever the stored
  state, and the choice still reports the underlying state and last probe so
  an operator can see why the leg is pinned.
* ``override_audit.OverrideAudit`` is the durable trail: a human write records
  who, when and why; no probe, canary or staleness rule appends to it or
  clears the pin; a request for an automated primary pin is refused by name.

Time is the ticket-01 ``FakeClock``; the probe interval is ticket 18's registry
bound. No test sleeps.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ProviderBreakerRecord,
    breaker_key,
    probe_interval_s,
)
from cascade.failures import classify
from cascade.ladders import Ladder, choose_rung
from cascade.override_audit import OverrideAudit, override_key
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock

INTERVAL_S = 30.0
STT = Ladder(leg="stt", primary="meta", fallback="assemblyai")
VOICE_ONLY = Ladder(leg="tts", primary="assemblyai", fallback=None)


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
    transitions = BreakerTransitions(breaker)
    audit = OverrideAudit(store, now=clock)
    return transitions, breaker, audit, store, clock


def choice(breaker, ladder, clock):
    record = run(breaker.read(ladder.leg))
    return choose_rung(
        record, ladder, now=clock(), probe_interval_s=probe_interval_s()
    )


class RungSelectionTest(unittest.TestCase):
    def test_an_unpinned_closed_leg_uses_the_primary_rung(self):
        transitions, breaker, _, _, clock = harness(closed_record())

        chosen = choice(breaker, STT, clock)

        self.assertEqual(chosen.rung, "primary")
        self.assertEqual(chosen.provider, "meta")
        self.assertFalse(chosen.pinned)
        self.assertEqual(chosen.state, "closed")

    def test_an_open_leg_uses_the_fallback_rung(self):
        _, breaker, _, _, clock = harness(
            half_open_record(state="open", opened_at=0.0)
        )

        chosen = choice(breaker, STT, clock)

        self.assertEqual(chosen.rung, "fallback")
        self.assertEqual(chosen.provider, "assemblyai")
        self.assertIn("open", chosen.reason)

    def test_a_stale_closed_leg_is_not_trusted_as_primary(self):
        _, breaker, _, _, clock = harness(closed_record(last_probe_at=0.0))
        clock.advance(2 * INTERVAL_S + 1.0)

        chosen = choice(breaker, STT, clock)

        self.assertEqual(chosen.state, "closed")
        self.assertEqual(chosen.effective_state, "half_open")
        self.assertEqual(chosen.rung, "fallback")

    def test_a_leg_with_no_fallback_rung_selects_none_and_says_why(self):
        _, breaker, _, _, clock = harness(
            ProviderBreakerRecord(
                leg="tts",
                provider="assemblyai",
                state="open",
                opened_at=0.0,
                trigger=BreakerTrigger(kind="failure", code=3005, phase="stream"),
                reason="tts 3005 no output while a FlushDone was owed",
            )
        )

        chosen = choice(breaker, VOICE_ONLY, clock)

        self.assertEqual(chosen.rung, "none")
        self.assertIsNone(chosen.provider)
        self.assertIn("no fallback rung", chosen.reason)

    def test_a_record_for_another_leg_is_refused_by_name(self):
        _, breaker, _, _, clock = harness(closed_record())
        with self.assertRaises(ValueError) as refused:
            choose_rung(
                run(breaker.read("stt")),
                Ladder(leg="llm", primary="spark", fallback="gateway"),
                now=clock(),
                probe_interval_s=INTERVAL_S,
            )
        self.assertIn("llm", str(refused.exception))


class PinSelectionTest(unittest.TestCase):
    def test_a_pinned_leg_selects_the_fallback_rung_on_every_read(self):
        transitions, breaker, audit, _, clock = harness(closed_record())
        run(audit.pin(transitions, "stt", actor="ana", why="vendor incident"))

        first = choice(breaker, STT, clock)
        clock.advance(1.0)
        second = choice(breaker, STT, clock)

        for chosen in (first, second):
            self.assertEqual(chosen.rung, "fallback")
            self.assertEqual(chosen.provider, "assemblyai")
            self.assertTrue(chosen.pinned)
            self.assertIn("ana", chosen.reason)

    def test_a_pinned_leg_still_reports_its_underlying_state_and_last_probe(self):
        captured = 12.5
        transitions, breaker, audit, _, clock = harness(
            closed_record(last_probe_at=captured)
        )
        run(audit.pin(transitions, "stt", actor="ana", why="vendor incident"))

        chosen = choice(breaker, STT, clock)

        self.assertEqual(chosen.rung, "fallback")
        self.assertEqual(chosen.state, "closed")
        self.assertEqual(chosen.effective_state, "closed")
        self.assertEqual(chosen.last_probe_at, captured)

    def test_no_probe_canary_or_staleness_rule_clears_the_pin(self):
        transitions, breaker, audit, _, clock = harness(half_open_record())
        pinned = run(audit.pin(transitions, "stt", actor="ana", why="vendor incident"))
        self.assertTrue(pinned.audited)

        for _ in range(3):
            run(transitions.record_probe_success("stt", latency_ms=20.0))
            clock.advance(INTERVAL_S)
        clock.advance(2 * INTERVAL_S + 1.0)
        run(transitions.settle("stt"))
        run(transitions.record_probe_failure("stt", verdict=classify("stt", 1011)))
        run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        record = run(breaker.read("stt"))
        self.assertEqual(record.manual_override, "fallback")
        self.assertEqual(choice(breaker, STT, clock).rung, "fallback")
        self.assertEqual(len(run(audit.read("stt"))), 1)

    def test_only_a_human_write_returns_the_pin_to_none_and_audits_who_when_why(self):
        transitions, breaker, audit, _, clock = harness(closed_record())
        clock.advance(100.0)
        run(audit.pin(transitions, "stt", actor="ana", why="vendor incident"))
        clock.advance(60.0)

        cleared = run(
            audit.clear(transitions, "stt", actor="bo", why="vendor recovered")
        )

        self.assertTrue(cleared.audited)
        self.assertEqual(run(breaker.read("stt")).manual_override, "none")
        entries = run(audit.read("stt"))
        self.assertEqual([entry.to_override for entry in entries], ["fallback", "none"])
        self.assertEqual([entry.actor for entry in entries], ["ana", "bo"])
        self.assertEqual([entry.at for entry in entries], [100.0, 160.0])
        self.assertEqual([entry.why for entry in entries], ["vendor incident", "vendor recovered"])
        self.assertEqual(entries[-1].from_override, "fallback")
        self.assertEqual(choice(breaker, STT, clock).rung, "primary")

    def test_a_primary_pin_is_refused_by_name_and_audits_nothing(self):
        transitions, breaker, audit, store, _ = harness(closed_record())

        with self.assertRaises(ValueError) as refused:
            run(
                audit.pin(
                    transitions,
                    "stt",
                    actor="ana",
                    why="test the primary",
                    target="primary",
                )
            )

        self.assertIn("primary", str(refused.exception))
        self.assertIn("fallback", str(refused.exception))
        self.assertEqual(run(breaker.read("stt")).record_version, 1)
        self.assertEqual(run(audit.read("stt")), ())
        self.assertNotIn(override_key("stt"), store.rows)

    def test_a_pin_needs_a_named_actor_and_a_stated_why_before_it_is_audited(self):
        transitions, breaker, audit, _, _ = harness(closed_record())

        with self.assertRaises(ValueError):
            run(audit.pin(transitions, "stt", actor=" ", why="incident"))
        with self.assertRaises(ValueError):
            run(audit.pin(transitions, "stt", actor="ana", why=""))

        self.assertEqual(run(breaker.read("stt")).manual_override, "none")
        self.assertEqual(run(audit.read("stt")), ())

    def test_the_audit_trail_survives_a_new_process_reading_the_same_store(self):
        transitions, breaker, audit, store, clock = harness(closed_record())
        run(audit.pin(transitions, "stt", actor="ana", why="vendor incident"))

        reopened = OverrideAudit(store, now=clock)

        entries = run(reopened.read("stt"))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].actor, "ana")
        self.assertEqual(entries[0].to_override, "fallback")
        self.assertEqual(entries[0].why, "vendor incident")


class LadderShapeTest(unittest.TestCase):
    def test_a_ladder_refuses_a_fallback_that_is_the_primary(self):
        with self.assertRaises(ValueError) as refused:
            Ladder(leg="stt", primary="meta", fallback="meta")
        self.assertIn("fallback", str(refused.exception))

    def test_a_ladder_has_no_default_rungs(self):
        with self.assertRaises(TypeError):
            Ladder(leg="stt")  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
