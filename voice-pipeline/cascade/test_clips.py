"""W1 clips: each demo voice's greeting, rendered by the call's own synthesis.

Seam: :mod:`cascade.clips` is the checked-in generator's plan, record and gate.
The render is exercised through the real call client
(:class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS`) over a scripted
synthesis socket, so the endpoint, the voice binding and the native format are
observed on the wire. No test opens a socket or needs a live key.

Independent expected values:

- the expected WAV bytes are assembled here from the recorded fixture PCM, not
  by calling the writer under test;
- the six demo voices and the six greetings are read from the app's own sources
  (``voni/src/lib/demo/voni-agent.ts``), so the plan cannot drift silently;
- the level is recomputed from the committed PCM here, so a record that claims
  a level its bytes do not have fails.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from cascade.assemblyai_tts import MODEL_ID, TTS_BASE_URL, schedule
from cascade.clips import (
    CLIP_GENERATOR_COMMAND,
    CLIP_LOCALES,
    CLIP_MANIFEST_PATH,
    CLIP_ASSET_DIR,
    DEMO_VOICE_IDS,
    ClipError,
    ClipLevel,
    ClipRecord,
    audit_manifest,
    clip_plan,
    clip_plan_for,
    clip_record_problems,
    manifest_document,
    render_all,
    render_clip,
)
from cascade.testing import FakeClock, ScriptedSocketFactory
from cascade.tts_support import (
    audio,
    begin,
    flush_done,
    pcm,
    pcm_ms,
    termination,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VONI_AGENT_TS = REPO_ROOT / "voni/src/lib/demo/voni-agent.ts"

API_KEY = "test-key"
SAMPLE_RATE = 24000
SENTENCE_MS = 120


def demo_voice_ids() -> list[str]:
    """The app's own demo subject list, read so drift is visible."""
    source = VONI_AGENT_TS.read_text(encoding="utf-8")
    match = re.search(r"DEMO_VOICE_IDS\s*=\s*\[([^\]]*)\]", source)
    assert match is not None, "DEMO_VOICE_IDS is not in voni-agent.ts"
    return re.findall(r'"([^"]+)"', match.group(1))


def greetings() -> dict[str, str]:
    """The app's own greeting table, read so drift is visible."""
    source = VONI_AGENT_TS.read_text(encoding="utf-8")
    match = re.search(r"VONI_GREETINGS[^=]*=\s*\{(.*?)\n\};", source, re.S)
    assert match is not None, "VONI_GREETINGS is not in voni-agent.ts"
    return dict(re.findall(r'(\w+):\s*"((?:[^"\\]|\\.)*)"', match.group(1)))


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


def plan_for(
    line: str, *, voice_id: str = "lola", language: str = "Spanish", sample: int = 1000
) -> tuple[list[str], bytes]:
    """Recorded frames for one rendered line, plus the PCM they carry."""
    frames = [begin(voice_id=voice_id, language=language)]
    chunks = schedule(line)
    pcm_bytes = b""
    for index in range(len(chunks)):
        chunk = pcm_ms(SENTENCE_MS, sample=sample + index)
        frames.append(audio(chunk, flush_id=index))
        frames.append(flush_done(flush_id=index, audio_duration_ms=SENTENCE_MS))
        pcm_bytes += chunk
    frames.append(termination(audio_duration_seconds=len(pcm_bytes) / 2 / SAMPLE_RATE))
    return frames, pcm_bytes


def sent(factory: ScriptedSocketFactory) -> list[dict]:
    socket = factory.socket
    assert socket is not None, "no socket was opened"
    return [json.loads(message) for message in socket.sent]


