"""Tests for the AssemblyAI streaming STT backend.

The socket is injected, so no network or credentials are needed: the fake
replays a scripted session (Begin, partial Turns, final Turn, Termination)
and records everything the backend sent for framing assertions.

Wire-format assumptions under test are marked LIVE-VERIFY in
backends/assemblyai_stt.py — a 30-second live run with real credits is the
P1 exit gate for each of them.
"""

import asyncio
import json
import unittest
from urllib.parse import parse_qs, urlparse

from backends.assemblyai_stt import AssemblyAIStreamingSTT


class FakeSocket:
    """Scripted stand-in for a websockets client connection."""

    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[str] = []
        self.closed = False
        self.extra_headers: dict | None = None
        self.url: str | None = None

    async def send(self, message: str) -> None:
        self.sent.append(message)

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if not self._inbound:
            raise StopAsyncIteration
        return json.dumps(self._inbound.pop(0))

    async def close(self) -> None:
        self.closed = True


def make_backend(inbound: list[dict], api_key: str = "test-key", **kwargs):
    holder: dict = {}

    async def factory(url: str, extra_headers: dict):
        sock = FakeSocket(inbound)
        sock.url = url
        sock.extra_headers = extra_headers
        holder["sock"] = sock
        return sock

    backend = AssemblyAIStreamingSTT(api_key=api_key, socket_factory=factory, **kwargs)
    return backend, holder


TURN_PARTIAL = {"type": "Turn", "transcript": "hi", "end_of_turn": False, "turn_order": 0}
TURN_PARTIAL_2 = {"type": "Turn", "transcript": "hi there", "end_of_turn": False, "turn_order": 0}
TURN_FINAL = {"type": "Turn", "transcript": "hi there", "end_of_turn": True, "turn_order": 0}


