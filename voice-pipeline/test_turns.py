"""Tests for the cascade turn commit gate.

The gate answers ONE question per user partial: has intent arrived, or must
the pipeline keep waiting? Fail-closed like every other judge in this repo:
unsure means wait, backchannels never commit.

Parity: the default backchannel check must agree with the two canonical
mirrors (telephony-bot/voice_judge.py, voni jev-judges.ts) on a shared
fixture set — one behavior in three languages, verified not assumed.
"""

import sys
import unittest
from pathlib import Path

from turns import commit_decision, is_backchannel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "telephony-bot"))
from voice_judge import classify_user_turn  # noqa: E402


BACKCHANNEL_FIXTURES = ["uh-huh", "yeah", "mhm", "okay", "right", "mm"]
INTERRUPTION_FIXTURES = [
    "stop, what is the price",
    "wait, tell me the price again",
    "no, I meant next Tuesday morning",
]


class BackchannelTests(unittest.TestCase):
    def test_backchannels_detected(self):
        for text in BACKCHANNEL_FIXTURES:
            self.assertTrue(is_backchannel(text), text)

    def test_real_speech_not_backchannel(self):
        for text in INTERRUPTION_FIXTURES:
            self.assertFalse(is_backchannel(text), text)


class CommitGateTests(unittest.TestCase):
    def test_backchannel_never_commits(self):
        for text in BACKCHANNEL_FIXTURES:
            self.assertEqual(
                commit_decision(text, agent_speaking_ms=5000, barge_probability=0.9),
                "backchannel",
                text,
            )

    def test_complete_intent_commits(self):
        for text in INTERRUPTION_FIXTURES:
            self.assertEqual(
                commit_decision(text, agent_speaking_ms=5000, barge_probability=0.88),
                "commit",
                text,
            )

    def test_unsure_waits_fail_closed(self):
        self.assertEqual(
            commit_decision("stop", agent_speaking_ms=5000, barge_probability=0.45),
            "wait",
        )
        self.assertEqual(
            commit_decision("stop, what is the price", agent_speaking_ms=200, barge_probability=0.9),
            "wait",
        )

    def test_empty_partial_waits(self):
        self.assertEqual(
            commit_decision("", agent_speaking_ms=5000, barge_probability=0.9), "wait"
        )


class ParityTests(unittest.TestCase):
    def test_agrees_with_bridge_judge_on_fixtures(self):
        for text in BACKCHANNEL_FIXTURES + INTERRUPTION_FIXTURES:
            decision, prob = classify_user_turn(text, agent_speaking_ms=5000)
            gate = commit_decision(text, agent_speaking_ms=5000, barge_probability=prob)
            if decision == "yield":
                self.assertEqual(gate, "commit", text)
            else:
                self.assertIn(gate, ("backchannel", "wait"), text)


if __name__ == "__main__":
    unittest.main()