def fixture_record(root: Path, plan: ClipPlan) -> ClipRecord:
    """A committed clip built independently of the writer, for the audit seams."""
    wav = wav_bytes(pcm(1000, -1000, 800, -800))
    path = root / (plan.asset or "")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav)
    return ClipRecord(
        voice=plan.voice_id,
        locale=plan.locale,
        language=plan.language,
        line=plan.greeting,
        line_sha256=hashlib.sha256(plan.greeting.encode()).hexdigest(),
        asset=plan.asset or "",
        sha256=hashlib.sha256(wav).hexdigest(),
        audio_bytes=len(wav) - 44,
        duration_ms=round((len(wav) - 44) / 2 / 24000 * 1000),
        format={
            "transport": "browser",
            "container": "wav",
            "sampleRate": 24000,
            "encoding": "pcm_s16le",
            "channels": 1,
            "bitsPerSample": 16,
            "model": MODEL_ID,
        },
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        level=ClipLevel(_peak_dbfs(wav[44:]), _rms_dbfs(wav[44:])),
        gain_stage="none",
        generated_on="2026-10-29",
    )


def write_fixture_manifest(root: Path, records: list[ClipRecord]) -> dict:
    manifest = manifest_document(records, generated_on="2026-10-29")
    path = root / CLIP_MANIFEST_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


class ClipPlanTest(unittest.TestCase):
    def test_the_plan_is_the_six_demo_voices_each_in_its_own_locale(self):
        plan = clip_plan()

        self.assertEqual(demo_voice_ids(), [entry.voice_id for entry in plan])
        self.assertEqual(["en", "es", "fr", "de", "it", "pt"], [entry.locale for entry in plan])
        for entry in plan:
            self.assertEqual(greetings()[entry.locale], entry.greeting)
            self.assertEqual(entry.greeting, clip_plan_for(entry.voice_id).greeting)

    def test_the_german_voice_plans_jorg_in_its_own_locale(self):
        plan = clip_plan_for("jorg")

        self.assertEqual("de", plan.locale)
        self.assertEqual("German", plan.language)
        self.assertEqual("bound", plan.state)
        self.assertEqual("voni/public/voices/cascade/jorg.wav", plan.asset)
        self.assertEqual("/voices/cascade/jorg.wav", plan.preview)
        self.assertIsNone(plan.reason)

    def test_an_unbound_historical_voice_would_be_an_open_row_not_a_clip(self):
        # The demo has no open Locale today. The open-row mechanism is kept
        # honest by naming the retired German id as a subject: the binding table
        # still refuses it, so the plan is a named row with no asset.
        with patch("cascade.clips.DEMO_VOICE_IDS", (*DEMO_VOICE_IDS, "juergen")):
            plan = clip_plan_for("juergen")

        self.assertEqual("de", plan.locale)
        self.assertEqual("German", plan.language)
        self.assertEqual("open", plan.state)
        self.assertIsNone(plan.asset, "an open Locale has no clip asset")
        self.assertIn("juergen", plan.reason)
        self.assertIn("not bound", plan.reason)
        self.assertIn("German", plan.reason)

    def test_a_bound_voice_plans_its_own_asset_and_language(self):
        plan = clip_plan_for("lola")

        self.assertEqual("bound", plan.state)
        self.assertEqual("Spanish", plan.language)
        self.assertEqual("voni/public/voices/cascade/lola.wav", plan.asset)

    def test_the_plan_covers_all_six_spoken_locales(self):
        self.assertEqual(set(CLIP_LOCALES), {entry.locale for entry in clip_plan()})


class ClipRenderTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.clock = FakeClock(0.0)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_clip_is_the_voices_greeting_rendered_by_the_call_client(self):
        plan = clip_plan_for("lola")
        frames, pcm_bytes = plan_for(plan.greeting)
        factory = ScriptedSocketFactory(frames, clock=self.clock)

        record = asyncio.run(
            render_clip(
                plan,
                out_dir=self.root / "references",
                asset_root=self.root,
                api_key=API_KEY,
                socket_factory=factory,
                clock=self.clock,
                generated_on="2026-10-29",
            )
        )

        expected = wav_bytes(pcm_bytes)
        asset = self.root / (plan.asset or "")
        self.assertEqual(expected, asset.read_bytes(), "the clip is the synthesis bytes verbatim")
        self.assertEqual(hashlib.sha256(expected).hexdigest(), record.sha256)
        self.assertEqual("lola", record.voice)
        self.assertEqual("es", record.locale)
        self.assertEqual("Spanish", record.language)
        self.assertEqual(plan.greeting, record.line)
        self.assertEqual(hashlib.sha256(plan.greeting.encode()).hexdigest(), record.line_sha256)

        # The call's own endpoint and binding, on the wire.
        connection = factory.connections[0]
        self.assertIn(TTS_BASE_URL, connection["url"])
        self.assertIn("voice_id=aai-lola", connection["url"])
        self.assertIn("language=Spanish", connection["url"])
        self.assertIn("sample_rate=24000", connection["url"])
        self.assertIn("encoding=pcm_s16le", connection["url"])
        self.assertIn(f"model_id={MODEL_ID}", connection["url"])

        # One Generate per sentence, the greeting's own text and order.
        self.assertEqual(
            [frame["text"] for frame in sent(factory) if frame["type"] == "Generate"],
            list(schedule(plan.greeting)),
        )

    def test_the_record_pins_the_native_format_endpoint_and_level(self):
        plan = clip_plan_for("anna")
        frames, pcm_bytes = plan_for(plan.greeting, voice_id="anna", language="English")
        record = asyncio.run(
            render_clip(
                plan,
                out_dir=self.root / "references",
                asset_root=self.root,
                api_key=API_KEY,
                socket_factory=ScriptedSocketFactory(frames, clock=self.clock),
                clock=self.clock,
                generated_on="2026-10-29",
            )
        )

        self.assertEqual(
            {
                "transport": "browser",
                "container": "wav",
                "sampleRate": 24000,
                "encoding": "pcm_s16le",
                "channels": 1,
                "bitsPerSample": 16,
                "model": MODEL_ID,
            },
            record.format,
        )
        self.assertEqual({"url": TTS_BASE_URL, "model": MODEL_ID}, record.endpoint)
        self.assertEqual("none", record.gain_stage)

        # Recomputed here from the fixture PCM, independent of the writer.
        self.assertEqual(
            {
                "samplePeakDbfs": _peak_dbfs(pcm_bytes),
                "rmsDbfs": _rms_dbfs(pcm_bytes),
            },
            record.level.to_document(),
        )

    def test_an_open_locale_refuses_to_render_before_a_socket(self):
        factory = ScriptedSocketFactory([], clock=self.clock)

        with patch("cascade.clips.DEMO_VOICE_IDS", (*DEMO_VOICE_IDS, "juergen")):
            plan = clip_plan_for("juergen")
        with self.assertRaises(ClipError) as raised:
            asyncio.run(
                render_clip(
                    plan,
                    out_dir=self.root / "references",
                    asset_root=self.root,
                    api_key=API_KEY,
                    socket_factory=factory,
                    clock=self.clock,
                )
            )

        self.assertIn("juergen", str(raised.exception))
        self.assertIn("not bound", str(raised.exception))
        self.assertEqual([], factory.connections)

    def test_a_render_without_a_key_is_blocked_before_a_socket_or_a_file(self):
        plan = clip_plan_for("anna")
        with patch.dict(os.environ, {"ASSEMBLYAI_API_KEY": ""}):
            with self.assertRaises(ClipError) as raised:
                asyncio.run(
                    render_clip(
                        plan,
                        out_dir=self.root / "references",
                        asset_root=self.root,
                        api_key=None,
                        socket_factory=None,
                    )
                )

        self.assertIn("ASSEMBLYAI_API_KEY", str(raised.exception))
        self.assertFalse((self.root / (plan.asset or "")).exists())


def _peak_dbfs(pcm_bytes: bytes) -> float:
    samples = struct.unpack(f"<{len(pcm_bytes) // 2}h", pcm_bytes)
    peak = max(abs(sample) for sample in samples)
    return round(20 * math.log10(peak / 32768), 6)


