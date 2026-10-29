"""The signed body envelope between the app and the cascade service (ticket 64).

The browser never sees the body, the prompt or the tool list. The app assembles
the stored body, reads it back, verifies its full fingerprint (ticket 63) and
then hands the *wire* message to the service over the authenticated service
channel::

    {"envelope": {version, call_id, agent_id, body_hash,
                  issued_at_ms, expires_at_ms, signature}, "body": {…}}

Two checks protect that channel, and both must pass before a vendor socket
opens:

- **The app's check** (:func:`sign_body`) is ticket 63's full fingerprint of
  the *served* body against the fingerprint the app minted, account salt
  included. :func:`sign_body` runs that check first, so a body nobody
  fingerprinted cannot be sealed.
- **The service's check** (:func:`verify_envelope`) recomputes the body hash
  from the body it received, verifies the HMAC over every envelope claim, and
  refuses an expired envelope or one minted for another call. A body whose
  hash does not match the envelope raises :class:`BodyHashMismatch` by name.

The signature covers the body hash and the call identity, so an envelope
cannot be replayed onto another call (:class:`EnvelopeCallMismatch`) or
re-pointed at a different body (:class:`BodyHashMismatch`). The signing input
is ``stable_json`` of the claims — the same canonical form ticket 63 uses, so
the TypeScript signer and this verifier produce the same bytes. The pinned
vector in ``envelope_vectors.json`` was produced by Node's crypto and
cross-checked with ``openssl``; the test fails if either language drifts.

**No secret ever leaves a caller's hand.** The HMAC secret and the account
salt are arguments, never envelope claims, never message fields, and never
part of an error: every refusal names the call, the claim or the two hashes.
This module also does no logging at all, so a raw body cannot reach a log line
from here.

**The TTL is an open value.** The spec says short-lived but states no number,
so :func:`sign_body` reads :data:`TOKEN_TTL_BOUND` from
:mod:`cascade.thresholds`; while it is open the signer refuses by name instead
of inventing one. Callers pass ``ttl_ms`` only in tests or once the bound has a
value — never as a literal in production code.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from cascade.body_map import stable_json, verify_served_body
from cascade.thresholds import require_bound

#: The envelope shape this module signs and verifies.
ENVELOPE_VERSION = 1

#: The registry bound that supplies the envelope's lifetime. Open until ticket
#: 04 records a value with a source and a date.
TOKEN_TTL_BOUND = "envelope.ttl_ms"

#: The signed claims, in the one order the canonical form ignores anyway.
_CLAIMS = (
    "version",
    "call_id",
    "agent_id",
    "body_hash",
    "issued_at_ms",
    "expires_at_ms",
)

_MESSAGE_FIELDS = frozenset({"envelope", "body"})
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class EnvelopeError(ValueError):
    """A signed body envelope cannot be trusted, so the call is refused."""


class EnvelopeSecretError(EnvelopeError):
    """The HMAC secret is missing or empty; nothing may be signed or verified.

    The message never contains the secret: an error that echoes a secret is a
    log line waiting to happen.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(f"the envelope secret {reason}; no default secret is substituted")


class EnvelopeIdentityError(EnvelopeError):
    """A call identity is absent or unusable, so the envelope cannot bind it."""

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(f'envelope field "{field}" must be a non-empty string')


class MalformedEnvelope(EnvelopeError):
    """The envelope or its wire message is not the declared shape."""

    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        self.reason = reason
        super().__init__(f'envelope field "{field}": {reason}')


class UnknownEnvelopeVersion(EnvelopeError):
    """A version this verifier does not understand. Guessing is forbidden."""

    def __init__(self, version: Any) -> None:
        self.version = version
        super().__init__(
            f"unknown envelope version {version!r}; this verifier understands "
            f"{ENVELOPE_VERSION} only"
        )


class EnvelopeSignatureMismatch(EnvelopeError):
    """The HMAC does not cover the claims presented.

    The signature and the secret are both absent from the message: the caller
    only learns that this envelope was not signed by the holder of the secret.
    """

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        super().__init__(
            f'envelope for call "{call_id}" is not signed by the service '
            "secret; it is refused before any vendor socket opens"
        )


class EnvelopeExpired(EnvelopeError):
    """The envelope is past its expiry, measured on the injected clock."""

    def __init__(self, call_id: str, expires_at_ms: int, now_ms: int) -> None:
        self.call_id = call_id
        self.expires_at_ms = expires_at_ms
        self.now_ms = now_ms
        super().__init__(
            f'envelope for call "{call_id}" expired at {expires_at_ms} ms; '
            f"the service saw {now_ms} ms, so the call is refused at connect"
        )


class EnvelopeCallMismatch(EnvelopeError):
    """The envelope was minted for another call id and cannot be replayed."""

    def __init__(self, expected: str, envelope_call_id: str) -> None:
        self.expected = expected
        self.envelope_call_id = envelope_call_id
        super().__init__(
            f'envelope was minted for call "{envelope_call_id}" but the token '
            f'names call "{expected}"; an envelope is never replayed onto '
            "another call"
        )


