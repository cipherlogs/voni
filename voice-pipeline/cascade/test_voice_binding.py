"""Behaviour of the voice binding table.

The table is the only authority for the language a synthesis request speaks:
one voice is bound to exactly one Locale, an absent or unbound voice is refused
by name, and no request field can talk the table into a different language.

Fixtures are the repo's real catalogue (`voni/src/lib/agents/voices.ts`) and the
measured level evidence (`voni/evidence/voice-levels/levels.json`), read here so
drift is visible instead of being restated by hand.
"""

import json
import re
import unittest
from pathlib import Path

from cascade.voice_binding import (
    BINDINGS,
    UNBOUND_VOICES,
    LanguageOverrideError,
    Locale,
    UnboundVoiceError,
    UnknownVoiceError,
    VoiceBinding,
    VoiceBindingConflictError,
    bind_voice,
    build_bindings,
    is_cascade_subject,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VOICES_TS = REPO_ROOT / "voni/src/lib/agents/voices.ts"
LEVELS_JSON = REPO_ROOT / "voni/evidence/voice-levels/levels.json"

# The six demo subjects, in the catalogue's demo order.
DEMO_VOICES = ("anna", "lola", "estelle", "juergen", "giovanni", "rafael")


def _catalogue() -> dict[str, tuple[str, str]]:
    """`voice_id -> (vendor language name, language code)` from voices.ts."""
    source = VOICES_TS.read_text(encoding="utf-8")
    entries = re.finditer(
        r'\{\s*id:\s*"([^"]+)"[^}]*?language:\s*"([^"]+)",\s*languageCode:\s*"([^"]+)"\s*\}',
        source,
    )
    return {m.group(1): (m.group(2), m.group(3)) for m in entries}


def _measured_locales() -> dict[str, str]:
    """`voice_id -> locale` from the committed level evidence, measured + unmeasured."""
    evidence = json.loads(LEVELS_JSON.read_text(encoding="utf-8"))
    rows = {row["voice"]: row["locale"] for row in evidence["voices"]}
    rows.update({row["voice"]: row["locale"] for row in evidence["unmeasured"]})
    return rows


class DemoSubjectTests(unittest.TestCase):
    def test_the_six_demo_voices_bind_to_their_own_locale(self):
        expected = {
            "anna": Locale("en", "English"),
            "lola": Locale("es", "Spanish"),
            "estelle": Locale("fr", "French"),
            "giovanni": Locale("it", "Italian"),
            "rafael": Locale("pt", "Portuguese"),
        }
        for voice_id, locale in expected.items():
            with self.subTest(voice=voice_id):
                binding = bind_voice(voice_id)
                self.assertEqual(binding.locale, locale)
                self.assertEqual(binding.language, locale.language)

        self.assertNotIn(
            "juergen",
            BINDINGS,
            "German is unbound: juergen returns 422 voice_not_found (ticket 130)",
        )
        self.assertIn("juergen", UNBOUND_VOICES)

    def test_german_is_unbound_by_name_not_absent(self):
        with self.assertRaises(UnboundVoiceError) as caught:
            bind_voice("juergen")
        message = str(caught.exception)
        self.assertIn('"juergen"', message)
        self.assertIn("422", message)
        self.assertFalse(is_cascade_subject("juergen"))

    def test_the_six_subjects_name_five_cascade_subjects(self):
        subjects = [voice for voice in DEMO_VOICES if is_cascade_subject(voice)]
        self.assertEqual(
            subjects,
            ["anna", "lola", "estelle", "giovanni", "rafael"],
        )


class UnknownVoiceTests(unittest.TestCase):
    def test_a_voice_absent_from_the_table_is_refused_by_name(self):
        with self.assertRaises(UnknownVoiceError) as caught:
            bind_voice("ghost")
        self.assertIn('"ghost"', str(caught.exception))
        self.assertEqual(caught.exception.voice_id, "ghost")

    def test_an_absent_voice_is_not_a_cascade_subject(self):
        self.assertFalse(is_cascade_subject("ghost"))
        self.assertFalse(is_cascade_subject(""))


class ConflictTests(unittest.TestCase):
    def test_a_voice_claimed_for_two_locales_is_refused_by_name(self):
        declarations = [
            VoiceBinding("anna", Locale("en", "English")),
            VoiceBinding("anna", Locale("es", "Spanish")),
        ]
        with self.assertRaises(VoiceBindingConflictError) as caught:
            build_bindings(declarations)
        message = str(caught.exception)
        self.assertIn('"anna"', message)
        self.assertIn("en (English)", message)
        self.assertIn("es (Spanish)", message)

    def test_a_voice_claimed_twice_for_the_same_locale_is_refused(self):
        declarations = [
            VoiceBinding("anna", Locale("en", "English")),
            VoiceBinding("anna", Locale("en", "English")),
        ]
        with self.assertRaises(VoiceBindingConflictError):
            build_bindings(declarations)

    def test_a_clean_table_is_built(self):
        table = build_bindings(
            [
                VoiceBinding("lola", Locale("es", "Spanish")),
                VoiceBinding("estelle", Locale("fr", "French")),
            ]
        )
        self.assertEqual(sorted(table), ["estelle", "lola"])


class LanguageOverrideTests(unittest.TestCase):
    def test_a_request_language_cannot_override_the_binding(self):
        with self.assertRaises(LanguageOverrideError) as caught:
            bind_voice("anna", requested_language="Spanish")
        message = str(caught.exception)
        self.assertIn('"anna"', message)
        self.assertIn('"Spanish"', message)

    def test_a_request_language_that_agrees_is_accepted_without_changing_the_table(self):
        binding = bind_voice("lola", requested_language="es")
        self.assertEqual(binding.locale, Locale("es", "Spanish"))
        binding = bind_voice("lola", requested_language="Spanish")
        self.assertEqual(binding.locale, Locale("es", "Spanish"))

    def test_an_unbound_voice_is_refused_before_its_request_language_is_read(self):
        with self.assertRaises(UnboundVoiceError):
            bind_voice("juergen", requested_language="German")


class LocaleTests(unittest.TestCase):
    def test_an_invented_vendor_language_name_is_refused(self):
        with self.assertRaises(ValueError):
            Locale("es", "Castilian")


class CatalogueDriftTests(unittest.TestCase):
    def test_every_catalogue_voice_matches_the_binding_table(self):
        catalogue = _catalogue()
        self.assertTrue(catalogue, f"could not read VOICES from {VOICES_TS}")

        bound = {
            voice_id: (binding.language, binding.locale.code)
            for voice_id, binding in BINDINGS.items()
        }
        unbound = set(UNBOUND_VOICES)
        self.assertEqual(
            sorted(set(catalogue) - set(bound) - unbound),
            [],
            "a serving catalogue voice has no binding",
        )
        self.assertEqual(sorted(set(bound) | unbound), sorted(catalogue))

        for voice_id, (language, code) in bound.items():
            with self.subTest(voice=voice_id):
                self.assertEqual((language, code), catalogue[voice_id])

    def test_bindings_match_the_measured_locale_evidence(self):
        measured = _measured_locales()
        rows = {**BINDINGS, **UNBOUND_VOICES}
        for voice_id, row in rows.items():
            with self.subTest(voice=voice_id):
                self.assertIn(voice_id, measured)
                self.assertEqual(row.locale.code, measured[voice_id])
        self.assertEqual(
            UNBOUND_VOICES["juergen"].locale,
            Locale("de", "German"),
            "German stays open with its Locale recorded, not silently dropped",
        )


if __name__ == "__main__":
    unittest.main()
