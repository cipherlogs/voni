"""W1 clip regeneration and vendor determinism (ticket 129).

Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point" — the PR test replays a
recorded synthesis fixture and compares the clip's binding, Locale, text, format
and measured level. Byte identity is required only if this ticket measures the
vendor render as deterministic; a voice/locale/level/format difference always
fails. A live regeneration is key-gated and recorded as evidence, never a
silent asset swap.

Seams pinned here:

- the **recorded fixture** (`cascade/fixtures/clips/*.json`): Begin echo, audio
  frames and their FlushDone maths for one clip line. Its PCM and level are
  pinned, so a changed frame fails by fixture name.
- the **replay** through the call's own client
  (:class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS`) and binding table,
  over the ticket-01 scripted socket: no key, no network, no sleep.
- the **comparison** (`regeneration_problems`): binding, Locale, vendor
  language, text, endpoint, format and measured level, plus the byte pin only
  when determinism was measured.

The fixture's PCM is repeated-sample tokens, not recorded speech: the contract
under test is the regeneration identity, not the timbre (a new voice is
auditioned in W2, ticket 133). No test writes into `public/voices`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from cascade.assemblyai_tts import MODEL_ID, TTS_BASE_URL
from cascade.clip_regeneration import (
    FIXTURE_DIR,
    ClipFixtureError,
    ClipRegenerationError,
    RegeneratedClip,
    determinism_for,
    live_regeneration_blocker,
    load_fixture,
    measure_determinism,
    regenerate,
    regenerate_live,
    regeneration_document,
    regeneration_problems,
)
from cascade.clips import (
    ClipLevel,
    clip_format,
    clip_plan_for,
    line_sha256,
    manifest_document,
    measure_wav,
    wav_sha256,
)
from cascade.reference_render import WAV_HEADER_BYTES, pcm16_wav
from cascade.testing import FakeClock

#: Every fixture on disk must be replayed by a named test: a new recording
#: cannot be dropped silently.
EXERCISED = ("anna-en",)

API_KEY_ENV = "ASSEMBLYAI_API_KEY"


def wav_pcm(wav: bytes) -> bytes:
    return wav[WAV_HEADER_BYTES:]


def swapped_pcm(wav: bytes) -> bytes:
    """The same samples in another order: a byte difference, an identical level."""
    pcm = bytearray(wav_pcm(wav))
    pcm[0:2], pcm[2:4] = pcm[2:4], pcm[0:2]
    return bytes(pcm)


def replay(name: str, *, plan=None) -> RegeneratedClip:
    """Replay one fixture into a fresh directory, as the PR test does."""
    fixture = load_fixture(name)
    voice_plan = plan or clip_plan_for(fixture.voice)
    with tempfile.TemporaryDirectory(prefix="clip-regeneration-") as directory:
        return asyncio.run(
            regenerate(
                voice_plan,
                fixture,
                out_dir=directory,
                clock=FakeClock(0.0),
            )
        )


class FixtureReplayTests(unittest.TestCase):
    def test_the_recorded_fixture_replays_through_the_calls_own_client(self):
        fixture = load_fixture("anna-en")
        regenerated = replay("anna-en")

        self.assertEqual(regenerated.fixture.name, "anna-en")
        self.assertEqual(regenerated.record.voice, fixture.voice)
        self.assertEqual(regenerated.record.locale, fixture.locale)
        self.assertEqual(regenerated.record.language, fixture.language)
        self.assertEqual(regenerated.record.line, fixture.text)
        self.assertEqual(regenerated.record.format, clip_format().to_document())
        # The client sent one Generate+Flush per scheduled sentence, so the
        # replay really drove the call's scheduler rather than copying bytes.
        kinds = [frame["type"] for frame in regenerated.sent]
        self.assertEqual(kinds[:2], ["Generate", "Flush"])
        self.assertEqual(kinds.count("Generate"), 3)
        self.assertEqual(kinds.count("Flush"), 3)

    def test_the_regenerated_bytes_are_the_fixtures_pinned_bytes(self):
        fixture = load_fixture("anna-en")
        regenerated = replay("anna-en")

        self.assertEqual(regenerated.pcm_sha256, fixture.pcm_sha256)
        self.assertEqual(regenerated.record.sha256, fixture.wav_sha256)
        self.assertEqual(regenerated.level.to_document(), fixture.level.to_document())
        self.assertEqual(regenerated.record.gain_stage, "none")

    def test_the_regeneration_matches_the_plan_and_builds_a_clean_manifest(self):
        fixture = load_fixture("anna-en")
        plan = clip_plan_for(fixture.voice)
        regenerated = replay("anna-en")

        self.assertEqual(
            regeneration_problems(plan, fixture, regenerated, byte_identity_required=True),
            [],
        )
        document = manifest_document([regenerated.record], generated_on="2026-10-30")
        row = next(clip for clip in document["clips"] if clip["voice"] == fixture.voice)
        self.assertEqual(row["sha256"], fixture.wav_sha256)
        self.assertEqual(row["gainStage"], "none")

    def test_a_fixture_without_its_recording_fails_by_name(self):
        with self.assertRaises(ClipFixtureError) as caught:
            load_fixture("no-such-fixture")
        self.assertIn("no-such-fixture", str(caught.exception))

    def test_every_recorded_clip_fixture_is_exercised(self):
        on_disk = {path.stem for path in FIXTURE_DIR.glob("*.json")}
        self.assertEqual(on_disk, set(EXERCISED), sorted(on_disk ^ set(EXERCISED)))


class VendorDeterminismTests(unittest.TestCase):
    def test_determinism_is_measured_not_assumed(self):
        first = replay("anna-en")
        second = replay("anna-en")

        measurement = measure_determinism((first, second))
        self.assertEqual(measurement.render_count, 2)
        self.assertTrue(measurement.byte_identical)
        self.assertEqual(first.pcm_sha256, second.pcm_sha256)

        # Only a measured deterministic render demands byte identity.
        fixture = load_fixture("anna-en")
        self.assertTrue(determinism_for((first, second)))
        self.assertEqual(
            regeneration_problems(
                clip_plan_for(fixture.voice), fixture, second, byte_identity_required=True
            ),
            [],
        )

    def test_a_byte_difference_with_matching_binding_and_level_is_not_a_failure(self):
        fixture = load_fixture("anna-en")
        plan = clip_plan_for(fixture.voice)
        regenerated = replay("anna-en")

        # Same samples, another order: a different file with the same voice,
        # Locale, text, format and measured level.
        pcm = swapped_pcm(regenerated.wav)
        alternate = replace(
            regenerated,
            wav=pcm16_wav(pcm, clip_format()),
            pcm_sha256=hashlib.sha256(pcm).hexdigest(),
            level=measure_wav(pcm16_wav(pcm, clip_format())),
            record=replace(
                regenerated.record,
                sha256=wav_sha256(pcm16_wav(pcm, clip_format())),
            ),
        )
        self.assertNotEqual(alternate.wav, regenerated.wav, "the bytes really differ")
        self.assertEqual(alternate.level.to_document(), regenerated.level.to_document())

        self.assertEqual(
            regeneration_problems(plan, fixture, alternate, byte_identity_required=False),
            [],
        )
        hash_problems = regeneration_problems(
            plan, fixture, alternate, byte_identity_required=True
        )
        self.assertTrue(
            any("sha256" in problem and "anna-en" in problem for problem in hash_problems),
            hash_problems,
        )


class IdentityDriftTests(unittest.TestCase):
    """A deliberate voice, locale, endpoint, text, format or level change fails."""

    def setUp(self) -> None:
        self.fixture = load_fixture("anna-en")
        self.plan = clip_plan_for(self.fixture.voice)
        self.regenerated = replay("anna-en")

    def problems(self, *, plan=None, fixture=None, regenerated=None, pinned=False):
        return regeneration_problems(
            plan or self.plan,
            fixture or self.fixture,
            regenerated or self.regenerated,
            byte_identity_required=pinned,
        )

    def test_a_changed_voice_fails_by_name(self):
        problems = self.problems(plan=clip_plan_for("lola"))
        self.assertTrue(any("binding" in problem and "lola" in problem for problem in problems), problems)

    def test_a_changed_locale_fails_by_name(self):
        problems = self.problems(fixture=replace(self.fixture, locale="es"))
        self.assertTrue(any("Locale" in problem for problem in problems), problems)

    def test_a_changed_vendor_language_fails_by_name(self):
        problems = self.problems(fixture=replace(self.fixture, language="Spanish"))
        self.assertTrue(any("language" in problem for problem in problems), problems)

    def test_a_changed_text_fails_by_name(self):
        problems = self.problems(fixture=replace(self.fixture, text="Hello! I am Voni."))
        self.assertTrue(any("line" in problem for problem in problems), problems)

    def test_a_changed_endpoint_fails_by_name(self):
        problems = self.problems(
            fixture=replace(
                self.fixture, endpoint={"url": "wss://example.invalid/v1/ws", "model": MODEL_ID}
            )
        )
        self.assertTrue(any("endpoint" in problem for problem in problems), problems)

    def test_a_changed_model_fails_by_name(self):
        problems = self.problems(fixture=replace(self.fixture, model="other-tts-9"))
        self.assertTrue(any("model" in problem for problem in problems), problems)

    def test_a_changed_format_fails_by_name(self):
        problems = self.problems(fixture=replace(self.fixture, format={**self.fixture.format, "sampleRate": 8000}))
        self.assertTrue(any("format" in problem for problem in problems), problems)

    def test_a_changed_level_fails_by_name(self):
        problems = self.problems(
            fixture=replace(
                self.fixture,
                level=ClipLevel(sample_peak_dbfs=-20.0, rms_dbfs=-20.0),
            )
        )
        self.assertTrue(any("level" in problem for problem in problems), problems)

    def test_the_text_hash_is_the_plants_greeting_hash(self):
        self.assertEqual(self.fixture.text_sha256, line_sha256(self.plan.greeting))


class KeyGateTests(unittest.TestCase):
    def test_no_key_is_a_named_blocker_and_no_audio_is_written(self):
        with patch.dict("os.environ", {}, clear=True):
            blocker = live_regeneration_blocker()
            self.assertIsNotNone(blocker)
            self.assertIn(API_KEY_ENV, blocker)
            self.assertIn("no clip is fabricated", blocker)

            with tempfile.TemporaryDirectory(prefix="live-clip-") as directory:
                with self.assertRaises(ClipRegenerationError) as caught:
                    asyncio.run(
                        regenerate_live(
                            clip_plan_for("anna"),
                            out_dir=directory,
                            generated_on="2026-10-30",
                        )
                    )
                self.assertIn(API_KEY_ENV, str(caught.exception))
                self.assertEqual(list(Path(directory).iterdir()), [], "no file was written")

    def test_a_keyed_live_regeneration_is_recorded_as_evidence(self):
        document = regeneration_document(
            self.fixture_plan(),
            replay("anna-en"),
            determinism=measure_determinism((replay("anna-en"), replay("anna-en"))),
            generated_on="2026-10-30",
        )

        self.assertEqual(document["voice"], "anna")
        self.assertEqual(document["locale"], "en")
        self.assertEqual(document["byteIdentityRequired"], True)
        self.assertEqual(document["sha256"], load_fixture("anna-en").wav_sha256)
        self.assertNotIn("pcm", document, "evidence carries facts, never audio bytes")

    def fixture_plan(self):
        return clip_plan_for("anna")


class FixtureDriftTests(unittest.TestCase):
    def test_a_fixture_whose_bytes_disagree_with_its_pin_fails_by_name(self):
        path = FIXTURE_DIR / "anna-en.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["expect"]["pcmSha256"] = "0" * 64
        with tempfile.TemporaryDirectory(prefix="drift-") as directory:
            drifted = Path(directory) / "anna-en.json"
            drifted.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(ClipFixtureError) as caught:
                load_fixture("anna-en", directory=directory)
        message = str(caught.exception)
        self.assertIn("anna-en", message)
        self.assertIn("pcmSha256", message)

    def test_an_unknown_fixture_field_fails_by_name(self):
        path = FIXTURE_DIR / "anna-en.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["vendor_extra"] = "not part of the fixture contract"
        with tempfile.TemporaryDirectory(prefix="drift-") as directory:
            drifted = Path(directory) / "anna-en.json"
            drifted.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(ClipFixtureError) as caught:
                load_fixture("anna-en", directory=directory)
        self.assertIn("anna-en", str(caught.exception))
        self.assertIn("vendor_extra", str(caught.exception))

    def test_a_fixture_naming_another_voice_than_its_file_is_refused(self):
        path = FIXTURE_DIR / "anna-en.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["voice"] = "lola"
        with tempfile.TemporaryDirectory(prefix="drift-") as directory:
            drifted = Path(directory) / "anna-en.json"
            drifted.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(ClipFixtureError) as caught:
                load_fixture("anna-en", directory=directory)
        self.assertIn("lola", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
