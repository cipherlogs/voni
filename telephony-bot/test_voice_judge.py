"""Tests for the PSTN bridge voice-judge client.

Mirrors the voni TypeScript suite (jev-judges.test.ts): same thresholds,
same fail-closed rule — backchannels must never read as interruptions.
"""

import asyncio
import unittest

from voice_judge import (
    BARGE_IN_THRESHOLD,
    allow_tool_call,
    choose_reply_action,
    classify_user_turn,
    heuristic_barge_in_score,
    judge_enabled,
    judge_payload,
)


class BargeInTests(unittest.TestCase):
    def test_backchannel_never_yields(self):
        for text in ["uh-huh", "yeah", "mhm", "okay", "right"]:
            decision, _ = classify_user_turn(text, agent_speaking_ms=3000)
            self.assertEqual(decision, "keep-speaking", text)

    def test_real_interruption_yields_when_agent_established(self):
        decision, prob = classify_user_turn(
            "stop, what is the price", agent_speaking_ms=3000
        )
        self.assertEqual(decision, "yield")
        self.assertGreaterEqual(prob, BARGE_IN_THRESHOLD)

    def test_early_agent_speech_stays_fail_closed(self):
        decision, _ = classify_user_turn(
            "stop, what is the price", agent_speaking_ms=200
        )
        self.assertEqual(decision, "keep-speaking")

    def test_heuristic_ranks_backchannel_below_interruption(self):
        back = heuristic_barge_in_score("mhm", 5000)
        real = heuristic_barge_in_score("wait, tell me the price again", 5000)
        self.assertLess(back, real)


class ReplyTests(unittest.TestCase):
    def test_filler_while_tools_work(self):
        action, _ = choose_reply_action(
            has_final=False, silence_ms=100, tool_active=True
        )
        self.assertEqual(action, "play_filler")

    def test_reply_on_settled_final(self):
        action, _ = choose_reply_action(
            has_final=True, silence_ms=900, tool_active=False
        )
        self.assertEqual(action, "reply_now")

    def test_wait_on_fresh_partial(self):
        action, _ = choose_reply_action(
            has_final=False, silence_ms=50, tool_active=False
        )
        self.assertEqual(action, "wait_300ms")


class ToolGateTests(unittest.TestCase):
    def test_named_tool_allowed(self):
        allowed, _ = allow_tool_call("lookupLead")
        self.assertTrue(allowed)

    def test_empty_name_denied(self):
        allowed, _ = allow_tool_call("")
        self.assertFalse(allowed)

    def test_malformed_name_denied(self):
        allowed, _ = allow_tool_call("drop table")
        self.assertFalse(allowed)


class PayloadTests(unittest.TestCase):
    def test_payload_shape(self):
        payload = judge_payload(
            "barge-in", {"partialText": "uh-huh", "agentSpeakingMs": 4000}
        )
        self.assertEqual(payload["kind"], "barge-in")
        self.assertIn("partialText", payload["state"])

    def test_sampler_returns_none_without_url(self):
        import os

        os.environ.pop("VOICE_JUDGE_URL", None)
        self.assertFalse(judge_enabled())
        from voice_judge import sample_judge

        self.assertIsNone(asyncio.run(sample_judge("barge-in", {"x": 1})))


if __name__ == "__main__":
    unittest.main()
