"""Jev fast cover judge: tone-or-silence with no network on the edges.

Seam: :func:`cascade.jev.jev_cover_tone` and :func:`cascade.jev.make_cover_judge`.
Jev is the owner-directed smart cover: tone-or-None with fail-silence, never a
hash fallback. End-intent and filler-only finals short-circuit before any
network; a missing key, low confidence (<0.85), a silence pick, a timeout, or
a failure is silence. All network is an injected fake ``session_factory`` —
no live calls.
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest import mock

# Alias the bare ``end_intent`` seam (see test_ack.py).
try:
    import end_intent  # noqa: F401
except ModuleNotFoundError:
    import cascade.end_intent as _cascade_end_intent

    sys.modules["end_intent"] = _cascade_end_intent

from cascade.jev import CONFIDENCE_GATE, jev_cover_tone, make_cover_judge


class FakeResp:
    """One fake gateway response: status plus a JSON body."""

    def __init__(self, data, status: int = 200) -> None:
        self._data = data
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return self._data


def factory_for(data, *, status: int = 200, calls: list | None = None):
    def factory(url, headers, payload, timeout_s):
        if calls is not None:
            calls.append((url, headers, payload, timeout_s))
        return FakeResp(data, status=status)

    return factory


def slow_factory(calls: list | None = None):
    class SlowResp(FakeResp):
        async def json(self):
            await asyncio.sleep(10)
            return {}

    def factory(url, headers, payload, timeout_s):
        if calls is not None:
            calls.append((url, headers, payload, timeout_s))
        return SlowResp({})

    return factory


def failing_factory(url, headers, payload, timeout_s):
    raise RuntimeError("gateway is down")


def tone_data(pick: str, probability: float) -> dict:
    return {"answers": {"judge": {"pick": pick, "probability": probability}}}


class JevCoverToneTest(unittest.TestCase):
    def test_end_intent_short_circuits_before_any_network(self):
        for text in ("can you please hang up?", "bye", "that's all", "please hang up now"):
            with self.subTest(final=text):
                calls: list = []
                tone = asyncio.run(
                    jev_cover_tone(
                        text,
                        "en",
                        api_key="test-key",
                        timeout_s=0.2,
                        session_factory=factory_for(
                            tone_data("question", 0.99), calls=calls
                        ),
                    )
                )
                self.assertIsNone(tone, text)
                self.assertEqual([], calls, "end-intent must not touch the network")

    def test_filler_only_short_circuits_before_any_network(self):
        calls: list = []
        tone = asyncio.run(
            jev_cover_tone(
                "mm-hmm",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("neutral", 0.99), calls=calls),
            )
        )
        self.assertIsNone(tone)
        self.assertEqual([], calls)

    def test_empty_final_is_silence_without_network(self):
        calls: list = []
        self.assertIsNone(
            asyncio.run(
                jev_cover_tone(
                    "   ",
                    "en",
                    api_key="test-key",
                    session_factory=factory_for(tone_data("neutral", 0.99), calls=calls),
                )
            )
        )
        self.assertEqual([], calls)

    def test_missing_key_is_silence_without_network(self):
        calls: list = []
        with mock.patch.dict(os.environ, {}, clear=True):
            tone = asyncio.run(
                jev_cover_tone(
                    "What does it cost?",
                    "en",
                    api_key=None,
                    session_factory=factory_for(
                        tone_data("question", 0.99), calls=calls
                    ),
                )
            )
        self.assertIsNone(tone)
        self.assertEqual([], calls, "no key means no request")

    def test_low_confidence_is_silence(self):
        self.assertGreaterEqual(CONFIDENCE_GATE, 0.85)
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("question", 0.5)),
            )
        )
        self.assertIsNone(tone, "below 0.85 must not cover")

    def test_silence_pick_is_silence(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("silence", 0.99)),
            )
        )
        self.assertIsNone(tone)

    def test_unknown_pick_is_silence(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("cheerful", 0.99)),
            )
        )
        self.assertIsNone(tone)

    def test_high_confidence_returns_the_tone(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("question", 0.95)),
            )
        )
        self.assertEqual("question", tone)

    def test_timeout_is_silence(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.05,
                session_factory=slow_factory(),
            )
        )
        self.assertIsNone(tone)

    def test_failure_is_silence(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=failing_factory,
            )
        )
        self.assertIsNone(tone)

    def test_non_200_is_silence(self):
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data("question", 0.99), status=500),
            )
        )
        self.assertIsNone(tone)

    def test_make_cover_judge_returns_a_callable(self):
        calls: list = []
        judge = make_cover_judge(
            "en",
            api_key="test-key",
            timeout_s=0.2,
            session_factory=factory_for(tone_data("negative", 0.95), calls=calls),
        )
        self.assertTrue(callable(judge))
        self.assertEqual("negative", asyncio.run(judge("This is ridiculous.")))
        self.assertEqual(1, len(calls))
        # End-intent through the built judge is still silence, no network.
        calls.clear()
        built_silent = make_cover_judge(
            "en",
            api_key="test-key",
            timeout_s=0.2,
            session_factory=factory_for(tone_data("question", 0.99), calls=calls),
        )
        self.assertIsNone(asyncio.run(built_silent("bye")))
        self.assertEqual([], calls)


if __name__ == "__main__":
    unittest.main()
