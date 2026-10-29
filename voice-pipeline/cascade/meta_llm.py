"""Meta LLM backend: the Chat Completions request and stream contract.

Meta's Spark model speaks OpenAI-compatible Chat Completions on Standard
``muse-spark-1.3``. This module owns the boundary between the cascade and the
vendor: *what we put on the wire* and *what the stream means*. It builds the
request from the stored body's system prompt plus the turn's history and posts
it through an injected HTTP session factory, so a test replays the whole
backend offline.

The request is deliberately narrow, because the vendor rejects or ignores
several knobs and a caller's conversation must not leak into them:

- bearer auth, the resolved Standard model, the full history, ``stream: true``,
  ``stream_options: {include_usage: true}`` and the measured
  ``reasoning_effort``;
- ``tool_choice: "auto"`` only when tools are supplied, and
  ``parallel_tool_calls`` left at the vendor default;
- never ``store``, ``stop``, penalties, ``n > 1``, ``logprobs``, temperature or
  unsupported modalities, and never a caller identifier as ``user`` or
  ``safety_identifier``. ``safety_identifier`` is opt-in and, when present, the
  salted digest of an internal id — never a name, phone, email or raw id.
- prompt caching is not a latency default; enabling it is a reviewed decision.

``reasoning_effort`` has no default. ``"none"`` is unavailable on Spark (HTTP
400), so an absent or unavailable effort is refused when the backend is
constructed, before any request exists. M03 fixes the value from the spike's
measurement; this module only carries it.

Stream parsing lives in :class:`MetaLLMTurn` and the SSE reader: content deltas
are the only speech, ``reasoning_content`` is recorded for usage and telemetry
and never yielded, and the first content delta marks ``first_token``. The turn
record also holds usage, the accumulated tool calls and the finish disposition.
Tool arguments are parsed and validated against the tool's declared schema
before a request is emitted; a correctable failure becomes a ``tool`` result the
model fixes next request, while an unenforceable schema fails the turn. The
failure/retry policy is ticket 42; the seam it fills is documented where it is.

The per-turn record is how a caller reads what the stream produced without
re-parsing it: pass a :class:`MetaLLMTurn` to ``complete()`` (or read
``last_turn`` afterwards). A record is never shared between turns.
"""

from __future__ import annotations

import codecs
import hashlib
import json
import os
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cascade.model_guard import resolve_model
from providers import LLMStream, PrefetchHandle, TokenDelta, ToolCallRequest

META_BASE_URL = "https://api.meta.ai/v1"

CHAT_COMPLETIONS_PATH = "/chat/completions"

#: Spark always reasons; asking it not to is a vendor 400, not a speed knob.
UNAVAILABLE_REASONING_EFFORT = "none"

#: The SSE terminator; everything after it is not part of this completion.
SSE_DONE = "[DONE]"

#: The ledger mark the first *content* delta records (never reasoning).
FIRST_TOKEN_MARK = "first_token"

#: Vendor contract: a tool call id is 1-64 characters (spec "Call identity").
CALL_ID_MAX_LENGTH = 64

#: Finish reasons that hand the turn to the tool loop. ``function_call`` is the
#: legacy spelling of the same outcome (spec "Finish reasons").
TOOL_FINISH_REASONS = frozenset({"tool_calls", "function_call"})

#: The ledger counter a denied (never-executed) tool call increments.
TOOL_DENIED_COUNTER = "tool_denied"

#: Stable codes a withheld call carries back to the model. A correctable failure
#: has a call id, so the tool loop can answer it with a ``role: "tool"`` result
#: and the model can fix the call on its next request.
TOOL_ARGUMENTS_MISSING = "missing_arguments"
TOOL_ARGUMENTS_INVALID_JSON = "invalid_json"
TOOL_ARGUMENTS_NOT_AN_OBJECT = "not_an_object"
TOOL_ARGUMENTS_SCHEMA = "schema_violation"
TOOL_CALL_ID_MISSING = "missing_call_id"

#: The codes that describe something the model can correct.
TOOL_FAILURE_CODES = frozenset(
    {
        TOOL_ARGUMENTS_MISSING,
        TOOL_ARGUMENTS_INVALID_JSON,
        TOOL_ARGUMENTS_NOT_AN_OBJECT,
        TOOL_ARGUMENTS_SCHEMA,
    }
)

#: Schema keywords the cascade enforces. An enforced subset is deliberate: a
#: keyword outside it raises :class:`ToolSchemaError` by name rather than
#: letting a call through unvalidated ("A tool that cannot be represented
#: refuses the cascade by name", ticket 57).
_ANNOTATION_KEYWORDS = frozenset(
    {
        "$comment",
        "$id",
        "$schema",
        "default",
        "deprecated",
        "description",
        "examples",
        "format",
        "readOnly",
        "title",
        "writeOnly",
    }
)
_VALIDATION_KEYWORDS = frozenset(
    {
        "additionalProperties",
        "allOf",
        "anyOf",
        "const",
        "enum",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "items",
        "maxItems",
        "maxLength",
        "maxProperties",
        "maximum",
        "minItems",
        "minLength",
        "minProperties",
        "minimum",
        "not",
        "oneOf",
        "pattern",
        "properties",
        "required",
        "type",
    }
)
_SUPPORTED_KEYWORDS = _ANNOTATION_KEYWORDS | _VALIDATION_KEYWORDS

#: Deployment secret that salts the model identifier. The salt never leaves the
#: process: the request carries the digest, not the salt (ticket 44).
IDENTIFIER_SALT_ENV = "META_IDENTIFIER_SALT"


