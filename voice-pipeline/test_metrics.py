"""Tests for the cascade metric rig.

Same scoreboard as the managed path so P1 A/B is apples-to-apples:
screen latency, think start, reply gap, plus judge/prefetch counters.
"""

import unittest

from metrics import TimingLedger


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
        self.assertAlmostEqual(gaps["commit_to_first_playout"], 1400.0)

    def test_first_mark_wins_and_missing_gaps_are_none(self):
        ledger = TimingLedger(now=lambda: 10.0)
        ledger.mark("audio_in")
        ledger.mark("audio_in")
        summary = ledger.summary()
        self.assertEqual(len(summary["marks"]), 1)
        self.assertIsNone(summary["gaps_ms"]["final_to_first_playout"])

    def test_commit_mark_overrides_final_for_reply_gap(self):
        t = [0.0]
        ledger = TimingLedger(now=lambda: t[0])
        ledger.mark("final")
        t[0] += 0.5
        ledger.mark("commit")
        t[0] += 0.8
        ledger.mark("first_playout")
        gaps = ledger.summary()["gaps_ms"]
        # Early commit: the reply gap counts from commit, not final.
        self.assertAlmostEqual(gaps["commit_to_first_playout"], 800.0)
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
        with self.assertRaises(ValueError):
            ledger.mark("banana")
        with self.assertRaises(ValueError):
            ledger.count("banana")

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
