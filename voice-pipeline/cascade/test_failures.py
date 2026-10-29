"""Tests for failure classification (ticket 16).

Spec: `.scratch/meta-cascade/spec.md` "Trigger set is closed" and the
"Provider wire and session lifecycle" edge-case catalog. Every expected value
below comes from that prose, not from the table implementation.
"""

import unittest

from cascade.failures import (
    FailureClass,
    LLM_SERVER_ERROR,
    LLM_TIMEOUT,
    SESSION_LIMIT,
    STT_CLOSE_RULES,
    TTS_CLOSE_RULES,
    LLM_STATUS_RULES,
    classify,
    classify_llm,
    classify_stt,
    classify_tts,
)


class STTClassificationTest(unittest.TestCase):
    def test_retryable_close_codes_open_the_leg(self):
        for code in (1011, 1013):
            with self.subTest(code=code):
                verdict = classify_stt(code)
                self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)
                self.assertTrue(verdict.opens_breaker)

    def test_1008_is_a_deterministic_request_bug(self):
        verdict = classify_stt(1008)
        self.assertEqual(FailureClass.BUG, verdict.failure_class)
        self.assertFalse(verdict.opens_breaker)

    def test_a_close_without_a_code_is_treated_as_1011(self):
        verdict = classify_stt(None)
        self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)

    def test_normal_close_1000_does_not_open(self):
        verdict = classify_stt(1000)
        self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)
        self.assertFalse(verdict.opens_breaker)

    def test_the_60_minute_session_limit_is_a_planned_reconnect(self):
        verdict = classify_stt(SESSION_LIMIT)
        self.assertEqual(FailureClass.PLANNED_RECONNECT, verdict.failure_class)
        self.assertFalse(verdict.opens_breaker)

    def test_a_verdict_names_its_leg_and_code(self):
        verdict = classify_stt(1013)
        self.assertEqual("stt", verdict.leg)
        self.assertEqual(1013, verdict.code)


class TTSClassificationTest(unittest.TestCase):
    def test_3005_opens_the_leg_after_its_one_retry(self):
        verdict = classify_tts(3005)
        self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)
        self.assertTrue(verdict.opens_breaker)

    def test_no_output_free_closes_are_socket_triggers(self):
        for code in (None, 1006, 1011):
            with self.subTest(code=code):
                verdict = classify_tts(code)
                self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)
                self.assertTrue(verdict.opens_breaker)

    def test_deterministic_request_errors_are_bugs(self):
        for code in (3006, 3010, 3011, 1009):
            with self.subTest(code=code):
                verdict = classify_tts(code)
                self.assertEqual(FailureClass.BUG, verdict.failure_class)
                self.assertFalse(verdict.opens_breaker)

    def test_3008_expiry_is_a_planned_reconnect(self):
        verdict = classify_tts(3008)
        self.assertEqual(FailureClass.PLANNED_RECONNECT, verdict.failure_class)
        self.assertFalse(verdict.opens_breaker)

    def test_reaching_expires_at_is_a_planned_reconnect(self):
        verdict = classify_tts(SESSION_LIMIT)
        self.assertEqual(FailureClass.PLANNED_RECONNECT, verdict.failure_class)

    def test_1000_normal_close_does_not_open(self):
        verdict = classify_tts(1000)
        self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)


class LLMClassificationTest(unittest.TestCase):
    def test_400_is_a_conversation_structure_bug(self):
        verdict = classify_llm(400)
        self.assertEqual(FailureClass.BUG, verdict.failure_class)
        self.assertFalse(verdict.opens_breaker)

    def test_429_opens_the_leg(self):
        verdict = classify_llm(429)
        self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)
        self.assertTrue(verdict.opens_breaker)

    def test_any_5xx_opens_the_leg(self):
        for status in (500, 503, 599):
            with self.subTest(status=status):
                verdict = classify_llm(status)
                self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)

    def test_a_timeout_opens_the_leg_with_or_without_a_status(self):
        for status in (None, 429):
            with self.subTest(status=status):
                verdict = classify_llm(status, timed_out=True)
                self.assertEqual(FailureClass.TRIGGER, verdict.failure_class)

    def test_no_status_and_no_timeout_fails_closed(self):
        verdict = classify_llm()
        self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)

    def test_unlisted_http_statuses_fail_closed(self):
        for status in (401, 404, 418):
            with self.subTest(status=status):
                verdict = classify_llm(status)
                self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)
                self.assertFalse(verdict.opens_breaker)


class LegKeyingTest(unittest.TestCase):
    def test_1011_is_synthesis_and_speech_but_not_model(self):
        self.assertEqual(FailureClass.TRIGGER, classify_tts(1011).failure_class)
        self.assertEqual(FailureClass.TRIGGER, classify_stt(1011).failure_class)
        self.assertEqual(
            FailureClass.DO_NOT_OPEN, classify_llm(1011).failure_class
        )

    def test_a_code_from_another_leg_is_unknown_not_retryable(self):
        for verdict in (classify_stt(3005), classify_tts(1013), classify_stt(400)):
            with self.subTest(leg=verdict.leg, code=verdict.code):
                self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)
                self.assertFalse(verdict.opens_breaker)

    def test_1008_is_a_speech_bug_and_an_unknown_synthesis_code(self):
        self.assertEqual(FailureClass.BUG, classify_stt(1008).failure_class)
        self.assertEqual(
            FailureClass.DO_NOT_OPEN, classify_tts(1008).failure_class
        )