class MetaLLMConfigError(RuntimeError):
    """A required piece of backend configuration is missing."""


class MetaLLMStreamError(RuntimeError):
    """The vendor sent a stream frame this backend cannot read.

    A malformed frame is a provider contract violation, not a token: parsing it
    as text would put vendor noise in the caller's ear.
    """


class ToolCallIdentityError(MetaLLMStreamError):
    """A tool call id outside the vendor's 1-64 character contract.

    This fails the turn: executing (or denying) a call whose identity cannot be
    quoted back to the vendor is worse than stopping.
    """


class ToolArgumentsError(ValueError):
    """The accumulated argument text cannot be handed to a tool.

    The model can correct every failure this type describes (malformed JSON, a
    non-object value, arguments outside the declared schema), so it is returned
    as a tool result rather than failing the turn. ``code`` is the stable
    machine-readable reason the result carries.
    """

    def __init__(self, reason: str, *, code: str = TOOL_ARGUMENTS_SCHEMA) -> None:
        super().__init__(reason)
        self.code = code


class ToolSchemaError(MetaLLMStreamError):
    """A tool schema uses a keyword the cascade cannot enforce.

    This is our bug (an unrepresentable body tool, ticket 57), never the
    model's: the turn fails by name instead of executing an unvalidated call.
    """


class ReasoningEffortError(ValueError):
    """A reasoning effort the cascade refuses to construct a client without."""


class MetaLLMRequestError(RuntimeError):
    """The vendor answered the request with a non-success status.

    Failure classification and retry belong to ticket 42; this type only makes
    the status visible instead of parsing an error body as a token stream.
    """

    def __init__(self, status: int) -> None:
        super().__init__(f"Meta chat completions returned HTTP {status}")
        self.status = status


def resolve_reasoning_effort(reasoning_effort: str | None) -> str:
    """Return the configured effort, or refuse by name.

    The value is a measurement (M00/M03), so this module supplies no default of
    its own: a missing value is a configuration bug that must surface at
    construction, and ``"none"`` is refused because Spark answers it with 400.
    """
    if reasoning_effort is None or not str(reasoning_effort).strip():
        raise ReasoningEffortError(
            "reasoning_effort is not configured: Spark always reasons and has "
            "no default we may invent; set the value fixed from the spike's "
            "measurement (M03) before constructing the Meta LLM backend"
        )
    effort = str(reasoning_effort).strip()
    if effort.lower() == UNAVAILABLE_REASONING_EFFORT:
        raise ReasoningEffortError(
            f'reasoning_effort {effort!r} is unavailable on Spark: the vendor '
            "rejects it with HTTP 400; use the lowest supported effort the "
            "spike measured (M03)"
        )
    return effort


