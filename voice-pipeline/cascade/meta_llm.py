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
model fixes next request, while an unenforceable schema fails the turn.

Failures follow the spec's phase policy and the ticket-94 budget: a 400 is a
conversation bug (fail the turn and alert, never open the leg), while
429/5xx/timeouts retry once before anything reached the caller and otherwise
open the leg for future calls. A reply already delivered is never restarted,
because a second completion would repeat speech: the turn drains at its last
complete sentence, ``spoken_text`` records the prefix the caller heard, and a
second failure on the leg ends the call (ticket 96).

The per-turn record is how a caller reads what the stream produced without
re-parsing it: pass a :class:`MetaLLMTurn` to ``complete()`` (or read
``last_turn`` afterwards). A record is never shared between turns.

A stored body may carry its own OpenAI-compatible provider (ticket 159). That
client is constructed server-side from the body's one entry by
:func:`construct_byo_model` and reuses this whole contract — the same request
builder, the same tools, the same stream parsing and the same failure policy.
Only construction differs: the Standard-only guard belongs to the Meta Spark
rung, not to a tenant's chosen model, and the body's optional
``reasoning_effort`` is sent verbatim (``"none"`` is a tenant-model choice, not
a Spark 400). The key is read from the signed body, reaches the authorization
header, and is never part of a representation or a document.
"""

from __future__ import annotations

import codecs
import hashlib
import json
import os
import re
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from urllib.parse import urlsplit

from cascade import llm_override
from cascade.body_map import LlmOverride
from cascade.failures import FailureClass, FailureVerdict, classify
from cascade.ladders import CallRungs, ProviderAttribution
from cascade.model_guard import resolve_model
from cascade.reconnect import (
    RECONNECTS_PER_LEG,
    ReconnectAction,
    ReconnectBudget,
)
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

#: Failure phases recorded with a retry decision. ``connect`` is a failure
#: before the request was accepted, ``turn`` after the stream started but before
#: any content token, and ``reply`` after audio text was already yielded.
PHASE_CONNECT = "connect"
PHASE_TURN = "turn"
PHASE_REPLY = "reply"
FAILURE_PHASES = (PHASE_CONNECT, PHASE_TURN, PHASE_REPLY)

#: The spec's failure policy: one retry per leg, so two failures end the call.
#: Kept as the exported contract, but the ticket-94 budget is the authority;
#: this is settled policy, not an operational bound, so it is not a threshold.
MAX_LEG_FAILURES = RECONNECTS_PER_LEG + 1

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


class ByoLlmError(MetaLLMConfigError):
    """The stored body's provider entry cannot construct a client.

    Raised at construction, before any request or vendor socket exists, and by
    eligibility's constructibility check. The message names the field, never
    its value: one of these fields is a credential.
    """


def byo_provider(base_url: str, model: str) -> str:
    """The provider id a BYO turn's attribution names.

    The tenant's provider is identified by the host its base URL points at,
    plus the model the body chose — never the Standard rung's model id.
    """
    host = urlsplit(base_url).netloc
    return f"{host}/{model}"


def _byo_reasoning_effort(value: str | None) -> str | None:
    """A tenant model's optional effort, verbatim; absent means omitted.

    The Spark-specific refusal (``"none"`` is an HTTP 400) belongs to the
    Standard rung, not here: a tenant model may explicitly disable thinking.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ByoLlmError(
            f"reasoning_effort must be a string, got {type(value).__name__}"
        )
    return value.strip() or None


def validate_byo_override(override: LlmOverride) -> LlmOverride:
    """Refuse an override that cannot become a request, by name.

    This is the client-side constructibility check: the body adapter already
    validated the served shape, and the constructor re-asserts it so no other
    entry point can build a client the request builder would fail on later. The
    rules themselves are :mod:`cascade.llm_override`'s one validator; this
    function only keeps the client's named refusal.
    """
    if not isinstance(override, LlmOverride):
        raise ByoLlmError(
            f"a BYO model needs the body's LlmOverride, got {type(override).__name__}"
        )
    try:
        llm_override.validate_override(
            base_url=override.base_url,
            model=override.model,
            api_key=override.api_key,
            reasoning_effort=override.reasoning_effort,
        )
    except llm_override.LlmOverrideInvalid as error:
        raise ByoLlmError(
            f"the stored body's LLM override is invalid: {error.reason}"
        ) from None
    return override


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


