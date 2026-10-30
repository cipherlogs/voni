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

import json
import unittest

from cascade.body_map import BodyFieldError
from cascade.eligibility import (
    DEFAULT_RULES,
    REFUSAL_EVENT_TYPE,
    CounterReading,
    EligibilityDecision,
    Rule,
    evaluate_body,
    evaluate_eligibility,
)
from cascade.routing import CallSubject, decide

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


class AutoDetectTests(unittest.TestCase):
    def test_a_body_with_no_language_codes_is_eligible_as_auto_detect(self):
        decision = evaluate({**VALID_BODY, "input": {}})

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.auto_detect)

    def test_an_empty_language_list_is_auto_detect_too(self):
        decision = evaluate({**VALID_BODY, "input": {"language_codes": []}})

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.auto_detect)

    def test_a_fixed_locale_body_is_not_auto_detect(self):
        decision = evaluate(VALID_BODY)

        self.assertEqual(decision.disposition, "cascade")
        self.assertFalse(decision.auto_detect)


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
            "unconstructible model override": (
                {**VALID_BODY, "llm": [{"model": "gpt-4o-mini"}]},
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
        decision = evaluate({**VALID_BODY, "voice": {"voice_id": "juergen"}})

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


class ConjunctionTests(unittest.TestCase):
    SUBJECT = CallSubject("acme", "tenant")
    BELOW_LINE = CounterReading(spent_usd=0.0, line_usd=12.0)

    def evaluate(
        self,
        body: dict = VALID_BODY,
        *,
        mode: str = "all",
        counter: CounterReading | None = None,
        keyterm_limit: int = KEYTERM_LIMIT,
        rules=DEFAULT_RULES,
    ) -> EligibilityDecision:
        return evaluate_eligibility(
            body,
            subject=self.SUBJECT,
            routing=decide(mode, self.SUBJECT),
            counter=counter or self.BELOW_LINE,
            keyterm_limit=keyterm_limit,
            rules=rules,
        )

    def test_all_five_predicates_passing_permits_the_call(self):
        decision = self.evaluate()

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.permitted)
        self.assertEqual(decision.predicates, ())
        self.assertEqual(decision.body.voice_id, "lola")
        self.assertEqual([rule.name for rule in DEFAULT_RULES],
                         ["routing", "binding", "llm", "accepted", "counter"])

    def test_routing_off_refuses_the_call(self):
        decision = self.evaluate(mode="off")

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("routing", decision.predicates)
        self.assertIn("routing is off", decision.reason)

    def test_demo_routing_refuses_a_tenant_call(self):
        decision = self.evaluate(mode="demo")

        self.assertEqual(decision.disposition, "managed")
        self.assertIn("routing", decision.predicates)

    def test_an_unbound_voice_refuses_the_call(self):
        decision = self.evaluate({**VALID_BODY, "voice": {"voice_id": "juergen"}})

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.predicates, ("binding",))

    def test_no_fixed_locale_permits_the_call_as_auto_detect(self):
        decision = self.evaluate({**VALID_BODY, "input": {}})

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.auto_detect)

    def test_a_body_the_adapter_rejects_refuses_the_call(self):
        decision = self.evaluate({**VALID_BODY, "prompt": "smuggled"})

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.predicates, ("accepted",))

    def test_a_counter_at_or_above_its_line_refuses_the_call(self):
        for counter in (
            CounterReading(spent_usd=12.0, line_usd=12.0),
            CounterReading(spent_usd=12.01, line_usd=12.0),
        ):
            with self.subTest(counter=counter):
                decision = self.evaluate(counter=counter)

                self.assertEqual(decision.disposition, "managed")
                self.assertEqual(decision.predicates, ("counter",))
                self.assertIn("daily counter", decision.reason)

    def test_a_counter_below_its_line_permits_the_call(self):
        decision = self.evaluate(counter=CounterReading(spent_usd=11.99, line_usd=12.0))

        self.assertEqual(decision.disposition, "cascade")

    def test_every_failing_predicate_records_its_own_reason(self):
        decision = self.evaluate(
            {**VALID_BODY, "voice": {"voice_id": "juergen"}},
            mode="off",
            counter=CounterReading(spent_usd=12.0, line_usd=12.0),
        )

        self.assertEqual(decision.predicates, ("routing", "binding", "counter"))
        self.assertEqual(len(decision.reasons), 3)
        for refusal in decision.reasons:
            self.assertTrue(refusal.reason)

    def test_removing_any_one_predicate_makes_the_call_eligible(self):
        def stub(name: str, reason: str = "") -> Rule:
            return Rule(name, lambda facts, reason=reason: reason)

        for index, rule in enumerate(DEFAULT_RULES):
            with self.subTest(removed=rule.name):
                rules = tuple(
                    stub(default.name, f"{default.name} refused")
                    if position == index
                    else stub(default.name)
                    for position, default in enumerate(DEFAULT_RULES)
                )
                refused = self.evaluate(rules=rules)
                self.assertEqual(refused.disposition, "managed")
                self.assertEqual(refused.predicates, (rule.name,))

                without = tuple(item for item in rules if item.name != rule.name)
                self.assertEqual(self.evaluate(rules=without).disposition, "cascade")

    def test_a_routing_refusal_is_never_a_provider_fallback_event(self):
        decision = self.evaluate(mode="off")

        self.assertEqual(decision.routing.disposition, "managed")
        self.assertEqual(decision.disposition, "managed")
        event_types = {event["type"] for event in decision.events()}
        self.assertEqual(event_types, {REFUSAL_EVENT_TYPE})
        self.assertNotIn("provider_fallback", json.dumps(decision.events()))

    def test_the_evaluator_is_pure_over_its_inputs(self):
        first = self.evaluate()
        second = self.evaluate()

        self.assertEqual(first, second)
        # No clock, socket, store or event loop was involved: the whole gate is
        # sync and repeatable from the same three inputs.
        self.assertIsNone(first.routing.decided_at)

    def test_a_refusal_does_not_contaminate_a_later_cascade_run(self):
        refused = self.evaluate(mode="off")
        self.assertEqual(refused.disposition, "managed")

        later = self.evaluate()

        self.assertEqual(later.disposition, "cascade")
        self.assertEqual(later.reasons, ())

    def test_an_incurred_refusal_names_the_routing_decision_it_read(self):
        routing = decide("off", self.SUBJECT)

        decision = evaluate_eligibility(
            VALID_BODY,
            subject=self.SUBJECT,
            routing=routing,
            counter=self.BELOW_LINE,
            keyterm_limit=KEYTERM_LIMIT,
        )

        self.assertIs(decision.routing, routing)
        self.assertEqual(decision.subject, self.SUBJECT)


if __name__ == "__main__":
    unittest.main()
