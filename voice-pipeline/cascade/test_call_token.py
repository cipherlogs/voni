"""The short-TTL call token that binds one call to one subject (ticket 136).

Seam: ``cascade.token.mint_call_token`` / ``verify_call_token`` for the one
credential the app mints and the service verifies at connect, and
``cascade.token.CallTokenRegistry`` for the one-claim, one-socket-per-call rule.

The token reuses ticket 64's signing construction — canonical JSON claims and
an HMAC-SHA256 hex signature under the envelope secret — so there is one
signature scheme. ``call_token_vectors.json`` was produced by Node's crypto and
pins that the app's signer and this verifier agree byte for byte.

Nothing here logs: every refusal names the claim, never the token, so an error
line is never a credential.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from cascade.testing import FakeClock
from cascade.thresholds import require_bound
from cascade.token import (
    CALL_TOKEN_TTL_BOUND,
    CallAlreadyConnected,
    CallTokenCallMismatch,
    CallTokenClaims,
    CallTokenExpired,
    CallTokenRegistry,
    CallTokenReplayed,
    CallTokenSecretError,
    CallTokenSubjectMismatch,
    CallTokenSignatureMismatch,
    UnknownCallTokenVersion,
    MalformedCallToken,
    mint_call_token,
    verify_call_token,
)

VECTORS = json.loads(
    Path(__file__).with_name("call_token_vectors.json").read_text(encoding="utf-8")
)

SECRET = "test-only-call-token-secret"
CALL_ID = "call_136"
SUBJECT = "agent_136"
NOW_S = 1_000_000.0
TTL_MS = int(require_bound("call_token.ttl_ms"))


def mint(**overrides) -> str:
    kwargs = dict(
        secret=SECRET,
        call_id=CALL_ID,
        subject=SUBJECT,
        clock=FakeClock(NOW_S),
        nonce="nonce-136",
    )
    kwargs.update(overrides)
    return mint_call_token(**kwargs)


def verify(token: str | None = None, **overrides):
    kwargs = dict(
        secret=SECRET,
        call_id=CALL_ID,
        subject=SUBJECT,
        clock=FakeClock(NOW_S + 1),
    )
    kwargs.update(overrides)
    return verify_call_token(mint() if token is None else token, **kwargs)


class MintAndVerifyTests(unittest.TestCase):
    def test_the_token_binds_the_call_the_subject_and_an_expiry(self):
        claims = verify()

        self.assertIsInstance(claims, CallTokenClaims)
        self.assertEqual(claims.call_id, CALL_ID)
        self.assertEqual(claims.subject, SUBJECT)
        self.assertEqual(claims.issued_at_ms, int(NOW_S * 1000))
        # The TTL is the recorded bound, not a literal invented here.
        self.assertEqual(claims.expires_at_ms - claims.issued_at_ms, TTL_MS)

    def test_the_token_ttl_is_its_own_named_bound(self):
        # The token lifetime is a token fact; borrowing the body envelope's
        # bound made two unrelated windows move together.
        self.assertEqual("call_token.ttl_ms", CALL_TOKEN_TTL_BOUND)
        self.assertEqual(60_000, require_bound("call_token.ttl_ms"))

    def test_a_bad_ttl_names_the_ttl_argument_not_the_expiry_claim(self):
        with self.assertRaises(MalformedCallToken) as caught:
            mint(ttl_ms=0)

        self.assertEqual("ttl_ms", caught.exception.field)
        self.assertIn("ttl_ms", str(caught.exception))

    def test_every_mint_is_a_new_token_even_at_the_same_instant(self):
        # A reconnect mints again: the nonce makes the token unique, so a
        # replayed token is distinguishable from a fresh one.
        self.assertNotEqual(mint(nonce=None), mint(nonce=None))
        self.assertNotEqual(mint(nonce="a"), mint(nonce="b"))

    def test_the_pinned_app_vector_verifies_byte_for_byte(self):
        vector = VECTORS["token"]
        claims = verify_call_token(
            vector,
            secret=VECTORS["secret"],
            call_id=VECTORS["call_id"],
            subject=VECTORS["subject"],
            clock=FakeClock(VECTORS["now_s"]),
        )
        self.assertEqual(claims.call_id, VECTORS["call_id"])
        self.assertEqual(claims.subject, VECTORS["subject"])
        self.assertEqual(claims.expires_at_ms, VECTORS["expires_at_ms"])
        self.assertEqual(claims.nonce, VECTORS["nonce"])

    def test_a_token_past_its_ttl_is_refused_by_name(self):
        token = mint()
        with self.assertRaises(CallTokenExpired) as caught:
            verify(token, clock=FakeClock(NOW_S + TTL_MS / 1000.0 + 1))
        self.assertIn("expired", str(caught.exception))
        self.assertIn("refused at connect", str(caught.exception))

    def test_a_token_for_another_call_is_refused_by_name(self):
        with self.assertRaises(CallTokenCallMismatch) as caught:
            verify(call_id="another_call")
        self.assertIn(CALL_ID, str(caught.exception))
        self.assertIn("another_call", str(caught.exception))

    def test_a_token_for_another_subject_is_refused_by_name(self):
        with self.assertRaises(CallTokenSubjectMismatch) as caught:
            verify(subject="someone-else")
        self.assertIn("someone-else", str(caught.exception))

    def test_a_tampered_token_is_refused_by_name(self):
        token = mint()
        prefix, payload, signature = token.split(".")
        tampered = ".".join((prefix, payload, "0" * len(signature)))
        with self.assertRaises(CallTokenSignatureMismatch) as caught:
            verify(tampered)
        self.assertIn("not signed", str(caught.exception))

    def test_another_secret_cannot_verify_the_token(self):
        with self.assertRaises(CallTokenSignatureMismatch):
            verify(secret="not-the-service-secret")

    def test_a_malformed_token_is_refused_by_name(self):
        for token in ("", "nonsense", "ct1.only-two-parts", "ct1.."):
            with self.subTest(token=token):
                with self.assertRaises(MalformedCallToken):
                    verify(token)

    def test_a_token_shape_without_the_expected_fields_is_refused(self):
        # A structurally valid token whose claims are not the call-token
        # claims must not be read as one (a signed body envelope is not a
        # call token).
        from cascade.envelope import _sign

        claims = {"version": 1, "call_id": CALL_ID, "subject": SUBJECT}
        import base64

        payload = base64.urlsafe_b64encode(
            json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
        ).decode().rstrip("=")
        token = f"ct1.{payload}.{_sign(claims, SECRET.encode())}"
        with self.assertRaises(MalformedCallToken):
            verify(token)

    def test_an_unknown_token_version_is_refused_by_name(self):
        import base64

        claims = {
            "kind": "call-token",
            "version": 99,
            "call_id": CALL_ID,
            "subject": SUBJECT,
            "issued_at_ms": int(NOW_S * 1000),
            "expires_at_ms": int(NOW_S * 1000) + TTL_MS,
            "nonce": "nonce-136",
        }
        from cascade.envelope import _sign

        payload = base64.urlsafe_b64encode(
            json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
        ).decode().rstrip("=")
        token = f"ct1.{payload}.{_sign(claims, SECRET.encode())}"
        with self.assertRaises(UnknownCallTokenVersion) as caught:
            verify(token)
        self.assertEqual(caught.exception.version, 99)

    def test_an_empty_secret_mints_and_verifies_nothing(self):
        with self.assertRaises(CallTokenSecretError):
            mint(secret="")
        with self.assertRaises(CallTokenSecretError):
            verify(secret="")

    def test_identity_fields_are_required(self):
        for field in ("call_id", "subject"):
            for value in ("", "   ", None, 7):
                with self.subTest(field=field, value=value):
                    with self.assertRaises((MalformedCallToken, ValueError)):
                        mint(**{field: value})

    def test_no_refusal_echoes_the_token(self):
        token = mint()
        prefix, payload, signature = token.split(".")
        cases = [
            (
                CallTokenExpired,
                token,
                dict(clock=FakeClock(NOW_S + TTL_MS)),
            ),
            (CallTokenSubjectMismatch, token, dict(subject="another")),
            (
                CallTokenSignatureMismatch,
                ".".join((prefix, payload, "0" * len(signature))),
                {},
            ),
        ]
        base = dict(
            secret=SECRET,
            call_id=CALL_ID,
            subject=SUBJECT,
            clock=FakeClock(NOW_S + 1),
        )
        for error, presented, overrides in cases:
            with self.subTest(error=error.__name__):
                with self.assertRaises(error) as caught:
                    verify_call_token(presented, **{**base, **overrides})
                self.assertNotIn(token, str(caught.exception))
                self.assertNotIn(signature, str(caught.exception))
                self.assertNotIn(token, repr(caught.exception))


class RegistryTests(unittest.TestCase):
    def registry(self) -> CallTokenRegistry:
        return CallTokenRegistry(secret=SECRET, clock=FakeClock(NOW_S + 1))

    def test_a_token_is_claimed_once(self):
        registry = self.registry()
        token = mint()

        claim = registry.claim(token, call_id=CALL_ID, subject=SUBJECT)
        self.assertEqual(claim.call_id, CALL_ID)

        with self.assertRaises(CallTokenReplayed):
            registry.claim(token, call_id=CALL_ID, subject=SUBJECT)

    def test_a_second_concurrent_socket_for_the_same_call_is_refused(self):
        registry = self.registry()
        first = registry.claim(mint(), call_id=CALL_ID, subject=SUBJECT)

        with self.assertRaises(CallAlreadyConnected) as caught:
            registry.claim(mint(nonce="second"), call_id=CALL_ID, subject=SUBJECT)
        self.assertIn(CALL_ID, str(caught.exception))
        self.assertIn("already has a live socket", str(caught.exception))

        registry.release(first)
        # A reconnect uses a new token and is accepted once the first socket
        # is gone.
        reconnect = registry.claim(mint(nonce="reconnect"), call_id=CALL_ID, subject=SUBJECT)
        self.assertEqual(reconnect.call_id, CALL_ID)

    def test_a_refused_claim_does_not_consume_the_token(self):
        registry = self.registry()
        token = mint()

        with self.assertRaises(CallTokenSubjectMismatch):
            registry.claim(token, call_id=CALL_ID, subject="other-subject")

        claim = registry.claim(token, call_id=CALL_ID, subject=SUBJECT)
        self.assertEqual(claim.call_id, CALL_ID)

    def test_release_is_idempotent_and_a_claim_reports_it(self):
        registry = self.registry()
        claim = registry.claim(mint(), call_id=CALL_ID, subject=SUBJECT)

        registry.release(claim)
        registry.release(claim)
        self.assertTrue(claim.released)

    def test_a_claim_never_carries_the_raw_token(self):
        registry = self.registry()
        token = mint()
        claim = registry.claim(token, call_id=CALL_ID, subject=SUBJECT)
        self.assertNotIn(token, repr(claim))

    def test_an_expired_token_is_refused_at_connect(self):
        registry = CallTokenRegistry(secret=SECRET, clock=FakeClock(NOW_S + TTL_MS))
        with self.assertRaises(CallTokenExpired):
            registry.claim(mint(), call_id=CALL_ID, subject=SUBJECT)


if __name__ == "__main__":
    unittest.main()
