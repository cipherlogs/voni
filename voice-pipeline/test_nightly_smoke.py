"""Offline proof of the nightly live smoke and its guards (ticket 151).

A live vendor call cannot run in CI without keys, so this file proves the parts
that must be right *before* the first live night: keys gate every leg, no keys
never becomes a green live claim, recordings never enter the repo, wire drift
is named, the timing lock serializes runs, nothing touches the production
breaker or counter, and the workflow cannot run on a PR.
"""

from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

from nightly_smoke import (
    EXIT_BLOCKED,
    EXIT_DRIFT,
    EXIT_NO_KEYS,
    EXIT_OK,
    LEGS,
    LegRecord,
    key_state,
    run,
    wire_drift,
)

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "nightly.yml"
CI = REPO / ".github" / "workflows" / "ci.yml"
FIXTURES = Path(__file__).with_name("cascade") / "fixtures"
KEYS = {"META_API_KEY": "m", "ASSEMBLYAI_API_KEY": "a", "META_REASONING_EFFORT": "low"}


class KeyGateTests(unittest.TestCase):
    def test_missing_keys_are_named(self):
        state = key_state({})
        self.assertFalse(state.present)
        self.assertEqual(state.missing, ("META_API_KEY", "ASSEMBLYAI_API_KEY"))
        self.assertIn("META_API_KEY", state.line())

    def test_both_keys_present(self):
        state = key_state({"META_API_KEY": "m", "ASSEMBLYAI_API_KEY": "a"})
        self.assertTrue(state.present)
        self.assertEqual(state.missing, ())

    def test_blank_key_is_missing(self):
        state = key_state({"META_API_KEY": "  ", "ASSEMBLYAI_API_KEY": "a"})
        self.assertFalse(state.present)
        self.assertEqual(state.missing, ("META_API_KEY",))


class NoKeysTests(unittest.TestCase):
    def test_without_keys_the_run_is_explicitly_skipped_and_never_green(self):
        def live(leg, *, key, env):  # pragma: no cover - must not be called
            raise AssertionError("a live call ran without keys")

        with tempfile.TemporaryDirectory() as out:
            code, lines = run(env={}, out_dir=Path(out), live=live, acquire_lock=_free_lock)
        self.assertEqual(code, EXIT_NO_KEYS)
        self.assertTrue(any("SKIPPED" in line for line in lines), lines)
        self.assertTrue(any("no live call" in line for line in lines), lines)


class RecordingTests(unittest.TestCase):
    def test_one_call_per_leg_records_outside_the_repo(self):
        calls: list[str] = []

        def live(leg, *, key, env):
            calls.append(leg)
            return _good_record(leg)

        with tempfile.TemporaryDirectory() as out:
            out_dir = Path(out)
            code, lines = run(env=KEYS, out_dir=out_dir, live=live, acquire_lock=_free_lock)
            written = sorted(path.name for path in out_dir.glob("*.json"))
        self.assertEqual(code, EXIT_OK, lines)
        self.assertEqual(calls, list(LEGS))
        self.assertEqual(written, ["llm.json", "stt.json", "tts.json"])

    def test_a_recording_may_not_overwrite_a_committed_fixture(self):
        def live(leg, *, key, env):
            return _good_record(leg)

        code, lines = run(env=KEYS, out_dir=FIXTURES / "stt", live=live, acquire_lock=_free_lock)
        self.assertEqual(code, EXIT_DRIFT)
        self.assertTrue(any("refus" in line.lower() for line in lines), lines)

    def test_the_recording_carries_no_credential(self):
        def live(leg, *, key, env):
            return _good_record(leg)

        with tempfile.TemporaryDirectory() as out:
            out_dir = Path(out)
            run(
                env={
                    "META_API_KEY": "super-secret",
                    "ASSEMBLYAI_API_KEY": "also-secret",
                    "META_REASONING_EFFORT": "low",
                },
                out_dir=out_dir,
                live=live,
                acquire_lock=_free_lock,
            )
            text = "".join(path.read_text() for path in out_dir.glob("*.json"))
        self.assertNotIn("super-secret", text)
        self.assertNotIn("also-secret", text)


