"""Tests for the PSTN bridge voice-judge client.

Mirrors the voni TypeScript suite (jev-judges.test.ts): same thresholds,
same fail-closed rule — backchannels must never read as interruptions.
"""

import asyncio
import os
import unittest
from unittest.mock import patch

import aiohttp

from voice_judge import (
    BARGE_IN_THRESHOLD,
    allow_tool_call,
    choose_reply_action,
    classify_user_turn,
    heuristic_barge_in_score,
    judge_enabled,
    judge_payload,
    judge_url,
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
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VOICE_JUDGE_URL", None)
            os.environ.pop("VONI_API_URL", None)
            self.assertFalse(judge_enabled())
            from voice_judge import sample_judge

            self.assertIsNone(asyncio.run(sample_judge("barge-in", {"x": 1})))


class JudgeUrlTests(unittest.TestCase):
    def test_explicit_url_wins(self):
        with patch.dict(
            os.environ,
            {"VOICE_JUDGE_URL": "https://x/judge", "VONI_API_URL": "https://y"},
        ):
            self.assertEqual(judge_url(), "https://x/judge")

    def test_derives_from_voni_api_url(self):
        with patch.dict(os.environ, {"VONI_API_URL": "https://voni.example.com/"}, clear=False):
            os.environ.pop("VOICE_JUDGE_URL", None)
            self.assertEqual(judge_url(), "https://voni.example.com/api/voice-judge")

    def test_none_without_either(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VOICE_JUDGE_URL", None)
            os.environ.pop("VONI_API_URL", None)
            self.assertIsNone(judge_url())

    def test_sampler_sends_bridge_bearer(self):
        seen: dict = {}

        class FakeResp:
            status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def json(self):
                return {"decision": "yield", "probability": 0.9}

        class FakeSession:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def post(self, url, json=None, headers=None):
                seen["url"] = url
                seen["headers"] = headers
                return FakeResp()

        original = aiohttp.ClientSession
        aiohttp.ClientSession = FakeSession  # type: ignore[assignment]
        try:
            with patch.dict(os.environ, {"VONI_TOOL_SECRET": "tok"}):
                from voice_judge import sample_judge

                out = asyncio.run(
                    sample_judge("barge-in", {"x": 1}, url="https://v/judge")
                )
        finally:
            aiohttp.ClientSession = original  # type: ignore[assignment]
        self.assertEqual(seen["headers"], {"authorization": "Bearer tok"})
        self.assertEqual(out, {"decision": "yield", "probability": 0.9})


if __name__ == "__main__":
    unittest.main()
