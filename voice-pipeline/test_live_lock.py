"""Offline proof of the live timing lock (ticket 151).

No live run, no network, no sleeping: a fake holder, a fake liveness probe and
an injected clock exercise the same rules the JS lock applies.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from live_lock import (
    DEFAULT_TIMING_LOCK_PATH,
    TimingLockHeldError,
    acquire_timing_lock,
)


class LockPorcelainTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "voni-demo-timing.lock"

    def tearDown(self):
        self.dir.cleanup()

    def test_acquire_writes_the_holder_and_release_removes_it(self):
        lock = acquire_timing_lock(path=self.path, scenario="live-smoke")
        self.assertTrue(self.path.is_file())
        holder = json.loads(self.path.read_text())
        self.assertEqual(holder["pid"], os.getpid())
        self.assertEqual(holder["scenario"], "live-smoke")
        self.assertRegex(holder["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        lock.release()
        self.assertFalse(self.path.exists())
        lock.release()  # idempotent

    def test_a_live_holder_is_refused_by_name(self):
        self.path.write_text(json.dumps({"pid": 4242, "at": "2026-10-29T00:00:00Z", "scenario": "demo"}))
        with self.assertRaises(TimingLockHeldError) as caught:
            acquire_timing_lock(path=self.path, is_alive=lambda pid: pid == 4242)
        message = str(caught.exception)
        self.assertIn(str(self.path), message)
        self.assertIn("pid 4242", message)
        self.assertIn("one at a time", message)
        # The live holder's file is untouched.
        self.assertTrue(self.path.exists())

    def test_a_dead_holder_is_reclaimed(self):
        self.path.write_text(json.dumps({"pid": 999999, "at": "x", "scenario": "demo"}))
        lock = acquire_timing_lock(path=self.path, is_alive=lambda pid: False)
        holder = json.loads(self.path.read_text())
        self.assertEqual(holder["pid"], os.getpid())
        lock.release()

    def test_a_corrupt_lock_younger_than_the_grace_is_not_stolen(self):
        self.path.write_text("{ not json")
        with self.assertRaises(TimingLockHeldError) as caught:
            acquire_timing_lock(path=self.path, now=lambda: 1_000.0)
        self.assertIn("unreadable", str(caught.exception))
        self.assertTrue(self.path.exists())

    def test_a_corrupt_lock_past_the_grace_is_reclaimed(self):
        self.path.write_text("{ not json")
        stale = time.time() - 60
        os.utime(self.path, (stale, stale))
        lock = acquire_timing_lock(path=self.path, now=time.time)
        self.assertEqual(json.loads(self.path.read_text())["pid"], os.getpid())
        lock.release()

    def test_release_never_deletes_another_process_s_lock(self):
        lock = acquire_timing_lock(path=self.path)
        self.path.write_text(json.dumps({"pid": 777, "at": "x", "scenario": "demo"}))
        lock.release()
        self.assertTrue(self.path.exists(), "someone else's live run stays serialized")


class SharedWithTheDemoScoreboardTests(unittest.TestCase):
    def test_the_lock_path_is_the_js_lock_s_path(self):
        # `voni/src/lib/demo/timing-lock.ts` -> join(tmpdir(), "voni-demo-timing.lock").
        # Same file means a JS demo run and the Python nightly cannot overlap.
        self.assertEqual(DEFAULT_TIMING_LOCK_PATH.name, "voni-demo-timing.lock")
        self.assertEqual(DEFAULT_TIMING_LOCK_PATH.parent, Path(tempfile.gettempdir()))


if __name__ == "__main__":
    unittest.main()