def _rms_dbfs(pcm_bytes: bytes) -> float:
    samples = struct.unpack(f"<{len(pcm_bytes) // 2}h", pcm_bytes)
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    return round(20 * math.log10(math.sqrt(mean_square) / 32768), 6)


class RecordAuditTest(unittest.TestCase):
    """A record must describe its own plan, and never another voice's clip."""

    def setUp(self) -> None:
        self.plan = clip_plan_for("lola")
        self.record = ClipRecord(
            voice="lola",
            locale="es",
            language="Spanish",
            line=self.plan.greeting,
            line_sha256=hashlib.sha256(self.plan.greeting.encode()).hexdigest(),
            asset="voni/public/voices/cascade/lola.wav",
            sha256="0" * 64,
            audio_bytes=480,
            duration_ms=10,
            format={
                "transport": "browser",
                "container": "wav",
                "sampleRate": 24000,
                "encoding": "pcm_s16le",
                "channels": 1,
                "bitsPerSample": 16,
                "model": MODEL_ID,
            },
            endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
            level=ClipLevel(-30.29, -30.30),
            gain_stage="none",
            generated_on="2026-10-29",
        )

    def replace(self, **changes) -> ClipRecord:
        return replace(self.record, **changes)

    def test_a_matching_record_has_no_problems(self):
        self.assertEqual([], clip_record_problems(self.plan, self.record))

    def test_a_clip_sourced_from_another_voice_fails(self):
        problems = clip_record_problems(self.plan, self.replace(voice="anna"))
        self.assertTrue(any("anna" in problem and "lola" in problem for problem in problems))

    def test_a_clip_speaking_another_locale_fails(self):
        problems = clip_record_problems(self.plan, self.replace(locale="en"))
        self.assertTrue(any("en" in problem and "es" in problem for problem in problems))

    def test_a_clip_speaking_a_different_line_fails(self):
        problems = clip_record_problems(self.plan, self.replace(line="Hello there."))
        self.assertTrue(any("line" in problem or "greeting" in problem for problem in problems))

    def test_a_clip_whose_line_hash_is_not_the_greeting_fails(self):
        problems = clip_record_problems(self.plan, self.replace(line_sha256="f" * 64))
        self.assertTrue(any("hash" in problem for problem in problems))

    def test_a_clip_in_another_format_fails(self):
        format_ = dict(self.record.format, sampleRate=16000)
        problems = clip_record_problems(self.plan, self.replace(format=format_))
        self.assertTrue(any("16000" in problem for problem in problems))

    def test_a_clip_from_another_endpoint_or_model_fails(self):
        endpoint = {"url": TTS_BASE_URL, "model": "another-tts-9"}
        problems = clip_record_problems(self.plan, self.replace(endpoint=endpoint))
        self.assertTrue(any("another-tts-9" in problem for problem in problems))

    def test_a_clip_with_a_gain_stage_fails(self):
        problems = clip_record_problems(self.plan, self.replace(gain_stage="normalised"))
        self.assertTrue(any("gain" in problem for problem in problems))

    def test_an_unmeasured_level_fails(self):
        problems = clip_record_problems(self.plan, self.replace(level=ClipLevel(float("nan"), -30.0)))
        self.assertTrue(any("level" in problem for problem in problems))


