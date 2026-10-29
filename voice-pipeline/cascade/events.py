"""One call-event envelope for both engines (meta-cascade M12, ticket 107).

Every call-scoped event the voice service emits carries ``schemaVersion``,
``pipeline``, ``callId``, ``type``, ``subject``, ``turn`` (a logical id or
``None``), ``atMs`` and ``phase``. An operational event carries ``leg`` in
place of ``subject``/``turn``. The managed engine and the cascade engine use the
same envelope; only the ``pipeline`` value differs.

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
from typing import Any, Mapping

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

#: Names owned by the envelope; a payload may never overwrite one.
_RESERVED_FIELDS = frozenset(CALL_SCOPED_FIELDS) | frozenset(OPERATIONAL_FIELDS)


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

    def _payload(self, fields: Mapping[str, Any] | None) -> dict[str, Any]:
        payload = dict(fields or {})
        for key in payload:
            if key in _RESERVED_FIELDS:
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
        event.update(self._payload(fields))
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
        event.update(self._payload(fields))
        return event