def build_messages(
    *,
    system_prompt: str = "",
    history: Sequence[dict[str, Any]] = (),
    hidden_context: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """Assemble the vendor message array for one turn.

    The stored body's ``system_prompt`` is sent unchanged and first; the
    cascade never rewrites the compiled prompt. History is replayed in order,
    including the assistant message that requested tools, because a tool
    result without it is a vendor 400. Hidden context is appended after the
    history as system message(s) whose content is exactly what was recorded -
    it is never captioned and never spoken.
    """
    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.extend(dict(message) for message in history)
    messages.extend({"role": "system", "content": item} for item in hidden_context)
    return messages


def build_chat_request(
    *,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    reasoning_effort: str,
    safety_identifier: str | None = None,
) -> dict[str, Any]:
    """The exact JSON body for ``POST /chat/completions``.

    One function owns the shape so a test can compare the whole payload. Any
    key not listed here is intentionally unsupported by Spark; adding one is a
    review decision, not a default.

    ``safety_identifier`` is opt-in and must already be the salted digest from
    :func:`privacy_identifier`; there is deliberately no ``user`` field and no
    prompt-caching key, because both are a reviewed privacy decision (ticket
    44), not a latency default.
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "reasoning_effort": resolve_reasoning_effort(reasoning_effort),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if safety_identifier:
        payload["safety_identifier"] = safety_identifier
    return payload


def privacy_identifier(internal_id: str, salt: str) -> str:
    """The only form in which an internal id may reach the model vendor.

    A salted SHA-256 digest: the same call always hashes the same way (vendor
    abuse detection stays coherent across retries), a different salt makes the
    same call unrecognisable, and the digest is not the unsalted hash a
    dictionary attack could reproduce. The salt is a deployment secret and is
    never part of the request.
    """
    if not internal_id.strip():
        raise ValueError("an internal id is required to build an identifier")
    if not salt:
        raise ValueError("a salt is required; an unsalted hash is not private")
    return hashlib.sha256(
        salt.encode("utf-8") + b"\x00" + internal_id.encode("utf-8")
    ).hexdigest()


class _NoPrefetch(PrefetchHandle):
    """Prefetch speculation is ticket 72; the contract still needs a handle."""

    def cancel(self) -> None:
        return None


@dataclass(slots=True)
class MetaLLMTurn:
    """Everything one completion produced, held apart from the wire.

    Created per ``complete()`` call. Nothing here is shared between turns, and
    ``close()`` is idempotent so an early exit (a barge-in cancelling the
    stream) records the same facts as a normal finish.

    ``reasoning_text`` is the model's private reasoning. It is recorded for
    usage and telemetry; it is never yielded to synthesis.

    ``usage`` starts and stays :meth:`TurnUsage.unmeasured` unless the vendor's
    usage chunk arrived. An interrupted stream therefore records "we do not
    know", never a zero that a cost table would price as free.

    ``tool_calls`` is the accumulated, index-ordered view of the stream's tool
    deltas. ``denied_tool_calls`` are calls that were emitted but must not run
    (no identity); ``rejected_tool_calls`` are calls held back for ticket 40's
    argument validation.
    """

    reasoning_text: str = ""
    reasoning_deltas: int = 0
    content_text: str = ""
    finish_reason: str | None = None
    usage: TurnUsage = field(default_factory=lambda: TurnUsage.unmeasured())
    tool_calls: list[MetaToolCall] = field(default_factory=list)
    denied_tool_calls: list[ToolDenial] = field(default_factory=list)
    rejected_tool_calls: list[ToolDenial] = field(default_factory=list)
    hold_line_required: bool = False
    finished: bool = False
    interrupted: bool = False
    closed: bool = False
    disposition: ReplyDisposition | None = None

    @property
    def truncated(self) -> bool:
        return self.disposition is not None and self.disposition.truncated

    @property
    def filtered(self) -> bool:
        return self.disposition is not None and self.disposition.filtered

    @property
    def tool_failures(self) -> list[ToolDenial]:
        """Withheld calls the model can correct from a tool result.

        A denial without a call id is not here: the vendor cannot be answered
        without an identity, so that turn closes with a hold line instead.
        """
        return [denial for denial in self.rejected_tool_calls if denial.correctable]

    def close(self) -> None:
        """Finalise the record; safe to call more than once."""
        if self.closed:
            return
        self.closed = True
        if not self.finished:
            self.interrupted = True
        if not self.usage.measured:
            # Restated, not recomputed: a partial count must never be read as
            # a measurement, and zero is a measurement.
            self.usage = TurnUsage.unmeasured()
        self.disposition = reply_disposition(self)


@dataclass(frozen=True, slots=True)
class TurnUsage:
    """The per-turn token units, or an honest "unmeasured".

    ``measured`` is the only thing a cost table may branch on: when it is
    False every count is ``None``. A single absent unit (a vendor that omits
    ``cached_tokens``) is ``None`` too, never a zero, because zero says "none
    were cached" and absence says "the vendor did not say".
    """

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    cached_tokens: int | None = None
    reasoning_tokens: int | None = None
    measured: bool = True

    @classmethod
    def unmeasured(cls) -> "TurnUsage":
        """The only value a stream that never saw a usage chunk may record."""
        return cls(measured=False)

    def as_dict(self) -> dict[str, Any]:
        """Stable artifact shape; ticket 101 prices these units, not the SSE."""
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "cached_tokens": self.cached_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "measured": self.measured,
        }


def _count(value: Any) -> int | None:
    """A token count, or ``None`` when the vendor did not supply one."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _nested_count(usage: dict[str, Any], container: str, key: str) -> int | None:
    details = usage.get(container)
    if isinstance(details, dict):
        return _count(details.get(key))
    return None


def _first_count(
    usage: dict[str, Any], container: str, key: str, top_level: str
) -> int | None:
    """A detail count, falling back to the top-level spelling when omitted."""
    nested = _nested_count(usage, container, key)
    return nested if nested is not None else _count(usage.get(top_level))


def parse_usage(usage: dict[str, Any]) -> TurnUsage:
    """Read the vendor's usage object into the per-turn record.

    The counts live either under ``*_tokens_details`` (current shape) or at the
    top level (older/open-compatible vendors). Cached and reasoning counts are
    absent-tolerant: an omitted detail is ``None``, never zero. A frame that
    carries no count at all is not a measurement.
    """
    prompt = _count(usage.get("prompt_tokens"))
    completion = _count(usage.get("completion_tokens"))
    total = _count(usage.get("total_tokens"))
    cached = _first_count(
        usage, "prompt_tokens_details", "cached_tokens", "cached_tokens"
    )
    reasoning = _first_count(
        usage, "completion_tokens_details", "reasoning_tokens", "reasoning_tokens"
    )
    if prompt is completion is total is cached is reasoning is None:
        return TurnUsage.unmeasured()
    return TurnUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        cached_tokens=cached,
        reasoning_tokens=reasoning,
        measured=True,
    )


@dataclass(frozen=True, slots=True)
class MetaToolCall:
    """One tool call, accumulated across the deltas that carried it.

    ``arguments`` is the raw JSON text the vendor streamed, joined in order.
    Parsing it is ticket 40's concern; keeping the text means a malformed
    payload can be reported verbatim instead of guessed at.
    """

    index: int
    call_id: str
    name: str
    arguments: str = ""


@dataclass(frozen=True, slots=True)
class ToolDenial:
    """A recorded reason a call was not executed, kept with the turn.

    ``code`` is the stable failure code; ``call_id`` is the identity the vendor
    expects back. A correctable denial (argument failure on a call that has an
    id) can be turned into the ``role: "tool"`` result the model corrects from;
    a denial without an id cannot, because there is nothing to quote back.
    """

    name: str
    reason: str
    call_id: str = ""
    code: str = ""

    @property
    def correctable(self) -> bool:
        return bool(self.call_id) and self.code in TOOL_FAILURE_CODES

    def as_tool_message(self) -> dict[str, Any]:
        """The tool result for this failure; refuses an unanswerable denial."""
        if not self.correctable:
            raise ValueError(
                f"tool denial for {self.name!r} has no usable call id or is not "
                "a correctable argument failure; it cannot be returned as a "
                "tool result"
            )
        return {
            "role": "tool",
            "tool_call_id": self.call_id,
            "content": json.dumps(
                {"error": self.code, "message": self.reason},
                ensure_ascii=False,
            ),
        }


