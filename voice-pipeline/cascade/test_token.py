"""The browser's token-only call config (ticket 65).

Seam: ``cascade.token.parse_browser_config`` for the one message the browser
may send, and ``cascade.token.StoredBodyChannel`` for the app -> service
handoff that carries the signed body (ticket 64). The browser never carries a
prompt, a tool list or a pipeline: a frame that does is refused by the name of
every offending key.

The signed body comes from ``cascade.envelope``; this test signs with the
pinned cross-language vector so the transport handoff is exercised on the same
bytes the app produces.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from cascade.envelope import (
    BodyHashMismatch,
    EnvelopeCallMismatch,
    EnvelopeExpired,
    EnvelopeSecretError,
    MalformedEnvelope,
    sign_body,
)
from cascade.testing import FakeClock
from cascade.token import (
    PROTOCOL_VERSION,
    BrowserConfig,
    ClientBodyRefusal,
    DuplicateCallToken,
    MalformedClientConfig,
    StoredBodyChannel,
    UnknownClientField,
    UnknownProtocolVersion,
    parse_browser_config,
)

VECTORS = json.loads(
    Path(__file__).with_name("envelope_vectors.json").read_text(encoding="utf-8")
)

BODY = VECTORS["body"]
ACCOUNT = VECTORS["account_salt"]
MINTED = VECTORS["minted_fingerprint"]
SECRET = VECTORS["secret"]
CALL_ID = VECTORS["call_id"]
AGENT_ID = VECTORS["agent_id"]
ISSUED_S = VECTORS["issued_at_ms"] / 1000.0
TTL_MS = VECTORS["expires_at_ms"] - VECTORS["issued_at_ms"]

TOKEN = "call-token-65"


def browser_config(**overrides) -> dict:
    config = {
        "type": "config",
        "protocolVersion": PROTOCOL_VERSION,
        "agentId": AGENT_ID,
        "callToken": TOKEN,
    }
    config.update(overrides)
    return config


def signed(**overrides):
    kwargs = dict(
        body=BODY,
        minted_fingerprint=MINTED,
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=CALL_ID,
        agent_id=AGENT_ID,
        ttl_ms=TTL_MS,
        clock=FakeClock(ISSUED_S),
    )
    kwargs.update(overrides)
    return sign_body(**kwargs)


def wire(signed_body) -> dict:
    """The message as it crosses the service channel: JSON in, JSON out."""
    return json.loads(json.dumps(signed_body.message()))


def channel(**overrides) -> StoredBodyChannel:
    options = dict(secret=SECRET, clock=FakeClock(ISSUED_S + 1))
    options.update(overrides)
    return StoredBodyChannel(**options)


class BrowserConfigTests(unittest.TestCase):
    def test_the_config_carries_only_the_token_agent_and_version(self):
        parsed = parse_browser_config(browser_config())

        self.assertEqual(
            parsed,
            BrowserConfig(
                call_token=TOKEN,
                agent_id=AGENT_ID,
                protocol_version=PROTOCOL_VERSION,
            ),
        )

    def test_a_client_assembled_body_is_refused_by_name(self):
        smuggled = (
            "pipeline",
            "system_prompt",
            "systemPrompt",
            "tools",
        )
        for field in smuggled:
            with self.subTest(field=field):
                message = browser_config(**{field: [] if field == "tools" else "x"})
                with self.assertRaises(ClientBodyRefusal) as caught:
                    parse_browser_config(message)
                self.assertEqual(caught.exception.fields, (field,))
                self.assertIn(f'"{field}"', str(caught.exception))
                self.assertIn("app assembles and signs the stored body", str(caught.exception))

    def test_every_client_body_key_is_named_at_once(self):
        message = browser_config(
            pipeline={"fallback_mode": "cascade"},
            system_prompt="Be brief.",
            tools=[],
        )
        with self.assertRaises(ClientBodyRefusal) as caught:
            parse_browser_config(message)
        self.assertEqual(caught.exception.fields, ("pipeline", "system_prompt", "tools"))

    def test_an_old_client_fails_on_the_protocol_version(self):
        # The pre-65 browser frame: a pipeline, a prompt and tools, no version.
        old_client = {
            "type": "config",
            "pipeline": {"fallback_mode": "cascade"},
            "system_prompt": "Be brief.",
            "tools": [],
            "agent_name": "Test",
        }
        with self.assertRaises(UnknownProtocolVersion) as caught:
            parse_browser_config(old_client)
        self.assertIsNone(caught.exception.version)
        self.assertIn("protocol version", str(caught.exception))
        self.assertIn(str(PROTOCOL_VERSION), str(caught.exception))

    def test_a_future_protocol_version_is_refused_not_guessed(self):
        for version in (0, PROTOCOL_VERSION + 1, True):
            with self.subTest(version=version):
                with self.assertRaises(UnknownProtocolVersion) as caught:
                    parse_browser_config(browser_config(protocolVersion=version))
                self.assertEqual(caught.exception.version, version)
                self.assertIn("protocol version", str(caught.exception))

    def test_an_unknown_client_key_is_refused_by_name(self):
        # The snake_case spelling is the half-changed app: refuse it by name
        # rather than silently dropping it and running an unidentified call.
        for field in ("agent_id", "call_token", "agentName", "foo"):
            with self.subTest(field=field):
                with self.assertRaises(UnknownClientField) as caught:
                    parse_browser_config(browser_config(**{field: "x"}))
                self.assertEqual(caught.exception.field, field)
                self.assertIn(f'"{field}"', str(caught.exception))

    def test_identity_fields_must_be_non_empty_strings(self):
        for field in ("agentId", "callToken"):
            for value in ("", "   ", 5, None):
                with self.subTest(field=field, value=value):
                    with self.assertRaises(MalformedClientConfig) as caught:
                        parse_browser_config(browser_config(**{field: value}))
                    self.assertEqual(caught.exception.field, field)

    def test_a_non_config_message_is_refused(self):
        with self.assertRaises(MalformedClientConfig):
            parse_browser_config({"type": "audio"})
        with self.assertRaises(MalformedClientConfig):
            parse_browser_config(["config"])


class StoredBodyChannelTests(unittest.TestCase):
    def test_the_app_delivers_the_body_and_the_token_claims_it_once(self):
        store = channel()

        delivered = store.deliver(
            call_token=TOKEN, call_id=CALL_ID, message=wire(signed())
        )
        # The service verified the envelope and the body hash before returning.
        self.assertEqual(delivered.body, BODY)
        self.assertEqual(delivered.agent_id, AGENT_ID)
        self.assertEqual(delivered.body_hash, VECTORS["body_hash"])

        claimed = store.claim(TOKEN)
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed.body, BODY)
        # One token serves one socket: a second connect cannot reuse it.
        self.assertIsNone(store.claim(TOKEN))

    def test_an_unknown_token_has_no_body(self):
        self.assertIsNone(channel().claim("never-delivered"))

    def test_a_body_signed_for_another_call_is_refused_by_name(self):
        store = channel()
        with self.assertRaises(EnvelopeCallMismatch) as caught:
            store.deliver(
                call_token=TOKEN,
                call_id="another_call_65",
                message=wire(signed(call_id=CALL_ID)),
            )
        self.assertIn(f'"{CALL_ID}"', str(caught.exception))
        self.assertIsNone(store.claim(TOKEN))

    def test_a_body_whose_hash_does_not_match_is_refused_by_name(self):
        message = wire(signed())
        message["body"] = {**message["body"], "system_prompt": "You are someone else."}

        store = channel()
        with self.assertRaises(BodyHashMismatch) as caught:
            store.deliver(call_token=TOKEN, call_id=CALL_ID, message=message)
        self.assertIn("body hash", str(caught.exception))
        self.assertIsNone(store.claim(TOKEN))

    def test_an_expired_body_is_refused(self):
        store = channel(clock=FakeClock(VECTORS["expires_at_ms"] / 1000.0 + 1))
        with self.assertRaises(EnvelopeExpired):
            store.deliver(call_token=TOKEN, call_id=CALL_ID, message=wire(signed()))

    def test_a_delivered_token_cannot_be_re_pointed_at_a_second_body(self):
        store = channel()
        store.deliver(call_token=TOKEN, call_id=CALL_ID, message=wire(signed()))
        with self.assertRaises(DuplicateCallToken):
            store.deliver(call_token=TOKEN, call_id=CALL_ID, message=wire(signed()))

    def test_the_channel_refuses_to_hold_a_body_without_a_secret(self):
        with self.assertRaises(EnvelopeSecretError):
            StoredBodyChannel(secret="")

    def test_an_unsigned_message_is_refused(self):
        store = channel()
        with self.assertRaises(MalformedEnvelope) as caught:
            store.deliver(call_token=TOKEN, call_id=CALL_ID, message={"body": BODY})
        self.assertIn('"envelope"', str(caught.exception))
        self.assertIsNone(store.claim(TOKEN))


if __name__ == "__main__":
    unittest.main()
