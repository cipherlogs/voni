"""Tests for the cascade metric rig.

Same scoreboard as the managed path so P1 A/B is apples-to-apples:
screen latency, think start, reply gap, plus judge/prefetch counters. The
cascade adds the marks its provider-owned turn boundary produces; a missing
mark is None, never a borrowed one.
"""

import copy
import json
import unittest

from metrics import CASCADE_GAPS, TimingLedger, cascade_gaps

# The marks a cascade call records, once each, first write wins.
CASCADE_MARKS = (
    "speech_end",
    "speech_complete",
    "floor_take",
    "greeting_start",
    "greeting_first_audio",
    "greeting_done",
    "reconnect",
    "cancelled",
)

# Recorded from the managed timeline below on base df21bedb, before the
# cascade marks existed. This is the existing-artifact expectation: a managed
# end-of-call ledger must keep reporting exactly these marks, gaps and counts.
# The ticket's one deliberate change is the cascade-only floor_take row (no
# floor_take on a managed call, so N/A instead of borrowing the final mark);
# every other key and value here is untouched.
MANAGED_ARTIFACT_DF21BEDB = {
    "marks": {
        "audio_in": 0.0,
        "first_partial": 0.25,
        "final": 1.25,
        "first_token": 1.75,
        "first_sentence_audio": 2.0,
        "first_playout": 2.125,
        "reply_done": 2.25,
    },
    "gaps_ms": {
        "audio_in_to_first_partial": 250.0,
        "final_to_first_token": 500.0,
        "final_to_first_playout": 875.0,
        "floor_take_to_first_playout": 875.0,
    },
    "counts": {
        "backchannel": 2,
        "yield": 1,
        "interruption": 0,
        "prefetch_started": 1,
        "prefetch_cancelled": 1,
        "prefetch_used": 1,
        "tool_denied": 0,
        "end_call": 1,
        "overheard": 0,
    },
}


def managed_ledger() -> TimingLedger:
    """A managed call: no cascade mark is ever recorded."""
    t = [0.0]
    ledger = TimingLedger(now=lambda: t[0])

    def mark(name: str, advance: float) -> None:
        ledger.mark(name)
        t[0] += advance

    mark("audio_in", 0.25)
    mark("first_partial", 1.0)
    mark("final", 0.5)
    mark("first_token", 0.25)
    mark("first_sentence_audio", 0.125)
    mark("first_playout", 0.125)
    mark("reply_done", 0.0)
    ledger.count("backchannel", 2)
    ledger.count("yield")
    ledger.count("prefetch_started")
    ledger.count("prefetch_cancelled")
    ledger.count("prefetch_used")
    ledger.count("end_call")
    return ledger


def without_row(summary: dict, row: str) -> dict:
    trimmed = copy.deepcopy(summary)
    del trimmed["gaps_ms"][row]
    return trimmed


