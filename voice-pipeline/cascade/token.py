"""The browser's token-only call config (ticket 65).

The cascade reads the stored body the managed path reads (ADR 0006): the app
assembles it, reads the served body back, fingerprints it and signs the
envelope (:mod:`cascade.envelope`, ticket 64). The browser therefore carries
an identity, never content. Its one config message is::

    {"type": "config", "protocolVersion": 1,
     "agentId": "...", "callToken": "..."}

and nothing else. A frame that still carries ``pipeline``, ``system_prompt``,
``tools`` (or the camelCase spelling of a prompt) is refused by the name of
every offending key: a client-assembled prompt or tool list is not a shape the
service may quietly ignore, because ignoring it would run a *different* body
than the one the app signed. Every other unknown key is refused by name too,
so a half-changed app fails loudly instead of dropping the field it meant.

Refusal order is deliberate:

1. **Protocol version first** (missing or unknown). The app and the service
   deploy separately; an old browser against a new service must fail on the
   version, not by luck on a field it happens to send. The service speaks
   :data:`PROTOCOL_VERSION` only and never guesses.
2. **Client-assembled body fields** by name, all of them in one refusal.
3. **Unknown keys** by name.
4. **Identity type checks** (non-empty strings).

The other half of the contract is the app -> service handoff.
:class:`StoredBodyChannel` is that seam: the app delivers the signed body for
a call token, the service verifies the envelope and body hash (ticket 64) and
holds the :class:`~cascade.envelope.VerifiedBody`; the browser's socket then
*claims* it by token exactly once. A token can therefore never carry two
bodies, and a body the app did not sign cannot reach the transport at all.

The channel is in-process on purpose: M1 is fixture-testable offline, and the
deployment's durable/token-verifying store (M17) replaces it behind this same
``deliver``/``claim`` seam.

**The call token (ticket 136).** The browser's ``callToken`` is not an opaque
string: the app mints it with :func:`mint_call_token`, which binds the call id,
the subject and an expiry. The service verifies it at connect, before it claims
a body or opens any vendor socket, and :class:`CallTokenRegistry` enforces the
two remaining rules — one claim per token, and one live socket per call. A
reconnect therefore mints a *new* token; the old one stays spent.

The token reuses ticket 64's one signature construction: canonical JSON
(``stable_json``) claims signed with HMAC-SHA256 and carried as hex. It adds a
``kind`` claim for domain separation, so a call token can never be read as a
signed body envelope or the reverse. ``call_token_vectors.json`` pins a vector
produced by Node's crypto so the app's signer and this verifier cannot drift.

No token, secret or signature ever appears in an error or a log line: every
refusal names the call, the claim or the timestamp.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from cascade.body_map import stable_json
from cascade.envelope import (
    EnvelopeSecretError,
    MalformedEnvelope,
    VerifiedBody,
    verify_envelope,
)
from cascade.thresholds import require_bound

#: The one protocol version this service speaks. The browser config carries it
#: and the service reports it. A mismatch refuses the call before a socket.
PROTOCOL_VERSION = 1

#: Versions a config may name. Extend this only with a compatible reader.
SUPPORTED_PROTOCOL_VERSIONS = (PROTOCOL_VERSION,)

#: The one message type the browser may send first.
CONFIG_TYPE = "config"

#: Every key a browser config message may carry — the closed set.
BROWSER_CONFIG_FIELDS = ("type", "protocolVersion", "agentId", "callToken")

#: Fields the browser used to assemble the body with. Refused by name; the
#: camelCase spellings are listed because a JS client would reach for them.
CLIENT_BODY_FIELDS = (
    "pipeline",
    "system_prompt",
    "systemPrompt",
    "tools",
)


class ClientConfigError(ValueError):
    """A browser config message is not part of the token-only contract.

    ``code`` is the machine-readable half of the refusal: the error frame
    carries it (ticket 138) so the client can act on a version mismatch rather
    than parse prose or hang.
    """

    code = "client_config"


class UnknownProtocolVersion(ClientConfigError):
    """The config names no version or one this service does not speak."""

    code = "protocol_version"

    def __init__(self, version: Any) -> None:
        self.version = version
        named = (
            "missing"
            if version is None
            else f"{version!r}, which is not one this service speaks"
        )
        super().__init__(
            f"protocol version {named}; this service speaks protocol version "
            f"{', '.join(str(v) for v in SUPPORTED_PROTOCOL_VERSIONS)} only and "
            "never guesses — update the app or the service together"
        )


class ClientBodyRefusal(ClientConfigError):
    """The frame carries a prompt, a tool list or a pipeline assembled by the client."""

    code = "client_body"

    def __init__(self, fields: tuple[str, ...]) -> None:
        self.fields = tuple(fields)
        names = ", ".join(f'"{field}"' for field in self.fields)
        super().__init__(
            f"the browser config carries {names}; the app assembles and signs the "
            "stored body, so the client never sends a prompt, a tool list or a "
            "pipeline"
        )


class UnknownClientField(ClientConfigError):
    """A key outside the token-only contract, refused by name."""

    code = "unknown_client_field"

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(
            f'browser config field "{field}" is not part of the token-only '
            f"contract (expected {', '.join(BROWSER_CONFIG_FIELDS)})"
        )


class MalformedClientConfig(ClientConfigError):
    """The message, its type or one identity field is not the declared shape."""

    code = "malformed_client_config"

    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        self.reason = reason
        super().__init__(f'browser config field "{field}": {reason}')


@dataclass(frozen=True)
class BrowserConfig:
    """What the browser is allowed to tell the service, and nothing more."""

    call_token: str
    agent_id: str
    protocol_version: int


def _non_empty(field: str, message: Mapping[str, Any]) -> str:
    value = message.get(field)
    if not isinstance(value, str) or not value.strip():
        raise MalformedClientConfig(field, "must be a non-empty string")
    return value


def parse_browser_config(message: Any) -> BrowserConfig:
    """Read the browser's one config frame, refusing everything it may not say.

    Refusal order is the module docstring's: version, then client body fields,
    then unknown keys, then identity types.
    """
    if not isinstance(message, Mapping):
        raise MalformedClientConfig(
            "config", f"expected an object, got {type(message).__name__}"
        )
    if message.get("type") != CONFIG_TYPE:
        raise MalformedClientConfig("type", f'expected "{CONFIG_TYPE}"')

    version = message.get("protocolVersion")
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version not in SUPPORTED_PROTOCOL_VERSIONS
    ):
        raise UnknownProtocolVersion(version)

    smuggled = tuple(
        field for field in CLIENT_BODY_FIELDS if field in message
    )
    if smuggled:
        raise ClientBodyRefusal(smuggled)

    unknown = sorted(set(message) - set(BROWSER_CONFIG_FIELDS))
    if unknown:
        raise UnknownClientField(unknown[0])

    return BrowserConfig(
        call_token=_non_empty("callToken", message),
        agent_id=_non_empty("agentId", message),
        protocol_version=version,
    )


# ---------------------------------------------------------------------------
# The short-TTL call token (ticket 136)
# ---------------------------------------------------------------------------

#: The token form this module mints: ``ct1.<payload>.<signature>``.
CALL_TOKEN_PREFIX = "ct1"

#: The claim set a call token carries, and nothing else.
CALL_TOKEN_FIELDS = (
    "kind",
    "version",
    "call_id",
    "subject",
    "issued_at_ms",
    "expires_at_ms",
    "nonce",
)

#: The token's own version, separate from the browser protocol version.
CALL_TOKEN_VERSION = 1

#: Domain separation from ticket 64's signed body envelope (same key, same
#: signature construction). A token can never verify as an envelope.
CALL_TOKEN_KIND = "call-token"

#: The registry bound that supplies the token's lifetime. It is the same
#: short-lived signed-material window the body envelope uses (ticket 04); the
#: number is never restated here.
CALL_TOKEN_TTL_BOUND = "envelope.ttl_ms"

_HEX_DIGEST = 64


class CallTokenError(ValueError):
    """A call token cannot be trusted, so the call is refused at connect."""


class CallTokenSecretError(CallTokenError):
    """The signing secret is missing or empty; no token is minted or verified."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"the call-token secret {reason}; no default secret is substituted"
        )


