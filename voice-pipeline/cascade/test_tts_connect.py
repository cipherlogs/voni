"""Connect frame for the AssemblyAI synthesis backend (ticket 47).

One synthesis socket per call, opened at call start before any user frame
exists. The connection is built from two authorities and nothing else: the
voice binding owns voice and language, the transport owns sample rate and
encoding, while the model and word boundaries are fixed for the cascade. A
voice or transport the tables cannot name refuses by name, and no request
field can override what the connection asked for.

The socket factory is injected (ticket 01 kit), so no test opens a real socket.
The opening ``Begin`` frame is read and kept as the session's own record; the
echo assertion is ticket 48's.
"""

import asyncio
import json
import unittest
from urllib.parse import parse_qs, urlparse

from cascade.assemblyai_tts import (
    MODEL_ID,
    TTS_BASE_URL,
    AssemblyAIStreamingTTS,
    UnknownTransportError,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.voice_binding import UnknownVoiceError
from config import TRANSPORTS

API_KEY = "test-key"


def begin(
    *,
    voice_id: str = "anna",
    language: str = "English",
    sample_rate: int = 24000,
    encoding: str = "pcm_s16le",
    model: str = MODEL_ID,
) -> str:
    """A Begin frame shaped like the vendor's, for the session under test."""
    return json.dumps(
        {
            "type": "Begin",
            "id": "10885144-0d4b-4928-9eff-ef292a352937",
            "expires_at": 1789556741,
            "configuration": {
                "language": language,
                "sample_rate": sample_rate,
                "encoding": encoding,
                "voice_id": voice_id,
                "model": model,
                "word_boundaries": True,
                "limits": {"max_generate_text_length": 2000},
                "unknown_params": [],
            },
        }
    )


def query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query)


def connect(tts: AssemblyAIStreamingTTS, factory: ScriptedSocketFactory) -> None:
    """Open the session against a scripted factory; the factory records the rest."""
    asyncio.run(tts.open())


class BrowserTransportTests(unittest.TestCase):
    def test_browser_connects_with_binding_voice_language_and_24k_pcm(self):
        factory = ScriptedSocketFactory([begin()])
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
        )

        connect(tts, factory)

        url = factory.connections[0]["url"]
        self.assertEqual(urlparse(url).scheme, "wss")
        self.assertTrue(url.startswith(TTS_BASE_URL + "?"), url)
        self.assertEqual(
            query(url),
            {
                "voice_id": ["anna"],
                "language": ["English"],
                "sample_rate": ["24000"],
                "encoding": ["pcm_s16le"],
                "model_id": [MODEL_ID],
                "word_boundaries": ["true"],
            },
        )


class PhoneTransportTests(unittest.TestCase):
    def test_phone_connects_with_8k_mulaw(self):
        factory = ScriptedSocketFactory([begin(sample_rate=8000, encoding="pcm_mulaw")])
        tts = AssemblyAIStreamingTTS(
            voice_id="lola",
            transport="telnyx",
            api_key=API_KEY,
            socket_factory=factory,
        )

        connect(tts, factory)

        sent = query(factory.connections[0]["url"])
        self.assertEqual(sent["sample_rate"], ["8000"])
        self.assertEqual(sent["encoding"], ["pcm_mulaw"])
        self.assertEqual(sent["language"], ["Spanish"])


class EveryTransportTests(unittest.TestCase):
    def test_every_configured_transport_has_a_rate_and_encoding(self):
        for transport in TRANSPORTS:
            with self.subTest(transport=transport):
                tts = AssemblyAIStreamingTTS(
                    voice_id="anna",
                    transport=transport,
                    api_key=API_KEY,
                    socket_factory=ScriptedSocketFactory([begin()]),
                )
                sent = query(tts.url)
                self.assertIn("sample_rate", sent)
                self.assertIn("encoding", sent)


class RefusalTests(unittest.TestCase):
    def test_an_undefined_transport_refuses_by_name_before_connecting(self):
        factory = ScriptedSocketFactory([begin()])
        with self.assertRaises(UnknownTransportError) as raised:
            AssemblyAIStreamingTTS(
                voice_id="anna",
                transport="carrier-pigeon",
                api_key=API_KEY,
                socket_factory=factory,
            )
        self.assertIn("carrier-pigeon", str(raised.exception))
        self.assertEqual(factory.connections, [])

    def test_an_unbound_voice_refuses_by_name_before_connecting(self):
        factory = ScriptedSocketFactory([begin()])
        with self.assertRaises(UnknownVoiceError) as raised:
            AssemblyAIStreamingTTS(
                voice_id="nobody",
                transport="browser",
                api_key=API_KEY,
                socket_factory=factory,
            )
        self.assertIn("nobody", str(raised.exception))
        self.assertEqual(factory.connections, [])


class OneSocketPerCallTests(unittest.TestCase):
    def test_open_connects_one_socket_and_sends_nothing_yet(self):
        factory = ScriptedSocketFactory([begin()])

        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
        )
        connect(tts, factory)

        self.assertEqual(len(factory.connections), 1)
        self.assertEqual(factory.socket.sent, [])
        self.assertEqual(factory.connections[0]["headers"], {"Authorization": API_KEY})

    def test_a_second_open_refuses_instead_of_opening_a_second_socket(self):
        factory = ScriptedSocketFactory([begin()])
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
        )
        connect(tts, factory)

        with self.assertRaises(RuntimeError):
            asyncio.run(tts.open())

        self.assertEqual(len(factory.connections), 1)

    def test_the_begin_frame_is_read_and_kept_for_the_echo_assertion(self):
        factory = ScriptedSocketFactory([begin()])
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
        )

        connect(tts, factory)

        self.assertEqual(tts.begin["type"], "Begin")
        self.assertEqual(tts.begin["configuration"]["voice_id"], "anna")
        self.assertEqual(tts.begin["expires_at"], 1789556741)

    def test_a_session_whose_first_frame_is_not_begin_fails_by_name(self):
        factory = ScriptedSocketFactory(
            [Frame(json.dumps({"type": "Error", "error_code": 3006, "error": "bad"}))]
        )
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=factory,
        )

        with self.assertRaises(RuntimeError) as raised:
            asyncio.run(tts.open())

        self.assertIn("3006", str(raised.exception))


class NoOverrideTests(unittest.TestCase):
    def test_no_request_field_can_override_the_binding_or_transport(self):
        factory = ScriptedSocketFactory([begin()])
        for field, value in (
            ("language", "Spanish"),
            ("sample_rate", 8000),
            ("encoding", "pcm_mulaw"),
            ("model_id", "something-else"),
        ):
            with self.subTest(field=field):
                with self.assertRaises(TypeError):
                    AssemblyAIStreamingTTS(  # type: ignore[call-arg]
                        voice_id="anna",
                        transport="browser",
                        api_key=API_KEY,
                        socket_factory=factory,
                        **{field: value},
                    )

    def test_the_connect_call_takes_no_request_fields_either(self):
        tts = AssemblyAIStreamingTTS(
            voice_id="anna",
            transport="browser",
            api_key=API_KEY,
            socket_factory=ScriptedSocketFactory([begin()]),
        )

        with self.assertRaises(TypeError):
            asyncio.run(tts.open(language="Spanish"))  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
