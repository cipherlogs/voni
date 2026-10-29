"""ProviderBreakerRecord v1: exact spec shape, honest reads, CAS writes."""

import asyncio
import tempfile
import unittest
from pathlib import Path

from cascade.breaker import (
    RECORD_VERSION,
    Breaker,
    BreakerRecordCorrupt,
    BreakerRecordMissing,
    BreakerRecordError,
    BreakerTrigger,
    ProbeSuccess,
    ProviderBreakerRecord,
    UnsupportedRecordVersion,
    breaker_key,
)
from cascade.store import MemoryStore, SqliteStore, StoreUnavailable, StoredDocument

LEG = "stt"
OTHER_LEG = "llm"
PROBE_INTERVAL_S = 30.0


def run(coro):
    return asyncio.run(coro)


def closed_record(**changes):
    fields = {"leg": LEG, "provider": "meta", "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def open_record(**changes):
    fields = {
        "leg": LEG,
        "provider": "assemblyai",
        "state": "open",
        "opened_at": 1000.0,
        "last_failure_at": 1000.0,
        "trigger": BreakerTrigger(kind="close", code=1013, phase="stream", turn=2),
        "reason": "stt 1013 rate limited",
    }
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def spec_document():
    return {
        "leg": "stt",
        "provider": "assemblyai",
        "state": "open",
        "openedAt": 1000.0,
        "lastFailureAt": 1000.0,
        "lastSuccessAt": 900.0,
        "lastProbeAt": 1010.0,
        "probeSuccesses": [{"at": 1010.0, "latencyMs": 85}],
        "manualOverride": "fallback",
        "trigger": {"kind": "close", "code": 1013, "phase": "stream", "turn": 2},
        "reason": "stt 1013 rate limited",
        "recordVersion": 2,
    }


class ProviderBreakerRecordShapeTest(unittest.TestCase):
    def test_record_writes_every_spec_field(self):
        record = ProviderBreakerRecord.from_document(spec_document())
        self.assertEqual(set(record.to_document()), set(spec_document()))
        self.assertEqual(record.to_document(), spec_document())

    def test_absent_trigger_and_timestamps_serialize_as_null(self):
        document = closed_record().to_document()
        self.assertIsNone(document["trigger"])
        self.assertIsNone(document["openedAt"])
        self.assertIsNone(document["lastFailureAt"])
        self.assertIsNone(document["lastSuccessAt"])
        self.assertIsNone(document["lastProbeAt"])
        self.assertEqual(document["probeSuccesses"], [])
        self.assertEqual(document["manualOverride"], "none")
        self.assertEqual(document["recordVersion"], RECORD_VERSION)

    def test_round_trip_is_stable(self):
        record = open_record()
        self.assertEqual(ProviderBreakerRecord.from_document(record.to_document()), record)

    def test_unknown_record_version_is_refused_by_name(self):
        for version in (0, -1, "2", 1.5, True, None):
            document = spec_document()
            document["recordVersion"] = version
            with self.subTest(version=version):
                with self.assertRaises(UnsupportedRecordVersion):
                    ProviderBreakerRecord.from_document(document)

    def test_missing_record_version_is_refused(self):
        document = spec_document()
        del document["recordVersion"]
        with self.assertRaises(UnsupportedRecordVersion):
            ProviderBreakerRecord.from_document(document)

    def test_unknown_document_field_is_refused_by_name(self):
        document = spec_document()
        document["fallbackProvider"] = "assemblyai"
        with self.assertRaises(BreakerRecordError) as caught:
            ProviderBreakerRecord.from_document(document)
        self.assertIn("fallbackProvider", str(caught.exception))

    def test_missing_document_field_is_refused_by_name(self):
        document = spec_document()
        del document["reason"]
        with self.assertRaises(BreakerRecordError) as caught:
            ProviderBreakerRecord.from_document(document)
        self.assertIn("reason", str(caught.exception))

    def test_a_probe_success_needs_a_latency(self):
        with self.assertRaises(BreakerRecordError):
            ProbeSuccess(at=1000.0, latency_ms=None)
        with self.assertRaises(BreakerRecordError):
            ProbeSuccess(at=1000.0, latency_ms=-1)

    def test_at_most_three_probe_successes(self):
        four = tuple(ProbeSuccess(at=1000.0 + i, latency_ms=80) for i in range(4))
        with self.assertRaises(BreakerRecordError):
            closed_record(probe_successes=four).to_document()
        three = four[:3]
        self.assertEqual(len(closed_record(probe_successes=three).to_document()["probeSuccesses"]), 3)

    def test_unknown_leg_state_and_override_are_refused_by_name(self):
        with self.assertRaises(BreakerRecordError) as leg:
            closed_record(leg="speech")
        self.assertIn("speech", str(leg.exception))
        with self.assertRaises(BreakerRecordError) as state:
            closed_record(state="tripped")
        self.assertIn("tripped", str(state.exception))
        with self.assertRaises(BreakerRecordError) as override:
            closed_record(manual_override="primary")
        self.assertIn("primary", str(override.exception))

    def test_open_state_requires_an_opened_at(self):
        with self.assertRaises(BreakerRecordError):
            closed_record(state="open", opened_at=None)

    def test_bumped_increments_the_version_and_keeps_the_rest(self):
        record = closed_record()
        bumped = record.bumped(state="open", opened_at=1000.0, reason="1011")
        self.assertEqual(bumped.record_version, RECORD_VERSION + 1)
        self.assertEqual(bumped.state, "open")
        self.assertEqual(bumped.reason, "1011")
        with self.assertRaises(BreakerRecordError):
            record.bumped(record_version=9)


class BreakerStoreContractTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "breaker.db"
        self.addCleanup(self._tmp.cleanup)

    def test_two_instances_reading_the_same_leg_see_the_same_record(self):
        left = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)
        right = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)

        async def scenario():
            await left.write(closed_record())
            await left.write(open_record().bumped())
            return await left.read(LEG), await right.read(LEG)

        read_left, read_right = run(scenario())
        self.assertEqual(read_left, read_right)
        self.assertEqual(read_right.state, "open")
        self.assertEqual(read_right.record_version, 2)

    def test_cas_on_record_version_prevents_silent_overwrite(self):
        left = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)
        right = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)

        async def scenario():
            await left.write(closed_record())
            left_seen = await left.read(LEG)
            right_seen = await right.read(LEG)
            left_won = await left.write(
                left_seen.bumped(state="open", opened_at=1000.0, reason="left")
            )
            right_lost = await right.write(
                right_seen.bumped(state="open", opened_at=1001.0, reason="right")
            )
            return left_won, right_lost, await right.read(LEG)

        left_won, right_lost, durable = run(scenario())
        self.assertTrue(left_won)
        self.assertFalse(right_lost)
        self.assertEqual(durable.reason, "left")
        self.assertEqual(durable.record_version, 2)

    def test_a_loser_can_re_read_and_write_the_next_version(self):
        left = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)
        right = Breaker(SqliteStore(self.path), probe_interval_s=PROBE_INTERVAL_S)

        async def scenario():
            await left.write(closed_record())
            seen = await right.read(LEG)
            await left.write(seen.bumped(reason="left"))
            await right.write(seen.bumped(reason="right"))
            refreshed = await right.read(LEG)
            retried = await right.write(refreshed.bumped(reason="right after re-read"))
            return retried, await right.read(LEG)

        retried, durable = run(scenario())
        self.assertTrue(retried)
        self.assertEqual(durable.reason, "right after re-read")
        self.assertEqual(durable.record_version, 3)

    def test_a_failed_read_returns_the_last_durable_state_not_a_closed_one(self):
        store = SqliteStore(self.path)
        breaker = Breaker(store, probe_interval_s=PROBE_INTERVAL_S)

        async def scenario():
            await breaker.write(open_record())
            before = await breaker.read(LEG)
            self.path.write_bytes(b"not a database")
            after = await breaker.read(LEG)
            return before, after

        before, after = run(scenario())
        self.assertEqual(before.state, "open")
        self.assertEqual(after, before)

    def test_a_failed_read_with_no_durable_state_does_not_invent_closed(self):
        store = MemoryStore()
        store.fail_reads = True
        breaker = Breaker(store, probe_interval_s=PROBE_INTERVAL_S)
        with self.assertRaises(StoreUnavailable):
            run(breaker.read(LEG))

    def test_a_missing_record_raises_rather_than_reading_closed(self):
        breaker = Breaker(MemoryStore(), probe_interval_s=PROBE_INTERVAL_S)
        with self.assertRaises(BreakerRecordMissing) as caught:
            run(breaker.read(LEG))
        self.assertIn(LEG, str(caught.exception))

    def test_a_record_stored_under_the_wrong_leg_is_refused(self):
        store = MemoryStore(
            {
                breaker_key(LEG): StoredDocument(
                    version=1, document=closed_record(leg=OTHER_LEG).to_document()
                )
            }
        )
        breaker = Breaker(store, probe_interval_s=PROBE_INTERVAL_S)
        with self.assertRaises(BreakerRecordCorrupt):
            run(breaker.read(LEG))

    def test_a_document_version_that_disagrees_with_the_row_is_refused(self):
        store = MemoryStore(
            {
                breaker_key(LEG): StoredDocument(
                    version=2, document=closed_record().to_document()
                )
            }
        )
        breaker = Breaker(store, probe_interval_s=PROBE_INTERVAL_S)
        with self.assertRaises(BreakerRecordCorrupt):
            run(breaker.read(LEG))

    def test_writing_version_one_twice_conflicts(self):
        breaker = Breaker(MemoryStore(), probe_interval_s=PROBE_INTERVAL_S)

        async def scenario():
            return await breaker.write(closed_record()), await breaker.write(closed_record())

        self.assertEqual(run(scenario()), (True, False))

    def test_probe_interval_is_injected_not_invented(self):
        with self.assertRaises(TypeError):
            Breaker(MemoryStore())
        with self.assertRaises(ValueError):
            Breaker(MemoryStore(), probe_interval_s=0)


class BreakerStalenessTest(unittest.TestCase):
    def test_a_record_stale_by_twice_the_probe_interval_reads_half_open(self):
        breaker = Breaker(MemoryStore(), probe_interval_s=PROBE_INTERVAL_S, now=lambda: 2000.0)
        fresh = closed_record(last_probe_at=2000.0 - 59.0)
        stale = closed_record(last_probe_at=2000.0 - 61.0)
        self.assertEqual(breaker.effective_state(fresh), "closed")
        self.assertEqual(breaker.effective_state(stale), "half_open")

    def test_stored_state_and_override_survive_a_stale_read(self):
        breaker = Breaker(MemoryStore(), probe_interval_s=PROBE_INTERVAL_S, now=lambda: 2000.0)
        pinned = open_record(manual_override="fallback", last_probe_at=1000.0)
        self.assertEqual(breaker.effective_state(pinned), "open")

    def test_a_never_probed_closed_record_is_not_stale(self):
        breaker = Breaker(MemoryStore(), probe_interval_s=PROBE_INTERVAL_S, now=lambda: 2000.0)
        self.assertEqual(breaker.effective_state(closed_record()), "closed")


if __name__ == "__main__":
    unittest.main()