class CatalogCoverageTest(unittest.TestCase):
    """Every code the spec names, classified exactly once, by leg."""

    # Codes named by "Trigger set is closed", the three backend sections'
    # close-code lists, and the Provider wire and session lifecycle catalog.
    SPEC_CODES = {
        "stt": {1000, 1008, 1011, 1013, None, SESSION_LIMIT},
        "tts": {
            1000,
            1006,
            1009,
            1011,
            3005,
            3006,
            3008,
            3010,
            3011,
            None,
            SESSION_LIMIT,
        },
        "llm": {400, 429, LLM_SERVER_ERROR, LLM_TIMEOUT},
    }

    # One row per case in the spec's "Provider wire and session lifecycle"
    # catalog, plus the trigger-set codes it names. The class is read off the
    # spec prose, never off the table.
    CATALOG = (
        ("Meta closes 1008", 1008, FailureClass.BUG, classify_stt(1008)),
        ("Meta closes 1011", 1011, FailureClass.TRIGGER, classify_stt(1011)),
        ("Meta closes 1013", 1013, FailureClass.TRIGGER, classify_stt(1013)),
        (
            "The STT session reaches 60 minutes",
            SESSION_LIMIT,
            FailureClass.PLANNED_RECONNECT,
            classify_stt(SESSION_LIMIT),
        ),
        ("TTS closes 3005", 3005, FailureClass.TRIGGER, classify_tts(3005)),
        ("TTS closes 3006", 3006, FailureClass.BUG, classify_tts(3006)),
        ("TTS closes 3008", 3008, FailureClass.PLANNED_RECONNECT, classify_tts(3008)),
        ("TTS closes 3010", 3010, FailureClass.BUG, classify_tts(3010)),
        ("TTS closes 3011", 3011, FailureClass.BUG, classify_tts(3011)),
        ("TTS closes 1009", 1009, FailureClass.BUG, classify_tts(1009)),
        ("TTS closes without a code", None, FailureClass.TRIGGER, classify_tts(None)),
        ("TTS closes 1006", 1006, FailureClass.TRIGGER, classify_tts(1006)),
        ("TTS closes 1011", 1011, FailureClass.TRIGGER, classify_tts(1011)),
        (
            "The TTS session reaches expires_at",
            SESSION_LIMIT,
            FailureClass.PLANNED_RECONNECT,
            classify_tts(SESSION_LIMIT),
        ),
        (
            "The LLM request times out before the first content token",
            LLM_TIMEOUT,
            FailureClass.TRIGGER,
            classify_llm(timed_out=True),
        ),
        (
            "The LLM request times out mid-reply",
            LLM_TIMEOUT,
            FailureClass.TRIGGER,
            classify_llm(timed_out=True),
        ),
        ("The LLM request returns 400", 400, FailureClass.BUG, classify_llm(400)),
        ("The LLM request returns 429", 429, FailureClass.TRIGGER, classify_llm(429)),
        (
            "The LLM request returns 5xx",
            LLM_SERVER_ERROR,
            FailureClass.TRIGGER,
            classify_llm(503),
        ),
    )

    def test_every_catalog_row_gets_the_documented_class(self):
        for case, _key, expected, verdict in self.CATALOG:
            with self.subTest(case=case):
                self.assertEqual(expected, verdict.failure_class)
                self.assertEqual(
                    expected is FailureClass.TRIGGER, verdict.opens_breaker
                )

    def test_the_catalog_covers_all_three_legs(self):
        legs = {verdict.leg for *_, verdict in self.CATALOG}
        self.assertEqual({"stt", "tts", "llm"}, legs)

    def test_no_code_is_classified_two_ways(self):
        classes_by_code: dict[tuple[str, object], set[FailureClass]] = {}
        for _case, key, expected, verdict in self.CATALOG:
            classes_by_code.setdefault((verdict.leg, key), set()).add(expected)
        for (leg, key), classes in classes_by_code.items():
            with self.subTest(leg=leg, code=key):
                self.assertEqual(1, len(classes), f"{leg} {key!r} -> {classes}")

    def test_each_leg_table_names_exactly_the_spec_codes(self):
        tables = {
            "stt": (STT_CLOSE_RULES,),
            "tts": (TTS_CLOSE_RULES,),
            "llm": (LLM_STATUS_RULES,),
        }
        for leg, expected in self.SPEC_CODES.items():
            keys = [key for table in tables[leg] for key in table]
            with self.subTest(leg=leg):
                self.assertEqual(len(keys), len(set(keys)), "code classified twice")
                self.assertEqual(expected, set(keys))

    def test_the_tables_are_read_only(self):
        with self.assertRaises(TypeError):
            STT_CLOSE_RULES[4242] = None  # type: ignore[index]


class UnknownCodeTest(unittest.TestCase):
    def test_unknown_codes_are_named_and_fail_closed(self):
        for leg, verdict in (
            ("stt", classify_stt(4242)),
            ("tts", classify_tts(4242)),
            ("llm", classify_llm(4242)),
        ):
            with self.subTest(leg=leg):
                self.assertEqual(FailureClass.DO_NOT_OPEN, verdict.failure_class)
                self.assertFalse(verdict.opens_breaker)
                self.assertIn("unclassified", verdict.reason)
                self.assertIn("4242", verdict.reason)


class DispatchTest(unittest.TestCase):
    def test_classify_routes_by_leg(self):
        self.assertEqual(FailureClass.BUG, classify("stt", 1008).failure_class)
        self.assertEqual(FailureClass.TRIGGER, classify("llm", 429).failure_class)
        self.assertEqual(FailureClass.BUG, classify("tts", 3006).failure_class)

    def test_an_unknown_leg_is_named_and_refused(self):
        with self.assertRaises(ValueError) as caught:
            classify("asr", 1008)
        self.assertIn("asr", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