class ReplyOutcome(str, Enum):
    """What a finished stream means for the turn, independent of the wording."""

    NORMAL = "normal"
    EMPTY = "empty"
    TRUNCATED = "truncated"
    FILTERED = "filtered"
    TOOL_HANDOFF = "tool_handoff"
    INCOMPLETE = "incomplete"


@dataclass(frozen=True, slots=True)
class ReplyDisposition:
    """What the orchestrator may do with the reply that was generated.

    ``speak`` is the audio decision: a tool handoff and an empty reply speak
    nothing, while a truncated or filtered reply speaks exactly what arrived.
    ``retry_allowed`` is the one seam ticket 42 reads: a stream that died before
    its first content token may be retried, a reply already in the caller's ear
    may not.
    """

    outcome: ReplyOutcome
    finish_reason: str | None
    speak: bool
    retry_allowed: bool
    truncated: bool = False
    filtered: bool = False
    hold_line: bool = False


def reply_disposition(turn: MetaLLMTurn) -> ReplyDisposition:
    """Map a turn's finish reason and content to its documented speech.

    ``stop`` is normal, but a stop with nothing to say is an empty turn, not a
    reason to invent a line. ``length`` and ``content_filter`` speak what was
    generated and never retry. ``tool_calls``/``function_call`` hand off to the
    tool loop. An absent or unknown finish reason is ``INCOMPLETE``: guessing
    it was a normal stop would hide a cut stream.
    """
    reason = turn.finish_reason
    has_content = bool(turn.content_text.strip())
    if reason in TOOL_FINISH_REASONS:
        return ReplyDisposition(
            outcome=ReplyOutcome.TOOL_HANDOFF,
            finish_reason=reason,
            speak=False,
            retry_allowed=False,
            hold_line=True,
        )
    if reason == "length":
        return ReplyDisposition(
            outcome=ReplyOutcome.TRUNCATED,
            finish_reason=reason,
            speak=has_content,
            retry_allowed=False,
            truncated=True,
        )
    if reason == "content_filter":
        return ReplyDisposition(
            outcome=ReplyOutcome.FILTERED,
            finish_reason=reason,
            speak=has_content,
            retry_allowed=False,
            filtered=True,
        )
    if reason == "stop":
        if not has_content:
            return ReplyDisposition(
                outcome=ReplyOutcome.EMPTY,
                finish_reason=reason,
                speak=False,
                retry_allowed=False,
            )
        return ReplyDisposition(
            outcome=ReplyOutcome.NORMAL,
            finish_reason=reason,
            speak=True,
            retry_allowed=False,
        )
    return ReplyDisposition(
        outcome=ReplyOutcome.INCOMPLETE,
        finish_reason=reason,
        speak=has_content,
        retry_allowed=not turn.content_text,
    )