class MessageAssemblyError(ValueError):
    """A message array that would be a conversation-structure bug.

    The vendor answers these shapes with HTTP 400, so the assembly refuses them
    here, by name, instead of spending a request to learn it.
    """


class MetaLLMRequestError(RuntimeError):
    """The vendor answered the request with a non-success status.

    Raised inside one attempt; :meth:`MetaLLM.complete` classifies it and
    applies the ticket-42 policy, so callers see a :class:`MetaLLMFailure`
    carrying the recorded decision instead of a bare status.
    """

    def __init__(self, status: int) -> None:
        super().__init__(f"Meta chat completions returned HTTP {status}")
        self.status = status


@dataclass(frozen=True, slots=True)
class FailureDecision:
    """One model-leg failure, and what the retry policy did about it.

    ``phase`` is the evidence the policy branches on: a ``reply`` failure has
    already handed text to synthesis, so restarting would repeat speech.
    ``opened_leg`` is true only when this decision wrote the durable breaker
    record; a bug verdict never does.
    """

    attempt: int
    phase: str
    verdict: FailureVerdict
    retry: bool
    opened_leg: bool
    reason: str

    def __post_init__(self) -> None:
        if self.phase not in FAILURE_PHASES:
            raise ValueError(
                f"unknown failure phase {self.phase!r}; expected one of "
                f"{FAILURE_PHASES}"
            )

    def to_document(self) -> dict[str, Any]:
        return {
            "attempt": self.attempt,
            "phase": self.phase,
            "code": self.verdict.code,
            "failureClass": self.verdict.failure_class.value,
            "retry": self.retry,
            "openedLeg": self.opened_leg,
            "reason": self.reason,
        }


class MetaLLMFailure(RuntimeError):
    """A model-leg failure the ticket-42 policy classified and recorded."""

    def __init__(self, decision: FailureDecision) -> None:
        self.decision = decision
        super().__init__(
            f"model leg failed in {decision.phase} on attempt "
            f"{decision.attempt} (code {decision.verdict.code!r}): "
            f"{decision.reason}"
        )


class MetaLLMTurnFailed(MetaLLMFailure):
    """Fail the turn and alert; the leg is not opened.

    A deterministic request bug (HTTP 400). The caller may answer with a failure
    line, but it must not retry the request or move to another rung mid-call.
    """


class MetaLLMReplyInterrupted(MetaLLMFailure):
    """A reply already in the caller's ear was cut.

    Never retried: a second completion would repeat speech. The caller drains
    what was queued, closes at the last complete sentence, and keeps the call.
    """


class MetaLLMLegExhausted(MetaLLMFailure):
    """The leg's one-retry policy is spent; this call ends.

    The breaker was opened (or was already unreadable) for future calls; there
    is no mid-call handover to the fallback rung.
    """


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


#: Characters that end a sentence when they are followed by whitespace or the
#: end of the generated text. A decimal point or an abbreviation inside a word
#: is not a boundary (the terminator must be followed by a break).
_SENTENCE_END = ".!?"

#: Closing punctuation that may sit between the terminator and the break.
_SENTENCE_CLOSERS = "\"'”’)]}"


def last_complete_sentence(text: str) -> str:
    """The longest prefix of ``text`` that ends at a complete sentence.

    A failure mid-reply drains the sentences already handed to synthesis and
    closes the turn here: the caller hears whole sentences and never a cut
    word. Text with no finished sentence has no safe close point, so the
    prefix is empty (the queued sentence is dropped, not truncated).
    """
    if not isinstance(text, str):
        raise TypeError(f"a reply must be text, got {type(text).__name__}")
    end = 0
    index = 0
    while index < len(text):
        if text[index] not in _SENTENCE_END:
            index += 1
            continue
        cursor = index + 1
        while cursor < len(text) and text[cursor] in _SENTENCE_CLOSERS:
            cursor += 1
        if cursor == len(text) or text[cursor].isspace():
            end = cursor
            index = cursor
            continue
        index += 1
    return text[:end].rstrip()


