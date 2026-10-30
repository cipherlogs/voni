"""Behaviour of the stored-body field map (ticket 57).

Seam: ``cascade.body_map.adapt_body`` — the one door from a stored agent body
to the cascade's config. A caller hands over the served body and gets a
``CascadeBody``; nothing else is public, and no body key reaches the config
except through an explicit ``FIELD_MAP`` entry.

Expected values come from an independent source: the spec's field map, the
stored body shape in ``voni/src/lib/agents/body.ts`` and the Agents API tool
shape in ``voni/src/lib/tools/definitions.ts``.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import asdict
from unittest import mock

from cascade import body_map
from cascade.body_map import (
    FIELD_MAP,
    IGNORE_SET,
    BodyFieldError,
    BodyFingerprintMismatch,
    CascadeBody,
    IgnoredField,
    InvalidToolNameError,
    LlmOverride,
    MissingLlmOverrideFieldError,
    MissingSystemPromptError,
    MultipleLlmOverridesError,
    UnknownBodyKeyError,
    UnknownLanguageCodeError,
    adapt_body,
    body_fingerprint,
    ignored_fields,
    stable_json,
    verify_served_body,
)
from cascade.meta_llm import build_chat_request, build_messages
from cascade.meta_stt import MetaStreamingSTT
from cascade.routing import CallSubject, decide
from cascade.testing.socket_factory import ScriptedSocketFactory
from cascade.voice_binding import Locale, UnboundVoiceError, UnknownVoiceError, VoiceBinding

# The smallest body the builder can emit that still names a voice and a
# language: prompt, voice, language codes. Everything else is optional.
MINIMAL_BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {"language_codes": ["es"]},
}


class MinimalBodyTests(unittest.TestCase):
    def test_a_minimal_body_produces_exactly_the_expected_config(self):
        config = adapt_body(MINIMAL_BODY)

        self.assertEqual(
            config,
            CascadeBody(
                system_prompt="You are a helpful agent.",
                greeting="",
                voice=VoiceBinding("lola", Locale("es", "Spanish")),
                speech_language_bias=("Spanish",),
                keyterms=(),
                tools=(),
                llm=None,
                ignored=(),
            ),
        )
        # The whole shape, pinned: no field arrives that the map did not name.
        self.assertEqual(
            asdict(config),
            {
                "system_prompt": "You are a helpful agent.",
                "greeting": "",
                "voice": {
                    "voice_id": "lola",
                    "locale": {"code": "es", "language": "Spanish"},
                },
                "speech_language_bias": ("Spanish",),
                "keyterms": (),
                "tools": (),
                "llm": None,
                "ignored": (),
            },
        )


class KeytermTests(unittest.TestCase):
    def test_input_keyterms_become_the_stt_keyword_list(self):
        body = {
            **MINIMAL_BODY,
            "input": {
                **MINIMAL_BODY["input"],
                "keyterms": ["Palm Jumeirah", "AED", "viewing"],
            },
        }
        self.assertEqual(adapt_body(body).keyterms, ("Palm Jumeirah", "AED", "viewing"))


# The Agents API REST tool shape, from `RestTool` in
# voni/src/lib/tools/definitions.ts: no `type`, plus execution metadata.
REST_TOOL = {
    "name": "book_viewing",
    "description": "Book a viewing for a property.",
    "parameters": {
        "type": "object",
        "properties": {"reference": {"type": "string"}},
        "required": ["reference"],
    },
    "execution_mode": "interactive",
    "timeout_seconds": 8,
}


class ToolTests(unittest.TestCase):
    def test_a_rest_tool_becomes_a_chat_completions_function(self):
        config = adapt_body({**MINIMAL_BODY, "tools": [REST_TOOL]})

        self.assertEqual(
            config.tools,
            (
                {
                    "type": "function",
                    "function": {
                        "name": "book_viewing",
                        "description": "Book a viewing for a property.",
                        "parameters": {
                            "type": "object",
                            "properties": {"reference": {"type": "string"}},
                            "required": ["reference"],
                        },
                    },
                },
            ),
        )

    def test_tool_order_is_preserved(self):
        second = {
            "name": "end_call",
            "description": "End the call.",
            "parameters": {"type": "object", "properties": {}},
            "execution_mode": "hold",
            "timeout_seconds": 5,
        }
        config = adapt_body({**MINIMAL_BODY, "tools": [REST_TOOL, second]})
        self.assertEqual(
            [tool["function"]["name"] for tool in config.tools],
            ["book_viewing", "end_call"],
        )

    def test_a_tool_name_with_more_than_one_dot_is_refused_by_name(self):
        tool = {**REST_TOOL, "name": "crm.deals.book"}

        with self.assertRaises(InvalidToolNameError) as caught:
            adapt_body({**MINIMAL_BODY, "tools": [tool]})

        self.assertEqual(caught.exception.path, "tools[0].name")
        self.assertIn("crm.deals.book", str(caught.exception))

    def test_a_tool_name_with_an_invalid_character_is_refused_by_name(self):
        for name in ("book viewing", "book/viewing", "book_viewing!", "booké"):
            with self.subTest(name=name):
                with self.assertRaises(InvalidToolNameError) as caught:
                    adapt_body({**MINIMAL_BODY, "tools": [{**REST_TOOL, "name": name}]})
                self.assertIn(name, str(caught.exception))

    def test_a_single_dot_in_a_tool_name_is_allowed(self):
        config = adapt_body({**MINIMAL_BODY, "tools": [{**REST_TOOL, "name": "crm.book"}]})

        self.assertEqual(config.tools[0]["function"]["name"], "crm.book")

    def test_one_unrepresentable_tool_refuses_the_whole_set(self):
        good = {**REST_TOOL, "name": "book_viewing"}
        bad = {**REST_TOOL, "name": "crm.deals.book"}

        with self.assertRaises(InvalidToolNameError) as caught:
            adapt_body({**MINIMAL_BODY, "tools": [good, bad]})

        # Nothing is silently dropped: no config exists to run the one good tool.
        self.assertEqual(caught.exception.path, "tools[1].name")


class ToolSchemaTests(unittest.TestCase):
    def test_a_missing_root_type_is_supplied(self):
        tool = {
            "name": "book_viewing",
            "description": "Book a viewing.",
            "parameters": {"properties": {"reference": {"type": "string"}}},
        }

        config = adapt_body({**MINIMAL_BODY, "tools": [tool]})

        parameters = config.tools[0]["function"]["parameters"]
        self.assertEqual(parameters["type"], "object")
        self.assertEqual(
            parameters["properties"], {"reference": {"type": "string"}}
        )

    def test_an_existing_root_type_is_passed_through_unchanged(self):
        schema = {
            "type": "object",
            "properties": {"reference": {"type": "string"}},
            "required": ["reference"],
            "additionalProperties": False,
        }
        config = adapt_body(
            {**MINIMAL_BODY, "tools": [{**REST_TOOL, "parameters": schema}]}
        )

        self.assertEqual(config.tools[0]["function"]["parameters"], schema)

    def test_a_tool_without_a_schema_gets_no_invented_one(self):
        config = adapt_body({**MINIMAL_BODY, "tools": [{"name": "end_call"}]})

        self.assertEqual(
            config.tools,
            ({"type": "function", "function": {"name": "end_call"}},),
        )

    def test_a_parameters_schema_that_is_not_an_object_is_refused_by_name(self):
        tool = {"name": "book_viewing", "parameters": "not-a-schema"}

        with self.assertRaises(BodyFieldError) as caught:
            adapt_body({**MINIMAL_BODY, "tools": [tool, REST_TOOL]})

        self.assertEqual(caught.exception.path, "tools[0].parameters")

    def test_one_body_tool_round_trips_through_the_built_request(self):
        config = adapt_body({**MINIMAL_BODY, "tools": [REST_TOOL]})

        request = build_chat_request(
            model="muse-spark-1.3",
            messages=build_messages(system_prompt=config.system_prompt),
            tools=list(config.tools),
            reasoning_effort="low",
        )

        self.assertEqual(
            request["tools"],
            [
                {
                    "type": "function",
                    "function": {
                        "name": "book_viewing",
                        "description": "Book a viewing for a property.",
                        "parameters": {
                            "type": "object",
                            "properties": {"reference": {"type": "string"}},
                            "required": ["reference"],
                        },
                    },
                }
            ],
        )
        self.assertEqual(request["tool_choice"], "auto")



class SystemPromptContractTests(unittest.TestCase):
    def test_a_missing_system_prompt_is_refused_as_a_contract_violation(self):
        body = {key: value for key, value in MINIMAL_BODY.items() if key != "system_prompt"}

        with self.assertRaises(MissingSystemPromptError) as caught:
            adapt_body(body)

        self.assertEqual(caught.exception.path, "system_prompt")

    def test_a_blank_system_prompt_is_refused(self):
        for prompt in ("", "   ", "\n\t"):
            with self.subTest(prompt=prompt):
                with self.assertRaises(MissingSystemPromptError):
                    adapt_body({**MINIMAL_BODY, "system_prompt": prompt})



class LanguageTests(unittest.TestCase):
    def test_language_codes_become_vendor_names_for_speech_bias(self):
        body = {
            **MINIMAL_BODY,
            "voice": {"voice_id": "anna"},
            "input": {"language_codes": ["en", "es"]},
        }
        self.assertEqual(adapt_body(body).speech_language_bias, ("English", "Spanish"))

    def test_synthesis_speaks_the_voices_own_locale_not_the_bias_list(self):
        # A Spanish voice may be biased toward English too; synthesis still
        # speaks Spanish, because the binding table owns that language.
        body = {
            **MINIMAL_BODY,
            "voice": {"voice_id": "lola"},
            "input": {"language_codes": ["en", "es"]},
        }
        config = adapt_body(body)
        self.assertEqual(config.speech_language_bias, ("English", "Spanish"))
        self.assertEqual(config.language_code, "es")
        self.assertEqual(config.synthesis_language, "Spanish")

    def test_automatic_detection_leaves_the_bias_empty(self):
        # A body with no language_codes routes managed (ticket 61); the adapter
        # must not invent a bias for it in the meantime.
        self.assertEqual(adapt_body({**MINIMAL_BODY, "input": {}}).speech_language_bias, ())

    def test_an_unknown_language_code_is_refused_by_name(self):
        body = {**MINIMAL_BODY, "input": {"language_codes": ["es", "tlh"]}}
        with self.assertRaises(UnknownLanguageCodeError) as caught:
            adapt_body(body)
        self.assertIn('"tlh"', str(caught.exception))


class GreetingTests(unittest.TestCase):
    def test_a_greeting_reaches_the_config(self):
        config = adapt_body({**MINIMAL_BODY, "greeting": "Hi, this is Voni."})
        self.assertEqual(config.greeting, "Hi, this is Voni.")
        self.assertTrue(config.has_greeting)

    def test_an_absent_or_empty_greeting_means_a_silent_open(self):
        for greeting in (None, ""):
            with self.subTest(greeting=greeting):
                body = dict(MINIMAL_BODY)
                if greeting is not None:
                    body["greeting"] = greeting
                config = adapt_body(body)
                self.assertEqual(config.greeting, "")
                self.assertFalse(config.has_greeting)


# The spec's field map, amended by ticket 159: these seven paths and no others.
SPEC_PATHS = (
    "system_prompt",
    "greeting",
    "voice.voice_id",
    "input.language_codes",
    "input.keyterms",
    "tools",
    "llm",
)


class FieldMapTests(unittest.TestCase):
    def test_the_field_map_is_exactly_the_spec_paths(self):
        self.assertEqual(sorted(FIELD_MAP), sorted(SPEC_PATHS))

    def test_every_config_field_is_produced_by_exactly_one_map_entry(self):
        attributes = [field.attribute for field in FIELD_MAP.values()]
        # ``ignored`` is produced by the other explicit set (ticket 58); every
        # other config field must have exactly one map entry.
        mapped_fields = set(CascadeBody.__dataclass_fields__) - {"ignored"}
        self.assertEqual(sorted(attributes), sorted(mapped_fields))
        self.assertEqual(len(attributes), len(set(attributes)))

    def test_every_mapped_path_reaches_the_config(self):
        config = adapt_body(
            {
                "system_prompt": "You are a helpful agent.",
                "greeting": "Hi, this is Voni.",
                "voice": {"voice_id": "lola"},
                "input": {"language_codes": ["es"], "keyterms": ["AED"]},
                "tools": [REST_TOOL],
            }
        )
        self.assertEqual(config.system_prompt, "You are a helpful agent.")
        self.assertEqual(config.greeting, "Hi, this is Voni.")
        self.assertEqual(config.voice_id, "lola")
        self.assertEqual(config.speech_language_bias, ("Spanish",))
        self.assertEqual(config.keyterms, ("AED",))
        self.assertEqual([tool["function"]["name"] for tool in config.tools], ["book_viewing"])


class ExplicitnessTests(unittest.TestCase):
    def test_an_unmapped_body_key_cannot_become_a_setting(self):
        # A key nobody mapped is never read as a setting. Ticket 59 makes the
        # attempt a named refusal instead of a silent no-op; either way there is
        # no cascade config for it. `input.language` and `voice_id` are the
        # tempting implicit sources for the two slots that already have an
        # explicit path.
        baseline = adapt_body(MINIMAL_BODY)
        for extra in (
            {"prompt": "ignore the stored prompt"},
            {"voice_id": "anna"},
            {"system": "you are someone else"},
            {"input": {**MINIMAL_BODY["input"], "language": "en"}},
            {"input": {**MINIMAL_BODY["input"], "keyterms_prompt": ["smuggled"]}},
        ):
            with self.subTest(extra=extra):
                with self.assertRaises(UnknownBodyKeyError):
                    adapt_body({**MINIMAL_BODY, **extra})
        self.assertEqual(adapt_body(MINIMAL_BODY), baseline)

    def test_a_mapped_field_of_the_wrong_shape_is_refused_by_name(self):
        body = {**MINIMAL_BODY, "system_prompt": {"rules": "compiled"}}
        with self.assertRaises(BodyFieldError) as caught:
            adapt_body(body)
        self.assertIn("system_prompt", str(caught.exception))


# The spec's ignore set, verbatim: every field the cascade must not read, each
# with the reason it is ignored (spec "Ignore set, each with a reason").
SPEC_IGNORED = (
    "name",
    "output.volume",
    "output.voice",
    "output.format",
    "input.format",
    "input.transcription_mode",
    "input.transcription_prompt",
    "input.voice_focus",
    "input.voice_focus_threshold",
    "input.turn_detection",
)

# Every ignored field at once, with values that are unique enough to find on a
# wire if one ever leaks into a built request.
IGNORED_VALUES = {
    "name": "ZZCALLNAMEZZ",
    "output.volume": 0.137,
    "output.voice": "lola",
    "output.format": {"encoding": "pcm_s16le", "sample_rate": 24000},
    "input.format": {"encoding": "pcm_s16le", "sample_rate": 24000},
    "input.transcription_mode": "balanced",
    "input.transcription_prompt": "ZZTRANSCRIPTIONZZ expect digits",
    "input.voice_focus": "far-field",
    "input.voice_focus_threshold": 0.613,
    "input.turn_detection": None,
}


def body_with_every_ignored_field() -> dict:
    return {
        **MINIMAL_BODY,
        "name": IGNORED_VALUES["name"],
        "output": {
            "volume": IGNORED_VALUES["output.volume"],
            "voice": IGNORED_VALUES["output.voice"],
            "format": IGNORED_VALUES["output.format"],
        },
        "input": {
            **MINIMAL_BODY["input"],
            "format": IGNORED_VALUES["input.format"],
            "transcription_mode": IGNORED_VALUES["input.transcription_mode"],
            "transcription_prompt": IGNORED_VALUES["input.transcription_prompt"],
            "voice_focus": IGNORED_VALUES["input.voice_focus"],
            "voice_focus_threshold": IGNORED_VALUES["input.voice_focus_threshold"],
            "turn_detection": IGNORED_VALUES["input.turn_detection"],
        },
    }


def built_requests(config: CascadeBody) -> tuple[str, str]:
    """The two vendor requests a call builds from this config, as JSON text."""
    factory = ScriptedSocketFactory([json.dumps({"status": "ready"})])
    backend = MetaStreamingSTT(
        call_id="call-1",
        api_key="test-key",
        socket_factory=factory,
        keyterms=config.keyterms,
    )
    asyncio.run(backend.open(language_codes=[config.language_code], sample_rate=24000))
    handshake = factory.socket.sent[0]
    assert isinstance(handshake, str), f"the speech handshake is not text: {handshake!r}"
    chat = build_chat_request(
        model="muse-spark-1.3",
        messages=build_messages(system_prompt=config.system_prompt),
        tools=list(config.tools) or None,
        reasoning_effort="low",
    )
    return handshake, json.dumps(chat)


class IgnoreSetTests(unittest.TestCase):
    def test_the_ignore_set_is_exactly_the_spec_fields(self):
        self.assertEqual(sorted(IGNORE_SET), sorted(SPEC_IGNORED))

    def test_every_ignored_field_names_why_it_is_ignored(self):
        for path, reason in IGNORE_SET.items():
            with self.subTest(path=path):
                self.assertIsInstance(reason, str)
                self.assertGreater(len(reason), 20, f"{path} has no real reason")

    def test_mapped_and_ignored_paths_do_not_overlap(self):
        self.assertEqual(set(FIELD_MAP) & set(IGNORE_SET), set())

    def test_every_present_ignored_field_is_recorded_with_its_reason(self):
        body = body_with_every_ignored_field()
        config = adapt_body(body)

        self.assertEqual(config.ignored, ignored_fields(body))
        self.assertEqual(
            {field.path for field in config.ignored},
            set(SPEC_IGNORED),
        )
        for field in config.ignored:
            with self.subTest(path=field.path):
                self.assertEqual(field.reason, IGNORE_SET[field.path])
                self.assertEqual(field.value, IGNORED_VALUES[field.path])

    def test_an_absent_ignored_field_is_not_recorded(self):
        self.assertEqual(adapt_body(MINIMAL_BODY).ignored, ())

    def test_ignoring_the_transcription_prompt_is_recorded_with_its_words(self):
        # The pre-cutover recognition check has to see the words that were
        # carried by a field the cascade no longer sends.
        config = adapt_body(body_with_every_ignored_field())

        prompt = {field.path: field for field in config.ignored}[
            "input.transcription_prompt"
        ]
        self.assertEqual(prompt.value, "ZZTRANSCRIPTIONZZ expect digits")
        self.assertIn("keyterms", prompt.reason)

    def test_no_ignored_field_reaches_a_built_request(self):
        config = adapt_body(body_with_every_ignored_field())
        handshake, chat = built_requests(config)

        for wire in (handshake, chat):
            for path in SPEC_IGNORED:
                with self.subTest(path=path, wire=wire[:20]):
                    self.assertNotIn(f'"{path.split(".")[-1]}"', wire)
            self.assertNotIn("ZZCALLNAMEZZ", wire)
            self.assertNotIn("ZZTRANSCRIPTIONZZ", wire)
            self.assertNotIn("0.137", wire)
            self.assertNotIn("0.613", wire)

    def test_the_ignore_set_is_data_so_extending_it_is_a_data_edit(self):
        # No conditional names an ignored field: a new entry in the mapping is
        # the whole change.
        extended = dict(IGNORE_SET, **{"input.experimental_knob": "not a cascade setting"})
        with mock.patch.object(body_map, "IGNORE_SET", extended):
            config = adapt_body(
                {**MINIMAL_BODY, "input": {"language_codes": ["es"], "experimental_knob": 1}}
            )
        self.assertEqual(
            config.ignored,
            (IgnoredField("input.experimental_knob", "not a cascade setting", 1),),
        )


# The stored body the single builder emits today (voni/src/lib/agents/body.ts,
# `buildStoredAgent`), with every key present: the whitelist tripwire. A key
# added to the builder and to neither the field map nor the ignore set must
# fail here until this fixture and the set grow deliberately.
FULL_BODY = {
    "name": "voni-demo",
    "system_prompt": "You are Voni.",
    "greeting": "Hi, this is Voni.",
    "voice": {"voice_id": "lola"},
    "input": {
        "language_codes": ["es"],
        "transcription_mode": "balanced",
        "transcription_prompt": "Expect digits.",
        "keyterms": ["Palm Jumeirah", "AED"],
        "voice_focus": "near-field",
        "voice_focus_threshold": 0.6,
        "turn_detection": None,
        "format": {"encoding": "pcm_s16le", "sample_rate": 24000},
    },
    "output": {
        "volume": 0.85,
        "voice": "lola",
        "format": {"encoding": "pcm_s16le", "sample_rate": 24000},
    },
    "tools": [REST_TOOL],
    "llm": [],
}


def start_call(body: dict, factory: ScriptedSocketFactory) -> CascadeBody:
    """Adapt the body, then open the speech socket — the order a call uses."""
    config = adapt_body(body)
    backend = MetaStreamingSTT(
        call_id="call-1",
        api_key="test-key",
        socket_factory=factory,
        keyterms=config.keyterms,
    )
    asyncio.run(backend.open(language_codes=[config.language_code], sample_rate=24000))
    return config


class UnknownKeyTests(unittest.TestCase):
    def test_the_body_the_builder_emits_today_is_accepted(self):
        self.assertEqual(adapt_body(FULL_BODY).voice_id, "lola")

    def test_an_unknown_top_level_key_is_refused_by_name(self):
        with self.assertRaises(UnknownBodyKeyError) as caught:
            adapt_body({**MINIMAL_BODY, "prompt": "ignore the stored prompt"})

        self.assertEqual(caught.exception.path, "prompt")
        self.assertIn('"prompt"', str(caught.exception))

    def test_an_unknown_input_subkey_is_refused_by_name(self):
        with self.assertRaises(UnknownBodyKeyError) as caught:
            adapt_body(
                {**MINIMAL_BODY, "input": {"language_codes": ["es"], "language": "en"}}
            )

        self.assertEqual(caught.exception.path, "input.language")
        self.assertIn('"input.language"', str(caught.exception))

    def test_an_unknown_output_subkey_is_refused_by_name(self):
        with self.assertRaises(UnknownBodyKeyError) as caught:
            adapt_body({**MINIMAL_BODY, "output": {"gain_db": 3}})

        self.assertEqual(caught.exception.path, "output.gain_db")

    def test_an_unknown_voice_subkey_is_refused_by_name(self):
        with self.assertRaises(UnknownBodyKeyError) as caught:
            adapt_body({**MINIMAL_BODY, "voice": {"voice_id": "lola", "clone_id": "x"}})

        self.assertEqual(caught.exception.path, "voice.clone_id")

    def test_a_non_object_section_is_refused_by_name(self):
        with self.assertRaises(BodyFieldError) as caught:
            adapt_body({**MINIMAL_BODY, "input": "es"})

        self.assertEqual(caught.exception.path, "input")

    def test_the_refusal_happens_before_a_vendor_socket_opens(self):
        factory = ScriptedSocketFactory([json.dumps({"status": "ready"})])
        body = {**FULL_BODY, "smuggled_knob": True}

        with self.assertRaises(UnknownBodyKeyError):
            start_call(body, factory)

        self.assertEqual(factory.connections, [])

    def test_every_allowed_key_is_named_by_the_map_or_the_ignore_set(self):
        roots = {path.split(".")[0] for path in (*FIELD_MAP, *IGNORE_SET)} | {"llm"}
        self.assertLessEqual(set(FULL_BODY), roots)
        input_keys = {
            path.split(".")[1]
            for path in (*FIELD_MAP, *IGNORE_SET)
            if path.startswith("input.")
        }
        self.assertLessEqual(set(FULL_BODY["input"]), input_keys)
        output_keys = {
            path.split(".")[1] for path in IGNORE_SET if path.startswith("output.")
        }
        self.assertLessEqual(set(FULL_BODY["output"]), output_keys)

    def test_a_key_a_future_builder_adds_fails_until_the_sets_grow(self):
        future = {
            **FULL_BODY,
            "input": {**FULL_BODY["input"], "endpointing_sensitivity": 0.4},
        }
        with self.assertRaises(UnknownBodyKeyError) as caught:
            adapt_body(future)
        self.assertEqual(caught.exception.path, "input.endpointing_sensitivity")

        # Deliberately extending the ignore set is the whole fix; the adapter
        # needs no code change.
        with mock.patch.object(
            body_map,
            "IGNORE_SET",
            dict(
                IGNORE_SET,
                **{"input.endpointing_sensitivity": "not a cascade setting"},
            ),
        ):
            config = adapt_body(future)
        self.assertIn(
            "input.endpointing_sensitivity",
            {field.path for field in config.ignored},
        )


class BindingReuseTests(unittest.TestCase):
    def test_an_unbound_voice_is_refused_by_the_binding_table(self):
        with self.assertRaises(UnboundVoiceError):
            adapt_body({**MINIMAL_BODY, "voice": {"voice_id": "juergen"}})

    def test_an_unknown_voice_is_refused_by_name(self):
        with self.assertRaises(UnknownVoiceError) as caught:
            adapt_body({**MINIMAL_BODY, "voice": {"voice_id": "ghost"}})
        self.assertIn('"ghost"', str(caught.exception))

    def test_a_missing_voice_is_a_named_field_error(self):
        body = {key: value for key, value in MINIMAL_BODY.items() if key != "voice"}
        with self.assertRaises(BodyFieldError) as caught:
            adapt_body(body)
        self.assertIn("voice.voice_id", str(caught.exception))


class LlmOverrideTests(unittest.TestCase):
    ONE_OVERRIDE = {
        "base_url": "https://models.example/v1",
        "model": "gpt-4o-mini",
        "api_key": "sk-tenant",
    }

    def test_one_model_override_is_read_into_the_body_config(self):
        config = adapt_body({**MINIMAL_BODY, "llm": [self.ONE_OVERRIDE]})

        self.assertIsInstance(config.llm, LlmOverride)
        self.assertEqual(config.llm.model, "gpt-4o-mini")

    def test_an_absent_or_empty_model_array_is_the_default_rung(self):
        for llm in (None, []):
            with self.subTest(llm=llm):
                body = dict(MINIMAL_BODY)
                if llm is not None:
                    body["llm"] = llm
                self.assertIsNone(adapt_body(body).llm)

    def test_a_non_list_model_override_is_refused_by_name(self):
        with self.assertRaises(BodyFieldError) as caught:
            adapt_body({**MINIMAL_BODY, "llm": {"model": "gpt-4o-mini"}})

        self.assertEqual(caught.exception.path, "llm")

    def test_more_than_one_entry_is_refused_by_name(self):
        second = {**self.ONE_OVERRIDE, "model": "second-model"}

        with self.assertRaises(MultipleLlmOverridesError) as caught:
            adapt_body({**MINIMAL_BODY, "llm": [self.ONE_OVERRIDE, second]})

        self.assertEqual(caught.exception.path, "llm")
        self.assertIn("gpt-4o-mini", str(caught.exception))
        self.assertIn("second-model", str(caught.exception))

    def test_an_entry_without_a_key_is_refused_by_name(self):
        entry = {
            "base_url": "https://models.example/v1",
            "model": "gpt-4o-mini",
        }

        with self.assertRaises(MissingLlmOverrideFieldError) as caught:
            adapt_body({**MINIMAL_BODY, "llm": [entry]})

        self.assertEqual(caught.exception.path, "llm[0].api_key")
        self.assertNotIn("sk-", str(caught.exception))

    def test_an_entry_with_an_unknown_key_is_refused_by_name(self):
        entry = {**self.ONE_OVERRIDE, "temperature": 0.2}

        with self.assertRaises(BodyFieldError) as caught:
            adapt_body({**MINIMAL_BODY, "llm": [entry]})

        self.assertEqual(caught.exception.path, "llm[0].temperature")

    def test_the_override_never_contaminates_a_later_default_run(self):
        subject = CallSubject("acme", "tenant")
        with_override = adapt_body({**MINIMAL_BODY, "llm": [self.ONE_OVERRIDE]})
        later = adapt_body({**MINIMAL_BODY, "llm": []})
        decision = decide("all", subject)

        self.assertIsNotNone(with_override.llm)
        self.assertIsNone(later.llm)
        self.assertEqual(decision.disposition, "cascade")
        self.assertEqual(decision.reason, "")


class FingerprintTests(unittest.TestCase):
    # The account (credential) the body is stored under, mixed into the hash.
    ACCOUNT = "acct_7f3"

    # Pinned independently of this module: the hash `agentBodyFingerprint` in
    # voni/src/lib/agents/fingerprint.ts mints for FULL_BODY under ACCOUNT,
    # computed by running that function under node. The two languages must
    # agree on the canonical form, or every minted body looks tampered with.
    MINTED = "c132f5973859c2629f1bc0eecbb6cf814db8e2971184196f9e2029f8dc2d2df6"

    def test_the_canonical_form_is_sorted_compact_json(self):
        self.assertEqual(
            stable_json({"b": 1, "a": {"d": [1, 2], "c": None}}),
            '{"a":{"c":null,"d":[1,2]},"b":1}',
        )

    def test_the_python_fingerprint_equals_the_minted_typescript_one(self):
        self.assertEqual(
            body_fingerprint(FULL_BODY, account_salt=self.ACCOUNT),
            self.MINTED,
        )

    def test_the_served_body_fingerprint_equals_the_minted_one(self):
        served = verify_served_body(
            served_body=FULL_BODY,
            minted_fingerprint=self.MINTED,
            account_salt=self.ACCOUNT,
        )

        self.assertEqual(served, self.MINTED)

    def test_the_account_salt_is_part_of_the_fingerprint(self):
        other = body_fingerprint(FULL_BODY, account_salt="acct_other")

        self.assertNotEqual(other, self.MINTED)
        with self.assertRaises(BodyFingerprintMismatch) as caught:
            verify_served_body(
                served_body=FULL_BODY,
                minted_fingerprint=self.MINTED,
                account_salt="acct_other",
            )
        self.assertEqual(caught.exception.minted, self.MINTED)
        self.assertEqual(caught.exception.served, other)

    def test_one_mutated_body_field_is_a_named_mismatch(self):
        served = {**FULL_BODY, "greeting": "Hi, this is someone else."}

        with self.assertRaises(BodyFingerprintMismatch) as caught:
            verify_served_body(
                served_body=served,
                minted_fingerprint=self.MINTED,
                account_salt=self.ACCOUNT,
            )

        self.assertEqual(caught.exception.minted, self.MINTED)
        self.assertNotEqual(caught.exception.served, self.MINTED)
        self.assertIn("full fingerprint", str(caught.exception))
        self.assertNotIn(self.ACCOUNT, str(caught.exception))

    def test_an_ignored_field_is_part_of_the_fingerprint(self):
        # The adapter ignores output.volume; the fingerprint does not. A body
        # that changed at all is a body nobody fingerprinted.
        served = {
            **FULL_BODY,
            "output": {**FULL_BODY["output"], "volume": 0.851},
        }

        with self.assertRaises(BodyFingerprintMismatch):
            verify_served_body(
                served_body=served,
                minted_fingerprint=self.MINTED,
                account_salt=self.ACCOUNT,
            )

    def test_the_check_runs_on_the_body_read_back_not_the_intended_one(self):
        # The mint happened over the intended body; the platform served a
        # different one. Verifying the intended body would pass by mistake.
        intended = FULL_BODY
        served = {**FULL_BODY, "system_prompt": "You are Voni, but different."}
        minted = body_fingerprint(intended, account_salt=self.ACCOUNT)

        with self.assertRaises(BodyFingerprintMismatch):
            verify_served_body(
                served_body=served,
                minted_fingerprint=minted,
                account_salt=self.ACCOUNT,
            )

    def test_a_mismatch_routes_managed_with_the_recorded_reason(self):
        subject = CallSubject("acme", "tenant")
        served = {**FULL_BODY, "greeting": "Hi, this is someone else."}
        with self.assertRaises(BodyFingerprintMismatch) as caught:
            verify_served_body(
                served_body=served,
                minted_fingerprint=self.MINTED,
                account_salt=self.ACCOUNT,
            )

        decision = decide("all", subject, refusal=str(caught.exception))

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.opens_cascade_connections, 0)
        self.assertIn("full fingerprint", decision.reason)

    def test_a_body_that_is_not_a_mapping_is_a_programmer_error(self):
        with self.assertRaises(TypeError):
            body_fingerprint("not-a-body", account_salt=self.ACCOUNT)


if __name__ == "__main__":
    unittest.main()