def parse_tool_arguments(raw: str) -> dict[str, Any]:
    """Read the accumulated argument text as a JSON object.

    The parse owns malformed JSON and object-ness; :func:`validate_tool_arguments`
    owns the declared schema. What this must never do is invent ``{}`` for a
    payload that was malformed or absent, because that would execute a side
    effect the model never asked for.
    """
    if not raw.strip():
        raise ToolArgumentsError(
            "no arguments were streamed: a call with no argument text is not "
            "executed with an invented empty object",
            code=TOOL_ARGUMENTS_MISSING,
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ToolArgumentsError(
            f"arguments are not valid JSON ({error.msg} at character "
            f"{error.pos}); the call is not executed",
            code=TOOL_ARGUMENTS_INVALID_JSON,
        ) from error
    if not isinstance(value, dict):
        raise ToolArgumentsError(
            f"arguments are a JSON {type(value).__name__}, not an object; the "
            "call is not executed",
            code=TOOL_ARGUMENTS_NOT_AN_OBJECT,
        )
    return value


def _json_type(value: Any) -> str:
    """The JSON type name, with bool kept apart from integer."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _matches_type(value: Any, name: str, path: str) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise ToolSchemaError(
        f"tool schema at {path} declares unsupported type {name!r}; the "
        "cascade validates only JSON Schema type names"
    )


def _violation(path: str, reason: str) -> ToolArgumentsError:
    return ToolArgumentsError(
        f"{path}: {reason}; the call is not executed and the failure is "
        "returned to the model",
        code=TOOL_ARGUMENTS_SCHEMA,
    )


def _check_combinations(value: Any, schema: dict[str, Any], path: str) -> None:
    for keyword in ("allOf",):
        branches = schema.get(keyword)
        if branches is None:
            continue
        if not isinstance(branches, list):
            raise ToolSchemaError(f"tool schema {keyword} at {path} is not a list")
        for index, branch in enumerate(branches):
            _validate(value, branch, f"{path} ({keyword}[{index}])")

    if "anyOf" in schema:
        branches = schema["anyOf"]
        if not isinstance(branches, list) or not branches:
            raise ToolSchemaError(f"tool schema anyOf at {path} is not a list")
        errors = []
        matched_any = False
        for index, branch in enumerate(branches):
            try:
                _validate(value, branch, path)
                matched_any = True
                break
            except ToolArgumentsError as error:
                errors.append(f"[{index}] {error}")
        if not matched_any:
            raise _violation(path, "matches none of anyOf: " + " | ".join(errors))

    if "oneOf" in schema:
        branches = schema["oneOf"]
        if not isinstance(branches, list) or not branches:
            raise ToolSchemaError(f"tool schema oneOf at {path} is not a list")
        matched = 0
        for branch in branches:
            try:
                _validate(value, branch, path)
                matched += 1
            except ToolArgumentsError:
                continue
        if matched != 1:
            raise _violation(
                path, f"matches {matched} oneOf branches; exactly one is required"
            )

    if "not" in schema:
        try:
            _validate(value, schema["not"], path)
        except ToolArgumentsError:
            pass
        else:
            raise _violation(path, "matches a 'not' schema")


def _validate_enum(value: Any, schema: dict[str, Any], path: str) -> None:
    if "const" in schema and value != schema["const"]:
        raise _violation(
            path, f"const: must equal {schema['const']!r}, got {value!r}"
        )
    if "enum" in schema:
        allowed = schema["enum"]
        if not isinstance(allowed, list):
            raise ToolSchemaError(f"tool schema enum at {path} is not a list")
        if not any(
            value == candidate and _json_type(value) == _json_type(candidate)
            for candidate in allowed
        ):
            raise _violation(
                path, f"enum: must be one of {allowed!r}, got {value!r}"
            )


def _validate_object(value: Any, schema: dict[str, Any], path: str) -> None:
    if not isinstance(value, dict):
        raise _violation(path, f"must be an object, got {_json_type(value)}")
    required = schema.get("required", [])
    if not isinstance(required, list):
        raise ToolSchemaError(f"tool schema required at {path} is not a list")
    missing = [name for name in required if name not in value]
    if missing:
        raise _violation(path, f"missing required property {missing[0]!r}")
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        raise ToolSchemaError(f"tool schema properties at {path} is not an object")
    for name, subschema in properties.items():
        if name in value:
            _validate(value[name], subschema, f"{path}.{name}")
    extra = [name for name in value if name not in properties]
    additional = schema.get("additionalProperties", True)
    if additional is False and extra:
        raise _violation(
            path,
            f"property {extra[0]!r} is not declared and additional properties "
            "are refused",
        )
    if isinstance(additional, dict):
        for name in extra:
            _validate(value[name], additional, f"{path}.{name}")
    if "minProperties" in schema and len(value) < schema["minProperties"]:
        raise _violation(path, f"needs at least {schema['minProperties']} properties")
    if "maxProperties" in schema and len(value) > schema["maxProperties"]:
        raise _violation(path, f"allows at most {schema['maxProperties']} properties")


def _validate_array(value: Any, schema: dict[str, Any], path: str) -> None:
    if not isinstance(value, list):
        raise _violation(path, f"must be an array, got {_json_type(value)}")
    items = schema.get("items")
    if items is not None:
        if not isinstance(items, dict):
            raise ToolSchemaError(
                f"tool schema uses array-form 'items' at {path}; the cascade "
                "validates a single item schema"
            )
        for index, item in enumerate(value):
            _validate(item, items, f"{path}[{index}]")
    if "minItems" in schema and len(value) < schema["minItems"]:
        raise _violation(path, f"needs at least {schema['minItems']} items")
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        raise _violation(path, f"allows at most {schema['maxItems']} items")


def _validate_string(value: Any, schema: dict[str, Any], path: str) -> None:
    if not isinstance(value, str):
        raise _violation(path, f"must be a string, got {_json_type(value)}")
    if "minLength" in schema and len(value) < schema["minLength"]:
        raise _violation(path, f"needs at least {schema['minLength']} characters")
    if "maxLength" in schema and len(value) > schema["maxLength"]:
        raise _violation(path, f"allows at most {schema['maxLength']} characters")
    if "pattern" in schema:
        try:
            matched = re.search(schema["pattern"], value)
        except re.error as error:
            raise ToolSchemaError(
                f"tool schema pattern at {path} is not a valid regex: {error}"
            ) from error
        if matched is None:
            raise _violation(path, f"must match pattern {schema['pattern']!r}")


def _validate_number(value: Any, schema: dict[str, Any], path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _violation(path, f"must be a number, got {_json_type(value)}")
    for keyword, comparison, wording in (
        ("minimum", lambda bound: value >= bound, "at least"),
        ("maximum", lambda bound: value <= bound, "at most"),
        ("exclusiveMinimum", lambda bound: value > bound, "greater than"),
        ("exclusiveMaximum", lambda bound: value < bound, "less than"),
    ):
        if keyword not in schema:
            continue
        bound = schema[keyword]
        if isinstance(bound, bool) or not isinstance(bound, (int, float)):
            raise ToolSchemaError(
                f"tool schema {keyword} at {path} is not a number"
            )
        if not comparison(bound):
            raise _violation(
                path, f"{keyword}: must be {wording} {bound!r}"
            )


def _validate(value: Any, schema: Any, path: str) -> None:
    if not isinstance(schema, dict):
        raise ToolSchemaError(f"tool schema at {path} is not an object")
    unsupported = sorted(set(schema) - _SUPPORTED_KEYWORDS)
    if unsupported:
        raise ToolSchemaError(
            f"tool schema at {path} uses unsupported keyword(s) "
            f"{', '.join(unsupported)}; the cascade refuses a schema it cannot "
            "enforce instead of executing an unvalidated call"
        )
    _validate_enum(value, schema, path)
    _check_combinations(value, schema, path)

    if "type" in schema:
        declared = schema["type"]
        names = [declared] if isinstance(declared, str) else list(declared)
        if not names:
            raise ToolSchemaError(f"tool schema type at {path} is empty")
        if not any(_matches_type(value, name, path) for name in names):
            expected = " or ".join(names)
            raise _violation(
                path, f"must be {expected}, got {_json_type(value)}"
            )

    object_keywords = {
        "additionalProperties",
        "maxProperties",
        "minProperties",
        "properties",
        "required",
    }
    if object_keywords & set(schema) or isinstance(value, dict):
        _validate_object(value, schema, path)
    if {"items", "maxItems", "minItems"} & set(schema) or isinstance(value, list):
        _validate_array(value, schema, path)
    if isinstance(value, str):
        _validate_string(value, schema, path)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        _validate_number(value, schema, path)


def validate_tool_arguments(
    arguments: dict[str, Any], schema: dict[str, Any] | None
) -> None:
    """Refuse arguments outside the tool's declared schema, before execution.

    A ``None`` schema means the tool declared no parameters, so there is
    nothing to check; the JSON object-ness was already decided by
    :func:`parse_tool_arguments`. An enforced keyword outside the documented
    subset raises :class:`ToolSchemaError` (a turn failure) so a schema can
    never be silently under-enforced.
    """
    if not isinstance(arguments, dict):
        raise ToolArgumentsError(
            f"arguments are a JSON {type(arguments).__name__}, not an object",
            code=TOOL_ARGUMENTS_NOT_AN_OBJECT,
        )
    if schema is None:
        return
    _validate(arguments, schema, "arguments")


def _tool_schemas(tools: Sequence[dict[str, Any]] | None) -> dict[str, Any]:
    """The declared parameter schema per tool name, for calls we may receive."""
    schemas: dict[str, Any] = {}
    for tool in tools or ():
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        parameters = function.get("parameters")
        if isinstance(name, str) and isinstance(parameters, dict):
            schemas[name] = parameters
    return schemas


class _SSEParser:
    """Incremental Server-Sent Events reader over a stream of byte chunks.

    A chunk boundary is a *byte* boundary, so UTF-8 decoding is incremental: a
    multi-byte character may be split across two chunks and must still arrive
    whole. A line boundary is a newline; a blank line dispatches one event.
    Comments (``:`` heartbeat) and non-``data`` fields carry no payload.
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._data: list[str] = []
        self.done = False

    def feed(self, chunk: bytes) -> list[str]:
        if self.done:
            return []
        return self._lines(self._decoder.decode(chunk))

    def close(self) -> list[str]:
        """Flush a final line and any trailing event the vendor did not end."""
        payloads = self._lines(self._decoder.decode(b"", final=True))
        if self.done:
            return payloads
        if self._buffer:
            payload = self._line(self._buffer)
            self._buffer = ""
            if payload is not None:
                payloads.append(payload)
        payload = self._line("")
        if payload is not None:
            payloads.append(payload)
        return payloads

    def _lines(self, text: str) -> list[str]:
        self._buffer += text
        payloads: list[str] = []
        while not self.done and "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            payload = self._line(line)
            if payload is not None:
                payloads.append(payload)
        if self.done:
            self._buffer = ""
        return payloads

    def _line(self, raw: str) -> str | None:
        line = raw.rstrip("\r")
        if not line:
            if not self._data:
                return None
            payload = "\n".join(self._data)
            self._data = []
            if payload.strip() == SSE_DONE:
                self.done = True
                return None
            return payload
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        if field != "data":
            return None
        self._data.append(value[1:] if value.startswith(" ") else value)
        return None


def _resolve_safety_identifier(
    internal_id: str | None, salt: str | None
) -> str | None:
    """The salted digest for this call, or ``None`` when identity is unset.

    An internal id without a salt is refused by name: the unsalted digest is a
    dictionary attack away from the raw id, so "configured" and "private" must
    not be the same thing.
    """
    if internal_id is None:
        return None
    if not internal_id.strip():
        raise MetaLLMConfigError(
            "internal_id is empty: the model identifier must derive from a real "
            "internal call id, never from a blank value"
        )
    resolved_salt = (salt or os.environ.get(IDENTIFIER_SALT_ENV) or "").strip()
    if not resolved_salt:
        raise MetaLLMConfigError(
            f"internal_id is configured without a salt: set {IDENTIFIER_SALT_ENV} "
            "or pass identifier_salt; an unsalted hash is not private"
        )
    return privacy_identifier(internal_id.strip(), resolved_salt)


def _text(value: Any) -> str:
    """A streamed string field, or empty when the vendor omitted it."""
    return value if isinstance(value, str) else ""


def _reasoning_delta(delta: dict[str, Any]) -> str:
    """The reasoning text in one delta, under either vendor spelling."""
    for key in ("reasoning_content", "reasoning"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


class _TurnStream:
    """Turns decoded SSE payloads into provider events and one turn record.

    Content deltas are yielded as ``TokenDelta`` the moment they arrive, so
    synthesis starts on the first spoken word. Reasoning is folded into the
    record only. Anything that must wait for the whole turn (tool-call
    accumulation, usage, finish disposition) is kept here, not re-parsed later.
    """

    def __init__(
        self,
        turn: MetaLLMTurn,
        ledger: Any = None,
        tools: Sequence[dict[str, Any]] | None = None,
    ) -> None:
        self.turn = turn
        self._ledger = ledger
        #: name -> declared parameter schema. A call whose name has no schema
        #: cannot be validated; the tool loop's invented-name rule owns it.
        self._schemas = _tool_schemas(tools)
        #: index -> {"id", "name", "arguments"} as streamed. One slot per index
        #: so a split id, name or argument string joins into one call.
        self._calls: dict[int, dict[str, str]] = {}
        self._emitted_indices: set[int] = set()

    def consume(self, payload: str) -> list[TokenDelta | ToolCallRequest]:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as error:
            raise MetaLLMStreamError(
                f"Meta stream frame is not JSON: {payload[:120]!r}"
            ) from error
        if not isinstance(data, dict):
            raise MetaLLMStreamError(
                f"Meta stream frame is not an object: {payload[:120]!r}"
            )
        usage = data.get("usage")
        if isinstance(usage, dict):
            parsed = parse_usage(usage)
            if parsed.measured:
                self.turn.usage = parsed
        emitted: list[TokenDelta | ToolCallRequest] = []
        for choice in data.get("choices") or ():
            delta = choice.get("delta") or {}
            self._record_reasoning(_reasoning_delta(delta))
            emitted.extend(self._content(delta.get("content")))
            self._accumulate_tool_calls(delta)
            finish = choice.get("finish_reason")
            if finish:
                self.turn.finish_reason = finish
                if finish in TOOL_FINISH_REASONS:
                    emitted.extend(self.finish())
        return emitted

    def finish(self) -> list[ToolCallRequest]:
        """Emit one request per accumulated index, in index order.

        Called when ``finish_reason`` is a tool handoff *and* again when the
        stream ends; the emitted-index set makes the second call a no-op, so a
        split delta can never produce two executions.
        """
        calls = [
            MetaToolCall(
                index=index,
                call_id=slot["id"],
                name=slot["name"],
                arguments=slot["arguments"],
            )
            for index, slot in sorted(self._calls.items())
        ]
        self.turn.tool_calls = calls
        emitted: list[ToolCallRequest] = []
        for call in calls:
            if call.index in self._emitted_indices:
                continue
            self._emitted_indices.add(call.index)
            request = self._request_for(call)
            if request is not None:
                emitted.append(request)
        return emitted

    def _request_for(self, call: MetaToolCall) -> ToolCallRequest | None:
        if len(call.call_id) > CALL_ID_MAX_LENGTH:
            raise ToolCallIdentityError(
                f"tool call id is {len(call.call_id)} characters; the vendor "
                f"contract is 1-{CALL_ID_MAX_LENGTH} (call {call.name!r})"
            )
        if not call.call_id:
            # Emitted with an empty id so the tool loop can see the intent, but
            # an empty id is never executable: the turn closes with a hold line.
            self._deny(
                call,
                "call_id is missing or empty; the call is not executed and the "
                "turn closes with a hold line",
                code=TOOL_CALL_ID_MISSING,
            )
            return ToolCallRequest(name=call.name, arguments={}, call_id="")
        try:
            arguments = parse_tool_arguments(call.arguments)
            validate_tool_arguments(arguments, self._schemas.get(call.name))
        except ToolArgumentsError as error:
            # Withheld, never executed, and answerable: the tool loop appends
            # ``denial.as_tool_message()`` so the model corrects next request.
            self.turn.rejected_tool_calls.append(
                ToolDenial(
                    name=call.name,
                    reason=str(error),
                    call_id=call.call_id,
                    code=error.code,
                )
            )
            return None
        return ToolCallRequest(
            name=call.name, arguments=arguments, call_id=call.call_id
        )

    def _deny(self, call: MetaToolCall, reason: str, *, code: str = "") -> None:
        self.turn.denied_tool_calls.append(
            ToolDenial(name=call.name, reason=reason, call_id=call.call_id, code=code)
        )
        self.turn.hold_line_required = True
        if self._ledger is not None:
            self._ledger.count(TOOL_DENIED_COUNTER)

    def _accumulate_tool_calls(self, delta: dict[str, Any]) -> None:
        batches = delta.get("tool_calls")
        if isinstance(batches, list):
            for batch in batches:
                if not isinstance(batch, dict):
                    continue
                index = batch.get("index")
                slot = self._slot(index if isinstance(index, int) else 0)
                slot["id"] += _text(batch.get("id"))
                function = batch.get("function")
                if isinstance(function, dict):
                    slot["name"] += _text(function.get("name"))
                    slot["arguments"] += _text(function.get("arguments"))
        legacy = delta.get("function_call")
        if isinstance(legacy, dict):
            # The deprecated single-call shape carries no id and no index.
            slot = self._slot(0)
            slot["name"] += _text(legacy.get("name"))
            slot["arguments"] += _text(legacy.get("arguments"))

    def _slot(self, index: int) -> dict[str, str]:
        return self._calls.setdefault(
            index, {"id": "", "name": "", "arguments": ""}
        )

    def _record_reasoning(self, text: str) -> None:
        if not text:
            return
        if self.turn.reasoning_deltas == 0:
            self.turn.reasoning_text = text
        else:
            self.turn.reasoning_text += text
        self.turn.reasoning_deltas += 1

    def _content(self, content: Any) -> list[TokenDelta]:
        if not isinstance(content, str) or not content:
            return []
        first_content = not self.turn.content_text
        self.turn.content_text += content
        if first_content and self._ledger is not None:
            self._ledger.mark(FIRST_TOKEN_MARK)
        return [TokenDelta(text=content)]


class _AiohttpResponse:
    def __init__(self, resp: Any) -> None:
        self._resp = resp
        self.status: int = resp.status

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        async for chunk in self._resp.content.iter_chunked(1024):
            yield chunk


class _AiohttpPost:
    def __init__(self, session: Any, url: str, headers: dict, payload: dict) -> None:
        self._session = session
        self._url = url
        self._headers = headers
        self._payload = payload
        self._cm: Any = None

    async def __aenter__(self) -> _AiohttpResponse:
        self._cm = self._session.post(
            self._url, headers=self._headers, json=self._payload
        )
        resp = await self._cm.__aenter__()
        return _AiohttpResponse(resp)

    async def __aexit__(self, *args: Any) -> bool:
        if self._cm is not None:
            await self._cm.__aexit__(*args)
        return False


class _AiohttpSession:
    """Production HTTP seam. Tests always inject a scripted factory instead.

    This mirrors the adapter in ``backends/gateway_llm.py``; unifying the
    vendor adapters is a separate ticket, and the cascade must stay importable
    without aiohttp installed (the import is lazy).
    """

    def __init__(self, timeout_s: float) -> None:
        import aiohttp

        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout_s)
        )

    async def __aenter__(self) -> "_AiohttpSession":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._session.close()

    def post(self, url: str, *, headers: dict, json: dict) -> _AiohttpPost:
        return _AiohttpPost(self._session, url, headers=headers, payload=json)



