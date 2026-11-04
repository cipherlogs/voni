"""Jev fast cover judge: tone-or-silence with no network on the edges.

Seam: :func:`cascade.jev.jev_cover_tone` and :func:`cascade.jev.make_cover_judge`.
Jev is the owner-directed smart cover: tone-or-None with fail-silence, never a
hash fallback. End-intent and filler-only finals short-circuit before any
network; a missing key, low confidence (tiered: 0.6 question/neutral/unknown,
0.85 negative), a silence pick, a timeout, or a failure is silence. Every
decision logs one redacted line (tone, bucket, latency, reason) with no
secrets and no caller text. All network is an injected fake
``session_factory`` — no live calls.
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

from cascade.jev import (
    CONFIDENCE_GATE,
    CONFIDENCE_GATES,
    TIMEOUT_S,
    confidence_gate_for,
    jev_cover_tone,
    make_cover_judge,
)


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


class FakeLogger:
    """An injectable logger: records formatted lines without secrets."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def info(self, msg, *args):
        try:
            line = msg % args if args else str(msg)
        except Exception:
            line = str(msg)
        self.lines.append(line)

    def warning(self, msg, *args):
        self.info(msg, *args)

    def debug(self, msg, *args):
        self.info(msg, *args)


class TieredGateTest(unittest.TestCase):
    def test_timeout_cap_is_kept_at_120ms(self):
        self.assertEqual(0.12, TIMEOUT_S)

    def test_gates_are_tiered_negative_costs_more(self):
        self.assertEqual(0.85, CONFIDENCE_GATE)
        self.assertEqual(0.85, CONFIDENCE_GATES["negative"])
        self.assertEqual(0.6, CONFIDENCE_GATES["question"])
        self.assertEqual(0.6, CONFIDENCE_GATES["neutral"])
        self.assertEqual(0.6, CONFIDENCE_GATES["unknown"])
        self.assertEqual(0.85, confidence_gate_for("negative"))
        self.assertEqual(0.6, confidence_gate_for("question"))

    def _tone_at(self, pick: str, prob: float) -> str | None:
        return asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.2,
                session_factory=factory_for(tone_data(pick, prob)),
            )
        )

    def test_question_speaks_at_0_6(self):
        self.assertEqual("question", self._tone_at("question", 0.65))
        self.assertEqual("question", self._tone_at("question", 0.6))

    def test_neutral_and_unknown_speak_at_0_6(self):
        self.assertEqual("neutral", self._tone_at("neutral", 0.65))
        self.assertEqual("unknown", self._tone_at("unknown", 0.65))
        self.assertIsNone(self._tone_at("neutral", 0.5))
        self.assertIsNone(self._tone_at("unknown", 0.5))

    def test_negative_needs_0_85(self):
        self.assertIsNone(self._tone_at("negative", 0.7))
        self.assertIsNone(self._tone_at("negative", 0.84))
        self.assertEqual("negative", self._tone_at("negative", 0.85))
        self.assertEqual("negative", self._tone_at("negative", 0.95))


class RedactedLoggingTest(unittest.TestCase):
    def _run_with_logger(self, text, *, factory, api_key="test-key"):
        logger = FakeLogger()
        tone = asyncio.run(
            jev_cover_tone(
                text,
                "en",
                api_key=api_key,
                timeout_s=0.2,
                session_factory=factory,
                logger=logger,
            )
        )
        return tone, logger

    def test_ok_logs_tone_bucket_latency_and_reason(self):
        tone, logger = self._run_with_logger(
            "What does it cost?",
            factory=factory_for(tone_data("question", 0.75)),
        )
        self.assertEqual("question", tone)
        self.assertEqual(1, len(logger.lines))
        line = logger.lines[0]
        self.assertIn("tone=question", line)
        self.assertIn("bucket=0.6-0.85", line)
        self.assertIn("latency_ms=", line)
        self.assertIn("reason=ok", line)
        self.assertNotIn("What does it cost?", line)
        self.assertNotIn("test-key", line)

    def test_negative_ok_logs_high_bucket(self):
        tone, logger = self._run_with_logger(
            "This is ridiculous.",
            factory=factory_for(tone_data("negative", 0.95)),
        )
        self.assertEqual("negative", tone)
        self.assertIn("reason=ok", logger.lines[0])
        self.assertIn("bucket=gte-0.85", logger.lines[0])
        self.assertIn("tone=negative", logger.lines[0])

    def test_low_conf_logs_low_conf_without_tone(self):
        tone, logger = self._run_with_logger(
            "What does it cost?",
            factory=factory_for(tone_data("question", 0.5)),
        )
        self.assertIsNone(tone)
        self.assertIn("reason=low-conf", logger.lines[0])
        self.assertIn("bucket=lt-0.6", logger.lines[0])

    def test_silence_pick_logs_silence_pick(self):
        _, logger = self._run_with_logger(
            "What does it cost?",
            factory=factory_for(tone_data("silence", 0.99)),
        )
        self.assertIn("reason=silence-pick", logger.lines[0])

    def test_unknown_pick_logs_unknown(self):
        _, logger = self._run_with_logger(
            "What does it cost?",
            factory=factory_for(tone_data("cheerful", 0.99)),
        )
        self.assertIn("reason=unknown", logger.lines[0])

    def test_non_200_logs_non_200(self):
        _, logger = self._run_with_logger(
            "What does it cost?",
            factory=factory_for(tone_data("question", 0.99), status=500),
        )
        self.assertIn("reason=non-200", logger.lines[0])

    def test_timeout_logs_timeout(self):
        logger2 = FakeLogger()
        tone = asyncio.run(
            jev_cover_tone(
                "What does it cost?",
                "en",
                api_key="test-key",
                timeout_s=0.05,
                session_factory=slow_factory(),
                logger=logger2,
            )
        )
        self.assertIsNone(tone)
        self.assertIn("reason=timeout", logger2.lines[0])

    def test_missing_key_logs_missing_key_without_network(self):
        calls: list = []
        logger = FakeLogger()
        with mock.patch.dict(os.environ, {}, clear=True):
            tone = asyncio.run(
                jev_cover_tone(
                    "What does it cost?",
                    "en",
                    api_key=None,
                    session_factory=factory_for(
                        tone_data("question", 0.99), calls=calls
                    ),
                    logger=logger,
                )
            )
        self.assertIsNone(tone)
        self.assertEqual([], calls)
        self.assertIn("reason=missing-key", logger.lines[0])

    def test_empty_end_intent_backchannel_log_their_reasons(self):
        for text, reason in (
            ("   ", "empty"),
            ("bye", "end_intent"),
            ("mm-hmm", "backchannel"),
        ):
            logger = FakeLogger()
            tone = asyncio.run(
                jev_cover_tone(
                    text,
                    "en",
                    api_key="test-key",
                    session_factory=factory_for(tone_data("neutral", 0.99)),
                    logger=logger,
                )
            )
            self.assertIsNone(tone, text)
            self.assertIn(f"reason={reason}", logger.lines[0], text)
            stripped = text.strip()
            if stripped:
                self.assertNotIn(stripped, logger.lines[0], text)

    def test_make_cover_judge_forwards_the_logger(self):
        logger = FakeLogger()
        judge = make_cover_judge(
            "en",
            api_key="test-key",
            timeout_s=0.2,
            session_factory=factory_for(tone_data("neutral", 0.8)),
            logger=logger,
        )
        self.assertEqual("neutral", asyncio.run(judge("I am calling about the flat.")))
        self.assertIn("reason=ok", logger.lines[0])
        self.assertNotIn("flat", logger.lines[0])


if __name__ == "__main__":
    unittest.main()
