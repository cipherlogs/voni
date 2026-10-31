"""One call-event envelope for both engines (meta-cascade M12, ticket 107).

Every call-scoped event the voice service emits carries ``schemaVersion``,
``pipeline``, ``callId``, ``type``, ``subject``, ``turn`` (a logical id or
``None``), ``atMs`` and ``phase``. An operational event carries ``leg`` in
place of ``turn``; a demo call's operational event also carries ``subject`` so
every line of its trace names ``demo:<voice>`` (ticket 17). A tenant call's
operational event keeps the existing shape: ``leg`` and no subject. The managed
engine and the cascade engine use the same envelope; only the ``pipeline``
value differs.

A provider fallback is a call-scoped event (``provider_fallback``) with
``leg``, ``from``, ``to`` and ``trigger`` in its payload, plus the optional
``reason``. It is emitted at connect (``phase="connect"``, ``turn=None``) and
mid-turn alike, through :func:`emit_fallback` and the one
:class:`EventWriter`; a routing or eligibility refusal is a different fact and
never emits it.

A turn names the providers that served it in a ``turn.attribution`` event
(ticket 108): ``{stt, llm, tts}``, each with its ``provider``, ``rung`` and
``reason``, and ``from`` when a fallback rung served, so a fallback turn names
both rungs. A leg that did not run is an explicit ``null`` (a backchannel has no
model); a managed turn records the table as ``N/A — vendor-owned`` rather than a
fabricated vendor; a turn whose attribution was never recorded is
``unmeasured`` with a named reason. The value object is
:class:`TurnAttribution` and the one emission site is
:func:`emit_attribution`. :class:`~cascade.turn_state.TurnStateStore` keys the
record by the logical turn, so a reconnect cannot move it, and derives the end
message's call-level provider table from the turns.

The persisted cascade stream is written by :class:`EventStream`, which is the
one Python write boundary: every line is built by :class:`EventWriter` and
passes through the one sanitizer's rules before it is written (ticket 111). The
rules live once, in ``voni/src/lib/demo/event-sanitizer.ts`` (ticket 07);
``cascade/sanitizer.py`` is a callable copy for the Python service, and
``test_sanitizer.py`` parses the TS source and fails by name when the copy
drifts. There is no second denylist and no unsanitized write path.

A finished call keeps its turn-level ledger in that trace
(demo-verification 04): :class:`TurnLedger` writes one row per turn event —
caller final, reply start, first audio, cut, tool call, tool result, goodbye,
hangup, failed turn — each against its logical turn, phase and call-relative
time, through the same :class:`EventStream` and sanitizer as every other line.
The methods take typed values and closed vocabularies only, so a row cannot
carry the caller's words, a tool's arguments or its payload. One event is one
row: a replayed final or a repeated tool result writes nothing. A hold return
resumes the same trace, and the ledger offsets its turn ids past every epoch
the file already names, so two sessions never share an id; the end row's
``turnSummary`` is the distinct reply starts of the session it closes, and
``agrees`` is the reader-repeatable check that the end document's ``turns``
count and the ledger say the same thing. A ``provider_fallback`` row (connect or
mid-turn) is written through :meth:`TurnLedger.fallback`, and a provider
protocol failure through :meth:`TurnLedger.protocol_error`, so a contaminated
run is visible in the same file as the turns it contaminated.

A finished call keeps its end document beside its trace
(demo-verification 03): :meth:`OperationalEvents.end` writes the exact document
the client received to ``<call-id>.end.json`` and adds one call-level ``end``
row pointing at it. A hold return rewrites that row and the sidecar, so a call
has one final end document and never two ``end`` rows. An unwritable evidence
directory raises :class:`EndEvidenceError` and is named on the end message; it
is never a silent skip.

Operational decisions are first-class events, not console lines (ticket 110):
:class:`OperationalEvents` emits ``budget.crossing`` (line, day, spend, cap),
``budget.stopped`` (call, spend, ceiling), ``deploy.drain``, ``reconnect`` (leg,
reason, planned/failure), the three greeting marks, ``protocol.error``,
``turn.failed`` and ``breaker.transition``. The breaker is operational (its
leg in place of turn; a demo call's line also names ``demo:<voice>``); a budget
crossing or stop is cascade-only and names the subject with a null turn. The methods take typed values rather than free
form fields, so caller text or audio cannot be smuggled onto a line, and the
one sanitizer still runs on every event.

The TS module (``voni/src/lib/demo/event-envelope.ts``) is the one reader. It
refuses an unknown schema version, a missing required field, a managed event
carrying a cascade-only type and a cascade event carrying a managed-only field,
always by name.

The canonical shapes are pinned by ``event-envelope.fixtures.json`` and both
sides' tests read it, so a drift between this writer and the reader fails rather
than quietly producing a second schema.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from cascade.breaker import LEGS, STATES
from cascade.counter import LINES as MONEY_LINES
from cascade.sanitizer import sanitize_fields

#: The one schema version. A reader must refuse anything else.
EVENT_SCHEMA_VERSION = 1

#: The subject kind a demo call declares in its signed envelope. A demo
#: call's trace names ``demo:<voice>`` on every line; it never names a tenant
#: subject, a managed agent id or a bare voice id, because a trace that names
#: the wrong subject is evidence of a call that never happened.
DEMO_SUBJECT_KIND = "demo"

#: The two subject kinds the signed envelope can name.
SUBJECT_KINDS = ("demo", "tenant")

_DEMO_SUBJECT = re.compile(r"demo:[^\s:]+")

#: The engine that produced the call.
PIPELINES = ("managed", "cascade")

#: The call phases an event may belong to.
PHASES = ("connect", "turn", "tool", "drain", "end")

#: Every field a call-scoped event carries, in write order.
CALL_SCOPED_FIELDS = (
    "schemaVersion",
    "pipeline",
    "callId",
    "type",
    "subject",
    "turn",
    "atMs",
    "phase",
)

#: Every field an operational event carries: ``leg`` replaces turn. A demo
#: call adds ``subject`` so no line of its trace lacks the demo subject.
OPERATIONAL_FIELDS = (
    "schemaVersion",
    "pipeline",
    "callId",
    "type",
    "leg",
    "atMs",
    "phase",
)

#: Event types that are operational, not turn events.
BREAKER_EVENT_TYPE = "breaker.transition"

#: The money/operations events ticket 110 makes first-class. They are built by
#: :class:`OperationalEvents` below, through this writer and the one stream.
BUDGET_CROSSING_EVENT_TYPE = "budget.crossing"
BUDGET_STOPPED_EVENT_TYPE = "budget.stopped"
#: The one priced row a completed session leaves in the call's artifact (ticket
#: 18). A hold return resumes the same call id, so its row appends to the same
#: file rather than creating a second record store.
COST_PRICED_EVENT_TYPE = "cost.priced"

#: The producer named on every cost row: the one pricing path, ``cost_call``.
#: A reader can tell a measured price from anything else by this name.
COST_PRODUCER = "cascade.cost.cost_call"
DEPLOY_DRAIN_EVENT_TYPE = "deploy.drain"
RECONNECT_EVENT_TYPE = "reconnect"
PROTOCOL_ERROR_EVENT_TYPE = "protocol.error"
TURN_FAILED_EVENT_TYPE = "turn.failed"

#: The one row a finished call adds to its trace (demo-verification 03). The
#: sidecar beside the trace keeps the raw end document the client received; the
#: row is the call-level pointer to it. A hold return rewrites the row rather
#: than appending a second one, so a call has exactly one ``end`` row.
END_EVENT_TYPE = "end"

#: The sidecar's suffix: ``<call-id>.end.json`` beside ``<call-id>.jsonl``.
END_DOCUMENT_SUFFIX = ".end.json"

#: The fields every end document carries, whether the call completed or failed.
END_DOCUMENT_FIELDS = (
    "metrics",
    "providers",
    "cost",
    "eligibility",
    "turns",
    "endedBy",
    "drain",
    "bounds",
)

#: The three greeting marks, in the order a spoken greeting writes them.
GREETING_EVENT_TYPES = (
    "greeting.start",
    "greeting.first_audio",
    "greeting.done",
)

OPERATIONAL_EVENT_TYPES = (BREAKER_EVENT_TYPE,)

#: Names owned by the envelope. A call-scoped event owns subject/turn, an
#: operational event owns leg (and, on a demo call, subject); ``leg`` is a
#: legitimate payload field on a call-scoped event (``provider_fallback`` names
#: the leg it moved), so each shape reserves only its own names.
_CALL_SCOPED_RESERVED = frozenset(CALL_SCOPED_FIELDS)
_OPERATIONAL_RESERVED = frozenset((*OPERATIONAL_FIELDS, "subject"))


class EventEnvelopeError(ValueError):
    """One refused event, named by the field and the value that failed."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


