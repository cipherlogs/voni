"""Handshake behaviour of the Meta realtime speech backend.

The speech session is judged by what it puts on the wire: the first text frame
carries the credential inside the frame (never an Authorization header), it
declares the one encoding/mode/partial shape the cascade reads, it maps the
body's language codes and keyterms into the vendor's names, and it identifies
the session by call id plus epoch rather than by a secret. The socket factory
is injected, so every assertion below replays a recorded frame and no test
opens a real socket.

The acknowledgement is a text frame without a ``type`` field; anything else
arriving before it is a protocol error, and no audio may leave the client
before it.
"""

import asyncio
import json
import logging
import os
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from cascade.meta_stt import (
    MetaHandshakeError,
    MetaHandshakeProtocolError,
    MetaStreamingSTT,
    UnknownLanguageCodeError,
    UnsupportedSampleRateError,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory


def untyped_ack() -> str:
    """The acknowledgement the vendor sends: a JSON object with no ``type``."""
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def open_stt(plan=(untyped_ack(),), **kwargs):
    """Open a backend over a scripted socket plan and return (backend, factory)."""
    factory = ScriptedSocketFactory(list(plan))
    options = {"api_key": "test-key", "call_id": "call-123"}
    options.update(kwargs)
    backend = MetaStreamingSTT(socket_factory=factory, **options)
    asyncio.run(backend.open(language_codes=[], sample_rate=24000))
    return backend, factory


def handshake_payload(factory: ScriptedSocketFactory) -> dict:
    frame = factory.socket.sent[0]
    assert isinstance(frame, str), f"first client frame is not text: {frame!r}"
    return json.loads(frame)


class CredentialInFrameTest(unittest.TestCase):
    def test_first_frame_carries_the_bearer_in_the_frame_not_a_header(self):
        _, factory = open_stt()

        payload = handshake_payload(factory)

        self.assertEqual(payload["authorization"], {"accessToken": "Bearer test-key"})
        connection = factory.connections[0]
        self.assertEqual(connection["headers"], {})
        self.assertNotIn(
            "authorization", {name.lower() for name in connection["headers"]}
        )

    def test_the_handshake_is_the_only_frame_sent_while_opening(self):
        _, factory = open_stt()

        self.assertEqual(len(factory.socket.sent), 1)
        self.assertIsInstance(factory.socket.sent[0], str)


class HandshakeSliceTest(unittest.TestCase):
    def test_frame_declares_the_encoding_model_mode_and_partial_shape(self):
        _, factory = open_stt()

        payload = handshake_payload(factory)

        self.assertEqual(payload["audioEncoding"], "PCM_24KHZ")
        self.assertEqual(payload["model"], "muse-voice-transcribe-1.0")
        self.assertEqual(payload["mode"], "ENDPOINTING")
        self.assertEqual(payload["partialMode"], "CUMULATIVE")
        self.assertIs(payload["emitAudioProgress"], False)

    def test_language_codes_become_the_vendors_language_names(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )
        asyncio.run(backend.open(language_codes=["es"], sample_rate=24000))

        self.assertEqual(handshake_payload(factory)["languageBias"], ["Spanish"])

        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )
        asyncio.run(backend.open(language_codes=["en", "pt"], sample_rate=24000))

        self.assertEqual(
            handshake_payload(factory)["languageBias"], ["English", "Portuguese"]
        )

    def test_an_unknown_language_code_is_refused_by_name_before_connecting(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(UnknownLanguageCodeError) as raised:
            asyncio.run(backend.open(language_codes=["zz"], sample_rate=24000))

        self.assertIn("zz", str(raised.exception))
        self.assertEqual(factory.connections, [])

    def test_keyterms_become_keywords_and_both_lists_freeze_at_session_start(self):
        keyterms = [" Voni ", "pricing", "Voni", ""]
        language_codes = ["es"]
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            keyterms=keyterms,
        )
        asyncio.run(backend.open(language_codes=language_codes, sample_rate=24000))

        keyterms.append("refinance")
        language_codes[:] = ["fr"]
        asyncio.run(backend.close())
        asyncio.run(backend.open(language_codes=language_codes, sample_rate=24000))

        first = handshake_payload_at(factory, 0)
        second = handshake_payload_at(factory, 1)
        self.assertEqual(first["keywords"], ["Voni", "pricing"])
        self.assertEqual(first["languageBias"], ["Spanish"])
        self.assertEqual(second["keywords"], ["Voni", "pricing"])
        self.assertEqual(second["languageBias"], ["Spanish"])


