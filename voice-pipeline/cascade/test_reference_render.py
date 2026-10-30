"""W0 reference render from direct synthesis (ticket 120).

Seam: :func:`cascade.reference_render.render_reference` is handed a real
:class:`cascade.body_map.CascadeBody` and a scripted synthesis socket. The
opened client is the call's own
:class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS`, so the connect URL,
the voice binding and the first-sentence flush are observed on the wire rather
than re-implemented here. No test opens a socket or needs a live key.

Independent expected values:

- the expected WAV bytes are built here from the recorded fixture PCM, not by
  calling the writer under test;
- the greeting text is the body's own text, copied before the render;
- the sentence order is :func:`cascade.assemblyai_tts.schedule`'s, the same
  scheduler the call uses.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

from cascade.assemblyai_tts import MODEL_ID, schedule
from cascade.body_map import CascadeBody, adapt_body
from cascade.reference_render import (
    MissingReferenceLine,
    ReferenceFormat,
    UnsupportedReferenceFormat,
    reference_key,
    reference_path,
    render_reference,
)
from cascade.testing import FakeClock, ScriptedSocketFactory
from cascade.tts_support import (
    audio,
    begin,
    flush_done,
    pcm_ms,
    termination,
)

GREETING = "Hola, soy Voni. ¿Qué tal?"
API_KEY = "test-key"
SAMPLE_RATE = 24000
SENTENCE_MS = 120


def body_document(greeting: str = GREETING, *, voice_id: str = "lola") -> dict:
    """The stored body the W0 render reads: the real shape, one line varied."""
    language = {"lola": "es", "anna": "en"}[voice_id]
    return {
        "system_prompt": "You are Voni, a careful voice agent.",
        "greeting": greeting,
        "voice": {"voice_id": voice_id},
        "input": {"language_codes": [language]},
        "output": {"voice": voice_id},
        "tools": [],
        "llm": [],
    }


def body_with(greeting: str = GREETING, *, voice_id: str = "lola") -> CascadeBody:
    """One real adapted body; only the greeting line varies per test."""
    return adapt_body(body_document(greeting, voice_id=voice_id))


def plan_for(
    line: str, *, voice_id: str = "lola", language: str = "Spanish", sample: int = 1000
) -> tuple[list[str], bytes]:
    """Recorded frames for one rendered line, plus the PCM they carry."""
    frames = [begin(voice_id=voice_id, language=language)]
    chunks = schedule(line)
    pcm = b""
    for index in range(len(chunks)):
        chunk = pcm_ms(SENTENCE_MS, sample=sample + index)
        frames.append(audio(chunk, flush_id=index))
        frames.append(flush_done(flush_id=index, audio_duration_ms=SENTENCE_MS))
        pcm += chunk
    frames.append(termination(audio_duration_seconds=len(pcm) / 2 / SAMPLE_RATE))
    return frames, pcm


def wav_bytes(pcm: bytes, *, sample_rate: int = SAMPLE_RATE) -> bytes:
    """The standard 44-byte-header PCM16 mono WAV, assembled independently."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
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
        len(pcm),
    )
    return header + pcm


def sent(factory: ScriptedSocketFactory) -> list[dict]:
    socket = factory.socket
    assert socket is not None, "no socket was opened"
    return [json.loads(message) for message in socket.sent]


class ReferenceRenderTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.clock = FakeClock(0.0)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_the_default_line_is_the_body_greeting_rendered_by_the_call_client(self):
        body = body_with(GREETING)
        frames, pcm = plan_for(GREETING)
        factory = ScriptedSocketFactory(frames, clock=self.clock)

        rendered = asyncio.run(
            render_reference(
                body,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=factory,
                clock=self.clock,
            )
        )

        expected = wav_bytes(pcm)
        self.assertEqual(GREETING, rendered.text)
        self.assertEqual("lola", rendered.voice_id)
        self.assertEqual("es", rendered.locale)
        self.assertEqual(SAMPLE_RATE, rendered.format.sample_rate)
        self.assertEqual("pcm_s16le", rendered.format.encoding)
        self.assertEqual(MODEL_ID, rendered.format.model_id)
        self.assertFalse(rendered.cached)
        self.assertEqual(hashlib.sha256(expected).hexdigest(), rendered.sha256)
        self.assertEqual(expected, Path(rendered.path).read_bytes())

        # The call's own client and binding, on the wire.
        connection = factory.connections[0]
        self.assertIn("wss://tts.us.assemblyai.com/v1/ws?", connection["url"])
        self.assertIn("voice_id=aai-lola", connection["url"])
        self.assertIn("language=Spanish", connection["url"])
        self.assertIn("sample_rate=24000", connection["url"])
        self.assertIn("encoding=pcm_s16le", connection["url"])

        # One Generate + Flush per sentence, first sentence first, then the
        # clean end. The first sentence is flushed before the second is sent.
        frames_sent = sent(factory)
        self.assertEqual(
            ["Generate", "Flush", "Generate", "Flush", "Terminate"],
            [frame["type"] for frame in frames_sent],
        )
        self.assertEqual(["Hola, soy Voni. ", "¿Qué tal?"], [
            frame["text"] for frame in frames_sent if frame["type"] == "Generate"
        ])

    def test_a_second_render_for_the_same_voice_text_and_format_is_the_cached_file(self):
        body = body_with(GREETING)
        frames, pcm = plan_for(GREETING)
        first = asyncio.run(
            render_reference(
                body,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=ScriptedSocketFactory(frames, clock=self.clock),
                clock=self.clock,
            )
        )

        second_factory = ScriptedSocketFactory([], clock=self.clock)
        second = asyncio.run(
            render_reference(
                body,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=second_factory,
                clock=self.clock,
            )
        )

        self.assertTrue(second.cached)
        self.assertEqual([], second_factory.connections, "a cache hit spends no synthesis")
        self.assertEqual(first.path, second.path)
        self.assertEqual(first.sha256, second.sha256, "the pin survives the cache hit")
        self.assertEqual(wav_bytes(pcm), Path(second.path).read_bytes())

    def test_a_truncated_cache_file_is_rendered_again(self):
        body = body_with(GREETING)
        frames, pcm = plan_for(GREETING)
        first = asyncio.run(
            render_reference(
                body,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=ScriptedSocketFactory(frames, clock=self.clock),
                clock=self.clock,
            )
        )
        Path(first.path).write_bytes(Path(first.path).read_bytes()[:100])

        second_factory = ScriptedSocketFactory(frames, clock=self.clock)
        second = asyncio.run(
            render_reference(
                body,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=second_factory,
                clock=self.clock,
            )
        )

        self.assertFalse(second.cached, "a broken cache is not a cache hit")
        self.assertEqual(1, len(second_factory.connections))
        self.assertEqual(wav_bytes(pcm), Path(second.path).read_bytes())

    def test_the_cache_identity_includes_the_whole_format(self):
        browser = ReferenceFormat.for_transport("browser")
        phone = ReferenceFormat(
            transport="telnyx",
            sample_rate=8000,
            encoding="pcm_mulaw",
            model_id=browser.model_id,
        )

        self.assertNotEqual(
            reference_key("lola", GREETING, browser),
            reference_key("lola", GREETING, phone),
            "the same line at another format is not the same reference",
        )
        self.assertNotEqual(
            reference_path(self.dir, "lola", GREETING, browser),
            reference_path(self.dir, "lola", GREETING, phone),
        )

    def test_another_sentence_is_its_own_reference_not_a_greeting_cache_hit(self):
        line = "El pedido número 427 no llegó."
        body = body_with(GREETING)
        frames, pcm = plan_for(line, sample=2000)
        factory = ScriptedSocketFactory(frames, clock=self.clock)

        rendered = asyncio.run(
            render_reference(
                body,
                text=line,
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=factory,
                clock=self.clock,
            )
        )

        self.assertEqual(line, rendered.text)
        self.assertEqual(wav_bytes(pcm), Path(rendered.path).read_bytes())
        self.assertEqual(
            ["El pedido número 427 no llegó."],
            [frame["text"] for frame in sent(factory) if frame["type"] == "Generate"],
        )
        self.assertNotEqual(
            rendered.path,
            reference_path(
                self.dir, "lola", GREETING, ReferenceFormat.for_transport("browser")
            ),
            "a mid-call sentence never shares the greeting's cache entry",
        )

    def test_the_body_greeting_is_rendered_verbatim_including_whitespace(self):
        line = "Hola, soy Voni.  ¿Qué tal? "
        frames, pcm = plan_for(line)
        factory = ScriptedSocketFactory(frames, clock=self.clock)

        rendered = asyncio.run(
            render_reference(
                body_with(line),
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=factory,
                clock=self.clock,
            )
        )

        self.assertEqual(line, rendered.text, "the call speaks the body's text as-is")
        self.assertEqual(
            list(schedule(line)),
            [frame["text"] for frame in sent(factory) if frame["type"] == "Generate"],
        )
        self.assertEqual(wav_bytes(pcm), Path(rendered.path).read_bytes())

    def test_a_body_with_no_greeting_and_no_text_fails_by_name_before_a_socket(self):
        factory = ScriptedSocketFactory([], clock=self.clock)
        with self.assertRaises(MissingReferenceLine) as raised:
            asyncio.run(
                render_reference(
                    body_with(""),
                    out_dir=self.dir,
                    api_key=API_KEY,
                    socket_factory=factory,
                    clock=self.clock,
                )
            )

        self.assertIn("body has no greeting", str(raised.exception))
        self.assertEqual([], factory.connections, "nothing is synthesized for no line")

    def test_a_blank_text_fails_by_name_before_a_socket(self):
        factory = ScriptedSocketFactory([], clock=self.clock)
        with self.assertRaises(MissingReferenceLine) as raised:
            asyncio.run(
                render_reference(
                    body_with(GREETING),
                    text="  \n\t",
                    out_dir=self.dir,
                    api_key=API_KEY,
                    socket_factory=factory,
                    clock=self.clock,
                )
            )

        self.assertIn("requested text is blank", str(raised.exception))
        self.assertEqual([], factory.connections)

    def test_a_format_the_comparison_cannot_read_is_refused_by_name(self):
        factory = ScriptedSocketFactory([], clock=self.clock)
        with self.assertRaises(UnsupportedReferenceFormat) as raised:
            asyncio.run(
                render_reference(
                    body_with(GREETING),
                    transport="telnyx",
                    out_dir=self.dir,
                    api_key=API_KEY,
                    socket_factory=factory,
                    clock=self.clock,
                )
            )

        self.assertIn("pcm_mulaw", str(raised.exception))
        self.assertIn("browser capture", str(raised.exception))
        self.assertEqual([], factory.connections)

    def test_the_document_carries_the_path_and_hash_and_never_the_audio(self):
        frames, pcm = plan_for(GREETING)
        rendered = asyncio.run(
            render_reference(
                body_with(GREETING),
                out_dir=self.dir,
                api_key=API_KEY,
                socket_factory=ScriptedSocketFactory(frames, clock=self.clock),
                clock=self.clock,
            )
        )

        document = rendered.to_document()
        self.assertEqual(rendered.path, document["path"])
        self.assertEqual(rendered.sha256, document["sha256"])
        self.assertEqual(hashlib.sha256(wav_bytes(pcm)).hexdigest(), document["sha256"])
        self.assertEqual(24000, document["format"]["sampleRate"])
        self.assertEqual("pcm_s16le", document["format"]["encoding"])
        self.assertEqual(len(pcm), document["bytes"])
        self.assertNotIn("pcm", document)
        self.assertNotIn("audio", document)

    def test_the_render_path_has_no_model_stt_or_platform_client(self):
        import cascade.reference_render as module

        source = Path(module.__file__).read_text(encoding="utf-8")
        for forbidden in (
            "agents.assemblyai.com",
            "silent-greeting",
            "silent_greeting",
            "meta_llm",
            "gateway_llm",
            "meta_stt",
            "assemblyai_stt",
            "LLMStream",
            "StreamingSTT",
            "CascadeSession",
            "voice-call",
        ):
            self.assertNotIn(
                forbidden,
                source,
                f"the W0 reference path must not contain {forbidden!r}",
            )

    def test_the_cli_names_the_live_key_blocker_without_writing_a_file(self):
        import os
        import subprocess
        import sys

        body_file = self.dir / "body.json"
        body_file.write_text(json.dumps(body_document()), encoding="utf-8")
        script = (
            Path(__file__).resolve().parents[1] / "scripts" / "render_reference.py"
        )
        env = {k: v for k, v in os.environ.items() if k != "ASSEMBLYAI_API_KEY"}

        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--body",
                str(body_file),
                "--out-dir",
                str(self.dir),
            ],
            cwd=str(script.parents[1]),
            env=env,
            capture_output=True,
            text=True,
        )

        self.assertEqual(1, result.returncode)
        self.assertIn("ASSEMBLYAI_API_KEY", result.stderr)
        self.assertIn("live synthesis", result.stderr)
        self.assertEqual([], list(self.dir.glob("*.wav")), "no reference WAV was written")

    def test_the_cli_names_a_missing_body_file(self):
        import os
        import subprocess
        import sys

        script = (
            Path(__file__).resolve().parents[1] / "scripts" / "render_reference.py"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--body",
                str(self.dir / "missing.json"),
                "--out-dir",
                str(self.dir),
            ],
            cwd=str(script.parents[1]),
            env={k: v for k, v in os.environ.items() if k != "ASSEMBLYAI_API_KEY"},
            capture_output=True,
            text=True,
        )

        self.assertEqual(1, result.returncode)
        self.assertIn("body file not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