class MetaLLM(LLMStream):
    """``LLMStream`` over Meta's OpenAI-compatible Chat Completions endpoint."""

    def __init__(
        self,
        *,
        reasoning_effort: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str = META_BASE_URL,
        system_prompt: str = "",
        session_factory: Any = None,
        timeout_s: float = 60.0,
        ledger: Any = None,
        internal_id: str | None = None,
        identifier_salt: str | None = None,
    ) -> None:
        # Construction guard first: a Contributor id must fail before any
        # request field exists to leak into (ticket 35).
        self._model = resolve_model(model)
        self._reasoning_effort = resolve_reasoning_effort(reasoning_effort)
        self._api_key = api_key or os.environ.get("META_API_KEY")
        self._base_url = base_url.rstrip("/")
        self._system_prompt = system_prompt
        self._session_factory = session_factory or _AiohttpSession
        self._timeout_s = timeout_s
        # Optional ``TimingLedger``-shaped sink: the first content delta marks
        # ``first_token``. Marking is first-write-wins, so an orchestrator that
        # also marks it is harmless.
        self._ledger = ledger
        # The optional model identifier is derived once, at construction: the
        # raw internal id never becomes a request field (ticket 44).
        self._safety_identifier = _resolve_safety_identifier(
            internal_id, identifier_salt
        )
        self._last_turn: MetaLLMTurn | None = None

    @property
    def model(self) -> str:
        return self._model

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    @property
    def last_turn(self) -> MetaLLMTurn | None:
        """The record of the most recent ``complete()`` call, if any.

        Convenience for a caller driving one completion at a time. A caller
        that may overlap completions passes its own ``turn=`` record instead.
        """
        return self._last_turn

    def prefetch(self, *, messages: list[dict[str, Any]]) -> PrefetchHandle:
        return _NoPrefetch()

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        hidden_context: Sequence[str] = (),
        turn: MetaLLMTurn | None = None,
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        if not self._api_key:
            raise MetaLLMConfigError(
                "META_API_KEY is not configured: the chat completions request "
                "needs bearer auth, and an unauthenticated request must not be "
                "sent"
            )
        payload = build_chat_request(
            model=self._model,
            messages=build_messages(
                system_prompt=self._system_prompt,
                history=messages,
                hidden_context=hidden_context,
            ),
            tools=tools,
            reasoning_effort=self._reasoning_effort,
            safety_identifier=self._safety_identifier,
        )
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        url = f"{self._base_url}{CHAT_COMPLETIONS_PATH}"
        record = turn if turn is not None else MetaLLMTurn()
        self._last_turn = record
        stream = _TurnStream(record, self._ledger, tools)
        parser = _SSEParser()
        session = self._session_factory(timeout_s=self._timeout_s)
        try:
            async with session as active:
                async with active.post(url, headers=headers, json=payload) as response:
                    if response.status != 200:
                        raise MetaLLMRequestError(response.status)
                    async for chunk in response.iter_bytes():
                        for frame in parser.feed(chunk):
                            for event in stream.consume(frame):
                                yield event
                    for frame in parser.close():
                        for event in stream.consume(frame):
                            yield event
                    for event in stream.finish():
                        yield event
                    record.finished = True
        finally:
            record.close()