class ForbiddenEventKey(EventEnvelopeError):
    """A line that still carries a forbidden key is refused before it is written.

    The names are the sanitizer's dotted paths; the values are never echoed, so
    a refusal cannot itself leak the text or credential that caused it.
    """

    def __init__(self, keys: tuple[str, ...] | list[str]) -> None:
        self.keys = tuple(keys)
        first = self.keys[0] if self.keys else "event"
        named = ", ".join(f'"{key}"' for key in self.keys)
        super().__init__(
            first,
            f"forbidden event key {named}; a line carrying caller text or audio "
            "is refused, not written",
        )


class EndEvidenceError(RuntimeError):
    """The call's end evidence could not be persisted; named, never silent.

    The end document and the one ``end`` row are the evidence a failure cites,
    so an unwritable evidence directory must be reported with the path and the
    reason rather than skipped. The call still ends: the failure travels on the
    end message as ``endEvidenceError``.
    """

    def __init__(self, what: str, path: str | Path, error: OSError | None = None) -> None:
        reason = "" if error is None else (error.strerror or str(error))
        detail = f"{what} {path}" + (f": {reason}" if reason else "")
        super().__init__(detail)
        self.what = what
        self.path = str(path)
        self.reason = reason


def _require_text(field: str, value: Any) -> str:
    if value is None:
        raise EventEnvelopeError(field, f'missing required field "{field}"')
    if not isinstance(value, str) or not value.strip():
        raise EventEnvelopeError(field, f'"{field}" must be a non-empty string, got {value!r}')
    return value


def _require_demo_subject(subject: Any) -> str:
    """A demo call's subject: ``demo:<voice>``, never a tenant identity.

    The refusal names the shape, not a guess: a tenant subject, a managed
    agent id and a bare voice id all fail the one prefix rule.
    """
    text = _require_text("subject", subject)
    if not _DEMO_SUBJECT.fullmatch(text):
        raise EventEnvelopeError(
            "subject",
            f'a demo call\'s subject must be "demo:<voice>", got {text!r}; a '
            "tenant subject, a managed agent id or a bare voice id is refused",
        )
    return text


def _require_phase(phase: Any) -> str:
    if phase is None:
        raise EventEnvelopeError("phase", 'missing required field "phase"')
    if phase not in PHASES:
        raise EventEnvelopeError(
            "phase", f"unknown phase {phase!r}; expected one of {', '.join(PHASES)}"
        )
    return phase


def _require_at_ms(at_ms: Any) -> float | int:
    if at_ms is None:
        raise EventEnvelopeError("atMs", 'missing required field "atMs"')
    if isinstance(at_ms, bool) or not isinstance(at_ms, (int, float)):
        raise EventEnvelopeError("atMs", f'"atMs" must be a finite non-negative number, got {at_ms!r}')
    if not math.isfinite(at_ms) or at_ms < 0:
        raise EventEnvelopeError("atMs", f'"atMs" must be a finite non-negative number, got {at_ms!r}')
    return at_ms


def _require_turn(turn: Any) -> str | None:
    if turn is None:
        return None
    if not isinstance(turn, str) or not turn.strip():
        raise EventEnvelopeError("turn", f'"turn" must be a logical id or None, got {turn!r}')
    return turn