def assistant_reply_message(
    turn: MetaLLMTurn, *, spoken_text: str | None = None
) -> dict[str, Any]:
    """The assistant message history records for a spoken reply.

    ``spoken_text`` is the prefix the caller actually heard. A reply cut by a
    barge-in or a drained queue is recorded up to that point only: the next turn
    must see the conversation the caller had, not words that never reached their
    ear. Omitting it uses the turn's own drain point when a mid-reply failure
    recorded one (ticket 96); otherwise the whole generated content is spoken
    and is recorded, which is only safe when nothing cut the reply.

    A prefix that the model never generated is refused: it would put invented
    speech in the model's mouth and make the next answer drift.
    """
    if turn.tool_calls:
        raise MessageAssemblyError(
            "this turn requested tools; record it with tool_turn_messages (or "
            "append_tool_turn) so the assistant message keeps its tool_calls "
            "ahead of the results"
        )
    heard = turn.spoken_text if spoken_text is None else spoken_text
    content = turn.content_text if heard is None else heard
    if not turn.content_text.startswith(content):
        raise MessageAssemblyError(
            f"spoken reply {content!r} is not a prefix of what the model "
            f"generated ({turn.content_text!r}); history may only record "
            "what the caller heard"
        )
    return {"role": "assistant", "content": content}


