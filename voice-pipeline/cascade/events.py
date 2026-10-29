"""One call-event envelope for both engines (meta-cascade M12, ticket 107).

Every call-scoped event the voice service emits carries ``schemaVersion``,
``pipeline``, ``callId``, ``type``, ``subject``, ``turn`` (a logical id or
``None``), ``atMs`` and ``phase``. An operational event carries ``leg`` in
place of ``subject``/``turn``. The managed engine and the cascade engine use the
same envelope; only the ``pipeline`` value differs.

A provider fallback is a call-scoped event (``provider_fallback``) with
``leg``, ``from``, ``to`` and ``trigger`` in its payload, plus the optional
``reason``. It is emitted at connect (``phase="connect"``, ``turn=None``) and
mid-turn alike, through :func:`emit_fallback` and the one
:class:`EventWriter`; a routing or eligibility refusal is a different fact and
never emits it.

This module is a builder, not a second writer and not a second sanitizer:

* The persisted stream is written by the one TS writer
  (``voni/src/lib/demo/event-envelope.ts``), which calls the one sanitizer
  (``event-sanitizer.ts``, ticket 07). Re-implementing the forbidden-key list
  here would be exactly the second denylist that ticket bans, so a Python event
  crosses the wire and is sanitized once, at that boundary.
* The same TS module is the one reader. It refuses an unknown schema version, a
  missing required field, a managed event carrying a cascade-only type and a
  cascade event carrying a managed-only field, always by name.

The canonical shapes are pinned by ``event-envelope.fixtures.json`` and both
sides' tests read it, so a drift between this writer and the reader fails rather
than quietly producing a second schema.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from cascade.breaker import LEGS

#: The one schema version. A reader must refuse anything else.
EVENT_SCHEMA_VERSION = 1

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

#: Every field an operational event carries: ``leg`` replaces subject and turn.
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
OPERATIONAL_EVENT_TYPES = ("breaker.transition",)

#: Names owned by the envelope. A call-scoped event owns subject/turn, an
#: operational event owns leg; ``leg`` is a legitimate payload field on a
#: call-scoped event (``provider_fallback`` names the leg it moved), so each
#: shape reserves only its own names.
_CALL_SCOPED_RESERVED = frozenset(CALL_SCOPED_FIELDS)
_OPERATIONAL_RESERVED = frozenset(OPERATIONAL_FIELDS)


class EventEnvelopeError(ValueError):
    """One refused event, named by the field and the value that failed."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


def _require_text(field: str, value: Any) -> str:
    if value is None:
        raise EventEnvelopeError(field, f'missing required field "{field}"')
    if not isinstance(value, str) or not value.strip():
        raise EventEnvelopeError(field, f'"{field}" must be a non-empty string, got {value!r}')
    return value


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
        fields: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One operational event: the leg, in place of subject and turn."""
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
            "leg": _require_text("leg", leg),
            "atMs": _require_at_ms(at_ms),
            "phase": _require_phase(phase),
        }
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
