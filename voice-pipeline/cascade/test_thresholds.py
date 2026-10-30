"""Contract tests for the cascade threshold registry (ticket 03).

Seam: the registry is read through ``cascade.thresholds`` — ``require_bound``
for a value, ``bound``/``bounds`` for provenance. Nothing here reaches into
the loader's private helpers, so the storage format can change without
rewriting a consumer.

Every expected number comes from an independent source: the committed budget
record, the spec, or a fixture written by the test itself.
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from cascade import thresholds

REPO_ROOT = Path(__file__).resolve().parents[2]
BUDGET_RECORD = REPO_ROOT / "voni" / "src" / "lib" / "demo" / "scoreboard-budgets.json"

# Bound name -> key in the frozen record. The registry must not carry the
# numbers; a retune of the record moves these without touching Python.
FROZEN_BOUNDS = {
    "reply_gap.p50_ms": "replyGapP50Ms",
    "reply_gap.p95_ms": "replyGapP95Ms",
    "barge_in.real_cut_ms": "realCutMs",
    "barge_in.filler_resume_tail_ms": "fillerResumeTailMs",
}

# Ticket 04 supplied every bound the spec left open. These are the owner
# decisions dated 2026-10-30; the registry keeps the provenance.
SUPPLIED_BOUNDS = {
    "budget.daily_cap": ("103", 25),
    "budget.per_call_ceiling": ("105", 0.25),
    "deploy.drain_max_wait_ms": ("140", 30_000),
    "turn.stall_guard_ms": ("69", 2_500),
    "tool.loop_cap": ("87", 3),
    "tts.keepalive_interval_ms": ("53", 30_000),
    "budget.day_boundary": ("102", "UTC"),
    "ci.browser_e2e_budget_s": ("149", 120),
    "turn.reply_task_ms": ("76", 10_000),
    "tool.timeout_ms": ("76", 5_000),
    "reconnect.handshake_ms": ("76", 10_000),
    "probe.model_max_completion_tokens": ("20", 16),
    "envelope.ttl_ms": ("04", 60_000),
    "call_token.ttl_ms": ("04", 60_000),
    "playout.cushion_ms": ("12", 500),
}


def read_budget_record() -> dict:
    return json.loads(BUDGET_RECORD.read_text(encoding="utf-8"))


def write_registry(tmp: str, bounds: dict, *, version: int = 1) -> Path:
    path = Path(tmp) / "thresholds.json"
    path.write_text(
        json.dumps(
            {
                "version": version,
                "note": "fixture",
                "budget_record": {
                    "path": "voni/src/lib/demo/scoreboard-budgets.json",
                    "version": 1,
                    "date": "2026-10-28",
                },
                "bounds": bounds,
            }
        ),
        encoding="utf-8",
    )
    return path


class FrozenBudgetTests(unittest.TestCase):
    def test_the_frozen_budgets_are_read_from_the_committed_record(self):
        record = read_budget_record()["budgets"]
        for name, key in FROZEN_BOUNDS.items():
            with self.subTest(bound=name):
                self.assertEqual(thresholds.require_bound(name), record[key])

    def test_a_retuned_record_moves_the_registry_without_a_code_edit(self):
        record = read_budget_record()
        record["budgets"]["replyGapP50Ms"] = 1234
        with tempfile.TemporaryDirectory() as tmp:
            retuned = Path(tmp) / "budgets.json"
            retuned.write_text(json.dumps(record), encoding="utf-8")
            registry = thresholds.load_registry(budgets_record=retuned)
            self.assertEqual(registry.require("reply_gap.p50_ms"), 1234)
            self.assertEqual(
                registry.require("reply_gap.p95_ms"), record["budgets"]["replyGapP95Ms"]
            )

    def test_a_frozen_bound_names_its_record_source_and_unit(self):
        entry = thresholds.bound("reply_gap.p50_ms")
        self.assertEqual(entry.unit, "ms")
        self.assertIn("scoreboard-budgets.json", entry.source)
        self.assertIn("replyGapP50Ms", entry.source)
        self.assertIn("sha256:", entry.source)
        self.assertRegex(entry.date, r"^\d{4}-\d{2}-\d{2}$")

    def test_the_source_pin_follows_the_record_bytes(self):
        record = read_budget_record()
        with tempfile.TemporaryDirectory() as tmp:
            retuned = Path(tmp) / "budgets.json"
            retuned.write_text(json.dumps(record), encoding="utf-8")
            same = thresholds.load_registry(budgets_record=retuned).bound(
                "barge_in.real_cut_ms"
            )
        self.assertNotEqual(
            same.source, thresholds.bound("barge_in.real_cut_ms").source
        )


class UnsetBoundTests(unittest.TestCase):
    def test_an_open_bound_raises_with_its_name_and_owning_ticket(self):
        entry = {"unit": "ms", "gate": "x.gate", "ticket": "99", "note": "open"}
        with tempfile.TemporaryDirectory() as tmp:
            registry = thresholds.load_registry(
                path=write_registry(tmp, {"x.open": entry})
            )
            with self.assertRaises(thresholds.UnsetBoundError) as caught:
                registry.require("x.open")
        message = str(caught.exception)
        self.assertIn("x.open", message)
        self.assertIn("99", message)
        self.assertEqual(caught.exception.name, "x.open")
        self.assertEqual(caught.exception.ticket, "99")

    def test_an_unknown_bound_fails_by_name(self):
        with self.assertRaises(thresholds.UnknownBoundError) as caught:
            thresholds.require_bound("floor.take_probability")
        self.assertIn("floor.take_probability", str(caught.exception))

    def test_a_supplied_bound_carries_value_source_and_date(self):
        for name, (ticket, expected) in SUPPLIED_BOUNDS.items():
            with self.subTest(bound=name):
                entry = thresholds.bound(name)
                self.assertFalse(entry.is_open)
                self.assertEqual(entry.value, expected)
                self.assertEqual(entry.ticket, ticket)
                self.assertTrue(entry.unit)
                self.assertTrue(entry.gate)
                self.assertTrue(entry.source)
                self.assertRegex(entry.date, r"^\d{4}-\d{2}-\d{2}$")
                self.assertEqual(thresholds.require_bound(name), expected)

    def test_no_production_bound_is_left_open(self):
        # Ticket 04 supplied every bound; a new open bound must be declared here.
        self.assertEqual(thresholds.open_bounds(), ())


class ProvenanceRefusalTests(unittest.TestCase):
    def load(self, entry: dict) -> thresholds.Registry:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_registry(tmp, {"x.bound": entry})
            return thresholds.load_registry(path=path)

    def test_a_value_without_a_source_is_refused(self):
        with self.assertRaises(thresholds.SourceRequiredError) as caught:
            self.load(
                {
                    "unit": "ms",
                    "gate": "some-gate",
                    "ticket": "76",
                    "value": 10,
                    "date": "2026-10-29",
                }
            )
        self.assertIn("x.bound", str(caught.exception))

    def test_a_value_with_a_blank_source_is_refused(self):
        with self.assertRaises(thresholds.SourceRequiredError) as caught:
            self.load(
                {
                    "unit": "ms",
                    "gate": "some-gate",
                    "ticket": "76",
                    "value": 10,
                    "source": "   ",
                    "date": "2026-10-29",
                }
            )
        self.assertIn("x.bound", str(caught.exception))

    def test_a_value_without_a_date_is_refused(self):
        with self.assertRaises(thresholds.DateRequiredError) as caught:
            self.load(
                {
                    "unit": "ms",
                    "gate": "some-gate",
                    "ticket": "76",
                    "value": 10,
                    "source": "operator decision",
                }
            )
        self.assertIn("x.bound", str(caught.exception))

    def test_a_date_that_is_not_a_date_is_refused(self):
        with self.assertRaises(thresholds.DateRequiredError):
            self.load(
                {
                    "unit": "ms",
                    "gate": "some-gate",
                    "ticket": "76",
                    "value": 10,
                    "source": "operator decision",
                    "date": "sometime",
                }
            )

    def test_a_record_backed_bound_may_not_carry_a_literal_value(self):
        with self.assertRaises(thresholds.CopiedBudgetError) as caught:
            self.load(
                {
                    "unit": "ms",
                    "gate": "reply-gap",
                    "ticket": "145",
                    "budget_key": "replyGapP50Ms",
                    "value": 1500,
                    "source": "copied",
                    "date": "2026-10-29",
                }
            )
        self.assertIn("x.bound", str(caught.exception))

    def test_a_bound_must_name_its_unit_gate_and_owner(self):
        for missing in ("unit", "gate", "ticket"):
            with self.subTest(missing=missing):
                entry = {"unit": "ms", "gate": "g", "ticket": "76"}
                del entry[missing]
                with self.assertRaises(thresholds.RegistryFormatError) as caught:
                    self.load(entry)
                self.assertIn("x.bound", str(caught.exception))
                self.assertIn(missing, str(caught.exception))

    def test_an_unknown_field_is_refused_rather_than_silently_dropped(self):
        with self.assertRaises(thresholds.RegistryFormatError) as caught:
            self.load(
                {
                    "unit": "ms",
                    "gate": "g",
                    "ticket": "76",
                    "valeu": 10,
                }
            )
        self.assertIn("valeu", str(caught.exception))

    def test_a_duplicate_bound_declaration_is_refused(self):
        text = json.dumps(
            {
                "version": 1,
                "note": "fixture",
                "budget_record": {
                    "path": "voni/src/lib/demo/scoreboard-budgets.json",
                    "version": 1,
                    "date": "2026-10-28",
                },
                "bounds": {},
            }
        ).replace(
            '"bounds": {}',
            '"bounds": {"x.bound": {"unit": "ms", "gate": "g", "ticket": "76"},'
            ' "x.bound": {"unit": "ms", "gate": "g", "ticket": "87"}}',
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "thresholds.json"
            path.write_text(text, encoding="utf-8")
            with self.assertRaises(thresholds.DuplicateBoundError) as caught:
                thresholds.load_registry(path=path)
        self.assertIn("x.bound", str(caught.exception))


class RegistryFormatTests(unittest.TestCase):
    def test_every_declared_bound_names_its_unit_gate_and_owner(self):
        entries = thresholds.bounds()
        self.assertTrue(entries)
        for entry in entries:
            with self.subTest(bound=entry.name):
                self.assertTrue(entry.unit, "a bound names its unit")
                self.assertTrue(entry.gate, "a bound names the gate it feeds")
                self.assertTrue(entry.ticket, "a bound names its owning ticket")
                if not entry.is_open:
                    self.assertTrue(entry.source, "a value names its source")
                    self.assertTrue(entry.date, "a value names the date taken")

    def test_the_spec_stated_values_are_set_with_a_source(self):
        self.assertEqual(thresholds.require_bound("budget.route_managed_ratio"), 0.8)
        self.assertEqual(thresholds.require_bound("budget.refuse_cascade_ratio"), 1.0)
        self.assertEqual(thresholds.require_bound("stt.handshake_ms"), 10_000)
        self.assertEqual(thresholds.require_bound("tts.idle_timeout_ms"), 120_000)
        for name in (
            "budget.route_managed_ratio",
            "budget.refuse_cascade_ratio",
            "stt.handshake_ms",
            "tts.idle_timeout_ms",
        ):
            with self.subTest(bound=name):
                self.assertIn("spec", thresholds.bound(name).source)

    def test_the_frozen_entries_carry_no_literal_value(self):
        data = json.loads(thresholds.REGISTRY_PATH.read_text(encoding="utf-8"))
        for name in FROZEN_BOUNDS:
            with self.subTest(bound=name):
                self.assertNotIn("value", data["bounds"][name])

    def test_no_frozen_budget_number_is_copied_into_the_code(self):
        text = Path(thresholds.__file__).read_text(encoding="utf-8")
        for number in ("1500", "2500"):
            with self.subTest(number=number):
                copied = re.search(rf"(?<![\w.]){number}(?![\w.])", text)
                self.assertIsNone(
                    copied,
                    f"thresholds.py must read the frozen budget, not copy {number}",
                )


class Ticket04ExtensionTests(unittest.TestCase):
    def test_a_supplied_value_loads_without_a_code_edit(self):
        data = json.loads(thresholds.REGISTRY_PATH.read_text(encoding="utf-8"))
        target = data["bounds"]["turn.stall_guard_ms"]
        target.pop("status", None)
        target.update(
            {
                "value": 12_000,
                "source": "operator decision, ticket 04",
                "date": "2026-10-30",
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "thresholds.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            registry = thresholds.load_registry(path=path)
            self.assertEqual(registry.require("turn.stall_guard_ms"), 12_000)
            self.assertNotIn(
                "turn.stall_guard_ms", {entry.name for entry in registry.open_bounds()}
            )

    def test_one_entry_per_bound_serves_every_consumer(self):
        entries = thresholds.bounds()
        names = [entry.name for entry in entries]
        self.assertEqual(len(names), len(set(names)))
        for entry in entries:
            with self.subTest(bound=entry.name):
                self.assertIs(entry, thresholds.bound(entry.name))
                if not entry.is_open:
                    self.assertEqual(thresholds.require_bound(entry.name), entry.value)


if __name__ == "__main__":
    unittest.main()