class BodyHashMismatch(EnvelopeError):
    """The body does not hash to the value the signed envelope carries.

    Both hashes are safe to name (they are already on the wire); the body
    itself is not, so no field of it appears here.
    """

    def __init__(self, call_id: str, declared: str, served: str) -> None:
        self.call_id = call_id
        self.declared = declared
        self.served = served
        super().__init__(
            f'the body served for call "{call_id}" hashes to "{served}", which '
            f'does not match the signed envelope\'s body hash "{declared}"; '
            "the call is refused before any vendor socket opens"
        )


def body_hash(body: Mapping[str, Any]) -> str:
    """SHA-256 of the canonical body — the hash the envelope carries.

    The account salt ticket 63 mixes into the *fingerprint* is deliberately
    absent: the fingerprint proves the app read the body it minted, while this
    hash proves the service received the body the app signed. The service
    never learns the account salt.
    """
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")
    return hashlib.sha256(stable_json(body).encode("utf-8")).hexdigest()


def _secret_bytes(secret: str | bytes) -> bytes:
    """The HMAC key as bytes; never echoed in an error."""
    if isinstance(secret, str):
        key = secret.encode("utf-8")
    elif isinstance(secret, bytes):
        key = secret
    else:
        raise EnvelopeSecretError(f"must be str or bytes, got {type(secret).__name__}")
    if not key:
        raise EnvelopeSecretError("is empty")
    return key


def _now_ms(clock: Callable[[], float]) -> int:
    """The injected clock in epoch milliseconds, the envelope's unit."""
    now = clock()
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        raise EnvelopeIdentityError("clock")
    return int(round(now * 1000))


