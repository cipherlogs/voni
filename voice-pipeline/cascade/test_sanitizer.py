"""The one sanitizer, callable from Python (ticket 111).

The one rule source is the TypeScript module
(``voni/src/lib/demo/event-sanitizer.ts``, ticket 07). Python cannot import it
at runtime (the voice service ships without the ``voni`` tree), so
``cascade/sanitizer.py`` is a callable copy and this module is the parity test
that makes drift fail by name: the forbidden set, both patterns, the marker and
the two bounds are read out of the TS source and compared.

The behaviour cases copy the expected values pinned by the TS test
(``event-sanitizer.test.ts``), so the copy answers the same questions as the
rule source, not merely the same constants.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from cascade import sanitizer
from cascade.sanitizer import (
    FORBIDDEN_EVENT_KEYS,
    MAX_DEPTH,
    MAX_LENGTH,
    REDACTED,
    redact_key_shaped,
    sanitize_fields,
)

TS_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "voni"
    / "src"
    / "lib"
    / "demo"
    / "event-sanitizer.ts"
).read_text(encoding="utf8")


def ts_forbidden_keys() -> set[str]:
    block = re.search(
        r"FORBIDDEN_EVENT_KEYS[^=]*=\s*new Set\(\[(.*?)\]\)", TS_SOURCE, re.S
    )
    if block is None:
        raise AssertionError("event-sanitizer.ts has no FORBIDDEN_EVENT_KEYS set")
    return set(re.findall(r'"([^"]+)"', block.group(1)))


def ts_pattern(name: str) -> tuple[str, str]:
    match = re.search(rf"{name}\s*=\s*/(.+)/([a-z]*);", TS_SOURCE)
    if match is None:
        raise AssertionError(f"event-sanitizer.ts has no {name} pattern")
    return match.group(1), match.group(2)


class RuleParityTests(unittest.TestCase):
    def test_the_forbidden_key_set_is_the_one_ts_set(self):
        self.assertEqual(set(FORBIDDEN_EVENT_KEYS), ts_forbidden_keys())
        self.assertEqual(len(FORBIDDEN_EVENT_KEYS), 14)

    def test_the_credential_patterns_match_the_ts_rule(self):
        key_source, key_flags = ts_pattern("KEY_SHAPED_VALUE")
        self.assertEqual(sanitizer.KEY_SHAPED_VALUE.pattern, key_source)
        self.assertEqual("i" in key_flags, bool(sanitizer.KEY_SHAPED_VALUE.flags & re.I))

        url_source, url_flags = ts_pattern("URL_CREDENTIAL")
        self.assertEqual(sanitizer.URL_CREDENTIAL.pattern, url_source)
        self.assertEqual("i" in url_flags, bool(sanitizer.URL_CREDENTIAL.flags & re.I))

    def test_the_marker_and_shared_bounds_match_the_ts_rule(self):
        self.assertIn(f'REDACTED = "{REDACTED}"', TS_SOURCE)
        self.assertIn(f"depth > {MAX_DEPTH}", TS_SOURCE)
        self.assertIn(f"slice(0, {MAX_LENGTH})", TS_SOURCE)
        self.assertIn(f'"{sanitizer.DEPTH_LIMIT}"', TS_SOURCE)
        self.assertIn(sanitizer.ELLIPSIS, TS_SOURCE)


class SanitizerBehaviourTests(unittest.TestCase):
    def test_a_forbidden_key_is_dropped_and_reported_by_name(self):
        result = sanitize_fields(
            {
                "sessionId": "sess_abc",
                "text": "caller words",
                "transcript": "caller words",
                "audio": "AAAA",
                "pcm": "AAAA",
                "authorization": "Bearer abc",
                "token": "tok_secret",
                "api_key": "sk_live_abcdefgh1234",
                "secret": "hunter2",
                "data": "base64audio",
            }
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.value, {"sessionId": "sess_abc"})
        self.assertEqual(
            sorted(result.rejected_keys),
            [
                "api_key",
                "audio",
                "authorization",
                "data",
                "pcm",
                "secret",
                "text",
                "token",
                "transcript",
            ],
        )

    def test_a_forbidden_key_is_matched_case_insensitively(self):
        result = sanitize_fields({"Authorization": "Bearer abc"})

        self.assertFalse(result.ok)
        self.assertEqual(result.value, {})
        self.assertEqual(result.rejected_keys, ("Authorization",))

    def test_a_key_shaped_value_inside_an_allowed_field_is_redacted_not_dropped(self):
        result = sanitize_fields(
            {
                "reason": "provider fallback to wss://edge:supersecret@cascade.example/ws timed out",
                "header": "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
                "note": "key sk_live_abcdefgh1234 leaked",
                "trace": "https://cascade.example/health",
            }
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.rejected_keys, ())
        self.assertEqual(
            result.value["reason"],
            "provider fallback to wss://[redacted]@cascade.example/ws timed out",
        )
        self.assertEqual(result.value["header"], REDACTED)
        self.assertEqual(result.value["note"], "key [redacted] leaked")
        self.assertEqual(result.value["trace"], "https://cascade.example/health")

    def test_a_forbidden_key_nested_in_an_object_or_array_is_dropped_and_named_by_path(self):
        result = sanitize_fields(
            {
                "nested": {
                    "text": "nested caller words",
                    "note": "key sk_live_abcdefgh1234 leaked",
                },
                "items": [{"transcript": "nested caller words"}, {"ok": True}],
            }
        )

        self.assertFalse(result.ok)
        self.assertEqual(
            result.value,
            {"nested": {"note": "key [redacted] leaked"}, "items": [{}, {"ok": True}]},
        )
        self.assertEqual(result.rejected_keys, ("nested.text", "items.transcript"))

    def test_the_shared_bounds_hold_depth_cap_truncation_and_non_finite(self):
        result = sanitize_fields(
            {
                "deep": {"a": {"b": {"c": {"d": {"e": 1}}}}},
                "long": "a" * 600,
                "infinite": float("inf"),
                "nan": float("nan"),
                "flag": True,
                "nothing": None,
            }
        )

        self.assertTrue(result.ok)
        self.assertEqual(
            result.value["deep"], {"a": {"b": {"c": {"d": "[depth-limit]"}}}}
        )
        self.assertEqual(len(result.value["long"]), 501)
        self.assertTrue(result.value["long"].endswith("…"))
        self.assertIsNone(result.value["infinite"])
        self.assertIsNone(result.value["nan"])
        self.assertTrue(result.value["flag"])
        self.assertIsNone(result.value["nothing"])

    def test_redact_key_shaped_keeps_the_surrounding_text_readable(self):
        self.assertEqual(
            redact_key_shaped("retry https://user:pw@vendor.example/ws now"),
            "retry https://[redacted]@vendor.example/ws now",
        )
        self.assertEqual(redact_key_shaped("Bearer abc.def"), REDACTED)


if __name__ == "__main__":
    unittest.main()