class LedgerTests(unittest.TestCase):
    def test_full_turn_reports_all_gaps(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        ledger.mark("audio_in")
        t[0] += 0.35
        ledger.mark("first_partial")
        t[0] += 1.2
        ledger.mark("final")
        t[0] += 0.4
        ledger.mark("first_token")
        t[0] += 0.9
        ledger.mark("first_sentence_audio")
        t[0] += 0.1
        ledger.mark("first_playout")
        gaps = ledger.summary()["gaps_ms"]
        self.assertAlmostEqual(gaps["audio_in_to_first_partial"], 350.0)
        self.assertAlmostEqual(gaps["final_to_first_token"], 400.0)
        self.assertAlmostEqual(gaps["final_to_first_playout"], 1400.0)
        # No floor_take on this timeline: the cascade row is N/A, not a copy
        # of the final row.
        self.assertIsNone(gaps["floor_take_to_first_playout"])

    def test_first_mark_wins_and_missing_gaps_are_none(self):
        ledger = TimingLedger(now=lambda: 10.0)
        ledger.mark("audio_in")
        ledger.mark("audio_in")
        summary = ledger.summary()
        self.assertEqual(len(summary["marks"]), 1)
        self.assertIsNone(summary["gaps_ms"]["final_to_first_playout"])

    def test_floor_take_mark_overrides_final_for_reply_gap(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        ledger.mark("final")
        t[0] += 0.5
        ledger.mark("floor_take")
        t[0] += 0.8
        ledger.mark("first_playout")
        gaps = ledger.summary()["gaps_ms"]
        # The caller took the floor early: the reply gap counts from there,
        # not from the final.
        self.assertAlmostEqual(gaps["floor_take_to_first_playout"], 800.0)
        self.assertAlmostEqual(gaps["final_to_first_playout"], 1300.0)

    def test_counters_track_judge_and_prefetch(self):
        ledger = TimingLedger(now=lambda: 0.0)
        ledger.count("backchannel")
        ledger.count("backchannel")
        ledger.count("yield")
        ledger.count("prefetch_started")
        ledger.count("prefetch_cancelled")
        ledger.count("prefetch_used")
        counts = ledger.summary()["counts"]
        self.assertEqual(counts["backchannel"], 2)
        self.assertEqual(counts["yield"], 1)
        self.assertEqual(counts["prefetch_started"], 1)
        self.assertEqual(counts["prefetch_cancelled"], 1)
        self.assertEqual(counts["prefetch_used"], 1)

    def test_unknown_marks_and_counters_rejected(self):
        ledger = TimingLedger(now=lambda: 0.0)
        with self.assertRaises(ValueError) as mark_error:
            ledger.mark("banana")
        self.assertIn("banana", str(mark_error.exception))
        with self.assertRaises(ValueError) as count_error:
            ledger.count("banana")
        self.assertIn("banana", str(count_error.exception))

    def test_every_cascade_mark_is_recorded_once_and_first_wins(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        first_seen = {}
        for name in CASCADE_MARKS:
            ledger.mark(name)
            first_seen[name] = t[0]
            t[0] += 1.0
            ledger.mark(name)
            t[0] += 1.0
        # Readable from the end-of-call ledger, once per call.
        self.assertEqual(ledger.summary()["marks"], first_seen)

    def test_cascade_ledger_without_floor_take_reports_na(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        for name in (
            "audio_in",
            "first_partial",
            "speech_end",
            "speech_complete",
            "final",
            "first_token",
            "first_playout",
        ):
            ledger.mark(name)
            t[0] += 0.25
        gaps = ledger.summary()["gaps_ms"]
        # The managed-shaped row is measured, but the cascade-only row is N/A.
        # Reintroducing the `else "final"` fallback makes this 500.0 and fails.
        self.assertAlmostEqual(gaps["final_to_first_playout"], 500.0)
        self.assertIsNone(gaps["floor_take_to_first_playout"])

    def test_three_cascade_gaps_derive_from_marks_alone(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        ledger.mark("audio_in")
        t[0] += 0.25
        ledger.mark("first_partial")
        t[0] += 1.0
        ledger.mark("speech_complete")
        t[0] += 0.5
        ledger.mark("first_token")
        t[0] += 0.25
        ledger.mark("first_playout")
        # Only the marks mapping is passed: no ledger state is consulted.
        gaps = cascade_gaps(ledger.summary()["marks"])
        self.assertEqual(
            gaps,
            {
                "screen_latency_ms": 250.0,
                "think_ms": 500.0,
                "reply_gap_ms": 750.0,
            },
        )
        self.assertEqual(
            [row for row, _, _ in CASCADE_GAPS],
            ["screen_latency_ms", "think_ms", "reply_gap_ms"],
        )
        # A gap with no anchor mark on either side is absent, never zero.
        self.assertEqual(
            cascade_gaps({"audio_in": 0.0}),
            {
                "screen_latency_ms": None,
                "think_ms": None,
                "reply_gap_ms": None,
            },
        )

    def test_managed_artifact_matches_existing_expectation(self):
        summary = managed_ledger().summary()
        # Byte-identical apart from the one row this ticket makes honest.
        self.assertEqual(
            without_row(summary, "floor_take_to_first_playout"),
            without_row(MANAGED_ARTIFACT_DF21BEDB, "floor_take_to_first_playout"),
        )
        self.assertIsNone(summary["gaps_ms"]["floor_take_to_first_playout"])
        # The new cascade marks add nothing to a managed ledger.
        self.assertEqual(
            json.dumps(summary, sort_keys=True),
            json.dumps(
                {
                    **MANAGED_ARTIFACT_DF21BEDB,
                    "gaps_ms": {
                        **MANAGED_ARTIFACT_DF21BEDB["gaps_ms"],
                        "floor_take_to_first_playout": None,
                    },
                },
                sort_keys=True,
            ),
        )

    def test_reset_clears_everything(self):
        ledger = TimingLedger(now=lambda: 0.0)
        ledger.mark("audio_in")
        ledger.count("yield")
        ledger.reset()
        summary = ledger.summary()
        self.assertEqual(summary["marks"], {})
        self.assertTrue(all(v == 0 for v in summary["counts"].values()))


if __name__ == "__main__":
    unittest.main()
