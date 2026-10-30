"""Auto-detect Locale on the cascade (ticket 160).

Seam: ``cascade.meta_stt``'s handshake, ``cascade.body_map.adapt_body``'s
language split, ``cascade.eligibility.evaluate_body`` and the synthesis
``Begin`` assertion. A body with no fixed ``language_codes`` is Meta
auto-detect: speech recognition sends no ``languageBias`` at all (no invented
empty list), while synthesis still speaks the bound voice's own Locale. An
unbound voice is still refused by name, and a ``Begin`` echo that disagrees with
the bound Locale still fails visibly.

Expected values come from the spec amendment (scope: auto-detect bodies run
cascade; managed is the fallback), the Meta handshake contract and the voice
binding table.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from cascade.assemblyai_tts import SynthesisEchoError
from cascade.body_map import adapt_body
from cascade.call import CallEligibility
from cascade.eligibility import CounterReading, Rule, evaluate_body, evaluate_eligibility
from cascade.meta_stt import MetaStreamingSTT
from cascade.routing import CallSubject, decide
from cascade.testing import FakeClock, ScriptedSocketFactory
from cascade.tts_support import begin, make_session, sent
from cascade.voice_binding import UnboundVoiceError

ACK = json.dumps({"sessionId": "call-1:0", "status": "ready"})

#: A bound voice with no fixed language list: the auto-detect subject.
AUTO_BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {},
}

#: The same voice with a fixed bias list: the fixed-Locale subject.
FIXED_BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {"language_codes": ["es"]},
}

KEYTERM_LIMIT = 4


def open_stt(language_codes) -> tuple[MetaStreamingSTT, dict]:
    """Open a speech session and return the backend with its handshake frame."""
    factory = ScriptedSocketFactory([ACK])
    backend = MetaStreamingSTT(
        call_id="call-1", api_key="test-key", socket_factory=factory
    )
    asyncio.run(backend.open(language_codes=list(language_codes), sample_rate=24000))
    return backend, json.loads(factory.socket.sent[0])


class AutoDetectHandshakeTests(unittest.TestCase):
    def test_an_empty_language_list_omits_language_bias_entirely(self):
        backend, handshake = open_stt([])

        self.assertNotIn("languageBias", handshake)
        self.assertTrue(backend.auto_detect)

    def test_an_absent_body_language_list_omits_language_bias(self):
        config = adapt_body(AUTO_BODY)

        self.assertEqual(config.speech_language_bias, ())
        self.assertTrue(config.auto_detect)
        _, handshake = open_stt(config.speech_language_bias)
        self.assertNotIn("languageBias", handshake)

    def test_a_fixed_locale_body_keeps_its_bias_list_unchanged(self):
        config = adapt_body(FIXED_BODY)

        self.assertEqual(config.speech_language_bias, ("Spanish",))
        self.assertFalse(config.auto_detect)
        backend, handshake = open_stt(FIXED_BODY["input"]["language_codes"])
        self.assertEqual(handshake["languageBias"], ["Spanish"])
        self.assertFalse(backend.auto_detect)

    def test_the_rest_of_the_handshake_is_unchanged_by_auto_detect(self):
        _, handshake = open_stt([])

        self.assertEqual(handshake["audioEncoding"], "PCM_24KHZ")
        self.assertEqual(handshake["model"], "muse-voice-transcribe-1.0")
        self.assertEqual(handshake["mode"], "ENDPOINTING")
        self.assertEqual(handshake["keywords"], [])


class SynthesisLocaleTests(unittest.TestCase):
    def test_synthesis_language_comes_from_the_bound_voice_not_detection(self):
        config = adapt_body(AUTO_BODY)

        self.assertEqual(config.synthesis_language, "Spanish")
        self.assertEqual(config.voice.language, "Spanish")

    def test_a_begin_echo_that_disagrees_with_the_bound_locale_still_fails(self):
        tts, factory = make_session(
            [begin(voice_id="lola", language="English")], voice_id="lola"
        )

        with self.assertRaises(SynthesisEchoError) as raised:
            asyncio.run(tts.open())

        self.assertIn("language", str(raised.exception))
        self.assertEqual(sent(factory), [])

    def test_a_begin_echo_that_matches_the_bound_locale_opens(self):
        tts, _ = make_session(
            [begin(voice_id="lola", language="Spanish")], voice_id="lola"
        )

        asyncio.run(tts.open())

        self.assertEqual(tts.begin_mismatches, ())
        self.assertEqual(tts.configuration["language"], "Spanish")


class EligibilityTests(unittest.TestCase):
    def test_an_auto_detect_body_is_no_longer_refused(self):
        decision = evaluate_body(AUTO_BODY, keyterm_limit=KEYTERM_LIMIT)

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.permitted)
        self.assertTrue(decision.auto_detect)

    def test_a_fixed_locale_body_is_not_recorded_as_auto_detect(self):
        decision = evaluate_body(FIXED_BODY, keyterm_limit=KEYTERM_LIMIT)

        self.assertEqual(decision.disposition, "cascade")
        self.assertFalse(decision.auto_detect)

    def test_an_unbound_voice_is_still_refused_by_name(self):
        body = {**AUTO_BODY, "voice": {"voice_id": "juergen"}}

        decision = evaluate_body(body, keyterm_limit=KEYTERM_LIMIT)

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.predicates, ("binding",))
        self.assertIn("juergen", decision.reason)

        with self.assertRaises(UnboundVoiceError):
            adapt_body(body)

    def test_the_full_conjunction_permits_an_auto_detect_subject(self):
        subject = CallSubject("acme", "tenant")

        decision = evaluate_eligibility(
            AUTO_BODY,
            subject=subject,
            routing=decide("all", subject),
            counter=CounterReading(spent_usd=0.0, line_usd=12.0),
            keyterm_limit=KEYTERM_LIMIT,
        )

        self.assertEqual(decision.disposition, "cascade")
        self.assertTrue(decision.auto_detect)

    def test_no_locale_rule_remains_to_refuse_detection(self):
        # The old "locale" predicate is gone by name; a rule that only passed
        # because nothing implemented detection would be a false green.
        from cascade.eligibility import DEFAULT_RULES

        self.assertNotIn("locale", [rule.name for rule in DEFAULT_RULES])

    def test_the_call_eligibility_fact_records_auto_detect(self):
        decision = evaluate_body(AUTO_BODY, keyterm_limit=KEYTERM_LIMIT)

        document = CallEligibility.from_decision(decision).to_document()

        self.assertEqual(document["disposition"], "cascade")
        self.assertIs(document["autoDetect"], True)

    def test_a_fixed_locale_call_records_auto_detect_false(self):
        decision = evaluate_body(FIXED_BODY, keyterm_limit=KEYTERM_LIMIT)

        document = CallEligibility.from_decision(decision).to_document()

        self.assertIs(document["autoDetect"], False)
