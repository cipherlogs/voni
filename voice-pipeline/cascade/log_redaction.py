"""No credential in any log (ticket 137).

The service holds four kinds of secret — vendor keys, the tool secret, the
signing secret and the database URL — and one credential that is not an env
var: the browser's call token, which travels in the socket query string and in
the config frame. None of them may reach an access log, an error log or a crash
dump, and the vendor handshake must never be logged at all because the Meta key
travels *inside* the handshake body.

This module is the one gate. It is not a second denylist: the forbidden key
names, the key-shaped value pattern and the URL-userinfo rule are
:mod:`cascade.sanitizer`'s, the one rule source ticket 07/111 owns.

What it does:

* **Query credentials** — ``token=``, ``callToken=``, ``api_key=`` and their
  siblings are replaced in place, so an access log keeps the path and the
  agent id but not the token.
* **Structured fields** — a mapping is passed through ``sanitize_fields``, so
  forbidden keys (``token``, ``authorization``, ``secret``, …) are dropped at
  any depth and key-shaped strings are redacted.
* **Vendor handshakes** — a mapping carrying a handshake-only field
  (``audioEncoding``, ``partialMode``, ``emitAudioProgress``) and a raw string
  that mentions one are replaced whole with :data:`HANDSHAKE_REDACTED`. The
  body is the credential's carrier; a line that contains it is not worth
  keeping.
* **Secret values** — the live values read from the named environment
  variables are replaced wherever they appear, including in an exception
  traceback (``record.exc_text``), which is the crash-dump path.

:func:`install_log_redaction` attaches one filter to the root logger, the
uvicorn access/error loggers and every existing root handler, and is
idempotent. :func:`redact_text` / :func:`redact_value` are the pure rules for a
call site that wants to format a line itself.
"""

from __future__ import annotations

import logging
import os
import re
import traceback
from collections.abc import Iterable, Mapping
from typing import Any

from cascade.sanitizer import (
    FORBIDDEN_EVENT_KEYS,
    KEY_SHAPED_VALUE,
    REDACTED,
    URL_CREDENTIAL,
    redact_key_shaped,
    sanitize_fields,
)

#: The env names whose values must never appear in a log line. Names only;
#: ``deploy/voice-pipeline.env.example`` is the deployment record.
SECRET_ENV_NAMES = (
    "META_API_KEY",
    "META_IDENTIFIER_SALT",
    "ASSEMBLYAI_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CARTESIA_API_KEY",
    "VONI_TOOL_SECRET",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
)

#: The whole-line replacement for a vendor handshake.
HANDSHAKE_REDACTED = "[redacted vendor handshake]"

#: Fields only a vendor handshake carries. A mapping with one of these is the
#: credential's carrier, not a log line.
HANDSHAKE_FIELDS = frozenset(
    {"audioencoding", "partialmode", "emitaudioprogress"}
)

#: A raw handshake string, detected by the same marker fields.
HANDSHAKE_MARKER = re.compile(
    r'"(?:audioEncoding|partialMode|emitAudioProgress)"\s*:', re.ASCII
)

#: A credential assignment: a query parameter, a crash-dump fragment or a log
#: field. The lead keeps the delimiter that preceded it so the line stays
#: readable ("?token=[redacted]", " token=[redacted]").
QUERY_SECRET = re.compile(
    r"(?i)(?P<lead>[?&\s,;(]|^)(?P<name>token|callToken|call_token|access_token|"
    r"api_key|apikey|key|secret|signature|sig|password|authorization)="
    r"[^&#\s\"']+",
    re.ASCII,
)

#: A JSON field that carries a credential, in a logged config frame or a
#: serialized handshake. The value is replaced, the key and the rest stay.
JSON_SECRET = re.compile(
    r"(?i)(\"(?:token|callToken|call_token|accessToken|access_token|api_key|"
    r"apikey|secret|signature|authorization)\"\s*:\s*\")[^\"]*(\")",
    re.ASCII,
)

#: Values shorter than this are not secret-shaped enough to replace blindly;
#: an exact match on a short string would mangle ordinary words.
MIN_SECRET_LENGTH = 8

_QUERY_REPLACEMENT = rf"\g<lead>\g<name>={REDACTED}"
_JSON_REPLACEMENT = rf"\1{REDACTED}\2"


