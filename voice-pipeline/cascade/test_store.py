"""The durable store is versioned and shared: no reader may see its own cache."""

import asyncio
import tempfile
import unittest
from pathlib import Path

from cascade.store import MemoryStore, SqliteStore, StoreUnavailable, StoredDocument


def run(coro):
    return asyncio.run(coro)


def document(state):
    return {"state": state}


class MemoryStoreTest(unittest.TestCase):
    def test_missing_key_reads_as_none(self):
        store = MemoryStore()
        self.assertIsNone(run(store.read("breaker:stt")))

    def test_create_wins_once_then_conflicts(self):
        store = MemoryStore()

        async def scenario():
            first = await store.compare_and_set(
                "breaker:stt", None, StoredDocument(1, document("closed"))
            )
            second = await store.compare_and_set(
                "breaker:stt", None, StoredDocument(1, document("open"))
            )
            return first, second, await store.read("breaker:stt")

        first, second, stored = run(scenario())
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(stored.version, 1)
        self.assertEqual(stored.document["state"], "closed")

    def test_stale_expected_version_is_refused(self):
        store = MemoryStore()

        async def scenario():
            await store.compare_and_set("k", None, StoredDocument(1, document("closed")))
            won = await store.compare_and_set("k", 1, StoredDocument(2, document("open")))
            lost = await store.compare_and_set("k", 1, StoredDocument(2, document("half_open")))
            return won, lost, await store.read("k")

        won, lost, stored = run(scenario())
        self.assertTrue(won)
        self.assertFalse(lost)
        self.assertEqual(stored.version, 2)
        self.assertEqual(stored.document["state"], "open")

    def test_outage_raises_store_unavailable(self):
        store = MemoryStore()
        store.fail_reads = True
        with self.assertRaises(StoreUnavailable):
            run(store.read("k"))

    def test_ping_reports_outage(self):
        store = MemoryStore()
        store.fail_pings = True
        with self.assertRaises(StoreUnavailable):
            run(store.ping())


class SqliteStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "cascade.db"
        self.addCleanup(self._tmp.cleanup)

    def corrupt(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists():
                candidate.write_bytes(b"not a database")

    def test_two_instances_read_the_same_record(self):
        writer = SqliteStore(self.path)
        reader = SqliteStore(self.path)

        async def scenario():
            created = await writer.compare_and_set(
                "breaker:stt", None, StoredDocument(1, document("closed"))
            )
            opened = await writer.compare_and_set(
                "breaker:stt", 1, StoredDocument(2, document("open"))
            )
            return created, opened, await reader.read("breaker:stt")

        created, opened, stored = run(scenario())
        self.assertTrue(created)
        self.assertTrue(opened)
        self.assertEqual(stored.version, 2)
        self.assertEqual(stored.document["state"], "open")

    def test_a_reader_is_not_cached(self):
        reader = SqliteStore(self.path)
        writer = SqliteStore(self.path)

        async def scenario():
            await writer.compare_and_set("k", None, StoredDocument(1, document("closed")))
            first = await reader.read("k")
            await writer.compare_and_set("k", 1, StoredDocument(2, document("open")))
            second = await reader.read("k")
            return first, second

        first, second = run(scenario())
        self.assertEqual(first.document["state"], "closed")
        self.assertEqual(second.document["state"], "open")
        self.assertEqual(second.version, 2)

    def test_cas_is_atomic_across_instances(self):
        left = SqliteStore(self.path)
        right = SqliteStore(self.path)

        async def scenario():
            await left.compare_and_set("k", None, StoredDocument(1, document("closed")))
            as_one = await left.compare_and_set("k", 1, StoredDocument(2, document("open")))
            as_two = await right.compare_and_set(
                "k", 1, StoredDocument(2, document("half_open"))
            )
            return as_one, as_two, await right.read("k")

        as_one, as_two, stored = run(scenario())
        self.assertTrue(as_one)
        self.assertFalse(as_two)
        self.assertEqual(stored.document["state"], "open")

    def test_failed_read_returns_last_durable_state(self):
        store = SqliteStore(self.path)

        async def scenario():
            await store.compare_and_set("k", None, StoredDocument(1, document("open")))
            before = await store.read("k")
            self.corrupt()
            after = await store.read("k")
            return before, after

        before, after = run(scenario())
        self.assertEqual(before.document["state"], "open")
        self.assertEqual(after.document["state"], "open")
        self.assertEqual(after.version, 1)

    def test_failed_read_without_durable_state_is_not_a_closed_record(self):
        self.path.write_bytes(b"not a database")
        store = SqliteStore(self.path)
        with self.assertRaises(StoreUnavailable):
            run(store.read("k"))

    def test_ping_reports_reachability(self):
        store = SqliteStore(self.path)

        async def scenario():
            await store.ping()
            self.corrupt()
            with self.assertRaises(StoreUnavailable):
                await store.ping()

        run(scenario())

    def test_key_and_version_are_validated(self):
        store = SqliteStore(self.path)
        with self.assertRaises(ValueError):
            run(store.compare_and_set("", None, StoredDocument(1, document("closed"))))
        with self.assertRaises(ValueError):
            run(store.compare_and_set("k", None, StoredDocument(0, document("closed"))))
        with self.assertRaises(ValueError):
            run(store.compare_and_set("k", None, StoredDocument(1, "not a mapping")))


if __name__ == "__main__":
    unittest.main()
