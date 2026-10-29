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
deployment's durable/token-verifying store (M17, with the HMAC token verified
at connect) replaces it behind this same ``deliver``/``claim`` seam. This
module does not mint or verify call tokens — ticket 64's envelope is the only
thing it verifies.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from cascade.envelope import (
    EnvelopeSecretError,
    MalformedEnvelope,
    VerifiedBody,
    verify_envelope,
)

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
    """A browser config message is not part of the token-only contract."""


class UnknownProtocolVersion(ClientConfigError):
    """The config names no version or one this service does not speak."""

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

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(
            f'browser config field "{field}" is not part of the token-only '
            f"contract (expected {', '.join(BROWSER_CONFIG_FIELDS)})"
        )


class MalformedClientConfig(ClientConfigError):
    """The message, its type or one identity field is not the declared shape."""

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