__all__ = [
    "CALL_ID_MAX_LENGTH",
    "CHAT_COMPLETIONS_PATH",
    "FIRST_TOKEN_MARK",
    "IDENTIFIER_SALT_ENV",
    "META_BASE_URL",
    "SSE_DONE",
    "TOOL_ARGUMENTS_INVALID_JSON",
    "TOOL_ARGUMENTS_MISSING",
    "TOOL_ARGUMENTS_NOT_AN_OBJECT",
    "TOOL_ARGUMENTS_SCHEMA",
    "TOOL_CALL_ID_MISSING",
    "TOOL_DENIED_COUNTER",
    "TOOL_FAILURE_CODES",
    "TOOL_FINISH_REASONS",
    "UNAVAILABLE_REASONING_EFFORT",
    "MetaLLM",
    "MetaLLMConfigError",
    "MetaLLMRequestError",
    "MetaLLMStreamError",
    "MetaLLMTurn",
    "MetaToolCall",
    "ReasoningEffortError",
    "ReplyDisposition",
    "ReplyOutcome",
    "ToolArgumentsError",
    "ToolCallIdentityError",
    "ToolDenial",
    "ToolSchemaError",
    "TurnUsage",
    "build_chat_request",
    "build_messages",
    "parse_tool_arguments",
    "parse_usage",
    "privacy_identifier",
    "reply_disposition",
    "resolve_reasoning_effort",
    "validate_tool_arguments",
]