class MessageHistory:
    """The ordered Chat Completions history for one call.

    One object owns the two rules a hand-rolled list gets wrong: a reply is
    appended as the prefix the caller heard, and a tool turn is appended as the
    assistant message followed by its results. Hidden context is held aside and
    appears only in the next request, as an uncaptioned system message.

    Construct it with ``system_prompt`` only when this object assembles the
    request itself; when :class:`MetaLLM` owns the body's prompt, leave it unset
    so the prompt is not sent twice.
    """

    def __init__(self, *, system_prompt: str = "") -> None:
        self.system_prompt = system_prompt
        self._messages: list[dict[str, Any]] = []
        self._hidden: list[str] = []

    @property
    def messages(self) -> tuple[dict[str, Any], ...]:
        """The recorded conversation, without system prompt or hidden context."""
        return tuple(self._messages)

    def append_user(self, text: str) -> dict[str, Any]:
        """Record the caller's final transcript."""
        message = {"role": "user", "content": text}
        self._messages.append(message)
        return message

    def append_reply(
        self, turn: MetaLLMTurn, *, spoken_text: str | None = None
    ) -> dict[str, Any] | None:
        """Record a spoken reply, or nothing when the caller heard no word."""
        message = assistant_reply_message(turn, spoken_text=spoken_text)
        if not message["content"]:
            return None
        self._messages.append(message)
        return message

    def add_hidden_context(self, text: str) -> None:
        """Hold context for the next request only.

        It is appended as a plain ``system`` message with exactly this content:
        no caption, no prefix, and no path into a reply or a tool result.
        """
        if not isinstance(text, str) or not text.strip():
            raise MessageAssemblyError(
                "hidden context must be non-empty text; an empty system "
                "message is noise the vendor does not need"
            )
        self._hidden.append(text)

    def append_tool_turn(
        self, turn: MetaLLMTurn, tool_messages: Sequence[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Record a tool turn as one ordered unit, never the results alone."""
        messages = tool_turn_messages(turn, tool_messages)
        self._messages.extend(messages)
        return messages

    def request_messages(self) -> list[dict[str, Any]]:
        """The next request's array: prompt, recorded history, hidden context."""
        hidden = list(self._hidden)
        self._hidden.clear()
        return build_messages(
            system_prompt=self.system_prompt,
            history=self._messages,
            hidden_context=hidden,
        )


def tool_call_part(call: MetaToolCall) -> dict[str, Any]:
    """One ``tool_calls`` entry, replayed with the arguments as streamed."""
    if not call.call_id:
        raise MessageAssemblyError(
            f"tool call {call.name!r} has no call id; it cannot be replayed to "
            "the vendor"
        )
    return {
        "id": call.call_id,
        "type": "function",
        "function": {"name": call.name, "arguments": call.arguments},
    }


def tool_call_message(turn: MetaLLMTurn) -> dict[str, Any]:
    """The assistant message that requested a tool turn.

    Its content is kept verbatim even when the narration was held back from
    audio: the model said it, and the next request must show the model its own
    words rather than the hold line the caller heard.
    """
    if not turn.tool_calls:
        raise MessageAssemblyError(
            "this turn requested no tool calls, so it has no assistant tool "
            "message to replay"
        )
    return {
        "role": "assistant",
        "content": turn.content_text,
        "tool_calls": [tool_call_part(call) for call in turn.tool_calls],
    }


def tool_result_message(call_id: str, content: str) -> dict[str, Any]:
    """One ``role: "tool"`` result answering the call that asked for it."""
    if not call_id:
        raise MessageAssemblyError(
            "a tool result needs the call id it answers; the vendor cannot "
            "match an anonymous result"
        )
    if not isinstance(content, str):
        raise MessageAssemblyError(
            "a tool result must be text; the vendor rejects a structured "
            f"content value (got {type(content).__name__})"
        )
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def tool_turn_messages(
    turn: MetaLLMTurn, tool_messages: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The replayable unit: assistant ``tool_calls`` message, then results.

    The assistant message is not optional. The vendor answers a ``tool``
    message whose call was never declared with HTTP 400, so returning the
    results alone is the one shape this function will not produce.
    """
    assistant = tool_call_message(turn)
    declared = {call.call_id for call in turn.tool_calls}
    results: list[dict[str, Any]] = []
    for message in tool_messages:
        if message.get("role") != "tool":
            raise MessageAssemblyError(
                f"a tool turn carries only tool results after the assistant "
                f"message, got a {message.get('role')!r} message"
            )
        call_id = message.get("tool_call_id")
        if call_id not in declared:
            raise MessageAssemblyError(
                f"tool result answers call {call_id!r}, which the assistant "
                f"message did not request (declared: {sorted(declared)})"
            )
        results.append(dict(message))
    return [assistant, *results]


def build_chat_request(
    *,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    reasoning_effort: str | None = None,
    safety_identifier: str | None = None,
    enforce_standard_model: bool = True,
) -> dict[str, Any]:
    """The exact JSON body for ``POST /chat/completions``.

    One function owns the shape so a test can compare the whole payload. Any
    key not listed here is intentionally unsupported by Spark; adding one is a
    review decision, not a default.

    ``reasoning_effort`` is optional for a tenant model (ticket 159): an
    override that declares no effort sends no key, rather than inventing one.
    On the Standard rung ``enforce_standard_model`` is true, so the value is
    required and the Spark-specific refusal still runs at the one validator.

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
    }
    if enforce_standard_model:
        payload["reasoning_effort"] = resolve_reasoning_effort(reasoning_effort)
    elif reasoning_effort is not None:
        payload["reasoning_effort"] = _byo_reasoning_effort(reasoning_effort)
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

    ``spoken_text`` is the drain point of a reply a mid-reply failure cut
    (ticket 96): the prefix up to the last complete sentence. It stays ``None``
    for a turn that was not cut, where the whole generated text is what the
    caller heard.
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
    failure_decisions: list[FailureDecision] = field(default_factory=list)
    spoken_text: str | None = None

    @property
    def last_failure(self) -> FailureDecision | None:
        """The most recent failure decision, if the turn saw one."""
        return self.failure_decisions[-1] if self.failure_decisions else None

    @property
    def unspoken_text(self) -> str:
        """The generated tail the caller must not hear or have in history."""
        if self.spoken_text is None:
            return ""
        return self.content_text[len(self.spoken_text):]

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



@dataclass
class _Progress:
    """How far one attempt got, which is exactly what selects the phase.

    A response status is not enough: a 200 whose stream dies before a token is
    a ``turn`` failure, and one that dies after content - or after a tool
    handoff - is a ``reply`` failure that must never be retried. ``delivered``
    means an event the caller could act on already left this module, so a retry
    could repeat speech or execute a tool twice.
    """

    frames: int = 0
    delivered: bool = False

    @property
    def phase(self) -> str:
        if self.delivered:
            return PHASE_REPLY
        if self.frames:
            return PHASE_TURN
        return PHASE_CONNECT


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
        rungs: CallRungs | None = None,
        on_alert: Callable[[FailureDecision], None] | None = None,
        budget: ReconnectBudget | None = None,
        enforce_standard_model: bool = True,
    ) -> None:
        # Construction guard first: a Contributor id must fail before any
        # request field exists to leak into (ticket 35). A tenant's own model
        # (ticket 159) is not a Meta rung, so the guard does not apply to it.
        self._enforce_standard_model = bool(enforce_standard_model)
        if self._enforce_standard_model:
            self._model = resolve_model(model)
            self._reasoning_effort = resolve_reasoning_effort(reasoning_effort)
            self._api_key = api_key or os.environ.get("META_API_KEY")
        else:
            # The same validator the body adapter and build_byo_client use: a
            # tenant model's four fields are normalised in one place.
            try:
                override = llm_override.validate_override(
                    base_url=base_url,
                    model=model,
                    api_key=api_key,
                    reasoning_effort=reasoning_effort,
                )
            except llm_override.LlmOverrideInvalid as error:
                if error.missing:
                    raise ByoLlmError(
                        f"a tenant model client needs a {error.field}: base_url, "
                        "model and api_key are all required, and none is defaulted"
                    ) from None
                raise ByoLlmError(
                    f"a tenant model client needs a usable {error.field}: "
                    f"{error.reason}"
                ) from None
            base_url = override.base_url
            self._model = override.model
            self._reasoning_effort = override.reasoning_effort
            # A tenant's key comes from the signed body only; the Meta key is
            # never substituted for it.
            self._api_key = override.api_key
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
        # Ticket 42: the call's frozen rungs record failures for *future* calls,
        # and the alert sink hears every terminal decision. Neither moves this
        # call's rung, and neither retries anything.
        self._rungs = rungs
        self._on_alert = on_alert
        # Ticket 94 owns the call's one failure reconnect per leg; this module
        # reports the phase evidence and never keeps a second counter. A retry
        # before speech, a drain after speech and the end on a second failure
        # are all that budget's answers.
        self._budget = budget or ReconnectBudget()
        self._last_turn: MetaLLMTurn | None = None

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        """The provider id this client's attribution names.

        The Standard rung is ``spark``; a tenant's model names its base URL's
        host plus the model the body chose (ticket 159).
        """
        if self._enforce_standard_model:
            return "spark"
        return byo_provider(self._base_url, self._model)

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    @property
    def reconnect_budget(self) -> ReconnectBudget:
        """The call's one reconnect ledger (ticket 94); this leg never counts."""
        return self._budget

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
            if self._enforce_standard_model:
                raise MetaLLMConfigError(
                    "META_API_KEY is not configured: the chat completions request "
                    "needs bearer auth, and an unauthenticated request must not be "
                    "sent"
                )
            raise ByoLlmError(
                "the stored body's LLM override has no api_key: the request "
                "needs bearer auth, and the Meta key is never substituted for a "
                "tenant's"
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
            enforce_standard_model=self._enforce_standard_model,
        )
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        url = f"{self._base_url}{CHAT_COMPLETIONS_PATH}"
        record = turn if turn is not None else MetaLLMTurn()
        self._last_turn = record
        attempt = 0
        try:
            while True:
                attempt += 1
                progress = _Progress()
                try:
                    async for event in self._run_attempt(
                        url=url,
                        headers=headers,
                        payload=payload,
                        tools=tools,
                        record=record,
                        progress=progress,
                    ):
                        yield event
                    return
                except MetaLLMStreamError:
                    # A provider contract violation or an unenforceable schema
                    # is not an outage: never retried, never classified away.
                    raise
                except (MetaLLMRequestError, TimeoutError, OSError) as error:
                    decision, retry, action = await self._apply_policy(
                        error, progress, attempt, record
                    )
                    if retry:
                        continue
                    failure = self._failure_error(decision, action)
                    if failure is None:
                        # An unclassified failure keeps its provider type: the
                        # policy recorded it and alerted, but it has no action.
                        raise
                    raise failure from error
        finally:
            record.close()

    async def _run_attempt(
        self,
        *,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
        tools: list[dict[str, Any]] | None,
        record: MetaLLMTurn,
        progress: _Progress,
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        """One request and its stream; every attempt gets fresh accumulators.

        Tool deltas from a failed attempt must not join the retry's slots, and a
        retry is only possible before any content token, so nothing is un-said.
        """
        stream = _TurnStream(record, self._ledger, tools)
        parser = _SSEParser()
        session = self._session_factory(timeout_s=self._timeout_s)
        async with session as active:
            async with active.post(url, headers=headers, json=payload) as response:
                if response.status != 200:
                    raise MetaLLMRequestError(response.status)
                async for chunk in response.iter_bytes():
                    for frame in parser.feed(chunk):
                        progress.frames += 1
                        for event in stream.consume(frame):
                            progress.delivered = True
                            yield event
                for frame in parser.close():
                    progress.frames += 1
                    for event in stream.consume(frame):
                        progress.delivered = True
                        yield event
                for event in stream.finish():
                    progress.delivered = True
                    yield event
                record.finished = True

    def _verdict_for(self, error: BaseException) -> FailureVerdict:
        if isinstance(error, MetaLLMRequestError):
            return classify("llm", error.status)
        if isinstance(error, TimeoutError):
            return classify("llm", None, timed_out=True)
        return classify("llm", None)

    async def _apply_policy(
        self,
        error: BaseException,
        progress: _Progress,
        attempt: int,
        record: MetaLLMTurn,
    ) -> tuple[FailureDecision, bool, ReconnectAction]:
        """Classify one attempt's failure and let the ticket-94 budget decide.

        The phase comes from what the caller already heard, not from the status:
        a ``connect``/``turn`` failure may be RECONNECTed before the first
        content token, while a ``reply`` failure is DRAINed (a restart would
        repeat speech) and a spent leg is ENDed. A bug never spends the retry.
        """
        verdict = self._verdict_for(error)
        phase = progress.phase
        recovery = self._budget.failed(
            verdict, mid_reply=phase == PHASE_REPLY
        )
        retry = recovery.action is ReconnectAction.RECONNECT
        opened = False
        if verdict.opens_breaker and not retry:
            opened = await self._open_leg(verdict, phase)

        if phase == PHASE_REPLY:
            # The turn closes at the last complete sentence; everything after
            # it is unspoken and must not enter history (ticket 96).
            record.spoken_text = last_complete_sentence(record.content_text)
        decision = FailureDecision(
            attempt=attempt,
            phase=phase,
            verdict=verdict,
            retry=retry,
            opened_leg=opened,
            reason=recovery.reason,
        )
        record.failure_decisions.append(decision)
        if not retry and self._on_alert is not None:
            self._on_alert(decision)
        return decision, retry, recovery.action

    async def _open_leg(self, verdict: FailureVerdict, phase: str) -> bool:
        """Record the failure for future calls; this call's rung never moves."""
        if self._rungs is None:
            return False
        outcome = await self._rungs.failed("llm", verdict=verdict, phase=phase)
        record = outcome.transition.record
        return record is not None and record.state == "open"

    def _failure_error(
        self, decision: FailureDecision, action: ReconnectAction
    ) -> MetaLLMFailure | None:
        verdict = decision.verdict
        if verdict.failure_class is FailureClass.TRIGGER:
            if action is ReconnectAction.DRAIN:
                # Speech is already queued: drain to the last complete
                # sentence, never restart the completion.
                return MetaLLMReplyInterrupted(decision)
            # The retry was already spent on this leg (or the caller may not
            # retry now), so this call ends.
            return MetaLLMLegExhausted(decision)
        if verdict.failure_class is FailureClass.BUG:
            return MetaLLMTurnFailed(decision)
        # do_not_open / planned_reconnect: the original provider error stands,
        # already recorded on the turn and sent to the alert sink.
        return None


# ---------------------------------------------------------------------------
# A tenant's own model (ticket 159): the same contract, a different constructor
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ByoModel:
    """One constructed tenant client and the attribution its turns carry."""

    client: MetaLLM
    attribution: ProviderAttribution

    @property
    def model(self) -> str:
        return self.client.model

    @property
    def provider(self) -> str:
        return self.attribution.provider


def byo_attribution(override: LlmOverride) -> ProviderAttribution:
    """The attribution a BYO turn earns: its provider host and model.

    It is the leg's primary rung because the body's own model is the only one
    its call may use; there is no Meta rung behind it to fall back to.
    """
    validate_byo_override(override)
    return ProviderAttribution(
        leg="llm",
        provider=byo_provider(override.base_url, override.model),
        rung="primary",
        reason=(
            "the stored body's LLM override names this provider and model; the "
            "default Standard rung does not serve this call"
        ),
    )


def build_byo_client(
    override: LlmOverride,
    *,
    system_prompt: str = "",
    session_factory: Any = None,
    timeout_s: float = 60.0,
    ledger: Any = None,
    rungs: CallRungs | None = None,
    on_alert: Callable[[FailureDecision], None] | None = None,
    budget: ReconnectBudget | None = None,
) -> MetaLLM:
    """Construct the tenant's OpenAI-compatible client, server-side.

    A body whose entry cannot build a client fails here, by name, before any
    vendor socket exists; it never routes managed. The key is passed to the
    client's authorization header only.
    """
    validate_byo_override(override)
    return MetaLLM(
        api_key=override.api_key,
        model=override.model,
        base_url=override.base_url,
        reasoning_effort=override.reasoning_effort,
        system_prompt=system_prompt,
        session_factory=session_factory,
        timeout_s=timeout_s,
        ledger=ledger,
        rungs=rungs,
        on_alert=on_alert,
        budget=budget,
        enforce_standard_model=False,
    )


def construct_byo_model(override: LlmOverride, **kwargs: Any) -> ByoModel:
    """Build the tenant's client together with the attribution it earns."""
    return ByoModel(
        client=build_byo_client(override, **kwargs),
        attribution=byo_attribution(override),
    )


__all__ = [
    "CALL_ID_MAX_LENGTH",
    "CHAT_COMPLETIONS_PATH",
    "FAILURE_PHASES",
    "FIRST_TOKEN_MARK",
    "IDENTIFIER_SALT_ENV",
    "MAX_LEG_FAILURES",
    "META_BASE_URL",
    "PHASE_CONNECT",
    "PHASE_REPLY",
    "PHASE_TURN",
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
    "FailureDecision",
    "ByoLlmError",
    "ByoModel",
    "MessageAssemblyError",
    "MessageHistory",
    "MetaLLM",
    "MetaLLMConfigError",
    "MetaLLMFailure",
    "MetaLLMLegExhausted",
    "MetaLLMReplyInterrupted",
    "MetaLLMRequestError",
    "MetaLLMStreamError",
    "MetaLLMTurn",
    "MetaLLMTurnFailed",
    "MetaToolCall",
    "ReasoningEffortError",
    "ReplyDisposition",
    "ReplyOutcome",
    "ToolArgumentsError",
    "ToolCallIdentityError",
    "ToolDenial",
    "ToolSchemaError",
    "TurnUsage",
    "assistant_reply_message",
    "build_chat_request",
    "build_byo_client",
    "build_messages",
    "byo_attribution",
    "byo_provider",
    "construct_byo_model",
    "parse_tool_arguments",
    "parse_usage",
    "privacy_identifier",
    "reply_disposition",
    "resolve_reasoning_effort",
    "tool_call_message",
    "tool_call_part",
    "tool_result_message",
    "tool_turn_messages",
    "validate_byo_override",
    "validate_tool_arguments",
]
