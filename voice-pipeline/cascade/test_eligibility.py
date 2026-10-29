"""Body eligibility refusals (ticket 61).

Seam: ``cascade.eligibility.evaluate_body`` — a pure function over a stored body
that answers one question: can the cascade represent this body, and if not, why?
Every answer is a routing fact: the call routes managed with the reason recorded,
never a fallback event.

Expected values come from the spec's "Eligibility refusals" and "Body adapter
and eligibility" tables, and the vendor's function-name rule (letters, digits,
underscores, dashes, at most one dot).
"""

from __future__ import annotations

import unittest

from cascade.body_map import BodyFieldError
from cascade.eligibility import (
    REFUSAL_EVENT_TYPE,
    EligibilityDecision,
    evaluate_body,
)

# The smallest body the builder emits for a bound voice with one fixed Locale.
VALID_BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {"language_codes": ["es"]},
}

# The vendor's keyword limit is an input here, not a number this module may
# invent (the registry owns it; ticket 04 supplies it).
KEYTERM_LIMIT = 4


def evaluate(body: dict, *, keyterm_limit: int = KEYTERM_LIMIT) -> EligibilityDecision:
    return evaluate_body(body, keyterm_limit=keyterm_limit)


class FixedLocaleTests(unittest.TestCase):
    def test_a_body_with_no_language_codes_is_refused_as_automatic_detection(self):
        decision = evaluate({**VALID_BODY, "input": {}})

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual([refusal.predicate for refusal in decision.reasons], ["locale"])
        self.assertIn("automatic language detection", decision.reason)

    def test_an_empty_language_list_is_refused(self):
        decision = evaluate({**VALID_BODY, "input": {"language_codes": []}})

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("locale", [refusal.predicate for refusal in decision.reasons])


class BindingRefusalTests(unittest.TestCase):
    def test_an_unbound_voice_is_refused_by_name(self):
        decision = evaluate({**VALID_BODY, "voice": {"voice_id": "juergen"}})

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual([refusal.predicate for refusal in decision.reasons], ["binding"])
        self.assertIn("juergen", decision.reason)

    def test_an_unknown_voice_is_refused_by_name(self):
        decision = evaluate({**VALID_BODY, "voice": {"voice_id": "ghost"}})

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("ghost", decision.reason)


class SystemPromptTests(unittest.TestCase):
    def test_a_body_with_no_system_prompt_is_refused_as_a_contract_violation(self):
        body = {key: value for key, value in VALID_BODY.items() if key != "system_prompt"}

        decision = evaluate(body)

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("system_prompt", decision.reason)

    def test_a_blank_system_prompt_is_refused(self):
        decision = evaluate({**VALID_BODY, "system_prompt": "   "})

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("system_prompt", decision.reason)


class ToolNameTests(unittest.TestCase):
    def test_a_tool_name_with_more_than_one_dot_is_refused_by_name(self):
        tool = {"name": "crm.deals.book", "parameters": {"type": "object"}}

        decision = evaluate({**VALID_BODY, "tools": [tool]})

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("crm.deals.book", decision.reason)

    def test_a_tool_name_with_an_invalid_character_is_refused_by_name(self):
        for name in ("book viewing", "book/viewing", "book_viewing!", "booké"):
            with self.subTest(name=name):
                decision = evaluate(
                    {**VALID_BODY, "tools": [{"name": name, "parameters": {}}]}
                )

                self.assertEqual(decision.disposition, "managed")
                self.assertIn(name, decision.reason)

    def test_a_single_dot_in_a_tool_name_is_allowed(self):
        body = {
            **VALID_BODY,
            "tools": [{"name": "crm.book", "parameters": {"type": "object"}}],
        }

        decision = evaluate(body)

        self.assertEqual(decision.disposition, "cascade")
        self.assertEqual(
            [tool["function"]["name"] for tool in decision.body.tools], ["crm.book"]
        )


