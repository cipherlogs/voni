"""One validator owns the stored body's LLM override (ticket 159).

The body adapter (``cascade.body_map``), the client builder
(``cascade.meta_llm.build_byo_client``) and the client's own constructor each
used to re-derive ``base_url``/``model``/``api_key``/``reasoning_effort``. This
test pins the one source: every entry point validates through
:mod:`cascade.llm_override`, so the three cannot disagree about whether an
override can be built.

The named refusals stay with their callers: the adapter keeps
``MissingLlmOverrideFieldError``/``LlmOverrideError`` and the client keeps
``ByoLlmError``; only the rules moved.
"""

from __future__ import annotations

import unittest
from unittest import mock

import cascade.llm_override as llm_override
from cascade.body_map import MissingLlmOverrideFieldError, adapt_body
from cascade.meta_llm import ByoLlmError, MetaLLM, build_byo_client

API_KEY = "sk-tenant-secret"

BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {"language_codes": ["es"]},
    "llm": [
        {
            "base_url": "https://models.example/v1",
            "model": "gpt-4o-mini",
            "api_key": API_KEY,
        }
    ],
}


class OneSourceTests(unittest.TestCase):
    def test_the_adapter_the_constructor_and_the_builder_share_the_validator(self):
        override = llm_override.LlmOverride(
            base_url="https://models.example/v1",
            model="gpt-4o-mini",
            api_key=API_KEY,
        )

        with mock.patch.object(
            llm_override, "validate_override", wraps=llm_override.validate_override
        ) as validator:
            adapt_body(BODY)
            self.assertEqual(1, validator.call_count, "the body adapter")

            validator.reset_mock()
            MetaLLM(
                api_key=API_KEY,
                model="gpt-4o-mini",
                base_url="https://models.example/v1",
                enforce_standard_model=False,
            )
            self.assertEqual(1, validator.call_count, "the client constructor")

            validator.reset_mock()
            build_byo_client(override)
            self.assertEqual(
                2,
                validator.call_count,
                "the client builder validates, then its constructor re-asserts",
            )


class ValidationRuleTests(unittest.TestCase):
    def test_the_validator_normalises_the_fields_it_accepts(self):
        override = llm_override.validate_override(
            base_url="  https://models.example/v1  ",
            model=" gpt-4o-mini ",
            api_key=" sk-tenant-secret ",
            reasoning_effort="   ",
        )

        self.assertEqual("https://models.example/v1", override.base_url)
        self.assertEqual("gpt-4o-mini", override.model)
        self.assertEqual(API_KEY, override.api_key)
        self.assertIsNone(override.reasoning_effort)

    def test_a_missing_required_field_is_named_and_marked_missing(self):
        with self.assertRaises(llm_override.LlmOverrideInvalid) as caught:
            llm_override.validate_override(
                base_url="https://models.example/v1",
                model="gpt-4o-mini",
                api_key="   ",
            )

        self.assertEqual("api_key", caught.exception.field)
        self.assertTrue(caught.exception.missing)
        self.assertNotIn(API_KEY, str(caught.exception))

    def test_a_relative_base_url_is_refused_by_field(self):
        with self.assertRaises(llm_override.LlmOverrideInvalid) as caught:
            llm_override.validate_override(
                base_url="models.example/v1",
                model="gpt-4o-mini",
                api_key=API_KEY,
            )

        self.assertEqual("base_url", caught.exception.field)
        self.assertFalse(caught.exception.missing)
        self.assertIn("http(s)", str(caught.exception))

    def test_a_non_string_effort_is_refused_by_field(self):
        with self.assertRaises(llm_override.LlmOverrideInvalid) as caught:
            llm_override.validate_override(
                base_url="https://models.example/v1",
                model="gpt-4o-mini",
                api_key=API_KEY,
                reasoning_effort=3,
            )

        self.assertEqual("reasoning_effort", caught.exception.field)


class CallerNamedErrorsTests(unittest.TestCase):
    def test_the_adapter_still_raises_its_named_field_error(self):
        body = {**BODY, "llm": [{"base_url": "https://models.example/v1", "model": "m"}]}

        with self.assertRaises(MissingLlmOverrideFieldError) as caught:
            adapt_body(body)

        self.assertEqual("llm[0].api_key", caught.exception.path)

    def test_the_client_still_raises_byo_llm_error(self):
        override = llm_override.LlmOverride(
            base_url="https://models.example/v1", model="m", api_key="  "
        )

        with self.assertRaises(ByoLlmError) as caught:
            build_byo_client(override)

        self.assertIn("api_key", str(caught.exception))

    def test_the_constructor_refuses_a_relative_base_url_by_name(self):
        # The constructor now shares the adapter's URL rule, so no direct
        # entry point can build a client the request builder would fail on.
        with self.assertRaises(ByoLlmError) as caught:
            MetaLLM(
                api_key=API_KEY,
                model="gpt-4o-mini",
                base_url="models.example/v1",
                enforce_standard_model=False,
            )

        self.assertIn("base_url", str(caught.exception))
        self.assertIn("http(s)", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
