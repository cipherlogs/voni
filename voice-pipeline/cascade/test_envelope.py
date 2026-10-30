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

import hashlib
import hmac
import json
import unittest
from pathlib import Path

from cascade import thresholds
from cascade.body_map import BodyFingerprintMismatch, adapt_body, stable_json
from cascade.envelope import (
    ENVELOPE_VERSION,
    ENVELOPE_VERSION_SUBJECT_KIND,
    LEGACY_SUBJECT_KIND,
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
    UnknownSubjectKind,
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

# The version 2 demo vector ticket 01 pinned: same secret and account salt,
# different claims (a `kind`) and therefore a different signature.
V2 = VECTORS["v2_demo"]
V2_BODY = V2["body"]
V2_CALL_ID = V2["call_id"]
V2_AGENT_ID = V2["agent_id"]
V2_ISSUED_S = V2["issued_at_ms"] / 1000.0


def v2_wire(*, kind=V2["kind"], signature=V2["signature"]) -> dict:
    """The pinned v2 demo message as JSON, with one claim swappable."""
    envelope = {
        "version": V2["version"],
        "kind": kind,
        "call_id": V2_CALL_ID,
        "agent_id": V2_AGENT_ID,
        "body_hash": V2["body_hash"],
        "issued_at_ms": V2["issued_at_ms"],
        "expires_at_ms": V2["expires_at_ms"],
        "signature": signature,
    }
    return json.loads(json.dumps({"envelope": envelope, "body": V2_BODY}))


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


def sign_version_two(
    *,
    kind: str = "tenant",
    agent_id: str = AGENT_ID,
    ttl_ms: int = TTL_MS,
    call_id: str = CALL_ID,
    clock=None,
    body=None,
):
    """Sign a v2 envelope: the claims add the kind, and the HMAC covers it."""
    return sign_body(
        body=BODY if body is None else body,
        minted_fingerprint=MINTED,
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=call_id,
        agent_id=agent_id,
        kind=kind,
        ttl_ms=ttl_ms,
        clock=clock or FakeClock(ISSUED_S),
    )


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


class SubjectKindSigningTests(unittest.TestCase):
    def test_signing_with_a_kind_seals_a_version_two_envelope(self):
        signed = sign_version_two(kind="demo", agent_id=V2_AGENT_ID)

        self.assertEqual(signed.envelope.version, ENVELOPE_VERSION_SUBJECT_KIND)
        self.assertEqual(signed.envelope.kind, "demo")
        self.assertEqual(
            set(signed.envelope.claims()),
            {
                "version",
                "kind",
                "call_id",
                "agent_id",
                "body_hash",
                "issued_at_ms",
                "expires_at_ms",
            },
        )

        verified = verify_envelope(
            wire(signed),
            secret=SECRET,
            call_id=CALL_ID,
            clock=FakeClock(ISSUED_S + 1),
        )
        self.assertEqual(verified.subject_kind, "demo")
        self.assertEqual(verified.agent_id, V2_AGENT_ID)

    def test_the_hmac_covers_the_kind_the_app_signs(self):
        message = wire(sign_version_two(kind="demo"))
        message["envelope"]["kind"] = "tenant"

        with self.assertRaises(EnvelopeSignatureMismatch):
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

    def test_signing_without_a_kind_keeps_the_pinned_version_one_envelope(self):
        envelope = sign().envelope

        self.assertEqual(envelope.version, ENVELOPE_VERSION)
        self.assertIsNone(envelope.kind)
        self.assertEqual(envelope.signature, VECTORS["signature"])

    def test_signing_refuses_a_kind_the_service_does_not_serve(self):
        with self.assertRaises(UnknownSubjectKind) as caught:
            sign_version_two(kind="admin")

        self.assertEqual(caught.exception.kind, "admin")


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
        message["envelope"]["version"] = ENVELOPE_VERSION_SUBJECT_KIND + 1

        with self.assertRaises(UnknownEnvelopeVersion) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.version, ENVELOPE_VERSION_SUBJECT_KIND + 1)

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