class ManifestAuditTest(unittest.TestCase):
    """The committed record is auditable without a key: plan, bytes, level."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.clock = FakeClock(0.0)
        self.wav = wav_bytes(pcm(1000, -1000, 800, -800))
        self.clips = [fixture_record(self.root, plan) for plan in clip_plan() if plan.bound]

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def manifest(self, clips: list[ClipRecord] | None = None) -> dict:
        return manifest_document(
            self.clips if clips is None else clips, generated_on="2026-10-29"
        )

    def test_the_manifest_pins_endpoint_model_voice_language_line_hashes_and_level(self):
        manifest = self.manifest()

        self.assertEqual(
            {"url": TTS_BASE_URL, "model": MODEL_ID}, manifest["endpoint"]
        )
        self.assertEqual("none", manifest["gainStage"])
        self.assertEqual(MODEL_ID, manifest["format"]["model"])
        self.assertEqual(24000, manifest["format"]["sampleRate"])
        self.assertEqual(
            ["anna", "lola", "estelle", "jorg", "giovanni", "rafael"],
            [clip["voice"] for clip in manifest["clips"]],
        )
        for clip, plan in zip(manifest["clips"], [p for p in clip_plan() if p.bound]):
            self.assertEqual(plan.locale, clip["locale"])
            self.assertEqual(plan.language, clip["language"])
            self.assertEqual(plan.greeting, clip["line"])
            self.assertEqual(hashlib.sha256(plan.greeting.encode()).hexdigest(), clip["lineSha256"])
            self.assertEqual(hashlib.sha256(self.wav).hexdigest(), clip["sha256"])
            self.assertEqual({"url": TTS_BASE_URL, "model": MODEL_ID}, clip["endpoint"])
            self.assertEqual("none", clip["gainStage"])
            self.assertIn("samplePeakDbfs", clip["level"])

    def test_the_manifest_has_no_open_locale_because_german_is_bound(self):
        manifest = self.manifest()
        self.assertEqual([], manifest["open"])
        german = next(clip for clip in manifest["clips"] if clip["voice"] == "jorg")
        self.assertEqual("de", german["locale"])
        self.assertEqual("German", german["language"])

    def test_a_matching_manifest_and_assets_audit_clean(self):
        audit = audit_manifest(self.manifest(), asset_root=self.root)

        self.assertEqual((), audit.problems)
        self.assertEqual(6, audit.clip_count)
        self.assertEqual(0, audit.open_count)

    def test_a_bound_voice_with_no_clip_fails(self):
        audit = audit_manifest(self.manifest(self.clips[1:]), asset_root=self.root)
        self.assertTrue(any("anna" in problem and "no clip" in problem for problem in audit.problems))

    def test_a_missing_asset_fails(self):
        (self.root / (self.clips[1].asset)).unlink()
        audit = audit_manifest(self.manifest(), asset_root=self.root)
        self.assertTrue(any("lola" in problem and "not committed" in problem for problem in audit.problems))

    def test_a_hand_edited_asset_fails_on_its_hash_and_level(self):
        path = self.root / self.clips[0].asset
        amplified = bytearray(path.read_bytes())
        samples = struct.unpack(f"<{len(amplified[44:]) // 2}h", amplified[44:])
        doubled = struct.pack(f"<{len(samples)}h", *(min(32767, s * 2) for s in samples))
        path.write_bytes(bytes(amplified[:44]) + doubled)

        audit = audit_manifest(self.manifest(), asset_root=self.root)

        self.assertTrue(any("anna" in problem and "sha256" in problem for problem in audit.problems))
        self.assertTrue(any("anna" in problem and "level" in problem for problem in audit.problems))

    def test_a_clip_for_the_retired_german_id_fails(self):
        # The lie the gate exists for: an id that is no longer a demo subject is
        # dressed as another voice's clip.
        forged = replace(
            fixture_record(self.root, clip_plan_for("estelle")), voice="juergen", locale="de"
        )
        manifest = self.manifest()
        manifest["clips"].append(forged.to_document())
        audit = audit_manifest(manifest, asset_root=self.root)

        self.assertTrue(
            any("juergen" in problem and "six demo voices" in problem for problem in audit.problems)
        )

    def test_a_clip_for_a_voice_outside_the_demo_fails(self):
        alien = replace(
            fixture_record(self.root, clip_plan_for("anna")),
            voice="alba",
            asset="voni/public/voices/cascade/alba.wav",
        )
        manifest = self.manifest()
        manifest["clips"].append(alien.to_document())
        audit = audit_manifest(manifest, asset_root=self.root)
        self.assertTrue(any("alba" in problem for problem in audit.problems))

    def test_the_producer_refuses_a_clip_for_a_voice_outside_the_demo(self):
        alien = replace(
            fixture_record(self.root, clip_plan_for("anna")),
            voice="alba",
            asset="voni/public/voices/cascade/alba.wav",
        )
        with self.assertRaises(ClipError):
            manifest_document([*self.clips, alien], generated_on="2026-10-29")

    def test_a_manifest_with_another_endpoint_fails(self):
        manifest = self.manifest()
        manifest["endpoint"] = {"url": "wss://example.invalid/v1/ws", "model": MODEL_ID}
        audit = audit_manifest(manifest, asset_root=self.root)
        self.assertTrue(any("endpoint" in problem for problem in audit.problems))

    def test_a_named_blocker_replaces_a_clip_and_keeps_no_asset(self):
        manifest = self.manifest(self.clips[1:])
        manifest["blockers"] = [
            {
                "voice": "anna",
                "locale": "en",
                "reason": "ASSEMBLYAI_API_KEY is not configured",
                "command": f"{CLIP_GENERATOR_COMMAND} --voice anna",
            }
        ]
        (self.root / self.clips[0].asset).unlink()

        audit = audit_manifest(manifest, asset_root=self.root)

        self.assertEqual((), audit.problems)
        self.assertEqual(1, audit.blocker_count)

    def test_a_blocker_with_no_reason_or_a_stale_asset_fails(self):
        manifest = self.manifest(self.clips[1:])
        manifest["blockers"] = [
            {
                "voice": "anna",
                "locale": "en",
                "reason": "  ",
                "command": f"{CLIP_GENERATOR_COMMAND} --voice anna",
            }
        ]
        audit = audit_manifest(manifest, asset_root=self.root)
        self.assertTrue(any("anna" in problem and "reason" in problem for problem in audit.problems))


class RenderPlanTest(unittest.TestCase):
    """The producer is authoritative: no key, no audio; a failure, no stale file."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_api_key_is_a_named_blocker_and_nothing_is_rendered(self):
        calls: list[str] = []

        async def fake(plan: ClipPlan, **kwargs):
            calls.append(plan.voice_id)
            raise AssertionError("a renderer must not run without a key")

        with self.assertRaises(ClipError) as raised:
            with patch.dict(os.environ, {"ASSEMBLYAI_API_KEY": ""}):
                asyncio.run(
                    render_all(
                        self.root,
                        out_dir=self.root / "references",
                        api_key=None,
                        socket_factory=None,
                        render=fake,
                    )
                )

        self.assertIn("ASSEMBLYAI_API_KEY", str(raised.exception))
        self.assertEqual([], calls)
        self.assertFalse((self.root / CLIP_MANIFEST_PATH).exists())
        self.assertEqual([], list(self.root.glob(f"{CLIP_ASSET_DIR}/*.wav")))

    def test_a_voice_that_fails_is_a_named_blocker_with_no_stale_asset(self):
        stale = self.root / CLIP_ASSET_DIR / "lola.wav"
        stale.parent.mkdir(parents=True)
        stale.write_bytes(b"stale audio from an earlier run")

        async def fake(plan: ClipPlan, **kwargs):
            if plan.voice_id == "lola":
                raise ClipError("vendor refused: 422 voice_not_found")
            return fixture_record(self.root, plan)

        records, blockers = asyncio.run(
            render_all(
                self.root,
                out_dir=self.root / "references",
                api_key="test-key",
                socket_factory=object(),
                render=fake,
            )
        )

        self.assertEqual(
            ["anna", "estelle", "jorg", "giovanni", "rafael"], [r.voice for r in records]
        )
        self.assertEqual(["lola"], [b.voice for b in blockers])
        self.assertIn("422", blockers[0].reason)
        self.assertIn("--voice lola", blockers[0].command)
        self.assertFalse(stale.exists(), "a failed voice must not keep a stale clip")

    def test_the_retired_german_ids_old_asset_is_retired(self):
        old = self.root / CLIP_ASSET_DIR / "juergen.wav"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"hand-captured audio that must not survive")

        async def fake(plan: ClipPlan, **kwargs):
            return fixture_record(self.root, plan)

        records, blockers = asyncio.run(
            render_all(
                self.root,
                out_dir=self.root / "references",
                api_key="test-key",
                socket_factory=object(),
                render=fake,
            )
        )

        self.assertNotIn("juergen", [r.voice for r in records])
        self.assertIn("jorg", [r.voice for r in records])
        self.assertFalse(old.exists(), "an id outside the demo keeps no clip")
        self.assertEqual([], blockers, "a retired id is not a demo subject, not a failure")