def _identity(field: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EnvelopeIdentityError(field)
    return value


def _sign(claims: Mapping[str, Any], key: bytes) -> str:
    return hmac.new(key, stable_json(dict(claims)).encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class Envelope:
    """The signed claims: body hash, call identity, lifetime and signature."""

    version: int
    call_id: str
    agent_id: str
    body_hash: str
    issued_at_ms: int
    expires_at_ms: int
    signature: str

    def claims(self) -> dict[str, Any]:
        """Everything the signature covers, and nothing else."""
        return {name: getattr(self, name) for name in _CLAIMS}

    def signing_input(self) -> bytes:
        """The canonical bytes the HMAC is computed over.

        ``stable_json`` sorts keys and is compact, so the app's signer and this
        verifier agree byte-for-byte regardless of object order on the wire.
        """
        return stable_json(self.claims()).encode("utf-8")

    def to_dict(self) -> dict[str, Any]:
        """The envelope as it travels: claims plus the signature."""
        return {**self.claims(), "signature": self.signature}

    @classmethod
    def from_dict(cls, raw: Any) -> "Envelope":
        """Parse one wire envelope, refusing any shape not declared here."""
        if not isinstance(raw, Mapping):
            raise MalformedEnvelope(
                "envelope", f"expected an object, got {type(raw).__name__}"
            )
        expected = (*_CLAIMS, "signature")
        missing = [field for field in expected if field not in raw]
        if missing:
            raise MalformedEnvelope(missing[0], "missing from the signed envelope")
        unknown = sorted(set(raw) - set(expected))
        if unknown:
            raise MalformedEnvelope(unknown[0], "is not a signed claim")

        version = raw["version"]
        if isinstance(version, bool) or not isinstance(version, int):
            raise MalformedEnvelope("version", f"expected an integer, got {version!r}")
        if version != ENVELOPE_VERSION:
            raise UnknownEnvelopeVersion(version)

        call_id = _identity("call_id", raw["call_id"])
        agent_id = _identity("agent_id", raw["agent_id"])

        for field in ("issued_at_ms", "expires_at_ms"):
            value = raw[field]
            if isinstance(value, bool) or not isinstance(value, int):
                raise MalformedEnvelope(field, f"expected integer milliseconds, got {value!r}")
        issued_at_ms = raw["issued_at_ms"]
        expires_at_ms = raw["expires_at_ms"]
        if expires_at_ms <= issued_at_ms:
            raise MalformedEnvelope(
                "expires_at_ms", "must be after issued_at_ms so the envelope can expire"
            )

        for field in ("body_hash", "signature"):
            value = raw[field]
            if not isinstance(value, str) or not _HEX64.match(value):
                raise MalformedEnvelope(field, "expected 64 lowercase hex characters")

        return cls(
            version=version,
            call_id=call_id,
            agent_id=agent_id,
            body_hash=raw["body_hash"],
            issued_at_ms=issued_at_ms,
            expires_at_ms=expires_at_ms,
            signature=raw["signature"],
        )


@dataclass(frozen=True)
class SignedBody:
    """The app's one wire message: the signed envelope and the body it covers."""

    envelope: Envelope
    body: dict[str, Any]

    @property
    def body_hash(self) -> str:
        return self.envelope.body_hash

    def message(self) -> dict[str, Any]:
        """The message the authenticated service channel carries."""
        return {"envelope": self.envelope.to_dict(), "body": dict(self.body)}


@dataclass(frozen=True)
class VerifiedBody:
    """A body whose envelope and hash both verified at the service."""

    body: dict[str, Any]
    envelope: Envelope

    @property
    def body_hash(self) -> str:
        return self.envelope.body_hash

    @property
    def call_id(self) -> str:
        return self.envelope.call_id

    @property
    def agent_id(self) -> str:
        return self.envelope.agent_id

    @property
    def issued_at_ms(self) -> int:
        return self.envelope.issued_at_ms

    @property
    def expires_at_ms(self) -> int:
        return self.envelope.expires_at_ms


def sign_body(
    *,
    body: Mapping[str, Any],
    minted_fingerprint: str,
    account_salt: str,
    secret: str | bytes,
    call_id: str,
    agent_id: str,
    ttl_ms: int | None = None,
    clock: Callable[[], float] = time.time,
) -> SignedBody:
    """Seal the served body for the service channel (the app's side).

    The body is verified against the fingerprint the app minted *before* it is
    signed, so the app's check and the service's check are the same body: a
    served body that is not the minted one refuses here (ticket 63) and never
    reaches a socket. ``ttl_ms`` defaults to the registry bound and must not be
    a literal in production code; ``clock`` makes expiry deterministic.
    """
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")

    # Ticket 63's check, run first: never sign a body nobody fingerprinted.
    verify_served_body(
        served_body=body,
        minted_fingerprint=minted_fingerprint,
        account_salt=account_salt,
    )

    key = _secret_bytes(secret)
    call_id = _identity("call_id", call_id)
    agent_id = _identity("agent_id", agent_id)

    if ttl_ms is None:
        ttl_ms = require_bound(TOKEN_TTL_BOUND)
    if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        raise MalformedEnvelope(
            "expires_at_ms", f"ttl_ms must be a positive whole number, got {ttl_ms!r}"
        )
    ttl = int(ttl_ms)
    if ttl != ttl_ms or ttl <= 0:
        raise MalformedEnvelope(
            "expires_at_ms", f"ttl_ms must be a positive whole number, got {ttl_ms!r}"
        )

    issued_at_ms = _now_ms(clock)
    claims: dict[str, Any] = {
        "version": ENVELOPE_VERSION,
        "call_id": call_id,
        "agent_id": agent_id,
        "body_hash": body_hash(body),
        "issued_at_ms": issued_at_ms,
        "expires_at_ms": issued_at_ms + ttl,
    }
    return SignedBody(
        envelope=Envelope(**claims, signature=_sign(claims, key)),
        body=dict(body),
    )


def verify_envelope(
    message: Mapping[str, Any],
    *,
    secret: str | bytes,
    call_id: str,
    clock: Callable[[], float] = time.time,
) -> VerifiedBody:
    """Verify one wire message before any vendor socket opens (the service's side).

    Refusals are named and ordered so a caller can act on them: malformed shape,
    then the HMAC, then expiry, then the call binding, then the body hash. The
    body is returned only when all of them pass.
    """
    key = _secret_bytes(secret)

    if not isinstance(message, Mapping):
        raise MalformedEnvelope("message", f"expected an object, got {type(message).__name__}")
    missing = [field for field in ("envelope", "body") if field not in message]
    if missing:
        raise MalformedEnvelope(missing[0], "missing from the signed body message")
    unknown = sorted(set(message) - _MESSAGE_FIELDS)
    if unknown:
        raise MalformedEnvelope(unknown[0], "is not part of the signed body message")

    raw_envelope = message["envelope"]
    envelope = (
        raw_envelope
        if isinstance(raw_envelope, Envelope)
        else Envelope.from_dict(raw_envelope)
    )
    body = message["body"]
    if not isinstance(body, Mapping):
        raise MalformedEnvelope("body", f"expected an object, got {type(body).__name__}")

    if not hmac.compare_digest(_sign(envelope.claims(), key), envelope.signature):
        raise EnvelopeSignatureMismatch(envelope.call_id)

    now_ms = _now_ms(clock)
    if now_ms >= envelope.expires_at_ms:
        raise EnvelopeExpired(envelope.call_id, envelope.expires_at_ms, now_ms)

    expected_call_id = _identity("call_id", call_id)
    if envelope.call_id != expected_call_id:
        raise EnvelopeCallMismatch(expected_call_id, envelope.call_id)

    served = body_hash(body)
    if served != envelope.body_hash:
        raise BodyHashMismatch(envelope.call_id, envelope.body_hash, served)

    return VerifiedBody(body=dict(body), envelope=envelope)
