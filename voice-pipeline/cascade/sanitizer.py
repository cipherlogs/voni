"""The one sanitizer's rules, callable from Python (ticket 111).

Ticket 07 made one sanitizer for both event streams
(``voni/src/lib/demo/event-sanitizer.ts``). The cascade's persisted stream is
written by the Python service, which ships without the ``voni`` tree, so this
module is a **callable copy** of that one rule source — not a second denylist:
``test_sanitizer.py`` reads the forbidden set, both patterns, the marker and
the two bounds out of the TS module and fails by name when they drift, and it
copies the TS test's expected values so the copy answers the same questions.

The rules, in the TS module's order:

* A forbidden key is dropped at any depth and reported by its dotted path; the
  caller decides what a rejection means. The cascade writer refuses the line.
* A key-shaped value (a URL with userinfo, ``sk_``/``pk_``/``api_``/``tok_``
  token, or a ``Bearer`` header) is redacted in place, keeping the text.
* Strings are bounded at 500 characters, objects at depth 4, a non-finite
  number becomes ``null``.

Patterns are compiled with ``re.ASCII`` because JavaScript's ``\\b``/``\\w``
are ASCII; without it a Python word boundary would treat accented text
differently from the rule source.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: Replacement marker for a key-shaped value.
REDACTED = "[redacted]"

#: Fields that may never appear on a line, whatever the call site passes.
FORBIDDEN_EVENT_KEYS = frozenset(
    {
        "apikey",
        "api_key",
        "authorization",
        "secret",
        "password",
        "token",
        "accesstoken",
        "access_token",
        "pcm",
        "audio",
        "data",
        "base64",
        "text",
        "transcript",
    }
)

#: Values shaped like a credential, redacted wherever they appear.
KEY_SHAPED_VALUE = re.compile(
    r"\b(?:sk|pk|api|tok)_[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+",
    re.IGNORECASE | re.ASCII,
)

#: URL userinfo (``scheme://user:password@host``) carries a credential too.
URL_CREDENTIAL = re.compile(
    r"\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@",
    re.IGNORECASE | re.ASCII,
)

#: The shared bounds the TS module enforces.
MAX_DEPTH = 4
MAX_LENGTH = 500
ELLIPSIS = "…"
DEPTH_LIMIT = "[depth-limit]"

#: The URL replacement keeps the scheme and the host, dropping only userinfo.
_URL_USERINFO = rf"\1{REDACTED}@"


def redact_key_shaped(value: str) -> str:
    """Redact credentials in one string, keeping the surrounding text readable."""
    return KEY_SHAPED_VALUE.sub(REDACTED, URL_CREDENTIAL.sub(_URL_USERINFO, value))


@dataclass(frozen=True)
class SanitizedFields:
    """One line's fields after the shared rules; refusals are named, not lost."""

    ok: bool
    """True when no forbidden key was present."""
    value: dict[str, Any]
    """The fields that may be written: forbidden keys removed, values sanitized."""
    rejected_keys: tuple[str, ...]
    """Dotted paths of every forbidden key that was dropped."""


def _sanitize(
    value: Any, depth: int, path: list[str], rejected: list[str]
) -> Any:
    if depth > MAX_DEPTH:
        return DEPTH_LIMIT
    if isinstance(value, str):
        redacted = redact_key_shaped(value)
        return redacted if len(redacted) <= MAX_LENGTH else redacted[:MAX_LENGTH] + ELLIPSIS
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, int):
        return value
    if isinstance(value, (list, tuple)):
        return [_sanitize(entry, depth + 1, path, rejected) for entry in value]
    if isinstance(value, Mapping):
        out: dict[Any, Any] = {}
        for key, entry in value.items():
            key_text = key if isinstance(key, str) else str(key)
            if key_text.lower() in FORBIDDEN_EVENT_KEYS:
                rejected.append(".".join([*path, key_text]))
                continue
            out[key] = _sanitize(entry, depth + 1, [*path, key_text], rejected)
        return out
    return str(value)


def sanitize_fields(fields: Mapping[str, Any]) -> SanitizedFields:
    """Sanitize one line's caller-supplied fields before it is written.

    Mirrors ``sanitizeEventFields`` in the one TS module: the returned
    ``rejected_keys`` are the dotted paths of the forbidden keys that were
    dropped, and ``ok`` is true only when none was present.
    """
    if not isinstance(fields, Mapping):
        raise TypeError(f"event fields must be a mapping, got {type(fields).__name__}")
    rejected: list[str] = []
    value = _sanitize(dict(fields), 0, [], rejected)
    return SanitizedFields(
        ok=not rejected, value=value, rejected_keys=tuple(rejected)
    )