class ClipCliTest(unittest.TestCase):
    """The checked-in script: no key is named, `--check` is the credentialless gate."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.script = Path(__file__).resolve().parents[1] / "scripts" / "render_clips.py"
        self.env = {k: v for k, v in os.environ.items() if k != "ASSEMBLYAI_API_KEY"}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_cli(self, *args: str):
        return subprocess.run(
            [sys.executable, str(self.script), "--root", str(self.root), *args],
            cwd=str(self.script.parents[1]),
            env=self.env,
            capture_output=True,
            text=True,
        )

    def complete_manifest(self) -> dict:
        records = [fixture_record(self.root, plan) for plan in clip_plan() if plan.bound]
        return write_fixture_manifest(self.root, records)

    def test_without_a_key_the_run_is_blocked_by_name_and_writes_nothing(self):
        result = self.run_cli()

        self.assertEqual(1, result.returncode)
        self.assertIn("ASSEMBLYAI_API_KEY", result.stderr)
        self.assertIn("blocked rather than fabricated", result.stderr)
        self.assertFalse((self.root / CLIP_MANIFEST_PATH).exists())
        self.assertEqual([], list(self.root.glob(f"{CLIP_ASSET_DIR}/*.wav")))

    def test_check_without_a_manifest_names_the_missing_file(self):
        result = self.run_cli("--check")

        self.assertEqual(1, result.returncode)
        self.assertIn(CLIP_MANIFEST_PATH, result.stderr)
        self.assertIn("run the clips command first", result.stderr)

    def test_check_passes_a_complete_manifest_and_assets_without_a_key(self):
        self.complete_manifest()

        result = self.run_cli("--check")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("6 committed", result.stdout)
        self.assertIn("0 open", result.stdout)

    def test_check_strict_passes_when_every_demo_voice_is_bound(self):
        self.complete_manifest()

        result = self.run_cli("--check", "--strict")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("6 committed", result.stdout)

    def test_check_names_a_clip_that_disagrees_with_its_binding(self):
        manifest = self.complete_manifest()
        lola = next(clip for clip in manifest["clips"] if clip["voice"] == "lola")
        lola["locale"] = "en"
        (self.root / CLIP_MANIFEST_PATH).write_text(json.dumps(manifest), encoding="utf-8")

        result = self.run_cli("--check")

        self.assertEqual(1, result.returncode)
        self.assertIn("lola", result.stderr)
        self.assertIn("Locale", result.stderr)

    def test_rendering_a_retired_german_id_refuses_by_name(self):
        result = self.run_cli("--voice", "juergen")

        self.assertEqual(1, result.returncode)
        self.assertIn("juergen", result.stderr)
        self.assertIn("not a demo subject", result.stderr)

    def test_an_unknown_voice_is_a_usage_error(self):
        result = self.run_cli("--voice", "nobody")

        self.assertEqual(1, result.returncode)
        self.assertIn("nobody", result.stderr)
        self.assertIn("six demo voices", result.stderr)

    def test_help_lists_the_modes(self):
        result = self.run_cli("--help")

        self.assertEqual(0, result.returncode)
        for flag in ("--check", "--strict", "--voice", "--root"):
            self.assertIn(flag, result.stdout)