class EventWriter:
    """Build one call's envelope-shaped events; the caller owns the sink.

    The writer is scoped to one call, so ``pipeline`` and ``callId`` cannot
    drift between lines. It validates the envelope fields it owns and keeps
    payload fields separate: a payload key that names an envelope field is
    refused instead of overwriting it. Payload values are sanitized once by the
    one TS writer, not here.
    """

    def __init__(self, *, pipeline: str, call_id: str) -> None:
        if pipeline not in PIPELINES:
            raise EventEnvelopeError(
                "pipeline",
                f"unknown pipeline {pipeline!r}; expected one of {', '.join(PIPELINES)}",
            )
        self.pipeline = pipeline
        self.call_id = _require_text("callId", call_id)

    def _payload(
        self, fields: Mapping[str, Any] | None, reserved: frozenset[str]
    ) -> dict[str, Any]:
        payload = dict(fields or {})
        for key in payload:
            if key in reserved:
                raise EventEnvelopeError(
                    key, f'payload field "{key}" collides with the envelope field'
                )
        return payload

    def call_scoped(
        self,
        type: str,
        *,
        subject: str,
        turn: str | None,
        at_ms: float | int,
        phase: str,
        fields: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One turn/connect/tool/drain/end event: subject plus logical turn."""
        if type in OPERATIONAL_EVENT_TYPES:
            raise EventEnvelopeError(
                "type",
                f'"{type}" is an operational event, not a turn event; use operational()',
            )
        event: dict[str, Any] = {
            "schemaVersion": EVENT_SCHEMA_VERSION,
            "pipeline": self.pipeline,
            "callId": self.call_id,
            "type": _require_text("type", type),
            "subject": _require_text("subject", subject),
            "turn": _require_turn(turn),
            "atMs": _require_at_ms(at_ms),
            "phase": _require_phase(phase),
        }
        event.update(self._payload(fields, _CALL_SCOPED_RESERVED))
        return event

    def operational(
        self,
        type: str,
        *,
        leg: str,
        at_ms: float | int,
        phase: str,
        subject: str | None = None,
        fields: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One operational event: the leg, and on a demo call its subject.

        A demo call's trace names ``demo:<voice>`` on every line (ticket 17),
        so its operational lines carry both ``subject`` and ``leg``. A tenant
        call passes no subject and keeps the existing shape.
        """
        if type not in OPERATIONAL_EVENT_TYPES:
            raise EventEnvelopeError(
                "type",
                f'"{type}" is not an operational event; use call_scoped() for turn events',
            )
        event: dict[str, Any] = {
            "schemaVersion": EVENT_SCHEMA_VERSION,
            "pipeline": self.pipeline,
            "callId": self.call_id,
            "type": _require_text("type", type),
        }
        if subject is not None:
            event["subject"] = _require_demo_subject(subject)
        event["leg"] = _require_text("leg", leg)
        event["atMs"] = _require_at_ms(at_ms)
        event["phase"] = _require_phase(phase)
        event.update(self._payload(fields, _OPERATIONAL_RESERVED))
        return event


# ---------------------------------------------------------------------------
# Provider fallback: one event for every fallback, at any phase (ticket 109)
# ---------------------------------------------------------------------------

#: The one cascade-only event a fallback emits. A run carrying any line of this
#: type is fallback-contaminated, whatever its numbers.
FALLBACK_EVENT_TYPE = "provider_fallback"

#: The provider faults a fallback may be triggered by. Closed, so a decision
#: that is not a provider fault cannot borrow this event.
FALLBACK_TRIGGERS = (
    "connect_failed",
    "breaker_open",
    "manual_pin",
    "mid_turn_failure",
    "probe_failed",
)

#: Facts that are routing, eligibility or budget decisions, never fallbacks.
#: A refusal routes the call managed; it does not contaminate a later run.
NON_FALLBACK_TRIGGERS = (
    "routing_refusal",
    "routing_managed",
    "eligibility_refusal",
    "budget_stop",
)

#: Where an emitted event goes. The cascade's one stream writer is the sink in
#: production; tests append to a list.
EventSink = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class Fallback:
    """One fallback: the leg, both rungs, the trigger, the turn and the phase.

    ``phase="connect"`` is a fallback too: it pre-selects the fallback rung
    before the first frame. A connect fallback has no turn (``None``); any
    other fallback names the turn that lost its rung.
    """

    leg: str
    from_provider: str
    to_provider: str
    trigger: str
    phase: str
    turn: str | None = None
    reason: str = ""

    def __post_init__(self) -> None:
        if self.leg not in LEGS:
            raise EventEnvelopeError(
                "leg", f"unknown cascade leg {self.leg!r}; expected one of {', '.join(LEGS)}"
            )
        _require_text("from", self.from_provider)
        _require_text("to", self.to_provider)
        if self.from_provider == self.to_provider:
            raise EventEnvelopeError(
                "to",
                f'a fallback must move to a different provider, got "{self.to_provider}" twice',
            )
        if self.trigger in NON_FALLBACK_TRIGGERS:
            raise EventEnvelopeError(
                "trigger",
                f'trigger "{self.trigger}" is a routing/eligibility/budget decision, '
                "not a provider fault; a refusal routes the call managed and never "
                "emits a provider fallback",
            )
        if self.trigger not in FALLBACK_TRIGGERS:
            raise EventEnvelopeError(
                "trigger",
                f'unknown fallback trigger {self.trigger!r}; expected one of '
                f"{', '.join(FALLBACK_TRIGGERS)}",
            )
        _require_phase(self.phase)
        _require_turn(self.turn)
        if self.phase == "connect":
            if self.turn is not None:
                raise EventEnvelopeError(
                    "turn",
                    f'a connect-time fallback has no turn, got {self.turn!r}',
                )
        elif self.turn is None:
            raise EventEnvelopeError(
                "turn",
                f'a fallback in phase "{self.phase}" must name the turn it lost',
            )
        if not isinstance(self.reason, str):
            raise EventEnvelopeError(
                "reason", f'"reason" must be a string, got {self.reason!r}'
            )


def connect_fallback(
    leg: str,
    *,
    primary: str,
    selected: str,
    trigger: str,
    reason: str = "",
) -> Fallback:
    """The fallback that a connect-time rung selection recorded.

    Emitted for ``breaker_open`` (the record selected the fallback rung), a
    manual pin, or a primary that would not open. The phase is ``connect`` and
    the turn is ``None`` by construction, so a connect fallback cannot be
    mistaken for a turn.
    """
    return Fallback(
        leg=leg,
        from_provider=primary,
        to_provider=selected,
        trigger=trigger,
        phase="connect",
        turn=None,
        reason=reason,
    )


def turn_fallback(
    leg: str,
    *,
    from_provider: str,
    to_provider: str,
    trigger: str,
    turn: str | None,
    reason: str = "",
) -> Fallback:
    """The fallback a live turn recorded, naming the turn that lost its rung."""
    return Fallback(
        leg=leg,
        from_provider=from_provider,
        to_provider=to_provider,
        trigger=trigger,
        phase="turn",
        turn=turn,
        reason=reason,
    )


def emit_fallback(
    writer: EventWriter,
    fallback: Fallback,
    *,
    subject: str,
    at_ms: float | int,
    sink: EventSink,
) -> dict[str, Any]:
    """Emit one fallback through the one envelope writer, then the sink.

    ``turn`` and ``phase`` are the envelope's, so a connect fallback carries
    ``turn: null`` and every fallback carries the phase it happened in. The
    payload names the leg, both rungs and the trigger; ``reason`` is optional.
    A managed writer is refused: a managed run has no provider choice.
    """
    if writer.pipeline != "cascade":
        raise EventEnvelopeError(
            "pipeline",
            f'a provider fallback is a cascade-only event; this writer is "{writer.pipeline}"',
        )
    fields: dict[str, Any] = {
        "leg": fallback.leg,
        "from": fallback.from_provider,
        "to": fallback.to_provider,
        "trigger": fallback.trigger,
    }
    if fallback.reason:
        fields["reason"] = fallback.reason
    event = writer.call_scoped(
        FALLBACK_EVENT_TYPE,
        subject=subject,
        turn=fallback.turn,
        at_ms=at_ms,
        phase=fallback.phase,
        fields=fields,
    )
    sink(event)
    return event


# ---------------------------------------------------------------------------
# Turn attribution: which providers served this turn (ticket 108)
# ---------------------------------------------------------------------------

#: The one event a turn's provider attribution is written as. Both engines emit
#: it; a managed turn names its table as vendor-owned instead of a vendor.
ATTRIBUTION_EVENT_TYPE = "turn.attribution"

#: The three states a turn attribution can be in. ``measured`` names the
#: providers, ``vendor-owned`` is the managed pipeline's table and
#: ``unmeasured`` is a turn whose attribution was never recorded.
ATTRIBUTION_STATES = ("measured", "vendor-owned", "unmeasured")

#: What a managed turn records in place of a vendor name.
VENDOR_OWNED = "N/A — vendor-owned"


class AttributionError(EventEnvelopeError):
    """A turn attribution that would name something it cannot know."""


def turn_key(turn: str | object) -> str:
    """The one string a logical turn is written as: ``<epoch>:<providerTurnId>``.

    Accepts a :class:`~cascade.turn_state.LogicalTurnId` without importing it:
    the schema keeps the turn-key convention, and the state module that owns the
    identity reuses this function, so a reconnect cannot rename a turn.
    """
    if isinstance(turn, str):
        if not turn.strip():
            raise AttributionError(
                "turn",
                f'an attribution needs the logical turn it belongs to, got {turn!r}',
            )
        return turn
    epoch = getattr(turn, "session_epoch", None)
    provider_turn_id = getattr(turn, "provider_turn_id", None)
    if (
        isinstance(epoch, int)
        and not isinstance(epoch, bool)
        and isinstance(provider_turn_id, str)
        and provider_turn_id.strip()
    ):
        return f"{epoch}:{provider_turn_id}"
    raise AttributionError(
        "turn",
        f"not a logical turn: {turn!r}; expected a LogicalTurnId or its "
        '"<sessionEpoch>:<providerTurnId>" string',
    )


@dataclass(frozen=True)
class LegAttribution:
    """One leg of one turn: the provider that served it and its rung.

    ``from_provider`` is the rung that lost when ``rung == "fallback"``. A
    fallback turn names both rungs: the provider that served and the one it
    replaced, so "which model answered this turn" is answerable without reading
    an unrelated fallback event.
    """

    leg: str
    provider: str
    rung: str
    reason: str
    from_provider: str | None = None

    def __post_init__(self) -> None:
        if self.leg not in LEGS:
            raise AttributionError(
                "leg",
                f"unknown cascade leg {self.leg!r}; expected one of {', '.join(LEGS)}",
            )
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise AttributionError(
                "provider",
                f'leg "{self.leg}" needs the provider that served it, '
                f"got {self.provider!r}",
            )
        if self.provider == VENDOR_OWNED:
            raise AttributionError(
                "provider",
                f'"{VENDOR_OWNED}" is a vendor-owned marker, not a provider name; '
                "a managed turn never fabricates a vendor",
            )
        if self.rung not in ("primary", "fallback"):
            raise AttributionError(
                "rung",
                f'leg "{self.leg}" names rung {self.rung!r}; only a rung that served '
                'is an attribution ("primary" or "fallback")',
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise AttributionError(
                "reason", f'leg "{self.leg}" needs the reason its rung was chosen'
            )
        if self.rung == "fallback":
            if not isinstance(self.from_provider, str) or not self.from_provider.strip():
                raise AttributionError(
                    "from",
                    f'leg "{self.leg}" served on the fallback rung, so it must name '
                    "both rungs: the provider that lost as well",
                )
            if self.from_provider == self.provider:
                raise AttributionError(
                    "from",
                    f'leg "{self.leg}" names "{self.provider}" as both rungs; the '
                    "losing rung is a different provider",
                )
        elif self.from_provider is not None:
            raise AttributionError(
                "from",
                f'leg "{self.leg}" served on the primary rung, so it has no losing '
                f"rung to name (got {self.from_provider!r})",
            )

    def to_document(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "leg": self.leg,
            "provider": self.provider,
            "rung": self.rung,
            "reason": self.reason,
        }
        if self.from_provider is not None:
            document["from"] = self.from_provider
        return document


@dataclass(frozen=True)
class TurnAttribution:
    """The providers one logical turn actually used, keyed by its logical id.

    A leg that did not run is ``None`` — a backchannel has no model — and is
    written as an explicit ``null`` rather than being left out. ``turn`` is the
    logical id string (``<sessionEpoch>:<providerTurnId>``), so a reconnect that
    rebinds the provider id cannot move the attribution to another turn.
    """

    turn: str
    stt: LegAttribution | None = None
    llm: LegAttribution | None = None
    tts: LegAttribution | None = None
    vendor_owned: bool = False
    unmeasured_reason: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "turn", turn_key(self.turn))
        if not isinstance(self.unmeasured_reason, str):
            raise AttributionError(
                "unmeasuredReason",
                f'"unmeasuredReason" must be a string, got {self.unmeasured_reason!r}',
            )
        if self.vendor_owned and self.unmeasured_reason:
            raise AttributionError(
                "state",
                "a vendor-owned table is not unmeasured; a managed turn is "
                "vendor-owned and a recorded cascade turn is measured",
            )
        if self.unmeasured_reason and any(
            getattr(self, name) is not None for name in LEGS
        ):
            raise AttributionError(
                "providers",
                "an unmeasured turn names no leg; the providers it used were "
                "never recorded, so naming one would be a guess",
            )
        if self.vendor_owned and any(getattr(self, name) is not None for name in LEGS):
            raise AttributionError(
                "providers",
                "a vendor-owned table names no leg; the managed pipeline is "
                "vendor-owned, so naming a provider would be a fabricated attribution",
            )
        for name in LEGS:
            value = getattr(self, name)
            if value is None:
                continue
            if not isinstance(value, LegAttribution):
                raise AttributionError(
                    "providers",
                    f'"{name}" must be a LegAttribution or None, got {value!r}',
                )
            if value.leg != name:
                raise AttributionError(
                    "leg",
                    f'attribution slot "{name}" cannot carry the "{value.leg}" leg',
                )
        if not self.vendor_owned and not self.unmeasured_reason and all(
            getattr(self, name) is None for name in LEGS
        ):
            raise AttributionError(
                "providers",
                "a measured attribution must name at least one leg; a turn whose "
                "providers were never recorded is unmeasured",
            )

    @classmethod
    def managed(cls, turn: str | object) -> "TurnAttribution":
        """The managed pipeline's table: ``N/A — vendor-owned``, never a vendor."""
        return cls(turn=turn_key(turn), vendor_owned=True)

    @classmethod
    def unmeasured(cls, turn: str | object, reason: str) -> "TurnAttribution":
        """A turn whose attribution was never recorded, named rather than guessed."""
        if not isinstance(reason, str) or not reason.strip():
            raise AttributionError(
                "unmeasuredReason",
                "an unmeasured turn needs a named reason; the missing attribution "
                "is reported, not invented",
            )
        return cls(turn=turn_key(turn), unmeasured_reason=reason)

    @property
    def state(self) -> str:
        if self.vendor_owned:
            return "vendor-owned"
        return "unmeasured" if self.unmeasured_reason else "measured"

    def leg(self, name: str) -> LegAttribution | None:
        """One leg's attribution, or ``None`` when the leg did not run."""
        if name not in LEGS:
            raise AttributionError(
                "leg",
                f"unknown cascade leg {name!r}; expected one of {', '.join(LEGS)}",
            )
        return getattr(self, name)

    def to_payload(self) -> dict[str, Any]:
        """The event payload; the envelope owns ``turn``, so it is not repeated."""
        if self.vendor_owned:
            payload: dict[str, Any] = {
                "state": self.state,
                "providers": {
                    name: {
                        "leg": name,
                        "provider": VENDOR_OWNED,
                        "rung": None,
                        "reason": "the managed pipeline is vendor-owned",
                    }
                    for name in LEGS
                },
            }
            payload["vendorOwned"] = True
            return payload
        if self.unmeasured_reason:
            return {
                "state": self.state,
                "providers": {name: None for name in LEGS},
                "unmeasuredReason": self.unmeasured_reason,
            }
        return {
            "state": self.state,
            "providers": {
                name: self.leg(name).to_document() if self.leg(name) else None
                for name in LEGS
            },
        }


def emit_attribution(
    writer: EventWriter,
    attribution: TurnAttribution,
    *,
    subject: str,
    at_ms: float | int,
    sink: EventSink,
    phase: str = "turn",
) -> dict[str, Any]:
    """Emit one turn's attribution through the one envelope writer, then the sink.

    A cascade writer cannot claim a vendor-owned table (the managed-only
    ``vendorOwned`` field) and a managed writer cannot name a provider: the
    managed pipeline has no vendor choice, so a name would be fabricated. Both
    refusals write nothing.
    """
    if writer.pipeline == "cascade" and attribution.vendor_owned:
        raise EventEnvelopeError(
            "vendorOwned",
            'a vendor-owned provider table belongs to the managed pipeline; '
            'this writer is "cascade"',
        )
    if writer.pipeline == "managed" and not attribution.vendor_owned:
        raise EventEnvelopeError(
            "providers",
            "a managed turn records its provider table as vendor-owned; naming a "
            f'provider ("{attribution.state}") would be a fabricated attribution',
        )
    event = writer.call_scoped(
        ATTRIBUTION_EVENT_TYPE,
        subject=subject,
        turn=attribution.turn,
        at_ms=at_ms,
        phase=phase,
        fields=attribution.to_payload(),
    )
    sink(event)
    return event


# ---------------------------------------------------------------------------
# Operational events: money, breaker, reconnect, greeting, deploy (ticket 110)
# ---------------------------------------------------------------------------

#: Event types only a cascade run can claim. This tuple is a mirror of the TS
#: reader's ``CASCADE_ONLY_EVENT_TYPES`` (in the same order), which is what a
#: managed envelope is refused for carrying. It is a second copy by necessity —
#: the service does not import TypeScript — and ``test_events.py`` reads the TS
#: source and fails by name when the two lists drift. ``provider_fallback`` is
#: emitted by :func:`emit_fallback`, not by :class:`OperationalEvents`; the
#: operational methods below own the breaker and cascade budget subset.
CASCADE_ONLY_EVENT_TYPES = (
    FALLBACK_EVENT_TYPE,
    BREAKER_EVENT_TYPE,
    BUDGET_CROSSING_EVENT_TYPE,
    BUDGET_STOPPED_EVENT_TYPE,
)

#: The transition phases a breaker trigger may name, mapped onto the envelope's
#: call phases. A probe or a manual write is pre-call, so it is ``connect``; a
#: stream failure happens in the turn.
_BREAKER_PHASES = {
    "stream": "turn",
    "turn": "turn",
    "probe": "connect",
    "read": "connect",
    "manual": "connect",
}


def _text_field(field: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EventEnvelopeError(
            field, f'"{field}" must be a non-empty string, got {value!r}'
        )
    return value


def _bool_field(field: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise EventEnvelopeError(
            field, f'"{field}" must be true or false, got {value!r}'
        )
    return value


def _count_field(field: str, value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EventEnvelopeError(
            field, f'"{field}" must be a non-negative integer, got {value!r}'
        )
    return value


def _number_field(field: str, value: Any) -> float | int:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise EventEnvelopeError(
            field, f'"{field}" must be a finite non-negative number, got {value!r}'
        )
    return value


def _document_of(value: Any, label: str) -> Mapping[str, Any]:
    """The value's own document, never a shape this module invents."""
    to_document = getattr(value, "to_document", None)
    if not callable(to_document):
        raise EventEnvelopeError(
            label, f"{label} must carry a to_document() view, got {value!r}"
        )
    document = to_document()
    if not isinstance(document, Mapping):
        raise EventEnvelopeError(label, f"{label}.to_document() is not a mapping")
    return document


def _leg_field(value: Any, field: str = "leg") -> str:
    if value not in LEGS:
        raise EventEnvelopeError(
            field, f"unknown cascade leg {value!r}; expected one of {', '.join(LEGS)}"
        )
    return value


def _cost_legs(value: Any) -> dict[str, Any]:
    """One cost summary's priced legs, validated, never a reinvented shape.

    Each leg keeps the fields :meth:`cascade.call.CostSummary.to_document`
    produced: the unit, the reported quantity, whether it was measured, the
    source of the measurement and the priced amount. A leg claiming to be
    measured without an amount is refused, because that is a zero in disguise.
    """
    if not isinstance(value, Mapping) or not value:
        raise EventEnvelopeError(
            "legs", f"a cost row must name the legs it priced, got {value!r}"
        )
    legs: dict[str, Any] = {}
    for name, raw in value.items():
        leg = _leg_field(name)
        if not isinstance(raw, Mapping):
            raise EventEnvelopeError(
                "legs", f"leg {leg!r} must be an object, got {raw!r}"
            )
        measured = _bool_field("measured", raw.get("measured"))
        quantity = raw.get("quantity")
        if quantity is not None:
            quantity = _number_field("quantity", quantity)
        amount = raw.get("amountUsd")
        if amount is not None:
            amount = _number_field("amountUsd", amount)
        if measured and amount is None:
            raise EventEnvelopeError(
                "amountUsd",
                f"a measured {leg} leg must carry its priced amount; an "
                "unmeasured leg must say so instead",
            )
        units = raw.get("units")
        if not isinstance(units, Mapping):
            raise EventEnvelopeError(
                "units", f"leg {leg!r} must carry the units it was measured in"
            )
        legs[leg] = {
            "unit": _text_field("unit", raw.get("unit")),
            "quantity": quantity,
            "measured": measured,
            "source": _text_field("source", raw.get("source")),
            "amountUsd": amount,
            "units": {
                _text_field("units", key): _number_field("units", entry)
                for key, entry in units.items()
            },
        }
    return legs


class OperationalEvents:
    """One call's operational decisions, through the one envelope and stream.

    Every method builds a line with :class:`EventWriter` and writes it through
    the call's one :class:`EventStream`, so the shared sanitizer runs on every
    event and a forbidden key refuses the whole line before it is written. The
    methods take typed values (a ``Crossing``, a ``BudgetStop``, a
    ``ReconnectEvent``, a ``BreakerTransition``) rather than free-form fields,
    so a caller cannot smuggle caller text or audio onto a line.

    A managed writer may emit a deploy drain, a reconnect, a greeting or a
    protocol/turn failure; the breaker and the cascade budget are cascade-only,
    exactly as the TS reader's ``CASCADE_ONLY_EVENT_TYPES`` says.
    """

    def __init__(
        self,
        stream: EventStream,
        *,
        subject: str,
        now: Callable[[], float] = time.time,
    ) -> None:
        if not isinstance(stream, EventStream):
            raise TypeError(
                f"OperationalEvents needs the one EventStream, got {stream!r}"
            )
        if not callable(now):
            raise ValueError(f"now must be callable, got {now!r}")
        self.stream = stream
        # A demo stream's subject is checked when the call is set up, so a
        # malformed identity refuses the call loudly instead of silently
        # dropping every line (the lifecycle continues past a failed write).
        if stream.subject_kind == DEMO_SUBJECT_KIND:
            _require_demo_subject(subject)
        self.subject = _require_text("subject", subject)
        self._now = now
        #: The call's turn rows, created on first use so a call that never
        #: reaches the turn layer writes no turn row and no turn ledger.
        self._turn_ledger: TurnLedger | None = None

    @property
    def path(self) -> Path | None:
        """The call's event artifact path, when the stream persists one."""
        return getattr(self.stream, "path", None)

    @property
    def error(self) -> str | None:
        """Why the call's event artifact is unavailable, when it is."""
        return getattr(self.stream, "unavailable", None)

    @property
    def directory(self) -> Path | None:
        """The evidence directory the trace is written under, when one exists."""
        return getattr(self.stream, "directory", None)

    @property
    def now(self) -> Callable[[], float]:
        """The call's clock; the turn ledger timestamps its rows with it."""
        return self._now

    @property
    def turns(self) -> TurnLedger:
        """The call's turn ledger: the same stream, one row per turn event."""
        if self._turn_ledger is None:
            self._turn_ledger = TurnLedger(self)
        return self._turn_ledger

    def end(self, document: Mapping[str, Any]) -> Path | None:
        """Persist the call's final end document and its one end row.

        The sidecar is the exact document the client received, written beside
        the trace under the call id (``<call-id>.end.json``). The trace carries
        one ``end`` row keyed by the same call id; a hold return rewrites that
        row rather than appending a second one, so the row and the sidecar
        always describe the same final state. A call wired to a non-persisting
        sink (a test list) has no evidence directory and writes nothing; a
        directory the host named but cannot write is a named
        :class:`EndEvidenceError`.
        """
        directory = self.directory
        if directory is None:
            return None
        evidence = EndEvidence(directory, call_id=self.stream.writer.call_id)
        return evidence.write(
            document,
            stream=self.stream,
            subject=self.subject,
            at_ms=self._moment(None),
        )

    # -- envelope helpers -------------------------------------------------

    def _moment(self, at_ms: float | int | None) -> float | int:
        moment = self._now() * 1000.0 if at_ms is None else at_ms
        return _require_at_ms(moment)

    def _cascade_only(self, type: str) -> None:
        if self.stream.writer.pipeline == "managed":
            raise EventEnvelopeError(
                "type",
                f'"{type}" is a cascade-only event; this writer is "managed"',
            )

    def _call(
        self,
        type: str,
        fields: Mapping[str, Any],
        *,
        turn: str | None,
        phase: str,
        at_ms: float | int | None,
    ) -> dict[str, Any]:
        return self.stream.call_scoped(
            type,
            subject=self.subject,
            turn=turn,
            at_ms=self._moment(at_ms),
            phase=phase,
            fields=fields,
        )

    def _operational(
        self,
        type: str,
        *,
        leg: str,
        fields: Mapping[str, Any],
        phase: str,
        at_ms: float | int | None,
    ) -> dict[str, Any]:
        return self.stream.operational(
            type,
            leg=leg,
            at_ms=self._moment(at_ms),
            phase=phase,
            subject=self.subject if self.stream.subject_kind == DEMO_SUBJECT_KIND else None,
            fields=fields,
        )

    # -- money ------------------------------------------------------------

    def budget_crossing(
        self, crossing: Any, *, at_ms: float | int | None = None
    ) -> dict[str, Any]:
        """The 80% or 100% line crossed by a charge: line, day, spend and cap."""
        self._cascade_only(BUDGET_CROSSING_EVENT_TYPE)
        document = _document_of(crossing, "crossing")
        line = _text_field("line", document.get("line"))
        if line not in MONEY_LINES:
            raise EventEnvelopeError(
                "line",
                f"unknown money line {line!r}; expected one of {', '.join(MONEY_LINES)}",
            )
        fields = {
            "line": line,
            "day": _text_field("day", document.get("day")),
            "spend": _text_field("spend", document.get("spend")),
            "cap": _text_field("cap", document.get("cap")),
        }
        return self._call(
            BUDGET_CROSSING_EVENT_TYPE,
            fields,
            turn=None,
            phase="end",
            at_ms=at_ms,
        )

    def budget_stopped(
        self, stop: Any, *, at_ms: float | int | None = None
    ) -> dict[str, Any]:
        """The per-call ceiling breach: call, spend and ceiling, emitted once."""
        self._cascade_only(BUDGET_STOPPED_EVENT_TYPE)
        document = _document_of(stop, "stop")
        measured = _bool_field("measured", document.get("measured"))
        fields: dict[str, Any] = {
            "spendUsd": _number_field("spendUsd", document.get("spendUsd")),
            "ceilingUsd": _number_field("ceilingUsd", document.get("ceilingUsd")),
            "measured": measured,
            "reason": _text_field("reason", document.get("reason")),
        }
        if not measured:
            fields["unmeasuredReason"] = _text_field(
                "unmeasuredReason", document.get("unmeasuredReason")
            )
        return self._call(
            BUDGET_STOPPED_EVENT_TYPE,
            fields,
            turn=_require_turn(document.get("turn")),
            phase="drain",
            at_ms=at_ms,
        )

    def cost_priced(
        self, cost: Any, *, at_ms: float | int | None = None
    ) -> dict[str, Any]:
        """The completed session's priced row, or the reason it has no price.

        A measured row cites the rate table and its version, the engine that
        produced it (the envelope's ``pipeline``), and every leg's measured
        unit and quantity. An unmeasured row keeps ``measured: false`` and
        ``totalUsd: null`` with ``unmeasuredReason``: a call that cannot be
        priced is visible here, never absent and never a zero.
        """
        document = _document_of(cost, "cost")
        measured = _bool_field("measured", document.get("measured"))
        version = document.get("rateTableVersion")
        if version is not None:
            version = _text_field("rateTableVersion", version)
        if measured and version is None:
            raise EventEnvelopeError(
                "rateTableVersion",
                "a measured cost row must cite the rate table that priced it",
            )
        total = document.get("totalUsd")
        if measured:
            total = _number_field("totalUsd", total)
        elif total is not None:
            raise EventEnvelopeError(
                "totalUsd",
                "an unmeasured cost row has no total; a zero would claim a "
                "price the table never gave",
            )
        fields: dict[str, Any] = {
            "producer": COST_PRODUCER,
            "rateTableVersion": version,
            "measured": measured,
            "totalUsd": total,
            "legs": _cost_legs(document.get("legs")),
        }
        if not measured:
            fields["unmeasuredReason"] = _text_field(
                "unmeasuredReason", document.get("unmeasuredReason")
            )
        return self._call(
            COST_PRICED_EVENT_TYPE,
            fields,
            turn=None,
            phase="end",
            at_ms=at_ms,
        )

    # -- deploy, reconnect ------------------------------------------------

    def deploy_drain(
        self,
        *,
        reason: str,
        planned: bool = True,
        turn: str | None = None,
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """An instance draining a live call for a deploy; never a failure."""
        if planned is not True:
            raise EventEnvelopeError(
                "planned",
                "a deploy drain is planned, never a failure; a failed leg uses "
                "the reconnect event",
            )
        fields = {"reason": _text_field("reason", reason), "planned": True}
        return self._call(
            DEPLOY_DRAIN_EVENT_TYPE,
            fields,
            turn=_require_turn(turn),
            phase="drain",
            at_ms=at_ms,
        )

    def reconnect(
        self,
        event: Any,
        *,
        turn: str | None = None,
        phase: str = "turn",
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """One reconnect: leg, reason, and whether it was planned or a failure."""
        document = _document_of(event, "reconnect")
        leg = _leg_field(document.get("leg"))
        planned = _bool_field("planned", document.get("planned"))
        action = document.get("action")
        if planned and action != "planned_reconnect":
            raise EventEnvelopeError(
                "action",
                f'a planned reconnect must say so, got action {action!r}',
            )
        if not planned and action == "planned_reconnect":
            raise EventEnvelopeError(
                "action",
                "a planned reconnect cannot be reported as a failure",
            )
        fields: dict[str, Any] = {
            "leg": leg,
            "reason": _text_field("reason", document.get("reason")),
            "planned": planned,
        }
        for key in ("action", "code", "failureClass"):
            value = document.get(key)
            if value is not None:
                fields[key] = value
        if not planned:
            _text_field("failureClass", document.get("failureClass"))
        return self._call(
            RECONNECT_EVENT_TYPE,
            fields,
            turn=_require_turn(turn),
            phase=phase,
            at_ms=at_ms,
        )

    # -- greeting ---------------------------------------------------------

    def greeting(
        self,
        mark: str,
        *,
        voice_id: str,
        frames: int = 0,
        sample_rate: int = 0,
        cancelled: bool = False,
        cause: str = "",
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """One greeting mark: spoken before caller audio, never a turn."""
        if mark not in GREETING_EVENT_TYPES:
            raise EventEnvelopeError(
                "type",
                f'unknown greeting mark {mark!r}; expected one of '
                f"{', '.join(GREETING_EVENT_TYPES)}",
            )
        fields: dict[str, Any] = {
            "voiceId": _text_field("voiceId", voice_id),
            "frames": _count_field("frames", frames),
            "sampleRate": _count_field("sampleRate", sample_rate),
            "cancelled": _bool_field("cancelled", cancelled),
        }
        if cause:
            fields["cause"] = _text_field("cause", cause)
        return self._call(
            mark,
            fields,
            turn=None,
            phase="connect",
            at_ms=at_ms,
        )

    # -- breaker, protocol, failed turns ---------------------------------

    def breaker_transition(
        self,
        transition: Any,
        *,
        manual_pin: bool | None = None,
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """One breaker move, operational: its leg, plus a demo call's subject."""
        self._cascade_only(BREAKER_EVENT_TYPE)
        leg = _leg_field(getattr(transition, "leg", None))
        from_state = getattr(transition, "from_state", None)
        to_state = getattr(transition, "to_state", None)
        for field, state in (("from", from_state), ("to", to_state)):
            if state not in STATES:
                raise EventEnvelopeError(
                    field, f"unknown breaker state {state!r}; expected one of {STATES}"
                )
        trigger = getattr(transition, "trigger", None)
        kind = getattr(trigger, "kind", None)
        if not isinstance(kind, str) or not kind.strip():
            raise EventEnvelopeError(
                "trigger", f"a breaker transition needs its trigger, got {trigger!r}"
            )
        if manual_pin is None:
            manual_pin = kind == "manual_pin"
        fields: dict[str, Any] = {
            "from": from_state,
            "to": to_state,
            "trigger": kind,
            "reason": _text_field("reason", getattr(transition, "reason", None)),
            "manualPin": _bool_field("manualPin", manual_pin),
        }
        code = getattr(trigger, "code", None)
        if code is not None:
            fields["triggerCode"] = code
        turn = getattr(trigger, "turn", None)
        if turn is not None:
            fields["triggerTurn"] = turn
        phase = _BREAKER_PHASES.get(getattr(trigger, "phase", ""), "connect")
        moment = (
            at_ms
            if at_ms is not None
            else _number_field("at", getattr(transition, "at", None)) * 1000.0
        )
        return self._operational(
            BREAKER_EVENT_TYPE,
            leg=leg,
            fields=fields,
            phase=phase,
            at_ms=moment,
        )

    def protocol_error(
        self,
        *,
        leg: str,
        code: int | str | None = None,
        reason: str,
        turn: str | None = None,
        phase: str = "connect",
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """A wire/protocol failure, named by leg, code and reason."""
        fields: dict[str, Any] = {
            "leg": _leg_field(leg),
            "reason": _text_field("reason", reason),
        }
        if code is not None:
            if isinstance(code, bool) or not isinstance(code, (int, str)):
                raise EventEnvelopeError(
                    "code", f'"code" must be an int, a string or null, got {code!r}'
                )
            fields["code"] = code
        return self._call(
            PROTOCOL_ERROR_EVENT_TYPE,
            fields,
            turn=_require_turn(turn),
            phase=phase,
            at_ms=at_ms,
        )

    def turn_failed(
        self,
        *,
        turn: str,
        leg: str,
        reason: str,
        name: str = "",
        phase: str = "turn",
        at_ms: float | int | None = None,
    ) -> dict[str, Any]:
        """One failed turn, naming the logical turn and the leg that failed."""
        if turn is None:
            raise EventEnvelopeError(
                "turn", "a failed turn must name its logical turn, not null"
            )
        fields: dict[str, Any] = {
            "leg": _leg_field(leg),
            "reason": _text_field("reason", reason),
        }
        if name:
            fields["name"] = _text_field("name", name)
        return self._call(
            TURN_FAILED_EVENT_TYPE,
            fields,
            turn=_require_turn(turn),
            phase=phase,
            at_ms=at_ms,
        )


# ---------------------------------------------------------------------------
# The turn-level ledger: one row per turn event (demo-verification 04)
# ---------------------------------------------------------------------------

#: The turn row vocabulary. Each row is one fact about one logical turn, in the
#: order the ticket lists them; a defect card cites a row's ``turn``.
TURN_USER_FINAL_EVENT_TYPE = "turn.user_final"
TURN_REPLY_START_EVENT_TYPE = "turn.reply_start"
TURN_FIRST_AUDIO_EVENT_TYPE = "turn.first_audio"
TURN_CUT_EVENT_TYPE = "turn.cut"
TURN_TOOL_CALL_EVENT_TYPE = "turn.tool_call"
TURN_TOOL_RESULT_EVENT_TYPE = "turn.tool_result"
TURN_GOODBYE_EVENT_TYPE = "turn.goodbye"
TURN_HANGUP_EVENT_TYPE = "turn.hangup"

#: Why a sounding reply was cut. Closed, so a reason cannot become a channel
#: for caller text.
CUT_REASONS = ("barge_in",)

#: Why the turn closed and the call drained. Closed for the same reason.
DRAIN_REASONS = ("end_call", "caller_end")


class TurnLedger:
    """One call's turn rows, each written once, through the one stream.

    The ledger never builds a second write path: every row goes through the
    call's :class:`EventStream`, so the one sanitizer runs and a forbidden key
    refuses the line before it is written. The methods take typed values and
    closed vocabularies — never caller text, tool arguments or tool payloads —
    so a turn row cannot smuggle the words or audio a defect card must not
    quote.

    One event is one row. A replayed provider final, a second first-audio frame
    or a repeated tool result is a duplicate, not a second fact, and writes
    nothing. A genuine second event (a different tool call, a different turn)
    has its own key and is written.
    """

    def __init__(
        self,
        events: OperationalEvents,
        *,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not isinstance(events, OperationalEvents):
            raise TypeError(f"TurnLedger needs OperationalEvents, got {events!r}")
        self._events = events
        self._stream = events.stream
        self._subject = events.subject
        self._now = events.now if now is None else now
        self._emitted: set[tuple[Any, ...]] = set()
        #: A hold return resumes the same call id and trace, so this session's
        #: turn ids continue past every epoch the file already names. The
        #: provider's own session counter restarts at 0 with the new process;
        #: the offset keeps the trace's identities unique without asking the
        #: vendor to count for us.
        self._epoch_offset = self.prior_turn_epoch + 1

    @property
    def path(self) -> Path | None:
        """The trace the rows were written to, when the stream persists one."""
        return self._stream.path

    @property
    def stream(self) -> EventStream:
        """The one stream every row passes through."""
        return self._stream

    @property
    def prior_turn_epoch(self) -> int:
        """The highest session epoch already in this call's trace, or ``-1``.

        A hold return resumes the same call id and the same trace file, so a
        new session's turn ids must not reuse an epoch the file already names:
        two different chains under one id would make a defect card ambiguous.
        """
        path = self._stream.path
        if path is None or not path.exists():
            return -1
        highest = -1
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return -1
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            turn = row.get("turn") if isinstance(row, Mapping) else None
            if not isinstance(turn, str) or ":" not in turn:
                continue
            head = turn.split(":", 1)[0]
            if head.isdigit():
                highest = max(highest, int(head))
        return highest

    def _moment(self, at_ms: float | int | None) -> float | int:
        return _require_at_ms(self._now() * 1000.0 if at_ms is None else at_ms)

    def _once(
        self, key: tuple[Any, ...], build: Callable[[], dict[str, Any]]
    ) -> dict[str, Any] | None:
        if key in self._emitted:
            return None
        event = build()
        self._emitted.add(key)
        return event

    def _row_turn(self, turn: str) -> str:
        """This session's trace identity for one logical turn."""
        head, separator, tail = turn.partition(":")
        if separator and head.isdigit():
            return f"{int(head) + self._epoch_offset}:{tail}"
        return turn

    def _call(
        self,
        type: str,
        *,
        turn: str,
        phase: str,
        fields: Mapping[str, Any],
        at_ms: float | int | None,
    ) -> dict[str, Any]:
        _require_turn(turn)
        turn = self._row_turn(turn)
        return self._stream.call_scoped(
            type,
            subject=self._subject,
            turn=turn,
            at_ms=self._moment(at_ms),
            phase=phase,
            fields=fields,
        )

    # -- the turn chain ---------------------------------------------------

    def user_final(
        self,
        turn: str,
        *,
        chars: int,
        empty: bool = False,
        wants_end: bool = False,
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The authoritative caller final: how long, never what was said."""
        return self._once(
            (TURN_USER_FINAL_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_USER_FINAL_EVENT_TYPE,
                turn=turn,
                phase="turn",
                fields={
                    "chars": _count_field("chars", chars),
                    "empty": _bool_field("empty", empty),
                    "wantsEnd": _bool_field("wantsEnd", wants_end),
                },
                at_ms=at_ms,
            ),
        )

    def reply_start(
        self, turn: str, *, at_ms: float | int | None = None
    ) -> dict[str, Any] | None:
        """The model request for this turn has started."""
        return self._once(
            (TURN_REPLY_START_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_REPLY_START_EVENT_TYPE,
                turn=turn,
                phase="turn",
                fields={},
                at_ms=at_ms,
            ),
        )

    def first_audio(
        self, turn: str, *, seq: int, at_ms: float | int | None = None
    ) -> dict[str, Any] | None:
        """The first frame of this turn's reply reached the wire."""
        return self._once(
            (TURN_FIRST_AUDIO_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_FIRST_AUDIO_EVENT_TYPE,
                turn=turn,
                phase="turn",
                fields={"seq": _count_field("seq", seq)},
                at_ms=at_ms,
            ),
        )

    def cut(
        self,
        turn: str,
        *,
        reason: str = "barge_in",
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The reply was cut; the reason is one of the closed vocabulary."""
        if reason not in CUT_REASONS:
            raise EventEnvelopeError(
                "reason",
                f"unknown cut reason {reason!r}; expected one of {', '.join(CUT_REASONS)}",
            )
        return self._once(
            (TURN_CUT_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_CUT_EVENT_TYPE,
                turn=turn,
                phase="turn",
                fields={"reason": reason},
                at_ms=at_ms,
            ),
        )

    def tool_call(
        self,
        turn: str,
        *,
        name: str,
        call_id: str,
        index: int = 0,
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The model asked for a tool: its name and ids, never its arguments."""
        call_id = _text_field("toolCallId", call_id)
        return self._once(
            (TURN_TOOL_CALL_EVENT_TYPE, turn, call_id),
            lambda: self._call(
                TURN_TOOL_CALL_EVENT_TYPE,
                turn=turn,
                phase="tool",
                fields={
                    "name": _text_field("name", name),
                    "toolCallId": call_id,
                    "index": _count_field("index", index),
                },
                at_ms=at_ms,
            ),
        )

    def tool_result(
        self,
        turn: str,
        *,
        name: str,
        call_id: str,
        ok: bool,
        code: str = "",
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The tool answered: success and a closed code, never its payload."""
        call_id = _text_field("toolCallId", call_id)
        fields: dict[str, Any] = {
            "name": _text_field("name", name),
            "toolCallId": call_id,
            "ok": _bool_field("ok", ok),
        }
        if code:
            fields["code"] = _text_field("code", code)
        return self._once(
            (TURN_TOOL_RESULT_EVENT_TYPE, turn, call_id),
            lambda: self._call(
                TURN_TOOL_RESULT_EVENT_TYPE,
                turn=turn,
                phase="tool",
                fields=fields,
                at_ms=at_ms,
            ),
        )

    def goodbye(
        self,
        turn: str,
        *,
        reason: str = "end_call",
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The turn's closing line is being spoken before the drain."""
        if reason not in DRAIN_REASONS:
            raise EventEnvelopeError(
                "reason",
                f"unknown goodbye reason {reason!r}; expected one of "
                f"{', '.join(DRAIN_REASONS)}",
            )
        return self._once(
            (TURN_GOODBYE_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_GOODBYE_EVENT_TYPE,
                turn=turn,
                phase="drain",
                fields={"reason": reason},
                at_ms=at_ms,
            ),
        )

    def hangup(
        self,
        turn: str,
        *,
        reason: str = "end_call",
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """The turn closed and the call is draining."""
        if reason not in DRAIN_REASONS:
            raise EventEnvelopeError(
                "reason",
                f"unknown hangup reason {reason!r}; expected one of "
                f"{', '.join(DRAIN_REASONS)}",
            )
        return self._once(
            (TURN_HANGUP_EVENT_TYPE, turn),
            lambda: self._call(
                TURN_HANGUP_EVENT_TYPE,
                turn=turn,
                phase="drain",
                fields={"reason": reason},
                at_ms=at_ms,
            ),
        )

    # -- failures and contamination --------------------------------------

    def turn_failed(
        self,
        turn: str,
        *,
        leg: str,
        name: str,
        reason: str,
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """One failed turn: the leg and the error class, never a stack trace."""
        return self._once(
            (TURN_FAILED_EVENT_TYPE, turn, leg),
            lambda: self._events.turn_failed(
                turn=self._row_turn(turn),
                leg=leg,
                name=name,
                reason=reason,
                at_ms=self._moment(at_ms),
            ),
        )

    def protocol_error(
        self,
        *,
        leg: str,
        reason: str,
        code: int | str | None = None,
        turn: str | None = None,
        phase: str = "turn",
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """A wire/protocol failure, named by leg and error class."""
        return self._once(
            (PROTOCOL_ERROR_EVENT_TYPE, leg, turn, code),
            lambda: self._events.protocol_error(
                leg=leg,
                code=code,
                reason=reason,
                turn=None if turn is None else self._row_turn(turn),
                phase=phase,
                at_ms=self._moment(at_ms),
            ),
        )

    def fallback(
        self,
        fallback: Fallback,
        *,
        at_ms: float | int | None = None,
    ) -> dict[str, Any] | None:
        """One provider fallback, connect-time or mid-turn, written once."""
        if not isinstance(fallback, Fallback):
            raise TypeError(f"fallback must be a Fallback, got {fallback!r}")
        if fallback.turn is not None:
            fallback = replace(fallback, turn=self._row_turn(fallback.turn))
        return self._once(
            (
                FALLBACK_EVENT_TYPE,
                fallback.leg,
                fallback.from_provider,
                fallback.to_provider,
                fallback.trigger,
                fallback.turn,
            ),
            lambda: emit_fallback(
                self._stream.writer,
                fallback,
                subject=self._subject,
                at_ms=self._moment(at_ms),
                sink=self._stream,
            ),
        )


# ---------------------------------------------------------------------------
# The persisted per-call stream
# ---------------------------------------------------------------------------


class CallEventLog:
    """One call's operational-event artifact: a single JSONL file.

    The sink is the one write boundary: lines reaching it have already passed
    :class:`EventStream`'s sanitizer, so the file carries no caller text and no
    audio. Each call writes under a directory the deployment provides
    (``VOICE_PIPELINE_EVENTS_DIR``, ``/var/lib/voni/events`` in the image); the
    file name is the call id reduced to a filesystem-safe stem, so a call id
    can never escape the directory.

    The artifact is best-effort: a directory that cannot be created or a write
    the host refuses disables it for this call, records the reason on
    :attr:`unavailable`, and never fails the call. The end message carries that
    reason, so a missing artifact is a fact the reader can act on rather than a
    silent gap.
    """

    def __init__(self, directory: str | Path, *, call_id: str) -> None:
        self.call_id = _require_text("callId", call_id)
        self._directory = Path(directory)
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", self.call_id).strip("._")
        self._path = self._directory / f"{safe or 'call'}.jsonl"
        #: Why this call's artifact is unavailable, or ``None`` while it works.
        self.unavailable: str | None = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self._disable(f"cannot create the events directory {self._path.parent}", exc)

    @property
    def path(self) -> Path | None:
        """The artifact path while it is usable, ``None`` once it is disabled."""
        return self._path if self.unavailable is None else None

    @property
    def directory(self) -> Path:
        """The evidence directory the host named, usable or not.

        The end document is written beside the trace, so the directory is read
        even after this sink disabled itself: an unwritable directory is then a
        named end-evidence failure, not a silent skip.
        """
        return self._directory

    def _disable(self, what: str, error: OSError) -> None:
        reason = error.strerror or str(error)
        self.unavailable = f"{what}: {reason}"

    def __call__(self, line: str) -> None:
        """Append one already-sanitized line; a write failure disables the sink."""
        if self.unavailable is not None:
            return
        try:
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(line if line.endswith("\n") else line + "\n")
        except OSError as exc:
            # The artifact is a record of the call, never a precondition for it.
            self._disable(f"cannot write the events artifact {self._path}", exc)


# ---------------------------------------------------------------------------
# The cascade's one stream writer: sanitize every line before it is written
# ---------------------------------------------------------------------------


class EventStream:
    """One cascade stream: the one envelope builder, the one sanitizer, one sink.

    Every line is built by :class:`EventWriter` and passes through the one
    shared rule module (``cascade.sanitizer``, a parity-tested copy of the TS
    rule source) before it is written. A line that still carries a forbidden
    key is refused by name and nothing is written; an allowed field keeps its
    value except where a credential inside it is redacted. There is no second
    write path: ``__call__`` is the only thing that touches the sink.

    ``emit_fallback(..., sink=stream)`` works because the stream is callable,
    so a fallback line is sanitized like every other line. When the sink is a
    :class:`CallEventLog`, ``path`` names the artifact the end message cites.

    ``subject_kind`` is the verified envelope's signed kind (``demo`` or
    ``tenant``; ``None`` for a stream built without one). A demo stream refuses
    any line without a ``demo:<voice>`` subject at this boundary, so no builder
    — call-scoped, operational, fallback or attribution — can write a line that
    names a tenant subject, a managed agent id or a bare voice id, or no
    subject at all.
    """

    def __init__(
        self,
        writer: EventWriter,
        *,
        sink: Callable[[str], None],
        subject_kind: str | None = None,
    ) -> None:
        if not isinstance(writer, EventWriter):
            raise TypeError(f"EventStream needs an EventWriter, got {writer!r}")
        if not callable(sink):
            raise TypeError(f"EventStream needs a write sink, got {sink!r}")
        if subject_kind is not None and subject_kind not in SUBJECT_KINDS:
            raise ValueError(
                f"subject_kind must be one of {', '.join(SUBJECT_KINDS)} or None, "
                f"got {subject_kind!r}"
            )
        self.writer = writer
        self.subject_kind = subject_kind
        self._sink = sink

    @property
    def path(self) -> Path | None:
        """The artifact path, while a persisting sink still has one."""
        return getattr(self._sink, "path", None)

    @property
    def unavailable(self) -> str | None:
        """Why the sink disabled its artifact, when it did."""
        return getattr(self._sink, "unavailable", None)

    @property
    def directory(self) -> Path | None:
        """The directory a persisting sink writes under, when it has one."""
        directory = getattr(self._sink, "directory", None)
        return None if directory is None else Path(directory)

    def __call__(self, event: Mapping[str, Any]) -> dict[str, Any]:
        """Sanitize one finished line, then write it; a refusal writes nothing."""
        sanitized = sanitize_fields(dict(event))
        if sanitized.rejected_keys:
            raise ForbiddenEventKey(sanitized.rejected_keys)
        if self.subject_kind == DEMO_SUBJECT_KIND:
            # A demo trace names ``demo:<voice>`` on every line, operational
            # lines included; a line without one is refused here, at the one
            # write boundary, before anything reaches the artifact.
            if "subject" not in sanitized.value:
                raise EventEnvelopeError(
                    "subject",
                    "every line of a demo call's trace must name "
                    '"demo:<voice>", including an operational line; this line '
                    "carries no subject",
                )
            _require_demo_subject(sanitized.value["subject"])
        self._sink(
            json.dumps(sanitized.value, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
        return sanitized.value

    def call_scoped(
        self,
        type: str,
        *,
        subject: str,
        turn: str | None,
        at_ms: float | int,
        phase: str,
        fields: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build and write one call-scoped line."""
        return self(
            self.writer.call_scoped(
                type,
                subject=subject,
                turn=turn,
                at_ms=at_ms,
                phase=phase,
                fields=fields,
            )
        )

    def operational(
        self,
        type: str,
        *,
        leg: str,
        at_ms: float | int,
        phase: str,
        subject: str | None = None,
        fields: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build and write one operational line."""
        return self(
            self.writer.operational(
                type,
                leg=leg,
                at_ms=at_ms,
                phase=phase,
                subject=subject,
                fields=fields,
            )
        )


# ---------------------------------------------------------------------------
# The end document: one sidecar and exactly one trace row (demo-verification 03)
# ---------------------------------------------------------------------------


class EndEvidence:
    """One call's end document beside its trace, and the one ``end`` row.

    The sidecar is ``<call-id>.end.json`` and is the exact document the client
    received, written atomically so a partial write never claims a record. The
    trace is ``<call-id>.jsonl`` and gains one call-level ``end`` row pointing
    at the sidecar; a hold return replaces that row (never appends a second)
    and overwrites the sidecar, so both describe the same final state.

    Every failure is named: a document missing a required field, a directory
    that cannot be created, or a write that fails raises
    :class:`EndEvidenceError` with the path and the reason. Nothing here
    swallows an error, because a call with no evidence must not look observed.
    """

    def __init__(self, directory: str | Path, *, call_id: str) -> None:
        self.call_id = _require_text("callId", call_id)
        self._directory = Path(directory)
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", self.call_id).strip("._")
        self._stem = safe or "call"
        self.document_path = self._directory / f"{self._stem}{END_DOCUMENT_SUFFIX}"
        self.trace_path = self._directory / f"{self._stem}.jsonl"

    def write(
        self,
        document: Mapping[str, Any],
        *,
        stream: EventStream,
        subject: str,
        at_ms: float | int,
    ) -> Path:
        """Write the sidecar, then the one end row; return the sidecar path."""
        if not isinstance(document, Mapping):
            raise EndEvidenceError(
                "the end evidence is not a document at", self.document_path
            )
        self._require_document(document)
        self._ensure_directory()
        self._write_document(document)
        self._write_row(document, stream=stream, subject=subject, at_ms=at_ms)
        return self.document_path

    def _require_document(self, document: Mapping[str, Any]) -> None:
        if document.get("type") != "end":
            raise EndEvidenceError(
                'the end evidence must be a "type": "end" document at',
                self.document_path,
            )
        if document.get("callId") != self.call_id:
            raise EndEvidenceError(
                f"the end evidence names callId {document.get('callId')!r}, not "
                f"{self.call_id!r}, at",
                self.document_path,
            )
        for field in END_DOCUMENT_FIELDS:
            if field not in document:
                raise EndEvidenceError(
                    f'the end evidence is missing the "{field}" field at',
                    self.document_path,
                )
        ended_by = document.get("endedBy")
        if not isinstance(ended_by, str) or not ended_by.strip():
            raise EndEvidenceError(
                "the end evidence names no endedBy at", self.document_path
            )

    def _ensure_directory(self) -> None:
        try:
            self._directory.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise EndEvidenceError(
                "cannot create the end evidence directory", self._directory, error
            ) from error

    def _write_document(self, document: Mapping[str, Any]) -> None:
        temporary = self.document_path.with_name(self.document_path.name + ".tmp")
        try:
            temporary.write_text(
                json.dumps(dict(document), indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary, self.document_path)
        except OSError as error:
            try:
                temporary.unlink()
            except OSError:
                pass
            raise EndEvidenceError(
                "cannot write the end evidence document", self.document_path, error
            ) from error

    def _write_row(
        self,
        document: Mapping[str, Any],
        *,
        stream: EventStream,
        subject: str,
        at_ms: float | int,
    ) -> None:
        try:
            existing = (
                self.trace_path.read_text(encoding="utf-8").splitlines()
                if self.trace_path.exists()
                else []
            )
        except OSError as error:
            raise EndEvidenceError(
                "cannot read the trace for the end row", self.trace_path, error
            ) from error
        kept = [
            line
            for line in existing
            if line.strip() and not self._is_end_row(line.strip())
        ]

        captured: list[str] = []
        # The row is built by the same envelope writer and sanitizer as every
        # other line, then written by the one trace rewrite below.
        capture = EventStream(
            stream.writer, sink=captured.append, subject_kind=stream.subject_kind
        )
        cost = document.get("cost")
        cost = cost if isinstance(cost, Mapping) else {}
        budget = document.get("budget")
        turn = budget.get("turn") if isinstance(budget, Mapping) else None
        capture.call_scoped(
            END_EVENT_TYPE,
            subject=subject,
            turn=_require_turn(turn),
            at_ms=at_ms,
            phase="end",
            fields={
                "endedBy": document["endedBy"],
                "turns": document["turns"],
                "costMeasured": bool(cost.get("measured")),
                "totalUsd": cost.get("totalUsd"),
                "endPath": str(self.document_path),
                # The summary is derived from the rows already persisted, so the
                # end document and the ledger cannot quietly disagree. The
                # previous end row (when a hold return resumed this call) is the
                # session boundary, so it is read before that row is replaced.
                "turnSummary": self._turn_summary(existing, document),
            },
        )
        kept.extend(line.rstrip("\n") for line in captured)

        temporary = self.trace_path.with_name(self.trace_path.name + ".tmp")
        try:
            temporary.write_text("\n".join(kept) + "\n", encoding="utf-8")
            os.replace(temporary, self.trace_path)
        except OSError as error:
            try:
                temporary.unlink()
            except OSError:
                pass
            raise EndEvidenceError(
                "cannot write the end row to the trace", self.trace_path, error
            ) from error

    def _turn_summary(
        self, lines: list[str], document: Mapping[str, Any]
    ) -> dict[str, Any]:
        """The end document's turn count against this session's reply starts.

        A turn that produced a reply is one ``turn.reply_start`` row; a duplicate
        or a replayed final adds nothing, so the distinct turn ids are the
        ledger's count. Only rows after the previous ``end`` row are counted: a
        hold return rewrites the end row, and the resumed session's document
        describes the turns it ran, not the ones the trace already recorded.
        ``agrees`` is the check a reader can repeat: a false here is a defect,
        never a footnote.
        """
        current = self._session_lines(lines)
        turn_ids: list[str] = []
        for line in current:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, Mapping) or row.get("callId") != self.call_id:
                continue
            turn = row.get("turn")
            if (
                row.get("type") == TURN_REPLY_START_EVENT_TYPE
                and isinstance(turn, str)
                and turn not in turn_ids
            ):
                turn_ids.append(turn)
        reported = document["turns"]
        return {
            "turns": reported,
            "turnsWithReply": len(turn_ids),
            "turnIds": turn_ids,
            "agrees": isinstance(reported, int)
            and not isinstance(reported, bool)
            and reported == len(turn_ids),
        }

    def _session_lines(self, lines: list[str]) -> list[str]:
        """Rows written since this call's previous ``end`` row, if any."""
        for index in range(len(lines) - 1, -1, -1):
            try:
                row = json.loads(lines[index])
            except ValueError:
                continue
            if (
                isinstance(row, Mapping)
                and row.get("type") == END_EVENT_TYPE
                and row.get("callId") == self.call_id
            ):
                return lines[index + 1 :]
        return lines

    def _is_end_row(self, line: str) -> bool:
        try:
            row = json.loads(line)
        except ValueError:
            return False
        return (
            isinstance(row, Mapping)
            and row.get("type") == END_EVENT_TYPE
            and row.get("callId") == self.call_id
        )