class MalformedCallToken(CallTokenError):
    """The token is not the declared shape."""

    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        self.reason = reason
        super().__init__(f'call token field "{field}": {reason}')


class UnknownCallTokenVersion(CallTokenError):
    """A token version this verifier does not understand; guessing is refused."""

    def __init__(self, version: Any) -> None:
        self.version = version
        super().__init__(
            f"unknown call token version {version!r}; this verifier understands "
            f"{CALL_TOKEN_VERSION} only"
        )


class CallTokenSignatureMismatch(CallTokenError):
    """The HMAC does not cover the claims presented."""

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        super().__init__(
            f'call token for call "{call_id}" is not signed by the service '
            "secret; the call is refused at connect"
        )


class CallTokenExpired(CallTokenError):
    """The token is past its expiry, measured on the injected clock."""

    def __init__(self, call_id: str, expires_at_ms: int, now_ms: int) -> None:
        self.call_id = call_id
        self.expires_at_ms = expires_at_ms
        self.now_ms = now_ms
        super().__init__(
            f'call token for call "{call_id}" expired at {expires_at_ms} ms; the '
            f"service saw {now_ms} ms, so the call is refused at connect"
        )


class CallTokenCallMismatch(CallTokenError):
    """The token was minted for another call id and cannot be replayed."""

    def __init__(self, expected: str, token_call_id: str) -> None:
        self.expected = expected
        self.token_call_id = token_call_id
        super().__init__(
            f'call token was minted for call "{token_call_id}" but the service '
            f'is serving call "{expected}"; a token is never replayed onto '
            "another call"
        )


