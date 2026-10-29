"""Behaviour of the signed body envelope (ticket 64).

Seam: ``cascade.envelope.sign_body`` (app side) and
``cascade.envelope.verify_envelope`` (service side). The app hands the served
body, the fingerprint it minted and the secret to ``sign_body`` and gets one
wire message — ``{"envelope": …, "body": …}``. The service hands that message,
the call id the browser's token names and the secret to ``verify_envelope``
and gets the verified body, or a named refusal.

Every refusal in this module happens before a vendor socket could open: the
module is pure (no I/O, no sockets) and the only clock it reads is the one the
caller injects.

Expected values come from independent sources:

- the signature and both hashes in ``envelope_vectors.json`` were computed
  with Node's ``crypto`` (canonical JSON + SHA-256/HMAC-SHA-256) and the
  signature was cross-checked with ``openssl dgst -sha256 -hmac``, so this
  test fails if Python's canonical form or HMAC drifts from the app's;
- the open TTL is read from ``cascade.thresholds``, never restated here.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from cascade import thresholds
from cascade.body_map import BodyFingerprintMismatch, adapt_body
from cascade.envelope import (
    ENVELOPE_VERSION,
    TOKEN_TTL_BOUND,
    BodyHashMismatch,
    Envelope,
    EnvelopeCallMismatch,
    EnvelopeExpired,
    EnvelopeIdentityError,
    EnvelopeSecretError,
    EnvelopeSignatureMismatch,
    MalformedEnvelope,
    UnknownEnvelopeVersion,
    sign_body,
    verify_envelope,
)
from cascade.testing import FakeClock

VECTORS = json.loads(
    Path(__file__).with_name("envelope_vectors.json").read_text(encoding="utf-8")
)

# A body the adapter can read and the signed envelope can carry.
BODY = VECTORS["body"]
ACCOUNT = VECTORS["account_salt"]
MINTED = VECTORS["minted_fingerprint"]
SECRET = VECTORS["secret"]
CALL_ID = VECTORS["call_id"]
AGENT_ID = VECTORS["agent_id"]
# Test-only TTL: the production envelope TTL is the open bound, never this.
TTL_MS = VECTORS["expires_at_ms"] - VECTORS["issued_at_ms"]
ISSUED_S = VECTORS["issued_at_ms"] / 1000.0


def sign(*, ttl_ms: int = TTL_MS, call_id: str = CALL_ID, clock=None, body=None):
    return sign_body(
        body=BODY if body is None else body,
        minted_fingerprint=MINTED,
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=call_id,
        agent_id=AGENT_ID,
        ttl_ms=ttl_ms,
        clock=clock or FakeClock(ISSUED_S),
    )


def wire(signed) -> dict:
    """The message as it crosses the service channel: JSON in, JSON out."""
    return json.loads(json.dumps(signed.message()))


class SigningTests(unittest.TestCase):
    def test_the_app_signs_the_body_hash_and_the_call_identity(self):
        signed = sign()
        envelope = signed.envelope

        self.assertEqual(envelope.version, ENVELOPE_VERSION)
        self.assertEqual(envelope.call_id, CALL_ID)
        self.assertEqual(envelope.agent_id, AGENT_ID)
        self.assertEqual(envelope.body_hash, VECTORS["body_hash"])
        self.assertEqual(envelope.issued_at_ms, VECTORS["issued_at_ms"])
        self.assertEqual(envelope.expires_at_ms, VECTORS["expires_at_ms"])
        self.assertEqual(len(envelope.signature), 64)
        self.assertEqual(signed.message()["body"], BODY)

    def test_the_python_envelope_equals_the_pinned_cross_language_vector(self):
        # Node's crypto + openssl produced these bytes; Python must agree or
        # the app's signature will not verify at the service.
        envelope = sign().envelope

        self.assertEqual(envelope.body_hash, VECTORS["body_hash"])
        self.assertEqual(envelope.signature, VECTORS["signature"])
        self.assertEqual(
            envelope.claims(),
            {
                "version": ENVELOPE_VERSION,
                "call_id": CALL_ID,
                "agent_id": AGENT_ID,
                "body_hash": VECTORS["body_hash"],
                "issued_at_ms": VECTORS["issued_at_ms"],
                "expires_at_ms": VECTORS["expires_at_ms"],
            },
        )

    def test_signing_refuses_a_body_that_is_not_the_fingerprinted_one(self):
        intended = {**BODY, "system_prompt": "You are Voni, but different."}

        with self.assertRaises(BodyFingerprintMismatch) as caught:
            sign_body(
                body=intended,
                minted_fingerprint=MINTED,
                account_salt=ACCOUNT,
                secret=SECRET,
                call_id=CALL_ID,
                agent_id=AGENT_ID,
                ttl_ms=TTL_MS,
                clock=FakeClock(ISSUED_S),
            )

        self.assertIn("full fingerprint", str(caught.exception))

    def test_an_omitted_ttl_is_read_from_the_registry_not_invented(self):
        entry = thresholds.bound(TOKEN_TTL_BOUND)
        self.assertEqual(entry.ticket, "04")
        self.assertEqual(entry.unit, "ms")

        if entry.is_open:
            # Ticket 04 has not supplied the number yet: the envelope refuses
            # to mint rather than guessing one.
            with self.assertRaises(thresholds.UnsetBoundError) as caught:
                sign_body(
                    body=BODY,
                    minted_fingerprint=MINTED,
                    account_salt=ACCOUNT,
                    secret=SECRET,
                    call_id=CALL_ID,
                    agent_id=AGENT_ID,
                    clock=FakeClock(ISSUED_S),
                )
            self.assertEqual(caught.exception.name, TOKEN_TTL_BOUND)
            self.assertIn("ticket 04", str(caught.exception))
        else:
            signed = sign_body(
                body=BODY,
                minted_fingerprint=MINTED,
                account_salt=ACCOUNT,
                secret=SECRET,
                call_id=CALL_ID,
                agent_id=AGENT_ID,
                clock=FakeClock(ISSUED_S),
            )
            self.assertEqual(
                signed.envelope.expires_at_ms - signed.envelope.issued_at_ms,
                entry.value,
            )

    def test_signing_refuses_an_empty_secret(self):
        for secret in ("", b""):
            with self.subTest(secret=secret):
                with self.assertRaises(EnvelopeSecretError):
                    sign_body(
                        body=BODY,
                        minted_fingerprint=MINTED,
                        account_salt=ACCOUNT,
                        secret=secret,
                        call_id=CALL_ID,
                        agent_id=AGENT_ID,
                        ttl_ms=TTL_MS,
                        clock=FakeClock(ISSUED_S),
                    )

    def test_signing_refuses_an_identity_that_cannot_bind_a_call(self):
        with self.assertRaises(EnvelopeIdentityError):
            sign_body(
                body=BODY,
                minted_fingerprint=MINTED,
                account_salt=ACCOUNT,
                secret=SECRET,
                call_id="",
                agent_id=AGENT_ID,
                ttl_ms=TTL_MS,
                clock=FakeClock(ISSUED_S),
            )


class VerificationTests(unittest.TestCase):
    def test_the_service_verifies_the_envelope_and_the_body_hash(self):
        clock = FakeClock(ISSUED_S + 1)

        verified = verify_envelope(wire(sign()), secret=SECRET, call_id=CALL_ID, clock=clock)

        self.assertEqual(verified.body, BODY)
        self.assertEqual(verified.body_hash, VECTORS["body_hash"])
        self.assertEqual(verified.call_id, CALL_ID)
        self.assertEqual(verified.agent_id, AGENT_ID)
        self.assertEqual(verified.envelope.version, ENVELOPE_VERSION)

    def test_the_verified_body_is_what_the_adapter_reads(self):
        clock = FakeClock(ISSUED_S + 1)

        verified = verify_envelope(wire(sign()), secret=SECRET, call_id=CALL_ID, clock=clock)
        config = adapt_body(verified.body)

        self.assertEqual(config.system_prompt, BODY["system_prompt"])
        self.assertEqual(config.voice_id, "lola")
        self.assertEqual(config.speech_language_bias, ("Spanish",))

    def test_a_body_whose_hash_does_not_match_is_refused_by_name(self):
        message = wire(sign())
        message["body"] = {**BODY, "system_prompt": "You are Voni, but injected."}

        with self.assertRaises(BodyHashMismatch) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.call_id, CALL_ID)
        self.assertEqual(caught.exception.declared, VECTORS["body_hash"])
        self.assertNotEqual(caught.exception.served, VECTORS["body_hash"])
        self.assertIn("does not match", str(caught.exception))
        self.assertNotIn("injected", str(caught.exception))

    def test_a_tampered_envelope_claim_is_refused_by_name(self):
        message = wire(sign())
        message["envelope"]["expires_at_ms"] += 1

        with self.assertRaises(EnvelopeSignatureMismatch):
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

    def test_a_wrong_secret_is_refused_by_name(self):
        with self.assertRaises(EnvelopeSignatureMismatch):
            verify_envelope(
                wire(sign()),
                secret="not-the-service-secret",
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

    def test_the_envelope_cannot_be_replayed_onto_another_call_id(self):
        message = wire(sign())

        with self.assertRaises(EnvelopeCallMismatch) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id="call_somebody_else",
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.expected, "call_somebody_else")
        self.assertEqual(caught.exception.envelope_call_id, CALL_ID)

    def test_an_expired_envelope_is_refused_against_the_injected_clock(self):
        message = wire(sign())

        # Just inside the TTL: accepted.
        verify_envelope(
            message,
            secret=SECRET,
            call_id=CALL_ID,
            clock=FakeClock((VECTORS["expires_at_ms"] - 1) / 1000.0),
        )

        # At the expiry instant and past it: refused by name.
        for at_ms in (VECTORS["expires_at_ms"], VECTORS["expires_at_ms"] + 60_000):
            with self.subTest(at_ms=at_ms):
                with self.assertRaises(EnvelopeExpired) as caught:
                    verify_envelope(
                        message,
                        secret=SECRET,
                        call_id=CALL_ID,
                        clock=FakeClock(at_ms / 1000.0),
                    )
                self.assertEqual(caught.exception.call_id, CALL_ID)

    def test_an_unknown_envelope_version_is_refused_by_name(self):
        message = wire(sign())
        message["envelope"]["version"] = ENVELOPE_VERSION + 1

        with self.assertRaises(UnknownEnvelopeVersion) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.version, ENVELOPE_VERSION + 1)

    def test_a_missing_envelope_claim_is_refused_by_name(self):
        message = wire(sign())
        del message["envelope"]["body_hash"]

        with self.assertRaises(MalformedEnvelope) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.field, "body_hash")

    def test_a_message_missing_the_body_is_refused_by_name(self):
        message = wire(sign())
        del message["body"]

        with self.assertRaises(MalformedEnvelope) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.field, "body")

    def test_envelope_parsing_is_the_same_check_as_verification(self):
        envelope = sign().envelope

        self.assertEqual(Envelope.from_dict(envelope.to_dict()), envelope)
        self.assertEqual(envelope.signature, sign().envelope.signature)


class SecrecyTests(unittest.TestCase):
    def test_neither_secret_nor_raw_body_appears_in_errors_or_logs(self):
        clock = FakeClock(ISSUED_S + 1)
        signed = sign()

        with self.assertNoLogs():
            message = wire(signed)
            message["body"] = {**BODY, "system_prompt": "You are Voni, but injected."}
            with self.assertRaises(BodyHashMismatch) as caught:
                verify_envelope(message, secret=SECRET, call_id=CALL_ID, clock=clock)

        for rendered in (str(caught.exception), repr(caught.exception), repr(signed)):
            self.assertNotIn(SECRET, rendered)
            self.assertNotIn("injected", rendered)
            self.assertNotIn(ACCOUNT, rendered)

    def test_the_wire_message_never_carries_the_secret_or_the_account_salt(self):
        rendered = json.dumps(wire(sign()), sort_keys=True)

        self.assertNotIn(SECRET, rendered)
        self.assertNotIn(ACCOUNT, rendered)
        self.assertEqual(set(json.loads(rendered)), {"envelope", "body"})


if __name__ == "__main__":
    unittest.main()
