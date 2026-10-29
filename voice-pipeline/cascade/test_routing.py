"""The routing switch decides new calls only: off, demo, all.

``off`` opens no cascade connection for any new call. ``demo`` makes the stored
demo subjects eligible and routes tenant calls managed. ``all`` makes every
eligible subject eligible, and a subject refused by another predicate (the body
adapter, the voice table, the counter) still routes managed with that reason
recorded. The decision is a frozen snapshot: it is taken before the first frame,
and a later flip cannot move a call that is already running.

The decision object is also the seam downstream tickets assert on, so these
tests never need a live call.
"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from cascade.routing import (
    DEFAULT_MODE,
    KEY,
    MODES,
    RECORD_VERSION,
    CallSubject,
    RoutingChange,
    RoutingDecision,
    RoutingRecord,
    RoutingSwitch,
    RoutingSwitchError,
    RoutingSwitchMissing,
    RoutingSwitchUnchanged,
    decide,
)
from cascade.store import MemoryStore, SqliteStore, StoredDocument, StoreUnavailable

DEMO_SUBJECT = CallSubject("demo-call-1", "demo")
TENANT_SUBJECT = CallSubject("tenant-call-1", "tenant")


def run(coro):
    return asyncio.run(coro)


class CountingStore:
    """A DurableStore that counts reads, so "read once" is observable."""

    def __init__(self, inner=None):
        self.inner = inner or MemoryStore()
        self.reads = 0
        self.writes = 0

    async def read(self, key):
        self.reads += 1
        return await self.inner.read(key)

    async def compare_and_set(self, key, expected_version, stored):
        self.writes += 1
        return await self.inner.compare_and_set(key, expected_version, stored)

    async def ping(self):
        return await self.inner.ping()


class RoutingDecisionTest(unittest.TestCase):
    def test_off_routes_every_new_call_managed_and_opens_no_connection(self):
        for subject in (DEMO_SUBJECT, TENANT_SUBJECT):
            decision = decide("off", subject)
            self.assertEqual(decision.disposition, "managed")
            self.assertFalse(decision.opens_cascade_connection)
            self.assertIn("off", decision.reason)

    def test_demo_makes_a_stored_demo_subject_eligible(self):
        decision = decide("demo", DEMO_SUBJECT)
        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.opens_cascade_connection)
        self.assertEqual(decision.reason, "")

    def test_demo_routes_tenant_calls_managed(self):
        decision = decide("demo", TENANT_SUBJECT)
        self.assertEqual(decision.disposition, "managed")
        self.assertFalse(decision.opens_cascade_connection)
        self.assertIn("demo", decision.reason)
        self.assertIn("tenant", decision.reason)

    def test_all_makes_every_eligible_subject_eligible(self):
        for subject in (DEMO_SUBJECT, TENANT_SUBJECT):
            decision = decide("all", subject)
            self.assertEqual(decision.disposition, "cascade")
            self.assertEqual(decision.reason, "")

    def test_all_refused_body_routes_managed_with_its_own_reason(self):
        decision = decide("all", TENANT_SUBJECT, refusal="body uses a BYO LLM")
        self.assertEqual(decision.disposition, "managed")
        self.assertFalse(decision.opens_cascade_connection)
        self.assertEqual(decision.reason, "body uses a BYO LLM")

    def test_demo_refused_demo_body_routes_managed_with_its_own_reason(self):
        decision = decide("demo", DEMO_SUBJECT, refusal="voice juergen is unbound")
        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.reason, "voice juergen is unbound")

    def test_routing_refusal_wins_over_a_later_predicate_refusal(self):
        decision = decide("off", TENANT_SUBJECT, refusal="body uses a BYO LLM")
        self.assertIn("off", decision.reason)
        self.assertNotIn("BYO", decision.reason)

    def test_unknown_mode_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            decide("sometimes", TENANT_SUBJECT)
        self.assertIn("sometimes", str(caught.exception))
        for mode in MODES:
            self.assertIn(mode, str(caught.exception))

    def test_a_managed_decision_must_name_its_reason(self):
        with self.assertRaises(ValueError) as caught:
            RoutingDecision(
                mode="off", subject=TENANT_SUBJECT, disposition="managed"
            )
        self.assertIn("reason", str(caught.exception))

    def test_an_unknown_mode_cannot_permit_cascade(self):
        with self.assertRaises(ValueError):
            RoutingDecision(
                mode=None,
                subject=TENANT_SUBJECT,
                disposition="cascade",
                reason="",
            )

    def test_decision_is_a_frozen_snapshot(self):
        decision = decide("demo", DEMO_SUBJECT, record_version=3, decided_at=100.0)
        with self.assertRaises(AttributeError):
            decision.disposition = "managed"
        self.assertEqual(decision.mode, "demo")
        self.assertEqual(decision.record_version, 3)
        self.assertEqual(decision.decided_at, 100.0)

    def test_decision_document_is_what_a_call_records(self):
        decision = decide("all", TENANT_SUBJECT, refusal="no fixed Locale", decided_at=5.0)
        self.assertEqual(
            decision.to_document(),
            {
                "mode": "all",
                "subject": {"id": "tenant-call-1", "kind": "tenant"},
                "disposition": "managed",
                "reason": "no fixed Locale",
                "recordVersion": None,
                "decidedAt": 5.0,
            },
        )


class CallSubjectTest(unittest.TestCase):
    def test_subject_requires_an_id(self):
        with self.assertRaises(ValueError):
            CallSubject("", "demo")

    def test_subject_kind_is_named(self):
        with self.assertRaises(ValueError) as caught:
            CallSubject("call", "internal")
        self.assertIn("internal", str(caught.exception))
        self.assertIn("demo", str(caught.exception))
        self.assertIn("tenant", str(caught.exception))


class FixedClock:
    def __init__(self, at):
        self.at = at

    def __call__(self):
        return self.at


class RoutingSwitchRecordTest(unittest.TestCase):
    def test_unwritten_switch_is_missing_not_invented(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(10.0))
        with self.assertRaises(RoutingSwitchMissing):
            run(switch.read())

    def test_first_change_is_created_at_version_one_with_an_audit_entry(self):
        store = MemoryStore()
        switch = RoutingSwitch(store, now=FixedClock(100.0))

        record = run(switch.set_mode("demo", actor="ops@voni", reason="W1 rehearsal"))

        self.assertIsNotNone(run(store.read(KEY)))
        self.assertEqual(record.mode, "demo")
        self.assertEqual(record.record_version, RECORD_VERSION)
        self.assertEqual(record.updated_at, 100.0)
        self.assertEqual(record.updated_by, "ops@voni")
        self.assertEqual(
            record.changes,
            (RoutingChange(at=100.0, actor="ops@voni", from_mode="unset", to_mode="demo",
                           reason="W1 rehearsal"),),
        )

    def test_every_change_records_who_when_from_and_to_and_stays_durable(self):
        store = MemoryStore()
        clock = FixedClock(100.0)
        first = RoutingSwitch(store, now=clock)
        run(first.set_mode("demo", actor="ops@voni"))

        clock.at = 200.0
        run(first.set_mode("all", actor="sre@voni", reason="cutover"))
        clock.at = 300.0
        run(first.set_mode("off", actor="ops@voni", reason="rollback rehearsal"))

        second = RoutingSwitch(store, now=FixedClock(999.0))
        record = run(second.read())
        self.assertEqual(record.mode, "off")
        self.assertEqual(record.record_version, 3)
        self.assertEqual(
            [(change.at, change.actor, change.from_mode, change.to_mode)
             for change in record.changes],
            [
                (100.0, "ops@voni", "unset", "demo"),
                (200.0, "sre@voni", "demo", "all"),
                (300.0, "ops@voni", "all", "off"),
            ],
        )
        self.assertEqual(record.changes[0].reason, "")
        self.assertEqual(record.changes[1].reason, "cutover")
        self.assertEqual(record.changes[2].reason, "rollback rehearsal")

    def test_mode_unknown_actor_and_unchanged_writes_are_refused_by_name(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(10.0))

        with self.assertRaises(ValueError) as unknown_mode:
            run(switch.set_mode("sometimes", actor="ops@voni"))
        self.assertIn("sometimes", str(unknown_mode.exception))
        for mode in MODES:
            self.assertIn(mode, str(unknown_mode.exception))

        with self.assertRaises(RoutingSwitchError) as no_actor:
            run(switch.set_mode("demo", actor="  "))
        self.assertIn("operator", str(no_actor.exception))

        run(switch.set_mode("demo", actor="ops@voni"))
        with self.assertRaises(RoutingSwitchUnchanged):
            run(switch.set_mode("demo", actor="ops@voni"))

    def test_compare_and_set_loser_must_reread_instead_of_overwriting(self):
        store = MemoryStore()
        clock = FixedClock(10.0)
        first = RoutingSwitch(store, now=clock)
        second = RoutingSwitch(store, now=clock)

        run(first.set_mode("demo", actor="ops@voni"))
        stale = run(first.read())
        run(second.set_mode("all", actor="sre@voni"))

        won = run(first.write(stale.switched("off", actor="ops@voni", at=20.0)))
        self.assertFalse(won)
        self.assertEqual(run(second.read()).mode, "all")

    def test_record_document_rejects_unknown_and_missing_fields(self):
        record = RoutingRecord.seeded("demo", actor="ops@voni", at=10.0)
        document = record.to_document()
        self.assertEqual(
            RoutingRecord.from_document(document), record
        )
        with self.assertRaises(RoutingSwitchError) as unknown:
            RoutingRecord.from_document({**document, "comment": "hi"})
        self.assertIn("comment", str(unknown.exception))
        without_changes = {key: value for key, value in document.items() if key != "changes"}
        with self.assertRaises(RoutingSwitchError) as missing:
            RoutingRecord.from_document(without_changes)
        self.assertIn("changes", str(missing.exception))

    def test_sqlite_switch_is_shared_by_two_instances(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cascade.sqlite3"
            writer = RoutingSwitch(SqliteStore(path), now=FixedClock(50.0))
            run(writer.set_mode("all", actor="ops@voni", reason="cutover"))

            reader = RoutingSwitch(SqliteStore(path), now=FixedClock(60.0))
            record = run(reader.read())
            self.assertEqual(record.mode, "all")
            self.assertEqual(record.updated_by, "ops@voni")
            self.assertEqual(record.changes[0].from_mode, "unset")

    def test_a_write_outage_is_raised_not_swallowed(self):
        store = MemoryStore()
        switch = RoutingSwitch(store, now=FixedClock(10.0))
        store.fail_writes = True
        with self.assertRaises(StoreUnavailable):
            run(switch.set_mode("demo", actor="ops@voni"))


class RoutingSwitchDecisionTest(unittest.TestCase):
    def test_switch_decides_off_demo_and_all_from_the_durable_mode(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(10.0))
        self.assertEqual(run(switch.decide(DEMO_SUBJECT)).disposition, "managed")

        run(switch.set_mode("demo", actor="ops@voni"))
        self.assertEqual(run(switch.decide(DEMO_SUBJECT)).disposition, "cascade")
        self.assertEqual(run(switch.decide(TENANT_SUBJECT)).disposition, "managed")

        run(switch.set_mode("all", actor="ops@voni"))
        self.assertEqual(run(switch.decide(TENANT_SUBJECT)).disposition, "cascade")

    def test_decision_carries_the_record_version_and_the_read_time(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(42.0))
        run(switch.set_mode("demo", actor="ops@voni"))
        decision = run(switch.decide(DEMO_SUBJECT))
        self.assertEqual(decision.record_version, 1)
        self.assertEqual(decision.decided_at, 42.0)

    def test_missing_switch_defaults_to_off_and_opens_no_connection(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        decision = run(switch.decide(TENANT_SUBJECT))
        self.assertEqual(decision.mode, DEFAULT_MODE)
        self.assertEqual(decision.disposition, "managed")
        self.assertIsNone(decision.record_version)
        self.assertIn("off", decision.reason)

    def test_unreadable_switch_routes_managed_with_an_honest_reason(self):
        store = MemoryStore()
        store.fail_reads = True
        switch = RoutingSwitch(store, now=FixedClock(1.0))
        decision = run(switch.decide(TENANT_SUBJECT))
        self.assertEqual(decision.mode, None)
        self.assertEqual(decision.disposition, "managed")
        self.assertFalse(decision.opens_cascade_connection)
        self.assertIn("unreadable", decision.reason)

    def test_a_corrupt_switch_record_routes_managed_instead_of_crashing_a_call(self):
        store = MemoryStore(
            {
                KEY: StoredDocument(
                    1,
                    {"mode": "sometimes", "recordVersion": 1, "changes": []},
                )
            }
        )
        switch = RoutingSwitch(store, now=FixedClock(1.0))
        decision = run(switch.decide(TENANT_SUBJECT))
        self.assertEqual(decision.mode, None)
        self.assertEqual(decision.disposition, "managed")
        self.assertIn("unreadable", decision.reason)

    def test_switch_is_read_exactly_once_before_the_first_frame(self):
        store = CountingStore()
        switch = RoutingSwitch(store, now=FixedClock(10.0))
        run(switch.set_mode("demo", actor="ops@voni"))
        store.reads = 0

        decision = run(switch.decide(DEMO_SUBJECT))
        self.assertEqual(store.reads, 1)
        self.assertEqual(decision.disposition, "cascade")

    def test_a_live_call_is_never_moved_by_a_later_change(self):
        store = CountingStore()
        switch = RoutingSwitch(store, now=FixedClock(10.0))
        run(switch.set_mode("demo", actor="ops@voni"))
        store.reads = 0

        live = run(switch.decide(DEMO_SUBJECT))
        self.assertEqual(store.reads, 1)
        run(switch.set_mode("off", actor="ops@voni", reason="rollback"))

        self.assertEqual(live.disposition, "cascade")
        self.assertEqual(live.mode, "demo")
        self.assertEqual(run(switch.decide(DEMO_SUBJECT)).disposition, "managed")

    def test_a_body_refusal_routes_managed_under_all(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(10.0))
        run(switch.set_mode("all", actor="ops@voni"))
        decision = run(switch.decide(TENANT_SUBJECT, refusal="voice juergen is unbound"))
        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.reason, "voice juergen is unbound")


if __name__ == "__main__":
    unittest.main()