class SubjectKindTests(unittest.TestCase):
    """Ticket 02: v2 names its subject kind, v1 is read as tenant."""

    def verify(self, message: dict):
        return verify_envelope(
            message,
            secret=SECRET,
            call_id=V2_CALL_ID,
            clock=FakeClock(V2_ISSUED_S + 1),
        )

    def signed_v2(self, *, kind: str) -> dict:
        """A v2 message signed over an arbitrary kind, computed independently."""
        claims = {
            "version": ENVELOPE_VERSION_SUBJECT_KIND,
            "kind": kind,
            "call_id": V2_CALL_ID,
            "agent_id": V2_AGENT_ID,
            "body_hash": V2["body_hash"],
            "issued_at_ms": V2["issued_at_ms"],
            "expires_at_ms": V2["expires_at_ms"],
        }
        signature = hmac.new(
            SECRET.encode("utf-8"), stable_json(claims).encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return json.loads(
            json.dumps({"envelope": {**claims, "signature": signature}, "body": V2_BODY})
        )

    def test_the_pinned_version_two_demo_vector_verifies_and_reports_demo(self):
        verified = verify_envelope(
            v2_wire(),
            secret=SECRET,
            call_id=V2_CALL_ID,
            clock=FakeClock(V2_ISSUED_S + 1),
        )

        self.assertEqual(verified.envelope.version, ENVELOPE_VERSION_SUBJECT_KIND)
        self.assertEqual(verified.envelope.kind, "demo")
        self.assertEqual(verified.subject_kind, "demo")
        self.assertEqual(verified.agent_id, V2_AGENT_ID)
        self.assertEqual(verified.body, V2_BODY)
        self.assertEqual(verified.body_hash, V2["body_hash"])

    def test_the_pinned_version_one_vector_still_verifies_and_reports_tenant(self):
        # The committed v1 wire message, signature and all: the rollout window
        # keeps an old app working, and v1 never claims a kind.
        verified = verify_envelope(
            wire(sign()),
            secret=SECRET,
            call_id=CALL_ID,
            clock=FakeClock(ISSUED_S + 1),
        )

        self.assertEqual(verified.envelope.version, ENVELOPE_VERSION)
        self.assertIsNone(verified.envelope.kind)
        self.assertEqual(verified.subject_kind, LEGACY_SUBJECT_KIND)
        self.assertNotIn("kind", verified.envelope.claims())

    def test_a_version_two_envelope_without_a_kind_is_refused_and_never_defaulted(self):
        message = v2_wire()
        del message["envelope"]["kind"]

        with self.assertRaises(MalformedEnvelope) as caught:
            self.verify(message)

        self.assertEqual(caught.exception.field, "kind")
        self.assertIn("missing", str(caught.exception))

    def test_a_version_two_envelope_with_a_non_string_kind_is_refused_by_name(self):
        for kind in (None, 2, True, ["demo"], {"value": "demo"}):
            with self.subTest(kind=kind):
                with self.assertRaises(MalformedEnvelope) as caught:
                    self.verify(v2_wire(kind=kind))

                self.assertEqual(caught.exception.field, "kind")

    def test_a_tampered_kind_fails_the_hmac_before_any_semantic_check(self):
        # The signature covers the kind: swapping it — even to another served
        # kind — is a signature mismatch, not a kind refusal.
        for kind in ("tenant", "admin"):
            with self.subTest(kind=kind):
                with self.assertRaises(EnvelopeSignatureMismatch):
                    self.verify(v2_wire(kind=kind))

    def test_a_correctly_signed_unknown_kind_is_refused_by_name_after_the_hmac(self):
        with self.assertRaises(UnknownSubjectKind) as caught:
            self.verify(self.signed_v2(kind="admin"))

        self.assertEqual(caught.exception.kind, "admin")
        self.assertIn('"kind"', str(caught.exception))

    def test_a_version_one_envelope_carrying_a_kind_is_still_refused(self):
        message = wire(sign())
        message["envelope"]["kind"] = "tenant"

        with self.assertRaises(MalformedEnvelope) as caught:
            verify_envelope(
                message,
                secret=SECRET,
                call_id=CALL_ID,
                clock=FakeClock(ISSUED_S + 1),
            )

        self.assertEqual(caught.exception.field, "kind")
        self.assertIn("is not a signed claim", str(caught.exception))

    def test_a_version_two_envelope_carrying_another_unknown_claim_is_refused(self):
        message = v2_wire()
        message["envelope"]["subject_kind"] = "demo"

        with self.assertRaises(MalformedEnvelope) as caught:
            self.verify(message)

        self.assertEqual(caught.exception.field, "subject_kind")
        self.assertIn("is not a signed claim", str(caught.exception))

    def test_from_dict_accepts_both_pinned_shapes(self):
        legacy = Envelope.from_dict(wire(sign())["envelope"])
        current = Envelope.from_dict(v2_wire()["envelope"])

        self.assertEqual(legacy.version, ENVELOPE_VERSION)
        self.assertIsNone(legacy.kind)
        self.assertEqual(current.version, ENVELOPE_VERSION_SUBJECT_KIND)
        self.assertEqual(current.kind, "demo")
        self.assertEqual(current.to_dict(), v2_wire()["envelope"])


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
