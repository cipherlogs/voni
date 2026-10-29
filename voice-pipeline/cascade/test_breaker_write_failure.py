"""A failed breaker write alerts and never kills a live call (ticket 21).

A live call has already chosen its rungs; a breaker write is bookkeeping for
*new* calls. So a store outage during a call must alert and change nothing:
the call keeps talking on the rung it selected, is not moved, cancelled or
restarted. The next call re-reads the durable record and uses it — and a
record it cannot read refuses the call rather than inventing a closed leg.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.failures import classify
from cascade.ladders import (
    CallRungs,
    Ladder,
    LegUnreadable,
    choose_rung,
    read_choices,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock

INTERVAL_S = 30.0
STT = Ladder(leg="stt", primary="meta", fallback="assemblyai")
LLM = Ladder(leg="llm", primary="spark", fallback="gateway")
LADDERS = (STT, LLM)


def run(coro):
    return asyncio.run(coro)


def closed(leg, provider, **changes):
    fields = {"leg": leg, "provider": provider, "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def half_open(leg, provider, **changes):
    fields = {
        "leg": leg,
        "provider": provider,
        "state": "half_open",
        "opened_at": 0.0,
        "last_failure_at": 0.0,
        "trigger": BreakerTrigger(kind="failure", code=1013, phase="stream"),
        "reason": f"{leg} 1013 rate limited",
    }
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def harness(*records, interval_s=INTERVAL_S, start=0.0):
    clock = FakeClock(start)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
            for record in records
        }
    )
    breaker = Breaker(store, probe_interval_s=interval_s, now=clock)
    return BreakerTransitions(breaker), breaker, store, clock


def call_rungs(breaker, transitions, *ladders):
    choices = run(read_choices(breaker, ladders=ladders or LADDERS))
    return CallRungs(choices, transitions=transitions)


class LiveCallSurvivesTest(unittest.TestCase):
    def test_a_failed_breaker_write_alerts_and_the_live_call_keeps_its_rung(self):
        transitions, breaker, store, clock = harness(closed("stt", "meta"), closed("llm", "spark"))
        call = call_rungs(breaker, transitions)
        self.assertEqual(call.rung("stt").provider, "meta")

        store.fail_writes = True
        outcome = run(
            call.failed("stt", verdict=classify("stt", 1013), phase="stream", turn=2)
        )

        self.assertFalse(outcome.written)
        self.assertTrue(outcome.alerted)
        self.assertIn("write failed", outcome.error)
        self.assertEqual(call.rung("stt").provider, "meta")
        self.assertEqual(call.rung("stt").rung, "primary")
        alerts = call.alerts
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0].leg, "stt")
        self.assertEqual(alerts[0].kind, "breaker_write_failed")
        self.assertEqual(alerts[0].rung, "primary")
        self.assertIn("write failed", alerts[0].error)
        self.assertEqual(alerts[0].at, clock())
        document = alerts[0].to_document()
        self.assertEqual(document["leg"], "stt")
        self.assertEqual(document["kind"], "breaker_write_failed")

    def test_the_call_is_not_moved_cancelled_or_restarted_by_the_write_failure(self):
        transitions, breaker, store, clock = harness(closed("stt", "meta"), closed("llm", "spark"))
        call = call_rungs(breaker, transitions)
        rung_before = call.rung("stt")
        backend_opens = []

        async def live_call():
            backend_opens.append("stt")
            store.fail_writes = True
            await call.failed(
                "stt", verdict=classify("stt", 1013), phase="stream", turn=1
            )
            # The rest of the call runs: the same rung answers the next turn.
            await call.succeeded("stt", phase="turn")
            return f"finished on {call.rung('stt').provider}"

        result = run(live_call())

        self.assertEqual(result, "finished on meta")
        self.assertEqual(backend_opens, ["stt"])
        self.assertIs(call.rung("stt"), rung_before)
        self.assertEqual(len(call.alerts), 2)  # the failed write, and the failed success write

    def test_the_next_call_rereads_the_durable_state_and_uses_it(self):
        transitions, breaker, store, clock = harness(closed("stt", "meta"), closed("llm", "spark"))
        call = call_rungs(breaker, transitions)
        store.fail_writes = True
        run(call.failed("stt", verdict=classify("stt", 1013), phase="stream"))

        # The failed write left the durable record closed, so the next call
        # starts on the primary rung — it does not trust the lost write.
        next_call = call_rungs(breaker, transitions)
        self.assertEqual(next_call.rung("stt").rung, "primary")
        self.assertEqual(next_call.rung("stt").state, "closed")

        store.fail_writes = False
        run(call.failed("stt", verdict=classify("stt", 1013), phase="stream"))
        after = call_rungs(breaker, transitions)
        self.assertEqual(after.rung("stt").rung, "fallback")
        self.assertEqual(after.rung("stt").provider, "assemblyai")

    def test_a_store_read_outage_refuses_the_new_call_instead_of_inventing_a_closed_leg(self):
        _, breaker, store, _ = harness(closed("stt", "meta"), closed("llm", "spark"))
        store.fail_reads = True

        with self.assertRaises(LegUnreadable) as refused:
            run(read_choices(breaker, ladders=LADDERS))

        self.assertEqual(refused.exception.leg, "stt")
        self.assertIn("stt", str(refused.exception))
        self.assertIn("unreadable", str(refused.exception))

    def test_a_failed_write_never_writes_a_synthetic_closed_record(self):
        transitions, breaker, store, clock = harness(
            half_open("stt", "assemblyai"), closed("llm", "spark")
        )
        call = call_rungs(breaker, transitions)
        self.assertEqual(call.rung("stt").rung, "fallback")
        store.fail_writes = True

        run(
            call.failed(
                "stt", verdict=classify("stt", 1011), phase="probe"
            )
        )

        durable = run(breaker.read("stt"))
        self.assertEqual(durable.state, "half_open")
        self.assertEqual(durable.record_version, 1)
        self.assertEqual(call.rung("stt").rung, "fallback")


class ChoiceReadingTest(unittest.TestCase):
    def test_a_missing_record_refuses_the_call_by_name(self):
        transitions, breaker, _, _ = harness(closed("stt", "meta"))

        with self.assertRaises(LegUnreadable) as refused:
            run(read_choices(breaker, ladders=LADDERS))

        self.assertEqual(refused.exception.leg, "llm")
        self.assertIn("no durable breaker record", str(refused.exception))

    def test_each_call_reads_the_record_and_there_is_no_cache(self):
        transitions, breaker, store, clock = harness(closed("stt", "meta"), closed("llm", "spark"))
        first = run(read_choices(breaker, ladders=LADDERS))
        self.assertEqual(first["stt"].rung, "primary")

        run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        second = run(read_choices(breaker, ladders=LADDERS))
        self.assertEqual(second["stt"].rung, "fallback")
        self.assertEqual(first["stt"].rung, "primary")  # the frozen first choice is unchanged

    def test_a_choice_is_the_pure_function_of_the_record_it_was_read_from(self):
        _, breaker, _, clock = harness(closed("stt", "meta"))
        record = run(breaker.read("stt"))

        chosen = run(read_choices(breaker, ladders=(STT,)))["stt"]

        self.assertEqual(
            chosen,
            choose_rung(record, STT, now=clock(), probe_interval_s=INTERVAL_S),
        )


if __name__ == "__main__":
    unittest.main()