def secret_values(environ: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """The live secret values named in :data:`SECRET_ENV_NAMES`.

    Empty values are skipped: an unset secret is not a string to redact.
    """
    env = os.environ if environ is None else environ
    values: list[str] = []
    for name in SECRET_ENV_NAMES:
        value = env.get(name, "")
        if isinstance(value, str) and len(value) >= MIN_SECRET_LENGTH:
            values.append(value)
    return tuple(values)


def _without_secrets(text: str, secrets: Iterable[str]) -> str:
    for secret in sorted(set(secrets), key=len, reverse=True):
        if len(secret) >= MIN_SECRET_LENGTH:
            text = text.replace(secret, REDACTED)
    return text


def redact_text(text: Any, *, secrets: Iterable[str] = ()) -> Any:
    """Redact one string: handshake, key-shaped values, query credentials, secrets."""
    if not isinstance(text, str):
        return text
    if HANDSHAKE_MARKER.search(text):
        return HANDSHAKE_REDACTED
    redacted = JSON_SECRET.sub(_JSON_REPLACEMENT, text)
    redacted = redact_key_shaped(redacted)
    redacted = QUERY_SECRET.sub(_QUERY_REPLACEMENT, redacted)
    return _without_secrets(redacted, secrets)


def _is_handshake(value: Mapping[Any, Any]) -> bool:
    return any(
        isinstance(key, str) and key.lower() in HANDSHAKE_FIELDS for key in value
    )


def redact_value(value: Any, *, secrets: Iterable[str] = ()) -> Any:
    """Redact one log value, keeping its shape so ``%`` formatting still works."""
    secrets = tuple(secrets)
    if isinstance(value, str):
        return redact_text(value, secrets=secrets)
    if isinstance(value, Mapping):
        if _is_handshake(value):
            return HANDSHAKE_REDACTED
        # The one sanitizer's rules: forbidden keys dropped, key-shaped values
        # redacted, strings and depth bounded.
        sanitized = sanitize_fields(value)
        return {
            key: redact_value(entry, secrets=secrets)
            for key, entry in sanitized.value.items()
        }
    if isinstance(value, tuple):
        return tuple(redact_value(entry, secrets=secrets) for entry in value)
    if isinstance(value, list):
        return [redact_value(entry, secrets=secrets) for entry in value]
    return value


def _scrub(record: logging.LogRecord, secrets: tuple[str, ...]) -> logging.LogRecord:
    """Scrub one record in place: message, args and the crash-dump text."""
    try:
        record.msg = redact_value(record.msg, secrets=secrets)
        if record.args:
            record.args = redact_value(record.args, secrets=secrets)
        if record.exc_info:
            rendered = "".join(traceback.format_exception(*record.exc_info))
            record.exc_text = redact_text(rendered, secrets=secrets)
            record.exc_info = None
        if record.stack_info:
            record.stack_info = redact_text(record.stack_info, secrets=secrets)
    except Exception:
        # A failure must fail closed: withhold the line rather than write it.
        record.msg = "[log record withheld: redaction failed]"
        record.args = ()
    return record


class RedactingFilter(logging.Filter):
    """Scrub one record in place: message, args and the crash-dump text."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(secrets)

    def redact(self, text: Any) -> Any:
        return redact_text(text, secrets=self._secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        _scrub(record, self._secrets)
        return True


#: The live secret values for the record factory, refreshed by ``install``.
_ACTIVE_SECRETS: tuple[str, ...] = ()

#: The factory that existed before this module replaced it.
_BASE_RECORD_FACTORY = logging.getLogRecordFactory()


def _redacting_record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    """Every record, whatever logger or handler created it, is scrubbed.

    A filter attached to a logger only sees records logged *to* that logger and
    a filter on a handler only sees records that reach it; a record from a
    child module propagates straight past an ancestor logger's filters. The
    factory is the one seam that covers all of them, including a crash dump
    rendered by a handler nobody updated.
    """
    return _scrub(_BASE_RECORD_FACTORY(*args, **kwargs), _ACTIVE_SECRETS)


def _attach_filter(logger_or_handler: Any, filter_: RedactingFilter) -> None:
    existing = [
        entry
        for entry in logger_or_handler.filters
        if isinstance(entry, RedactingFilter)
    ]
    for entry in existing:
        logger_or_handler.removeFilter(entry)
    logger_or_handler.addFilter(filter_)


def install_log_redaction(
    environ: Mapping[str, str] | None = None,
) -> RedactingFilter:
    """Attach one redacting filter to the service's loggers and root handlers.

    Idempotent: a second call replaces the installed filters (refreshing the
    secret values) instead of stacking a second one.
    """
    global _ACTIVE_SECRETS
    _ACTIVE_SECRETS = secret_values(environ)
    filter_ = RedactingFilter(secrets=_ACTIVE_SECRETS)

    # The record factory covers every logger and every handler, including ones
    # configured after this call (uvicorn configures its handlers at startup).
    if logging.getLogRecordFactory() is not _redacting_record_factory:
        logging.setLogRecordFactory(_redacting_record_factory)

    root = logging.getLogger()
    _attach_filter(root, filter_)
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error", "fastapi"):
        _attach_filter(logging.getLogger(name), filter_)
    for handler in root.handlers:
        _attach_filter(handler, filter_)
    return filter_


__all__ = [
    "FORBIDDEN_EVENT_KEYS",
    "HANDSHAKE_FIELDS",
    "HANDSHAKE_REDACTED",
    "JSON_SECRET",
    "KEY_SHAPED_VALUE",
    "MIN_SECRET_LENGTH",
    "QUERY_SECRET",
    "REDACTED",
    "RedactingFilter",
    "SECRET_ENV_NAMES",
    "URL_CREDENTIAL",
    "install_log_redaction",
    "redact_text",
    "redact_value",
    "secret_values",
]
