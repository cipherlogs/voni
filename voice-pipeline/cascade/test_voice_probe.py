"""Ticket 130: probe which German voice ids the synthesis endpoint serves.

Seam: :mod:`cascade.voice_probe` is the recorded probe and
``scripts/probe_voices.py`` is its operator CLI. Every request goes through an
injected poster, so no test opens a socket, needs a live key, or can mistake a
refusal for audio.

Independent expected values:

- the WAV hash is recomputed here from the bytes the fake endpoint returned;
- the German catalogue ids are read from the app's own ``voices.ts``, so a
  guessed UUID cannot enter the candidate list;
- the binding tables are snapshotted before the probe so a mutation is visible.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from cascade import voice_binding
from cascade.voice_probe import (
    DEFAULT_CANDIDATES,
    ENDPOINT,
    MissingProbeKey,
    ProbeResponse,
    catalogue_german_ids,
    german_candidates,
    probe_voice,
    probe_voices,
    safe_voice_filename,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VOICES_TS = REPO_ROOT / "voni/src/lib/agents/voices.ts"
API_KEY = "test-key"
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00" + b"\x01\x00\x01\x00" + b"\x00" * 32
REFUSAL_422 = json.dumps(
    {
        "code": "voice_not_found",
        "message": "No voice with this voice_id that your account can use.",
        "param": "voice_id",
        "request_id": "req-422",
    }
).encode()
REFUSAL_400 = json.dumps(
    {
        "code": "invalid_parameter",
        "message": "container: must be one of wav, mp3, pcm",
        "param": "container",
    }
).encode()


def response(status: int, *, body: bytes = b"", **headers: str) -> ProbeResponse:
    return ProbeResponse(status=status, headers=headers, body=body)


def success(voice_id: str = "aai-juergen") -> ProbeResponse:
    return response(
        200,
        body=WAV,
        **{
            "X-Request-Id": "req-200",
            "X-TTS-Voice-Id": voice_id,
            "X-TTS-Language": "german",
            "X-TTS-Model": "assemblyai-tts-1",
        },
    )


class FakePoster:
    """One recorded request per scripted response; never a socket."""

    def __init__(self, *responses: ProbeResponse) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict[str, str], dict]] = []

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> ProbeResponse:
        self.calls.append((url, dict(headers), json.loads(body)))
        if not self.responses:
            raise AssertionError("the probe made more requests than the fake scripted")
        return self.responses.pop(0)


class ProbeSuccessTests(unittest.TestCase):
    def test_a_rendered_voice_records_the_request_and_the_http_evidence(self):
        poster = FakePoster(success())

        probe = probe_voice("aai-juergen", api_key=API_KEY, poster=poster)

        url, headers, body = poster.calls[0]
        self.assertEqual(ENDPOINT, url)
        self.assertEqual(f"Bearer {API_KEY}", headers["Authorization"])
        self.assertEqual("aai-juergen", body["voice_id"])
        self.assertEqual("wav", body["container"])
        self.assertIs(False, body["stream"])
        self.assertNotIn("voice", body, "the retired `voice` field is never sent")
        self.assertIn("Deutsch", body["text"])

        self.assertTrue(probe.rendered)
        self.assertEqual(200, probe.status)
        self.assertEqual("req-200", probe.request_id)
        self.assertEqual("aai-juergen", probe.response_voice_id)
        self.assertEqual("german", probe.language)
        self.assertEqual("assemblyai-tts-1", probe.model)
        self.assertEqual(len(WAV), probe.audio_bytes)
        self.assertEqual(hashlib.sha256(WAV).hexdigest(), probe.sha256)
        self.assertIsNone(probe.error)

    def test_a_200_with_no_audio_is_not_reported_as_a_success(self):
        probe = probe_voice(
            "aai-juergen", api_key=API_KEY, poster=FakePoster(response(200))
        )

        self.assertFalse(probe.rendered)
        self.assertIsNone(probe.sha256)
        self.assertIsNotNone(probe.error)
        self.assertEqual("empty_audio", probe.error.error_type)


class ProbeRefusalTests(unittest.TestCase):
    def test_a_422_voice_not_found_is_a_named_refusal_with_no_audio(self):
        probe = probe_voice(
            "juergen", api_key=API_KEY, poster=FakePoster(response(422, body=REFUSAL_422))
        )

        self.assertFalse(probe.rendered)
        self.assertEqual(422, probe.status)
        self.assertEqual("voice_not_found", probe.error.error_type)
        self.assertEqual("voice_id", probe.error.param)
        self.assertIn("No voice", probe.error.message)
        self.assertEqual(b"", probe.audio)
        self.assertIsNone(probe.sha256)

    def test_a_400_invalid_parameter_keeps_the_status_and_the_field(self):
        probe = probe_voice(
            "bogus", api_key=API_KEY, poster=FakePoster(response(400, body=REFUSAL_400))
        )

        self.assertFalse(probe.rendered)
        self.assertEqual(400, probe.status)
        self.assertEqual("invalid_parameter", probe.error.error_type)
        self.assertEqual("container", probe.error.param)
        self.assertEqual(b"", probe.audio)


class MissingKeyTests(unittest.TestCase):
    def test_a_missing_key_refuses_before_any_request(self):
        poster = FakePoster(success())

        with self.assertRaises(MissingProbeKey) as caught:
            probe_voices(DEFAULT_CANDIDATES, api_key=None, poster=poster)

        self.assertIn("ASSEMBLYAI_API_KEY", str(caught.exception))
        self.assertEqual([], poster.calls, "no key must mean no socket")


class CandidateTests(unittest.TestCase):
    def test_the_defaults_are_the_two_known_german_candidates(self):
        self.assertEqual(("juergen", "aai-juergen"), DEFAULT_CANDIDATES)
        self.assertEqual(DEFAULT_CANDIDATES, german_candidates())

    def test_extra_candidates_are_kept_in_order_without_duplicates(self):
        self.assertEqual(
            ("juergen", "aai-juergen", "acct-de-1"),
            german_candidates(["aai-juergen", "acct-de-1"]),
        )

    def test_the_app_catalogue_supplies_only_ids_declared_german(self):
        source = """
        export const VOICES = [
          { id: "lola", accent: "ES", presents: "feminine", language: "Spanish", languageCode: "es" },
          { id: "juergen", accent: "DE", presents: "masculine", language: "German", languageCode: "de" },
        ];
        """

        self.assertEqual(("juergen",), catalogue_german_ids(source))

    def test_the_real_catalogue_contains_the_unbound_german_row(self):
        ids = catalogue_german_ids(VOICES_TS.read_text(encoding="utf-8"))

        self.assertIn("juergen", ids)
        self.assertEqual(
            ids,
            tuple(
                re.findall(
                    r'\{ id: "([^"]+)"[^}]*languageCode: "de"',
                    VOICES_TS.read_text(encoding="utf-8"),
                )
            ),
        )

    def test_a_filename_is_safe_and_never_a_path(self):
        self.assertEqual("aai-juergen.wav", safe_voice_filename("aai-juergen"))
        self.assertEqual("evil-id.wav", safe_voice_filename("../evil id"))


class OutDirTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_successful_wav_and_probe_json_are_saved(self):
        run = probe_voices(
            ["aai-juergen"],
            api_key=API_KEY,
            poster=FakePoster(success()),
            out_dir=self.out,
            sent_on="2026-10-30",
        )

        wav = self.out / "aai-juergen.wav"
        self.assertEqual(WAV, wav.read_bytes())
        document = json.loads((self.out / "probe.json").read_text(encoding="utf-8"))
        row = document["candidates"][0]
        self.assertEqual("aai-juergen", row["voiceId"])
        self.assertEqual(200, row["status"])
        self.assertTrue(row["rendered"])
        self.assertEqual(hashlib.sha256(WAV).hexdigest(), row["sha256"])
        self.assertEqual("aai-juergen.wav", row["audioFile"])
        self.assertEqual("2026-10-30", document["probedOn"])
        self.assertEqual(
            ['VoiceBinding("aai-juergen", LOCALES["de"]),'],
            document["suggestedBinding"],
        )
        self.assertEqual("aai-juergen", run.rendered[0].voice_id)

    def test_a_refusal_saves_no_audio(self):
        probe_voices(
            ["juergen"],
            api_key=API_KEY,
            poster=FakePoster(response(422, body=REFUSAL_422)),
            out_dir=self.out,
            sent_on="2026-10-30",
        )

        self.assertEqual([], list(self.out.glob("*.wav")))
        document = json.loads((self.out / "probe.json").read_text(encoding="utf-8"))
        self.assertIsNone(document["candidates"][0]["audioFile"])
        self.assertEqual("voice_not_found", document["candidates"][0]["error"]["errorType"])
        self.assertEqual([], document["suggestedBinding"])


class ExitCodeTests(unittest.TestCase):
    def test_one_rendered_candidate_is_a_successful_probe(self):
        run = probe_voices(
            ["juergen", "aai-juergen"],
            api_key=API_KEY,
            poster=FakePoster(
                response(422, body=REFUSAL_422), success()
            ),
        )

        self.assertEqual(0, run.exit_code)

    def test_every_candidate_refusing_is_not_a_pass(self):
        run = probe_voices(
            ["juergen", "aai-juergen"],
            api_key=API_KEY,
            poster=FakePoster(
                response(422, body=REFUSAL_422), response(422, body=REFUSAL_422)
            ),
        )

        self.assertEqual(1, run.exit_code)
        self.assertEqual((), run.rendered)


class NoBindingMutationTests(unittest.TestCase):
    def test_probing_never_binds_the_voice_or_edits_the_table(self):
        before_bindings = dict(voice_binding.BINDINGS)
        before_unbound = dict(voice_binding.UNBOUND_VOICES)

        probe_voices(
            ["aai-juergen"],
            api_key=API_KEY,
            poster=FakePoster(success()),
        )

        self.assertEqual(before_bindings, dict(voice_binding.BINDINGS))
        self.assertEqual(before_unbound, dict(voice_binding.UNBOUND_VOICES))
        self.assertFalse(voice_binding.is_cascade_subject("aai-juergen"))


def load_cli():
    path = Path(__file__).resolve().parents[1] / "scripts" / "probe_voices.py"
    spec = importlib.util.spec_from_file_location("probe_voices_cli", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        self.cli = load_cli()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_cli(self, args, *, poster, environ):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.cli.main(args, poster=poster, environ=environ)
        return code, out.getvalue(), err.getvalue()

    def test_without_a_key_the_run_is_skipped_by_name_and_sends_nothing(self):
        poster = FakePoster(success())

        code, out, err = self.run_cli(
            ["--out", str(self.out)], poster=poster, environ={}
        )

        self.assertEqual(2, code)
        self.assertEqual([], poster.calls)
        self.assertFalse(self.out.exists() and list(self.out.iterdir()))
        self.assertIn("SKIPPED", out + err)
        self.assertIn("ASSEMBLYAI_API_KEY", out + err)

    def test_a_render_prints_a_table_and_a_suggested_binding_but_never_the_key(self):
        code, out, err = self.run_cli(
            ["--voice-id", "aai-juergen", "--out", str(self.out)],
            poster=FakePoster(success()),
            environ={"ASSEMBLYAI_API_KEY": API_KEY},
        )

        self.assertEqual(0, code, err)
        self.assertIn("aai-juergen", out)
        self.assertIn("200", out)
        self.assertIn('VoiceBinding("aai-juergen", LOCALES["de"]),', out)
        self.assertNotIn(API_KEY, out + err)
        self.assertTrue((self.out / "aai-juergen.wav").is_file())

    def test_every_refusal_exits_one_and_prints_no_binding(self):
        code, out, err = self.run_cli(
            ["--voice-id", "juergen", "--out", str(self.out)],
            poster=FakePoster(response(422, body=REFUSAL_422)),
            environ={"ASSEMBLYAI_API_KEY": API_KEY},
        )

        self.assertEqual(1, code)
        self.assertIn("voice_not_found", out + err)
        self.assertNotIn("VoiceBinding(", out)
        self.assertEqual([], list(self.out.glob("*.wav")))

    def test_catalogue_de_adds_its_ids_to_the_candidates(self):
        catalogue = self.out / "voices.ts"
        catalogue.write_text(
            'export const VOICES = [\n'
            '  { id: "juergen", accent: "DE", presents: "masculine", language: "German", languageCode: "de" },\n'
            '  { id: "de-test", accent: "DE", presents: "feminine", language: "German", languageCode: "de" },\n'
            "];\n",
            encoding="utf-8",
        )
        poster = FakePoster(
            response(422, body=REFUSAL_422),
            response(422, body=REFUSAL_422),
            response(422, body=REFUSAL_422),
        )

        code, _out, err = self.run_cli(
            ["--catalogue-de", str(catalogue), "--out", str(self.out)],
            poster=poster,
            environ={"ASSEMBLYAI_API_KEY": API_KEY},
        )

        self.assertEqual(1, code, err)
        self.assertEqual(
            ["juergen", "aai-juergen", "de-test"],
            [body["voice_id"] for _, _, body in poster.calls],
        )