class CallTokenSubjectMismatch(CallTokenError):
    """The token was minted for another subject and cannot be reused."""

    def __init__(self, expected: str, token_subject: str) -> None:
        self.expected = expected
        self.token_subject = token_subject
        super().__init__(
            f'call token names subject "{token_subject}" but this call belongs '
            f'to subject "{expected}"; the call is refused at connect'
        )


class CallTokenReplayed(CallTokenError):
    """This exact token was already claimed; a token serves one socket."""

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        super().__init__(
            f'call token for call "{call_id}" was already claimed; a token is '
            "spent by one claim, so a reconnect mints a new one"
        )


class CallAlreadyConnected(CallTokenError):
    """The call already has a live socket; a second concurrent one is refused."""

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        super().__init__(
            f'call "{call_id}" already has a live socket; a second concurrent '
            "socket for the same call is refused, and a reconnect uses a new "
            "token after the first closes"
        )


#: The published name for the same refusal; callers may catch either spelling.
CallTokenInUse = CallAlreadyConnected


@dataclass(frozen=True)
class CallTokenClaims:
    """The verified claims of one call token. Never carries the token itself."""

    call_id: str
    subject: str
    issued_at_ms: int
    expires_at_ms: int
    nonce: str
    version: int = CALL_TOKEN_VERSION
    kind: str = CALL_TOKEN_KIND

    def to_document(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in CALL_TOKEN_FIELDS}


@dataclass
class CallTokenClaim:
    """One registry claim: a call, its subject, and whether it is still live."""

    call_id: str
    subject: str
    nonce: str
    expires_at_ms: int
    released: bool = False


def _token_key(secret: str | bytes) -> bytes:
    if isinstance(secret, str):
        key = secret.encode("utf-8")
    elif isinstance(secret, bytes):
        key = secret
    else:
        raise CallTokenSecretError(
            f"must be str or bytes, got {type(secret).__name__}"
        )
    if not key:
        raise CallTokenSecretError("is empty")
    return key


def _token_now_ms(clock: Callable[[], float]) -> int:
    now = clock()
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        raise MalformedCallToken("clock", "must return epoch seconds")
    return int(round(now * 1000))