class KeytermLimitTests(unittest.TestCase):
    def test_over_limit_keyterms_are_refused_by_name(self):
        body = {
            **VALID_BODY,
            "input": {
                "language_codes": ["es"],
                "keyterms": ["one", "two", "three", "four", "five"],
            },
        }

        decision = evaluate(body, keyterm_limit=4)

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("5", decision.reason)
        self.assertIn("4", decision.reason)

    def test_keyterms_are_never_truncated(self):
        keyterms = ["one", "two", "three", "four", "five"]
        body = {**VALID_BODY, "input": {"language_codes": ["es"], "keyterms": keyterms}}

        decision = evaluate(body, keyterm_limit=4)

        # The refused config still carries every keyterm: the adapter dropped
        # nothing, the eligibility gate refused instead of truncating.
        self.assertEqual(decision.body.keyterms, tuple(keyterms))

    def test_keyterms_within_the_limit_are_accepted(self):
        body = {
            **VALID_BODY,
            "input": {"language_codes": ["es"], "keyterms": ["one", "two"]},
        }

        self.assertEqual(evaluate(body, keyterm_limit=2).disposition, "cascade")


class UnsupportedLanguageTests(unittest.TestCase):
    def test_an_unsupported_language_code_is_refused_by_name(self):
        decision = evaluate(
            {**VALID_BODY, "input": {"language_codes": ["es", "tlh"]}}
        )

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("tlh", decision.reason)


class RoutesManagedTests(unittest.TestCase):
    def test_every_body_refusal_routes_managed_with_its_own_reason(self):
        cases = {
            "automatic language": ({**VALID_BODY, "input": {}}, KEYTERM_LIMIT),
            "unbound voice": ({**VALID_BODY, "voice": {"voice_id": "juergen"}}, KEYTERM_LIMIT),
            "unknown voice": ({**VALID_BODY, "voice": {"voice_id": "ghost"}}, KEYTERM_LIMIT),
            "missing prompt": (
                {k: v for k, v in VALID_BODY.items() if k != "system_prompt"},
                KEYTERM_LIMIT,
            ),
            "bad tool name": (
                {**VALID_BODY, "tools": [{"name": "a.b.c", "parameters": {}}]},
                KEYTERM_LIMIT,
            ),
            "unsupported language": (
                {**VALID_BODY, "input": {"language_codes": ["tlh"]}},
                KEYTERM_LIMIT,
            ),
            "too many keyterms": (
                {**VALID_BODY, "input": {"language_codes": ["es"], "keyterms": ["a", "b"]}},
                1,
            ),
            "unknown key": ({**VALID_BODY, "prompt": "smuggled"}, KEYTERM_LIMIT),
        }
        for label, (body, limit) in cases.items():
            with self.subTest(case=label):
                decision = evaluate(body, keyterm_limit=limit)
                self.assertEqual(decision.disposition, "managed")
                self.assertFalse(decision.permitted)
                self.assertTrue(decision.reason)
                self.assertTrue(decision.reasons)

    def test_a_valid_body_is_eligible(self):
        decision = evaluate(VALID_BODY)

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.permitted)
        self.assertEqual(decision.reasons, ())
        self.assertEqual(decision.body.voice_id, "lola")

    def test_a_refusal_is_recorded_as_an_eligibility_event_not_a_fallback(self):
        decision = evaluate({**VALID_BODY, "input": {}})

        events = decision.events()
        self.assertTrue(events)
        self.assertEqual({event["type"] for event in events}, {REFUSAL_EVENT_TYPE})
        self.assertNotIn(
            "provider_fallback", {event["type"] for event in decision.events()}
        )


class AdapterErrorTests(unittest.TestCase):
    def test_a_body_that_is_not_a_mapping_is_a_programmer_error(self):
        with self.assertRaises(TypeError):
            evaluate_body("not a body", keyterm_limit=KEYTERM_LIMIT)

    def test_a_body_error_still_carries_the_adapter_message(self):
        with self.assertRaises(BodyFieldError):
            # The adapter itself still refuses; the evaluator is the gate that
            # turns that into a routing reason, not a replacement for it.
            from cascade.body_map import adapt_body

            adapt_body({**VALID_BODY, "input": "es"})


if __name__ == "__main__":
    unittest.main()
