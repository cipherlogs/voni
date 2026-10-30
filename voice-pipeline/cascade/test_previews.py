"""Previews are the cascade clips, checked by the same clip gate (ticket 132).

Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point" — previews are generated
from the synthesis endpoint at native level and covered by the clip test. A
preview that does not match its voice's Locale and level fails. The
`voice-preview` route's old "AssemblyAI offers no standalone TTS" claim is
wrong; this module pins the corrected contract.

A preview is not a second kind of audio. It is the clip the picker plays: the
same asset `cascade/clips.py` renders from the call's own synthesis endpoint
and binding table, recorded in the same manifest and audited by the same
:func:`cascade.clips.audit_manifest`. These tests exercise that one gate from
the preview side:

- every bound demo voice has exactly one preview URL under `/voices/cascade`;
- the chosen German voice (`jorg`) has its own preview, and the retired
  `juergen` is not a preview subject;
- a preview file that is on disk but not in the manifest fails by name;
- a preview whose bytes were edited is stale against its hash, named;
- a preview in another Locale fails by name;
- a gained preview fails on its level: the preview level is native;
- the app's preview prefix and the Python plan agree, so the two cannot drift.

The managed path's `public/voices/<voice>.mp3` is untouched: a cascade preview
is a new native render, never a silent swap of the managed picker asset.
"""

from __future__ import annotations

import hashlib
import re
import struct
import tempfile
import unittest
from pathlib import Path

from cascade.assemblyai_tts import MODEL_ID, TTS_BASE_URL
from cascade.clips import (
    CLIP_ASSET_DIR,
    PREVIEW_URL_PREFIX,
    ClipError,
    ClipRecord,
    audit_manifest,
    clip_format,
    clip_plan,
    clip_plan_for,
    manifest_document,
    measure_wav,
    preview_url,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
APP_PREVIEW_TS = REPO_ROOT / "voni/src/lib/voice/preview.ts"

SAMPLE_RATE = 24000


def wav_bytes(pcm_bytes: bytes, *, sample_rate: int = SAMPLE_RATE) -> bytes:
    """The standard 44-byte-header PCM16 mono WAV, assembled independently."""
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


def pcm_bytes(gain: int = 1) -> bytes:
    """A short deterministic PCM16 tone: one amplitude, so a gain is visible."""
    values = (1000, -1000, 800, -800) * 100
    return b"".join(
        int(max(-32768, min(32767, value * gain))).to_bytes(2, "little", signed=True)
        for value in values
    )


def preview_record(root: Path, plan, *, gain: int = 1) -> ClipRecord:
    """One committed preview built independently of the writer."""
    if plan.asset is None:
        raise AssertionError(f"{plan.voice_id} is open and has no preview")
    data = pcm_bytes(gain)
    wav = wav_bytes(data)
    path = root / plan.asset
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav)
    return ClipRecord(
        voice=plan.voice_id,
        locale=plan.locale,
        language=plan.language,
        line=plan.greeting,
        line_sha256=hashlib.sha256(plan.greeting.encode()).hexdigest(),
        asset=plan.asset,
        sha256=hashlib.sha256(wav).hexdigest(),
        audio_bytes=len(data),
        duration_ms=round(len(data) / 2 / SAMPLE_RATE * 1000),
        format=clip_format().to_document(),
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        level=measure_wav(wav),
        gain_stage="none",
        generated_on="2026-10-30",
    )


def bound_plans():
    return [plan for plan in clip_plan() if plan.bound]


class PreviewCoverageTests(unittest.TestCase):
    def test_every_bound_demo_voice_has_one_native_preview(self):
        for plan in bound_plans():
            self.assertEqual(f"/voices/cascade/{plan.voice_id}.wav", plan.preview)
            self.assertEqual(preview_url(plan.voice_id), plan.preview)
        self.assertEqual(PREVIEW_URL_PREFIX, "/voices/cascade")

    def test_the_german_voice_has_its_own_preview(self):
        plan = clip_plan_for("jorg")

        self.assertTrue(plan.bound)
        self.assertEqual("/voices/cascade/jorg.wav", plan.preview)
        self.assertEqual("voni/public/voices/cascade/jorg.wav", plan.asset)

    def test_the_retired_german_id_is_not_a_preview_subject(self):
        with self.assertRaises(ClipError) as raised:
            clip_plan_for("juergen")

        self.assertIn('"juergen" is not a demo subject', str(raised.exception))

    def test_the_cascade_preview_is_not_the_managed_picker_asset(self):
        preview = preview_url("anna")

        self.assertEqual("/voices/cascade/anna.wav", preview)
        self.assertNotEqual("/voices/anna.mp3", preview)
        self.assertEqual("voni/public/voices/cascade", CLIP_ASSET_DIR)
        self.assertNotEqual("voni/public/voices", CLIP_ASSET_DIR)

    def test_the_app_preview_prefix_is_the_plan_prefix(self):
        source = APP_PREVIEW_TS.read_text(encoding="utf-8")
        match = re.search(r'CASCADE_PREVIEW_PREFIX\s*=\s*"([^"]+)"', source)
        self.assertIsNotNone(match, "preview.ts declares CASCADE_PREVIEW_PREFIX")
        self.assertEqual(PREVIEW_URL_PREFIX, match.group(1))


class ManifestPreviewAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cascade-previews-")
        self.root = Path(self.temp.name)
        self.plans = bound_plans()
        self.records = [preview_record(self.root, plan) for plan in self.plans]
        self.manifest = manifest_document(self.records, generated_on="2026-10-30")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def audit(self, manifest=None):
        return audit_manifest(manifest or self.manifest, asset_root=self.root)

    def test_every_preview_is_in_the_manifest_and_the_gate_passes(self):
        audit = self.audit()

        self.assertTrue(audit.ok, audit.problems)
        self.assertEqual(len(self.plans), audit.clip_count)
        self.assertEqual(PREVIEW_URL_PREFIX, self.manifest["previewBase"])
        for row in self.manifest["clips"]:
            self.assertEqual(f"/voices/cascade/{row['voice']}.wav", row["preview"])

    def test_a_preview_not_in_the_manifest_fails_by_name(self):
        orphan = self.root / CLIP_ASSET_DIR / "estelle.wav"
        # Drop estelle's row while keeping her committed preview on disk.
        manifest = {
            **self.manifest,
            "clips": [row for row in self.manifest["clips"] if row["voice"] != "estelle"],
        }

        problems = self.audit(manifest).problems

        self.assertTrue(
            any(str(orphan.relative_to(self.root)) in problem and "not in the manifest" in problem
                for problem in problems),
            problems,
        )
        self.assertTrue(any("estelle" in problem for problem in problems), problems)

    def test_a_stale_preview_fails_against_its_hash(self):
        path = self.root / CLIP_ASSET_DIR / "anna.wav"
        path.write_bytes(path.read_bytes() + b"\0\0")

        problems = self.audit().problems

        self.assertTrue(
            any("anna.wav sha256" in problem and "edited or swapped" in problem for problem in problems),
            problems,
        )

    def test_a_preview_in_another_locale_fails_by_name(self):
        manifest = {
            **self.manifest,
            "clips": [
                {**row, "locale": "en"} if row["voice"] == "lola" else row
                for row in self.manifest["clips"]
            ],
        }

        problems = self.audit(manifest).problems

        self.assertTrue(
            any("lola" in problem and "not the voice's own Locale es" in problem for problem in problems),
            problems,
        )

    def test_the_preview_level_is_native(self):
        # A gained file with a refreshed hash: the level leg must catch it even
        # though the bytes now agree with the record's sha256.
        path = self.root / CLIP_ASSET_DIR / "lola.wav"
        recorded = next(
            row["level"]["samplePeakDbfs"]
            for row in self.manifest["clips"]
            if row["voice"] == "lola"
        )
        gained = wav_bytes(pcm_bytes(2))
        path.write_bytes(gained)
        gained_level = measure_wav(gained)
        manifest = {
            **self.manifest,
            "clips": [
                {
                    **row,
                    "sha256": hashlib.sha256(gained).hexdigest(),
                }
                if row["voice"] == "lola"
                else row
                for row in self.manifest["clips"]
            ],
        }

        self.assertGreater(gained_level.sample_peak_dbfs, recorded)

        problems = self.audit(manifest).problems

        self.assertTrue(
            any("lola.wav measures" in problem and "a level stage moved it" in problem for problem in problems),
            problems,
        )

    def test_a_preview_url_that_is_not_the_voices_own_fails_by_name(self):
        manifest = {
            **self.manifest,
            "clips": [
                {**row, "preview": "/voices/cascade/lola.wav"} if row["voice"] == "anna" else row
                for row in self.manifest["clips"]
            ],
        }

        problems = self.audit(manifest).problems

        self.assertTrue(
            any("anna" in problem and "preview" in problem and "lola.wav" in problem for problem in problems),
            problems,
        )

    def test_a_manifest_with_another_preview_base_fails_by_name(self):
        problems = self.audit({**self.manifest, "previewBase": "/voices"}).problems

        self.assertTrue(
            any("previewBase" in problem and "cascade" in problem for problem in problems),
            problems,
        )


if __name__ == "__main__":
    unittest.main()
