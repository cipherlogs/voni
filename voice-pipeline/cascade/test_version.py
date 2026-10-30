"""The service reports what it is running, and never reports a secret (141).

Seams:

* ``cascade.version`` — the one place a build version is read, and the protocol
  version it re-exports from :mod:`cascade.token` (ticket 138 owns that logic;
  this module must not grow a second copy of it).
* ``GET /healthz`` and the browser socket's end message — the two places the
  spec says the report appears.
* the log gate from ticket 137 — a line that carries a host secret is refused,
  so "secrets are never logged" is proved rather than promised.

The deployment artifact's own checks (app/service versions, a protocol mismatch
being a deploy error, the repository secret scan) are in
``voice-pipeline/test_deploy_versions.py``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import unittest
from io import StringIO
from unittest import mock

from cascade.testing import FakeClock
from cascade.token import PROTOCOL_VERSION, CallTokenRegistry, StoredBodyChannel, mint_call_token
from cascade.version import (
    BUILD_VERSION_ENV,
    IMAGE_REF_ENV,
    SERVICE_NAME,
    UNVERSIONED,
    build_source,
    build_version,
    version_document,
)

SECRET = "test-only-version-secret"
ACCOUNT = "acct_test_141"
CALL_ID = "call_version_141"
AGENT_ID = "agent_version_141"
CLOCK = FakeClock(1_000_000.0)
TOKEN = mint_call_token(
    secret=SECRET,
    call_id=CALL_ID,
    subject=AGENT_ID,
    clock=CLOCK,
    nonce="version-token-141",
)

BODY = {
    "name": "version-agent",
    "system_prompt": "You are the signed body's agent.",
    "greeting": "Hola.",
    "voice": {"voice_id": "lola"},
    "input": {
        "format": "pcm_24000",
        "language_codes": ["es"],
        "transcription_mode": "accurate",
        "transcription_prompt": "",
        "keyterms": ["Voni"],
        "voice_focus": "near-field",
        "voice_focus_threshold": 0.4,
        "turn_detection": None,
    },
    "output": {"voice": "lola", "format": "pcm_24000", "volume": 0.851},
    "tools": [],
    "llm": [],
}


class BuildVersionTests(unittest.TestCase):
    def test_the_build_is_read_from_the_host_environment(self):
        self.assertEqual(
            build_version({BUILD_VERSION_ENV: "2026.10.30-abc1234"}), "2026.10.30-abc1234"
        )
        self.assertEqual(build_source({BUILD_VERSION_ENV: "v1"}), BUILD_VERSION_ENV)

    def test_the_image_reference_is_the_fallback(self):
        self.assertEqual(
            build_version({IMAGE_REF_ENV: "registry.fly.io/voni-voice-pipeline:abc"}),
            "registry.fly.io/voni-voice-pipeline:abc",
        )
        self.assertEqual(
            build_source({IMAGE_REF_ENV: "registry.fly.io/voni-voice-pipeline:abc"}),
            IMAGE_REF_ENV,
        )

    def test_an_unversioned_build_is_named_rather_than_guessed(self):
        self.assertEqual(build_version({}), UNVERSIONED)
        self.assertEqual(build_source({}), "none")
        self.assertEqual(build_version({BUILD_VERSION_ENV: "   "}), UNVERSIONED)

    def test_the_protocol_version_is_ticket_138s_number_not_a_second_copy(self):
        from pathlib import Path

        import cascade.token as token
        import cascade.version as version

        self.assertIs(version.PROTOCOL_VERSION, token.PROTOCOL_VERSION)
        source = Path(version.__file__).read_text(encoding="utf-8")
        self.assertNotIn(
            "PROTOCOL_VERSION = ",
            source,
            "cascade.version must import the protocol version, not restate it",
        )

    def test_the_document_is_the_two_reports_and_their_source(self):
        document = version_document({BUILD_VERSION_ENV: "abc123"})

        self.assertEqual(document["service"], SERVICE_NAME)
        self.assertEqual(document["buildVersion"], "abc123")
        self.assertEqual(document["buildSource"], BUILD_VERSION_ENV)
        self.assertEqual(document["protocolVersion"], PROTOCOL_VERSION)

    def test_the_version_and_its_source_resolve_the_same_entry(self):
        both = {BUILD_VERSION_ENV: "local-build", IMAGE_REF_ENV: "registry/img:abc"}
        self.assertEqual("local-build", build_version(both))
        self.assertEqual(BUILD_VERSION_ENV, build_source(both))

        blank_primary = {BUILD_VERSION_ENV: "   ", IMAGE_REF_ENV: "registry/img:abc"}
        self.assertEqual("registry/img:abc", build_version(blank_primary))
        self.assertEqual(IMAGE_REF_ENV, build_source(blank_primary))

        self.assertEqual("v1", build_version({BUILD_VERSION_ENV: " v1 "}))

    def test_one_loop_decides_which_source_supplies_the_build(self):
        from pathlib import Path

        import cascade.version as version

        source = Path(version.__file__).read_text(encoding="utf-8")
        self.assertEqual(
            1,
            source.count("for name in BUILD_SOURCES"),
            "build_version and build_source must share one source-resolution "
            "loop, not each walk BUILD_SOURCES",
        )


class HealthReportTests(unittest.TestCase):
    def client(self):
        from fastapi.testclient import TestClient

        from server import create_app

        return TestClient(create_app(envelope_secret="", clock=lambda: 1_000_000.0))

    def test_healthz_reports_the_build_and_the_protocol_version(self):
        with mock.patch.dict(os.environ, {BUILD_VERSION_ENV: "build-141"}):
            body = self.client().get("/healthz").json()

        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], SERVICE_NAME)
        self.assertEqual(body["buildVersion"], "build-141")
        self.assertEqual(body["buildSource"], BUILD_VERSION_ENV)
        self.assertEqual(body["protocolVersion"], PROTOCOL_VERSION)

    def test_healthz_says_unversioned_when_the_host_supplies_no_build(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            body = self.client().get("/healthz").json()

        self.assertEqual(body["buildVersion"], UNVERSIONED)
        self.assertEqual(body["buildSource"], "none")


class FakeDisconnect(Exception):
    pass


class FakeWebSocket:
    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        await asyncio.sleep(0)
        if not self._inbound:
            raise FakeDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, message: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(message)


class FakeSTT:
    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        pass

    async def send_audio(self, pcm: bytes) -> None:
        pass

    async def events(self):
        return
        yield

    async def close(self) -> None:
        pass


class FakeLLM:
    async def complete(self, *, messages, tools=None, turn=None):
        return
        yield


class FakeTTS:
    def __init__(self) -> None:
        from cascade.voice_binding import bind_voice

        self.binding = bind_voice("lola")

    async def open(self) -> None:
        pass

    async def speak(self, text: str):
        return
        yield

    async def speak_greeting(self, text: str):
        from providers import SentenceAudio

        yield SentenceAudio(pcm=b"\x01\x00", sample_rate=24000, text=text)

    async def close(self) -> None:
        pass


class FakeLegs:
    """Constructed legs for the end-message test; no vendor socket opens."""

    def __init__(self) -> None:
        from cascade.call import OpenedLeg

        self._opened = OpenedLeg
        self.speech = FakeSTT()
        self.voice = FakeTTS()
        self.model = FakeLLM()

    async def open_speech(self, body):
        await self.speech.open(language_codes=[], sample_rate=24000)
        return self._opened("stt", "meta", "primary", "speech rung", self.speech)

    async def open_voice(self, body):
        await self.voice.open()
        return self._opened("tts", "assemblyai", "primary", "voice rung", self.voice)

    async def open_model(self, body):
        return self._opened("llm", "spark", "primary", "model rung", self.model)


def signed_message() -> dict:
    from cascade.body_map import body_fingerprint
    from cascade.envelope import sign_body

    signed = sign_body(
        body=BODY,
        minted_fingerprint=body_fingerprint(BODY, account_salt=ACCOUNT),
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=CALL_ID,
        agent_id=AGENT_ID,
        ttl_ms=60_000,
        clock=CLOCK,
    )
    return json.loads(json.dumps(signed.message()))


def end_message() -> dict:
    from cascade.routing import KEY as ROUTING_KEY
    from cascade.routing import RoutingRecord, RoutingSwitch
    from cascade.store import MemoryStore, StoredDocument
    from transport import handle_browser_call

    channel = StoredBodyChannel(secret=SECRET, clock=CLOCK)
    channel.deliver(call_token=TOKEN, call_id=CALL_ID, message=signed_message())
    config = {
        "type": "config",
        "protocolVersion": PROTOCOL_VERSION,
        "agentId": AGENT_ID,
        "callToken": TOKEN,
    }

    async def run():
        store = MemoryStore()
        record = RoutingRecord.seeded("all", actor="version-test", at=CLOCK())
        await store.compare_and_set(
            ROUTING_KEY, None, StoredDocument(version=1, document=record.to_document())
        )
        ws = FakeWebSocket([config, {"type": "stop"}])
        await handle_browser_call(
            ws,
            config_message=config,
            body_channel=channel,
            call_tokens=CallTokenRegistry(secret=SECRET, clock=FakeClock(1_000_001.0)),
            switch=RoutingSwitch(store, now=CLOCK),
            secret=SECRET,
            envelope_clock=CLOCK,
            leg_builder=lambda body, raw: FakeLegs(),
        )
        return ws

    ws = asyncio.run(run())
    ends = [message for message in ws.sent if message["type"] == "end"]
    assert len(ends) == 1, ws.sent
    return ends[0]


class EndMessageReportTests(unittest.TestCase):
    def test_the_end_message_reports_the_build_and_the_protocol_version(self):
        with mock.patch.dict(os.environ, {BUILD_VERSION_ENV: "build-141"}):
            message = end_message()

        self.assertEqual(message["buildVersion"], "build-141")
        self.assertEqual(message["protocolVersion"], PROTOCOL_VERSION)

    def test_the_end_message_names_an_unversioned_build(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            message = end_message()

        self.assertEqual(message["buildVersion"], UNVERSIONED)


class SecretEmissionTests(unittest.TestCase):
    """Nothing the service emits may carry a host secret, by value or by name."""

    SECRETS = {
        "META_API_KEY": "meta-key-value-141",
        "VOICE_PIPELINE_ENVELOPE_SECRET": SECRET,
        "DATABASE_URL": "postgres://cascade:hunter2@db.internal/voni",
    }

    def test_the_health_and_end_reports_carry_no_secret_value(self):
        from fastapi.testclient import TestClient

        from server import create_app

        with mock.patch.dict(os.environ, self.SECRETS):
            health = TestClient(
                create_app(envelope_secret="", clock=lambda: 1_000_000.0)
            ).get("/healthz")
            emitted = json.dumps({"health": health.json(), "end": end_message()})

        for name, value in self.SECRETS.items():
            self.assertNotIn(value, emitted, f"{name}'s value reached a report")

    def test_a_log_line_that_carries_a_secret_fails(self):
        from cascade.log_redaction import install_log_redaction

        stream = StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("cascade.test.version.secret")
        logger.propagate = False
        logger.setLevel(logging.DEBUG)
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)

        with mock.patch.dict(os.environ, self.SECRETS):
            install_log_redaction()
            logger.info("service boot key %s", self.SECRETS["META_API_KEY"])

        emitted = stream.getvalue()
        self.assertNotIn(self.SECRETS["META_API_KEY"], emitted)
        self.assertIn("[redacted]", emitted)


if __name__ == "__main__":
    unittest.main()