def _token_identity(field: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MalformedCallToken(field, "must be a non-empty string")
    return value


def _token_ttl(ttl_ms: Any) -> int:
    if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        raise MalformedCallToken(
            "expires_at_ms", f"ttl_ms must be a positive whole number, got {ttl_ms!r}"
        )
    ttl = int(ttl_ms)
    if ttl != ttl_ms or ttl <= 0:
        raise MalformedCallToken(
            "expires_at_ms", f"ttl_ms must be a positive whole number, got {ttl_ms!r}"
        )
    return ttl


def _token_sign(claims: Mapping[str, Any], key: bytes) -> str:
    """Ticket 64's signature: HMAC-SHA256 over canonical JSON, hex encoded."""
    return hmac.new(
        key, stable_json(dict(claims)).encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _encode_claims(claims: Mapping[str, Any]) -> str:
    payload = stable_json(dict(claims)).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_claims(payload: str) -> Mapping[str, Any]:
    if not payload:
        raise MalformedCallToken("token", "has an empty claim payload")
    try:
        padded = payload + "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        claims = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise MalformedCallToken("token", "claim payload is not base64url JSON") from exc
    if not isinstance(claims, Mapping):
        raise MalformedCallToken(
            "token", f"claims must be an object, got {type(claims).__name__}"
        )
    return claims


def _claims(message: Mapping[str, Any]) -> CallTokenClaims:
    missing = [name for name in CALL_TOKEN_FIELDS if name not in message]
    if missing:
        raise MalformedCallToken(missing[0], "missing from the call token")
    unknown = sorted(set(message) - set(CALL_TOKEN_FIELDS))
    if unknown:
        raise MalformedCallToken(unknown[0], "is not a call-token claim")

    kind = message["kind"]
    if kind != CALL_TOKEN_KIND:
        raise MalformedCallToken(
            "kind", f"expected {CALL_TOKEN_KIND!r}, got {kind!r}"
        )

    version = message["version"]
    if isinstance(version, bool) or not isinstance(version, int):
        raise MalformedCallToken("version", f"expected an integer, got {version!r}")
    if version != CALL_TOKEN_VERSION:
        raise UnknownCallTokenVersion(version)

    call_id = _token_identity("call_id", message["call_id"])
    subject = _token_identity("subject", message["subject"])
    nonce = _token_identity("nonce", message["nonce"])

    for name in ("issued_at_ms", "expires_at_ms"):
        value = message[name]
        if isinstance(value, bool) or not isinstance(value, int):
            raise MalformedCallToken(name, f"expected integer milliseconds, got {value!r}")
    issued_at_ms = message["issued_at_ms"]
    expires_at_ms = message["expires_at_ms"]
    if expires_at_ms <= issued_at_ms:
        raise MalformedCallToken(
            "expires_at_ms", "must be after issued_at_ms so the token can expire"
        )

    return CallTokenClaims(
        call_id=call_id,
        subject=subject,
        issued_at_ms=issued_at_ms,
        expires_at_ms=expires_at_ms,
        nonce=nonce,
        version=version,
    )


def mint_call_token(
    *,
    secret: str | bytes,
    call_id: str,
    subject: str,
    ttl_ms: int | None = None,
    nonce: str | None = None,
    clock: Callable[[], float] = time.time,
) -> str:
    """Mint the app's short-lived token for one call and one subject.

    ``ttl_ms`` defaults to the recorded registry bound and is never a literal
    in production code. ``nonce`` is fresh per mint, so a reconnect produces a
    different token even inside the same millisecond. The returned string is a
    credential: it is never logged and never echoed in an error.
    """
    key = _token_key(secret)
    call_id = _token_identity("call_id", call_id)
    subject = _token_identity("subject", subject)
    ttl = _token_ttl(require_bound(CALL_TOKEN_TTL_BOUND) if ttl_ms is None else ttl_ms)
    nonce = uuid.uuid4().hex if nonce is None else _token_identity("nonce", nonce)

    issued_at_ms = _token_now_ms(clock)
    claims = {
        "kind": CALL_TOKEN_KIND,
        "version": CALL_TOKEN_VERSION,
        "call_id": call_id,
        "subject": subject,
        "issued_at_ms": issued_at_ms,
        "expires_at_ms": issued_at_ms + ttl,
        "nonce": nonce,
    }
    return f"{CALL_TOKEN_PREFIX}.{_encode_claims(claims)}.{_token_sign(claims, key)}"


def verify_call_token(
    token: Any,
    *,
    secret: str | bytes,
    call_id: str | None = None,
    subject: str | None = None,
    clock: Callable[[], float] = time.time,
) -> CallTokenClaims:
    """Verify one token at connect, before any vendor socket may open.

    Refusal order: shape, signature, expiry, then the call and subject
    bindings. Every refusal is named and none contains the token.
    """
    key = _token_key(secret)
    if not isinstance(token, str) or not token.strip():
        raise MalformedCallToken("token", "must be a non-empty string")

    parts = token.split(".")
    if len(parts) != 3 or parts[0] != CALL_TOKEN_PREFIX:
        raise MalformedCallToken(
            "token", f"expected {CALL_TOKEN_PREFIX!r}.<payload>.<signature>"
        )
    _, payload, signature = parts
    if len(signature) != _HEX_DIGEST:
        raise MalformedCallToken("signature", "expected 64 lowercase hex characters")
    try:
        int(signature, 16)
    except ValueError:
        raise MalformedCallToken(
            "signature", "expected 64 lowercase hex characters"
        ) from None

    claims = _claims(_decode_claims(payload))
    presented = claims.to_document()
    if not hmac.compare_digest(_token_sign(presented, key), signature):
        raise CallTokenSignatureMismatch(claims.call_id)

    now_ms = _token_now_ms(clock)
    if now_ms >= claims.expires_at_ms:
        raise CallTokenExpired(claims.call_id, claims.expires_at_ms, now_ms)

    if call_id is not None:
        expected = _token_identity("call_id", call_id)
        if claims.call_id != expected:
            raise CallTokenCallMismatch(expected, claims.call_id)

    if subject is not None:
        expected = _token_identity("subject", subject)
        if claims.subject != expected:
            raise CallTokenSubjectMismatch(expected, claims.subject)

    return claims


class CallTokenRegistry:
    """Verify, claim once and keep one live socket per call.

    A claim is spent by its first successful use; a second socket for the same
    call is refused until the first is released. ``release`` runs when the
    socket closes, so a reconnect (which mints a new token) is accepted.
    """

    def __init__(
        self,
        *,
        secret: str | bytes,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._secret = _token_key(secret)
        self._clock = clock
        self._used: set[str] = set()
        self._live: dict[str, CallTokenClaim] = {}

    def verify(
        self,
        token: Any,
        *,
        call_id: str | None = None,
        subject: str | None = None,
    ) -> CallTokenClaims:
        """Verify signature, expiry and bindings without claiming the token."""
        return verify_call_token(
            token,
            secret=self._secret,
            call_id=call_id,
            subject=subject,
            clock=self._clock,
        )

    def claim(self, token: Any, *, call_id: str, subject: str) -> CallTokenClaim:
        """Claim one verified token for one call; refuses a replay or a second socket."""
        claims = self.verify(token, call_id=call_id, subject=subject)
        if claims.nonce in self._used:
            raise CallTokenReplayed(claims.call_id)
        if claims.call_id in self._live:
            raise CallAlreadyConnected(claims.call_id)

        self._used.add(claims.nonce)
        claim = CallTokenClaim(
            call_id=claims.call_id,
            subject=claims.subject,
            nonce=claims.nonce,
            expires_at_ms=claims.expires_at_ms,
        )
        self._live[claims.call_id] = claim
        return claim

    def release(self, claim: CallTokenClaim) -> None:
        """Drop a claim when its socket closes; idempotent."""
        if not isinstance(claim, CallTokenClaim):
            return
        live = self._live.get(claim.call_id)
        if live is claim:
            del self._live[claim.call_id]
        claim.released = True

    def live_call_ids(self) -> tuple[str, ...]:
        """The calls with a live socket, for readiness and diagnostics."""
        return tuple(sorted(self._live))


class DuplicateCallToken(ClientConfigError):
    """The app already delivered a body for this call token.

    A reconnect uses a new token (M17), so a second delivery is a bug and is
    refused rather than silently replacing the body the first socket may use.
    """

    def __init__(self) -> None:
        super().__init__(
            "this call token already has a signed body; a reconnect mints a new "
            "token instead of re-pointing the old one at another body"
        )


class StoredBodyChannel:
    """The app -> service handoff of one signed body per browser call token.

    ``deliver`` verifies ticket 64's envelope and body hash before anything is
    held; ``claim`` pops the verified body so one token serves exactly one
    socket. Until claimed, the body is the app's, never the browser's.
    """

    def __init__(
        self,
        *,
        secret: str | bytes,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not secret:
            raise EnvelopeSecretError(
                "is empty; the signed-body channel cannot verify a body without one"
            )
        self._secret = secret
        self._clock = clock
        self._bodies: dict[str, VerifiedBody] = {}

    def deliver(
        self,
        *,
        call_token: str,
        call_id: str,
        message: Mapping[str, Any],
    ) -> VerifiedBody:
        """Verify and hold the body the app signed for ``call_token``."""
        token = _identity_token(call_token)
        verified = verify_envelope(
            message,
            secret=self._secret,
            call_id=call_id,
            clock=self._clock,
        )
        if token in self._bodies:
            raise DuplicateCallToken()
        self._bodies[token] = verified
        return verified

    def claim(self, call_token: str) -> VerifiedBody | None:
        """Take the verified body for a token, once; ``None`` if never delivered."""
        if not isinstance(call_token, str) or not call_token:
            return None
        return self._bodies.pop(call_token, None)


def _identity_token(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MalformedEnvelope("call_token", "must be a non-empty string")
    return value
