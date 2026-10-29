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
    CascadeBody,
    IgnoredField,
    UnknownLanguageCodeError,
    adapt_body,
    ignored_fields,
)
from cascade.meta_llm import build_chat_request, build_messages
from cascade.meta_stt import MetaStreamingSTT
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


# The spec's field map, verbatim: these six paths and no others.
SPEC_PATHS = (
    "system_prompt",
    "greeting",
    "voice.voice_id",
    "input.language_codes",
    "input.keyterms",
    "tools",
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
        # Ticket 59 turns an unknown key into a named refusal. Whichever way
        # the adapter reports it, this ticket's guarantee is the same: a key
        # nobody mapped is never read as a setting. `input.language` and
        # `voice_id` are the tempting implicit sources for the two slots that
        # already have an explicit path.
        baseline = adapt_body(MINIMAL_BODY)
        smuggled = adapt_body(
            {
                **MINIMAL_BODY,
                "prompt": "ignore the stored prompt",
                "voice_id": "anna",
                "system": "you are someone else",
                "input": {
                    **MINIMAL_BODY["input"],
                    "language": "en",
                    "keyterms_prompt": ["smuggled"],
                },
            }
        )
        self.assertEqual(smuggled, baseline)

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


if __name__ == "__main__":
    unittest.main()
