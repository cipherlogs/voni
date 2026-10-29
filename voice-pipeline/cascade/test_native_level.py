"""Native level: the cascade has no gain stage (W1 ticket 127).

Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point: level, clips, German
re-cast" — the cascade carries no ``output.volume``, no client gain and no
limiter; each voice's native level is its target. The managed path keeps
``output.volume`` until it retires.

The seams pinned here are the ones a level stage would have to pass through:

- the synthesis request's own query parameters (a volume/gain knob would be
  visible on the wire before any audio exists);
- the stored body adapter (``output.volume`` is managed-only, so it is
  *ignored and recorded*, never turned into a cascade setting);
- the clip/render record (a stage other than ``none`` fails by name);
- the measured level (the native level is read from the delivered bytes as
  rendered, never from a claimed number).

No test opens a socket or reads a key: the request URL is built from the
binding and transport tables, and the body adapter is pure.
"""

from __future__ import annotations

import struct
import unittest
from urllib.parse import parse_qs, urlparse

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.body_map import adapt_body
from cascade.clips import ClipError, ClipLevel, clip_plan_for, clip_record_problems, measure_wav
from cascade.native_level import (
    CASCADE_GAIN_STAGES,
    LEVEL_STAGE_KEYS,
    MANAGED_LEVEL_FIELD,
    NATIVE_GAIN_STAGE,
    LevelStageError,
    assert_native_stage,
    assert_no_level_stage,
    level_stage_keys,
)
from cascade.testing import ScriptedSocketFactory

API_KEY = "test-key"


def wav_from_pcm(pcm_bytes: bytes, *, sample_rate: int = 24000) -> bytes:
    """A standard PCM16 mono WAV around ``pcm_bytes``, assembled independently."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm_bytes),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm_bytes),
    )
    return header + pcm_bytes


def scaled_pcm(scale: int, samples: int = 2400) -> bytes:
    """A whole tone at one amplitude: a level stage changes ``scale``."""
    return b"".join(scale.to_bytes(2, "little", signed=True) for _ in range(samples))


class NativeStageContractTests(unittest.TestCase):
    def test_native_is_the_only_cascade_stage(self):
        self.assertEqual(NATIVE_GAIN_STAGE, "none")
        self.assertEqual(CASCADE_GAIN_STAGES, ("none",))

    def test_a_native_stage_is_accepted(self):
        self.assertEqual(assert_native_stage("none", where="clip"), "none")

    def test_any_other_stage_fails_by_name(self):
        for stage in ("normalised", "limiter", "gain", "output.volume"):
            with self.assertRaises(LevelStageError) as caught:
                assert_native_stage(stage, where='clip "anna"')
            message = str(caught.exception)
            self.assertIn(stage, message)
            self.assertIn('clip "anna"', message)
            self.assertIn("no output.volume, no gain, no limiter", message)

    def test_the_managed_level_field_is_named_but_not_a_cascade_key(self):
        self.assertEqual(MANAGED_LEVEL_FIELD, "output.volume")
        self.assertNotIn("output.volume", LEVEL_STAGE_KEYS)


class ManagedVolumeIsManagedOnlyTests(unittest.TestCase):
    """The stored body may carry a volume; the cascade must not read it."""

    def body(self, **output: object) -> dict:
        return {
            "system_prompt": "You are Voni.",
            "greeting": "Hola.",
            "voice": {"voice_id": "lola"},
            "input": {"language_codes": ["es"]},
            "output": {"voice": "lola", **output},
            "tools": [],
            "llm": [],
        }

    def test_output_volume_is_ignored_and_recorded(self):
        adapted = adapt_body(self.body(volume=62))

        self.assertFalse(hasattr(adapted, "volume"), "the cascade body carries no level")
        ignored = {entry.path: entry for entry in adapted.ignored}
        self.assertIn(MANAGED_LEVEL_FIELD, ignored)
        self.assertEqual(ignored[MANAGED_LEVEL_FIELD].value, 62)
        self.assertIn("managed-only", ignored[MANAGED_LEVEL_FIELD].reason)
        self.assertIn("no gain stage", ignored[MANAGED_LEVEL_FIELD].reason)

    def test_the_cascade_body_is_identical_with_and_without_the_managed_volume(self):
        with_volume = adapt_body(self.body(volume=62))
        without = adapt_body(self.body())

        self.assertEqual(with_volume.voice, without.voice)
        self.assertEqual(with_volume.greeting, without.greeting)
        self.assertEqual(with_volume.system_prompt, without.system_prompt)
        self.assertEqual(with_volume.language_code, "es")


class SynthesisRequestHasNoLevelStageTests(unittest.TestCase):
    """A gain stage would have to appear in the request before any audio."""

    def request_parameters(self) -> dict[str, list[str]]:
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=ScriptedSocketFactory([]),
        )
        return parse_qs(urlparse(tts.url).query)

    def test_the_synthesis_request_carries_no_level_knob(self):
        parameters = self.request_parameters()

        self.assertEqual(level_stage_keys(parameters), ())
        assert_no_level_stage(parameters, where="synthesis request")
        # The request is not empty: it names the voice, language and format.
        self.assertEqual(parameters["voice_id"], ["anna"])
        self.assertEqual(parameters["language"], ["English"])
        self.assertEqual(parameters["sample_rate"], ["24000"])
        self.assertEqual(parameters["encoding"], ["pcm_s16le"])

    def test_a_level_knob_on_the_request_fails_by_name(self):
        parameters = {**self.request_parameters(), "volume": ["90"]}

        with self.assertRaises(LevelStageError) as caught:
            assert_no_level_stage(parameters, where="synthesis request")

        self.assertIn("volume", str(caught.exception))
        self.assertIn("synthesis request", str(caught.exception))

    def test_a_gain_stage_smuggled_into_the_request_is_named(self):
        for key in ("gain", "limiter", "normalisation", "normalization", "loudness"):
            with self.assertRaises(LevelStageError) as caught:
                assert_no_level_stage({"voice_id": "anna", key: 1}, where="synthesis request")
            self.assertIn(key, str(caught.exception))


class ClipRecordStageTests(unittest.TestCase):
    """A clip's record declares its stage; anything but native fails by name."""

    def test_the_plan_is_native_and_a_gain_stage_fails_the_gate(self):
        plan = clip_plan_for("lola")
        self.assertTrue(plan.bound)

        # The gate reads a full record; the fields that matter here are the
        # stage and the level, so a native record is built from the plan.
        record = make_record(plan, gain_stage="normalised")

        problems = clip_record_problems(plan, record)
        self.assertTrue(
            any("gain stage" in problem and "normalised" in problem for problem in problems),
            problems,
        )
        self.assertTrue(
            any("output.volume, gain, limiter or normalisation" in problem for problem in problems),
            problems,
        )

    def test_a_native_clip_record_has_no_stage_problem(self):
        plan = clip_plan_for("lola")
        record = make_record(plan, gain_stage=NATIVE_GAIN_STAGE)

        self.assertEqual(
            [problem for problem in clip_record_problems(plan, record) if "gain stage" in problem],
            [],
        )