class AssemblyAISTTTests(unittest.TestCase):
    def test_auth_header_and_sample_rate_in_handshake(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}], api_key="k")
            await backend.open(language_codes=["en"], sample_rate=24000)
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        assert sock.extra_headers is not None
        self.assertEqual(sock.extra_headers.get("Authorization"), "k")
        assert sock.url is not None
        query = parse_qs(urlparse(sock.url).query)
        self.assertEqual(query.get("sample_rate"), ["24000"])
        self.assertIn("streaming.assemblyai.com", sock.url)

    def test_accuracy_tuning_in_handshake(self):
        # Balanced U3 Pro with patient endpointing is the default; the
        # handshake carries the full tuning, not just the sample rate.
        # LIVE-VERIFY: list params are JSON-encoded per the documented
        # keyterms_prompt pattern — confirm on the next live run.
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        query = parse_qs(urlparse(sock.url or "").query)
        self.assertEqual(query.get("sample_rate"), ["16000"])
        self.assertEqual(query.get("speech_model"), ["universal-3-6-pro"])
        self.assertEqual(query.get("mode"), ["balanced"])
        self.assertEqual(query.get("min_turn_silence"), ["100"])
        self.assertEqual(query.get("max_turn_silence"), ["1000"])
        self.assertEqual(query.get("interruption_delay"), ["500"])
        self.assertEqual(query.get("language_codes"), [json.dumps(["en"])])
        self.assertNotIn("language_code", query)
        self.assertNotIn("language_detection", query)

    def test_prompt_keyterms_and_voice_focus_in_handshake(self):
        async def run():
            backend, holder = make_backend(
                [{"type": "Begin", "id": "s1"}],
                prompt="A property viewing call.",
                keyterms_prompt=["Yas Island", "Voni"],
                voice_focus="far-field",
                voice_focus_threshold=0.8,
                agent_context="Sure, what date works?",
            )
            await backend.open(language_codes=[], sample_rate=8000)
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        query = parse_qs(urlparse(sock.url or "").query)
        self.assertEqual(query.get("prompt"), ["A property viewing call."])
        self.assertEqual(
            query.get("keyterms_prompt"), [json.dumps(["Yas Island", "Voni"])]
        )
        self.assertEqual(query.get("voice_focus"), ["far-field"])
        self.assertEqual(query.get("voice_focus_threshold"), ["0.8"])
        self.assertEqual(query.get("agent_context"), ["Sure, what date works?"])
        # Empty language list means auto-detect: the key stays absent.
        self.assertNotIn("language_codes", query)

    def test_update_configuration_sends_allowlisted_fields(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.update_configuration(min_turn_silence=1000)
            await backend.update_configuration(mode="balanced")
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        frames = [json.loads(m) for m in sock.sent if isinstance(m, str)]
        self.assertIn(
            {"type": "UpdateConfiguration", "min_turn_silence": 1000}, frames
        )
        self.assertIn({"type": "UpdateConfiguration", "mode": "balanced"}, frames)

    def test_update_configuration_rejects_unknown_fields(self):
        async def run():
            backend, _ = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            try:
                with self.assertRaises(ValueError):
                    await backend.update_configuration(speech_model="x")
            finally:
                await backend.close()

        asyncio.run(run())

    def test_audio_sent_as_raw_binary_frames(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.send_audio(b"\x00\x01\x02\x03")
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        # Docs: binary frames of raw PCM — never JSON, never base64.
        self.assertIn(b"\x00\x01\x02\x03", sock.sent)

    def test_force_endpoint_sends_turn_end(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.force_endpoint()
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        frames = [json.loads(m) for m in sock.sent if isinstance(m, str)]
        self.assertIn({"type": "ForceEndpoint"}, frames)

    def test_session_error_raises_loudly(self):
        async def run():
            backend, _ = make_backend(
                [{"type": "Error", "error": "boom", "error_code": 3006}]
            )
            await backend.open(language_codes=["en"], sample_rate=16000)
            out = [e async for e in backend.events()]
            await backend.close()
            return out

        with self.assertRaisesRegex(RuntimeError, "3006"):
            asyncio.run(run())

    def test_close_terminates_session(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        frames = [json.loads(m) for m in sock.sent if isinstance(m, str)]
        self.assertIn({"type": "Terminate"}, frames)
        self.assertTrue(sock.closed)

    def test_partials_then_final(self):
        from providers import FinalTranscript, PartialTranscript

        async def run():
            backend, _ = make_backend([TURN_PARTIAL, TURN_PARTIAL_2, TURN_FINAL])
            await backend.open(language_codes=["en"], sample_rate=16000)
            out = [e async for e in backend.events()]
            await backend.close()
            return out

        out = asyncio.run(run())
        self.assertIsInstance(out[0], PartialTranscript)
        self.assertEqual(out[0].text, "hi")
        self.assertIsInstance(out[1], PartialTranscript)
        self.assertIsInstance(out[2], FinalTranscript)
        self.assertEqual(out[2].text, "hi there")

    def test_empty_transcript_turns_skipped(self):
        async def run():
            backend, _ = make_backend(
                [
                    {"type": "Turn", "transcript": "", "end_of_turn": False, "turn_order": 0},
                    TURN_FINAL,
                ]
            )
            await backend.open(language_codes=["en"], sample_rate=16000)
            out = [e async for e in backend.events()]
            await backend.close()
            return out

        out = asyncio.run(run())
        self.assertEqual(len(out), 1)

    def test_termination_ends_stream(self):
        async def run():
            backend, _ = make_backend([TURN_FINAL, {"type": "Termination"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            out = [e async for e in backend.events()]
            await backend.close()
            return out

        out = asyncio.run(run())
        self.assertEqual(len(out), 1)

    def test_unknown_message_types_ignored(self):
        async def run():
            backend, _ = make_backend([{"type": "SomethingNew", "x": 1}, TURN_FINAL])
            await backend.open(language_codes=["en"], sample_rate=16000)
            out = [e async for e in backend.events()]
            await backend.close()
            return out

        out = asyncio.run(run())
        self.assertEqual(len(out), 1)

    def test_close_is_idempotent(self):
        async def run():
            backend, holder = make_backend([{"type": "Begin", "id": "s1"}])
            await backend.open(language_codes=["en"], sample_rate=16000)
            await backend.close()
            await backend.close()
            return holder["sock"]

        sock = asyncio.run(run())
        self.assertTrue(sock.closed)


if __name__ == "__main__":
    unittest.main()