class SessionIdentityTest(unittest.TestCase):
    def test_session_id_is_a_query_param_of_call_id_and_epoch_and_no_secret(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        asyncio.run(backend.open(language_codes=[], sample_rate=24000))
        asyncio.run(backend.close())
        asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        first = session_query(factory, 0)
        second = session_query(factory, 1)
        self.assertEqual(first, "call-123:0")
        self.assertEqual(second, "call-123:1")
        self.assertNotEqual(first, second)
        for index in (0, 1):
            url = factory.connections[index]["url"]
            self.assertNotIn("test-key", url)


def handshake_payload_at(factory: ScriptedSocketFactory, index: int) -> dict:
    frame = factory.connections[index]["socket"].sent[0]
    assert isinstance(frame, str), f"first client frame is not text: {frame!r}"
    return json.loads(frame)


def session_query(factory: ScriptedSocketFactory, index: int) -> str:
    query = parse_qs(urlsplit(factory.connections[index]["url"]).query)
    return query["sessionId"][0]


class AcknowledgementTest(unittest.TestCase):
    def test_a_text_frame_without_type_is_the_acknowledgement(self):
        backend, factory = open_stt()

        self.assertTrue(backend.acked)
        self.assertEqual(len(factory.socket.sent), 1)

    def test_a_typed_frame_before_the_ack_fails_by_name_and_closes(self):
        factory = ScriptedSocketFactory(
            [Frame(json.dumps({"type": "transcript", "text": "hi"}))]
        )
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeProtocolError) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertIn("transcript", str(raised.exception))
        self.assertIn("call-123:0", str(raised.exception))
        self.assertFalse(backend.acked)
        self.assertTrue(factory.socket.closed)

    def test_a_non_json_frame_before_the_ack_is_a_protocol_error(self):
        factory = ScriptedSocketFactory([Frame(b"\x00\x01")])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeProtocolError):
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertFalse(backend.acked)

    def test_a_socket_that_ends_before_the_ack_fails_by_name(self):
        factory = ScriptedSocketFactory([])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeError) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertIn("call-123:0", str(raised.exception))
        self.assertIn("acknowledgement", str(raised.exception))


class NoAudioBeforeAckTest(unittest.TestCase):
    def test_the_handshake_sends_no_audio_frame(self):
        _, factory = open_stt()

        self.assertEqual(len(factory.socket.sent), 1)
        self.assertIsInstance(factory.socket.sent[0], str)

    def test_audio_before_the_session_is_open_is_refused(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(RuntimeError):
            asyncio.run(backend.send_audio(b"\x00\x00"))

        self.assertEqual(factory.connections, [])


class CredentialHygieneTest(unittest.TestCase):
    def test_the_handshake_frame_is_never_logged_or_reprd(self):
        records: list[logging.LogRecord] = []

        class Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = Capture()
        root = logging.getLogger()
        previous_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            backend, factory = open_stt()
        finally:
            root.removeHandler(handler)
            root.setLevel(previous_level)

        # The credential really was on the wire, so the hygiene check is not
        # vacuous.
        self.assertIn("Bearer test-key", factory.socket.sent[0])
        logged = [record.getMessage() for record in records]
        self.assertEqual([line for line in logged if "test-key" in line], [])
        self.assertNotIn("test-key", repr(backend))


class RefusalTest(unittest.TestCase):
    def test_a_missing_api_key_is_refused_by_name_before_connecting(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        with mock.patch.dict(os.environ, {}, clear=True):
            backend = MetaStreamingSTT(call_id="call-123", socket_factory=factory)

            with self.assertRaises(RuntimeError) as raised:
                asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertIn("META_API_KEY", str(raised.exception))
        self.assertEqual(factory.connections, [])

    def test_a_sample_rate_other_than_the_declared_encoding_is_refused(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(UnsupportedSampleRateError) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=8000))

        self.assertIn("8000", str(raised.exception))
        self.assertIn("PCM_24KHZ", str(raised.exception))
        self.assertEqual(factory.connections, [])


if __name__ == "__main__":
    unittest.main()