class MeasuredLevelIsNativeTests(unittest.TestCase):
    """The level is read from the bytes; a gain stage moves it."""

    def test_the_measured_level_is_the_rendered_bytes_level(self):
        native = measure_wav(wav_from_pcm(scaled_pcm(1000)))
        doubled = measure_wav(wav_from_pcm(scaled_pcm(2000)))

        self.assertIsInstance(native, ClipLevel)
        self.assertAlmostEqual(doubled.sample_peak_dbfs - native.sample_peak_dbfs, 6.0206, places=3)
        self.assertAlmostEqual(doubled.rms_dbfs - native.rms_dbfs, 6.0206, places=3)

    def test_a_silent_render_is_refused_not_measured_as_a_level(self):
        with self.assertRaises(ClipError) as caught:
            measure_wav(wav_from_pcm(scaled_pcm(0)))
        self.assertIn("silent", str(caught.exception))

    def test_a_negative_pcm_stage_reads_as_a_level_difference(self):
        native = measure_wav(wav_from_pcm(scaled_pcm(1000)))
        attenuated = measure_wav(wav_from_pcm(scaled_pcm(500)))

        self.assertAlmostEqual(native.rms_dbfs - attenuated.rms_dbfs, 6.0206, places=3)


def make_record(plan, *, gain_stage: str):
    """A complete clip record for ``plan`` at native level."""
    from cascade.clips import clip_format

    return type(
        "ClipRecord",
        (),
        {
            "voice": plan.voice_id,
            "locale": plan.locale,
            "language": plan.language,
            "line": plan.greeting,
            "line_sha256": _line_sha(plan.greeting),
            "asset": plan.asset,
            "sha256": "0" * 64,
            "audio_bytes": 4800,
            "duration_ms": 100,
            "format": clip_format().to_document(),
            "endpoint": {"url": _tts_url(), "model": _tts_model()},
            "level": ClipLevel(sample_peak_dbfs=-20.0, rms_dbfs=-23.0),
            "gain_stage": gain_stage,
            "generated_on": "2026-10-30",
        },
    )()


def _line_sha(text: str) -> str:
    from cascade.clips import line_sha256

    return line_sha256(text)


def _tts_url() -> str:
    from cascade.assemblyai_tts import TTS_BASE_URL

    return TTS_BASE_URL


def _tts_model() -> str:
    from cascade.assemblyai_tts import MODEL_ID

    return MODEL_ID


if __name__ == "__main__":
    unittest.main()