class WireDriftTests(unittest.TestCase):
    def test_a_live_wire_the_adapter_can_no_longer_read_is_named(self):
        # The STT adapter maps `speechComplete` to its final. A vendor rename
        # means the live call no longer observes a final: that is drift, and it
        # must name the leg and what went missing.
        recorded = LegRecord(leg="stt", frames=[{"type": "ack"}], observations=["ack"])
        drift = wire_drift("stt", recorded)
        self.assertTrue(drift, "a missing final is drift")
        joined = " ".join(drift)
        self.assertIn("stt/events-turn", joined)
        self.assertIn("speechComplete", joined)

    def test_an_additive_unknown_frame_is_not_drift(self):
        recorded = LegRecord(
            leg="stt",
            frames=[{"type": "ack"}, {"type": "brandNewVendorEvent", "whatever": 1}],
            observations=["ack", "speechComplete"],
        )
        self.assertEqual(wire_drift("stt", recorded), [])

    def test_no_adapter_observation_at_all_is_a_named_failure(self):
        drift = wire_drift("stt", LegRecord(leg="stt", frames=[], observations=[]))
        self.assertTrue(drift)
        self.assertIn("no adapter observation", " ".join(drift))

    def test_each_leg_names_its_own_baseline(self):
        self.assertIn("llm/normal-reply", " ".join(wire_drift("llm", LegRecord(leg="llm", frames=[], observations=[]))))
        self.assertIn("tts/begin-echo", " ".join(wire_drift("tts", LegRecord(leg="tts", frames=[], observations=[]))))


class DriftRunTests(unittest.TestCase):
    def test_drift_fails_the_night_with_the_fixture_name(self):
        def live(leg, *, key, env):
            record = _good_record(leg)
            if leg == "tts":
                record.observations.remove("Audio")
            return record

        with tempfile.TemporaryDirectory() as out:
            code, lines = run(env=KEYS, out_dir=Path(out), live=live, acquire_lock=_free_lock)
        self.assertEqual(code, EXIT_DRIFT)
        self.assertTrue(any("tts/begin-echo" in line for line in lines), lines)

    def test_a_blocked_leg_is_labelled_not_green(self):
        def live(leg, *, key, env):
            return _good_record(leg)

        with tempfile.TemporaryDirectory() as out:
            env = dict(KEYS)
            env.pop("META_REASONING_EFFORT")
            code, lines = run(env=env, out_dir=Path(out), live=live, acquire_lock=_free_lock)
        # M03 owns reasoning_effort; without it the model leg cannot be called
        # and the night says so instead of claiming a live pass.
        self.assertEqual(code, EXIT_BLOCKED)
        self.assertTrue(any("BLOCKED" in line and "reasoning_effort" in line for line in lines), lines)
        self.assertTrue(any("M03" in line for line in lines), lines)

    def test_a_vendor_outage_is_named_and_still_records_the_other_legs(self):
        def live(leg, *, key, env):
            if leg == "llm":
                raise TimeoutError("vendor did not answer")
            return _good_record(leg)

        with tempfile.TemporaryDirectory() as out:
            out_dir = Path(out)
            code, lines = run(env=KEYS, out_dir=out_dir, live=live, acquire_lock=_free_lock)
            written = sorted(path.name for path in out_dir.glob("*.json"))
        self.assertEqual(code, EXIT_DRIFT)
        self.assertTrue(any("llm: FAILED" in line for line in lines), lines)
        self.assertIn("stt.json", written)


class TimingLockTests(unittest.TestCase):
    def test_a_live_holder_stops_the_night_by_name(self):
        from live_lock import TimingLockHeldError

        def live(leg, *, key, env):  # pragma: no cover - must not be called
            raise AssertionError("a second live run dialled while a timing run held the lock")

        def held(*args, **kwargs):
            raise TimingLockHeldError(
                Path("/tmp/voni-demo-timing.lock"),
                {"pid": 1, "at": "x", "scenario": "demo"},
            )

        with tempfile.TemporaryDirectory() as out:
            code, lines = run(env=KEYS, out_dir=Path(out), live=live, acquire_lock=held)
        self.assertEqual(code, EXIT_DRIFT)
        self.assertTrue(any("another timing run holds the lock" in line for line in lines), lines)


class NonProductionTests(unittest.TestCase):
    def test_the_nightly_module_never_touches_the_breaker_counter_or_store(self):
        source = Path(__file__).with_name("nightly_smoke.py").read_text()
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        for forbidden in ("cascade.breaker", "cascade.store", "cascade.usage"):
            self.assertNotIn(forbidden, imported)
        for name in ("record_failure(", "record_real_call_success(", "compare_and_set("):
            self.assertNotIn(name, source)


class WorkflowWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.keys_job = cls.text.split("\n  keys:\n", 1)[1].split("\n  live-smoke:", 1)[0]
        cls.live_job = cls.text.split("\n  live-smoke:\n", 1)[1]

    def test_the_nightly_is_scheduled_and_dispatchable_only(self):
        self.assertIn("schedule:", self.text)
        self.assertIn("workflow_dispatch:", self.text)
        self.assertNotIn("pull_request:", self.text)
        on_block = self.text.split("permissions:", 1)[0]
        self.assertNotIn("push:", on_block)

    def test_the_live_job_needs_the_key_gate(self):
        self.assertIn("needs: [keys]", self.text)
        self.assertIn("if: needs.keys.outputs.present == 'true'", self.text)
        self.assertIn("META_API_KEY", self.keys_job)
        self.assertIn("ASSEMBLYAI_API_KEY", self.keys_job)

    def test_the_key_gate_sees_the_nightly_environment(self):
        # Environment-scoped secrets are invisible to a job that names no
        # environment; a gate that cannot see the keys is always false and the
        # night would be silently skipped forever.
        self.assertIn("environment: nightly", self.keys_job)

    def test_the_live_run_gets_keys_only_from_secrets(self):
        self.assertIn("${{ secrets.META_API_KEY }}", self.live_job)
        self.assertIn("${{ secrets.ASSEMBLYAI_API_KEY }}", self.live_job)
        self.assertIn("environment: nightly", self.live_job)
        self.assertIn("permissions:\n  contents: read", self.text)

    def test_the_key_gate_labels_a_skip_instead_of_claiming_one(self):
        self.assertIn("present=false", self.keys_job)
        self.assertTrue("SKIPPED" in self.keys_job or "skipped" in self.keys_job)
        self.assertIn("GITHUB_STEP_SUMMARY", self.keys_job)

    def test_the_workflow_passes_a_throwaway_recording_dir_and_never_commits(self):
        self.assertIn("runner.temp", self.live_job)
        self.assertIn("nightly_smoke.py", self.live_job)
        self.assertNotIn("git commit", self.text)
        self.assertNotIn("git push", self.text)

    def test_a_vendor_outage_is_an_alert_not_a_pr_check(self):
        ci = CI.read_text(encoding="utf-8")
        self.assertNotIn("nightly.yml", ci)
        self.assertIn("workflow_dispatch:", self.text)
        self.assertNotIn("required-", self.live_job)

    def test_the_live_job_uses_the_existing_shared_timing_lock(self):
        # An override would serialize the night only against itself. The night
        # must take the demo scoreboard's lock file, so the two cannot overlap.
        self.assertNotIn("--timing-lock", self.live_job)
        from live_lock import DEFAULT_TIMING_LOCK_PATH

        self.assertEqual(DEFAULT_TIMING_LOCK_PATH.name, "voni-demo-timing.lock")


class LiveGuardTests(unittest.TestCase):
    def test_the_pr_e2e_runner_refuses_vendor_keys(self):
        runner = (REPO / "voni" / "scripts" / "e2e-run.mjs").read_text(encoding="utf-8")
        self.assertIn("ASSEMBLYAI_API_KEY", runner)
        self.assertIn("META_API_KEY", runner)
        self.assertRegex(runner, r"REFUSE:[\s\S]{0,200}vendor key")

    def test_the_pr_workflow_has_no_vendor_key_anywhere(self):
        ci = CI.read_text(encoding="utf-8")
        for key in ("META_API_KEY", "ASSEMBLYAI_API_KEY", "CARTESIA_API_KEY"):
            self.assertNotIn(key, ci)


class _FreeLock:
    def release(self) -> None:
        pass


def _free_lock(**kwargs) -> _FreeLock:
    return _FreeLock()


def _good_record(leg: str) -> LegRecord:
    """What one live session looks like once the adapter has read it."""
    if leg == "stt":
        return LegRecord(
            leg="stt",
            frames=[
                {"sessionId": "live:0", "status": "ready"},
                {"type": "speechStart", "turnId": "t1"},
                {"type": "speechComplete", "text": "hi", "turnId": "t1"},
            ],
            observations=["ack", "speechStart", "transcript", "speechComplete"],
        )
    if leg == "llm":
        return LegRecord(
            leg="llm",
            frames=[
                {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "Hi"}}]},
            ],
            observations=["content"],
        )
    return LegRecord(
        leg="tts",
        frames=[
            {"type": "Begin", "id": "begin-1", "configuration": {"voice_id": "anna", "sample_rate": 24000}},
            {"type": "Audio", "audio": "AAAA", "flush_id": 0},
        ],
        observations=["Begin", "Audio"],
    )


if __name__ == "__main__":
    unittest.main()
