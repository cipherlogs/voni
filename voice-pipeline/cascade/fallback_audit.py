"""Every fallback a call's frozen rungs select is emitted (ticket 146).

The rung read (``cascade.ladders.read_choices``) happens before the first
frame, so a leg the durable records put on the fallback rung is a *connect-time*
fallback: it pre-selected the fallback provider before the call measured
anything. Ticket 109 owns the one fallback emission site
(:func:`cascade.events.emit_fallback`); this module is its only connect caller.
It turns the frozen choices into connect events and then audits the stream a
run carries against the choices that run made, so a fallback rung with no event
is refused by name instead of being read as a clean run.

A routing or eligibility refusal is a different fact: it routes the call
managed and never freezes a fallback rung, so there is nothing here to emit or
audit for one. :class:`cascade.events.Fallback` already refuses those triggers
by name.

Nothing here builds a line itself. It composes ``emit_fallback`` and reads the
finished events, so there is exactly one place that writes the event type.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from cascade.breaker import LEGS
from cascade.events import (
    FALLBACK_EVENT_TYPE,
    EventSink,
    EventWriter,
    connect_fallback,
    emit_fallback,
)
from cascade.ladders import Ladder, RungChoice


class FallbackAuditError(RuntimeError):
    """A run's rungs and its event stream disagree about a fallback."""


class MissingFallbackEvent(FallbackAuditError):
    """A leg used the fallback rung, but the run carries no fallback event."""

    def __init__(self, leg: str, phase: str) -> None:
        self.leg = leg
        self.phase = phase
        super().__init__(
            f"the {leg} leg used the fallback rung at {phase}, but the run "
            f"carries no {FALLBACK_EVENT_TYPE} event; a fallback-contaminated "
            "run cannot be read as clean"
        )


def _trigger(choice: RungChoice) -> str:
    """Which provider fault put this leg on the fallback rung at connect."""
    if choice.pinned:
        return "manual_pin"
    if choice.effective_state == "half_open":
        # The stored record is stale and a probe has not closed the leg again;
        # it is not proven healthy, so the fallback rung is the probe's verdict.
        return "probe_failed"
    return "breaker_open"


def _checked(choices: Mapping[str, RungChoice]) -> dict[str, RungChoice]:
    if not isinstance(choices, Mapping):
        raise FallbackAuditError(
            f"connect fallbacks need a mapping of rung choices, got {type(choices).__name__}"
        )
    ordered: dict[str, RungChoice] = {}
    for leg in LEGS:
        if leg not in choices:
            continue
        choice = choices[leg]
        if not isinstance(choice, RungChoice):
            raise FallbackAuditError(
                f"the {leg} choice is not a RungChoice, got {choice!r}"
            )
        if choice.leg != leg:
            raise FallbackAuditError(
                f"the {leg} slot carries the {choice.leg} leg; the rung read never moves"
            )
        ordered[leg] = choice
    return ordered


def emit_connect_fallbacks(
    writer: EventWriter,
    choices: Mapping[str, RungChoice],
    ladders: Mapping[str, Ladder],
    *,
    subject: str,
    at_ms: float | int,
    sink: EventSink,
) -> tuple[dict[str, Any], ...]:
    """Emit one connect-time fallback for every leg the records put on it.

    ``choices`` is the call's frozen rung read; ``ladders`` supplies the
    primary rung each fallback moved away from. A primary or exhausted
    (``"none"``) leg emits nothing. The returned tuple is exactly what reached
    ``sink``, so a caller cannot believe an event the stream never saw.
    """
    ordered = _checked(choices)
    emitted: list[dict[str, Any]] = []
    for leg, choice in ordered.items():
        if choice.rung != "fallback":
            continue
        ladder = ladders.get(leg)
        if not isinstance(ladder, Ladder):
            raise FallbackAuditError(
                f"the {leg} leg has no ladder; its primary rung cannot be named"
            )
        if ladder.fallback is None or choice.provider != ladder.fallback:
            raise FallbackAuditError(
                f"the {leg} rung chose {choice.provider!r}, but the ladder's "
                f"fallback rung is {ladder.fallback!r}; refusing to name a provider "
                "the ladder does not have"
            )
        fallback = connect_fallback(
            leg,
            primary=ladder.primary,
            selected=choice.provider,
            trigger=_trigger(choice),
            reason=choice.reason,
        )
        emitted.append(
            emit_fallback(
                writer, fallback, subject=subject, at_ms=at_ms, sink=sink
            )
        )
    return tuple(emitted)


def assert_fallbacks_emitted(
    choices: Mapping[str, RungChoice],
    events: Iterable[Mapping[str, Any]],
    *,
    phase: str = "connect",
) -> None:
    """Refuse a run whose fallback rung carries no event in ``phase``.

    Only a frozen fallback choice requires an event; a routing refusal never
    chooses one. A mid-turn fallback is audited against its own phase, so it
    cannot stand in for the connect emission a fallback rung owes.
    """
    ordered = _checked(choices)
    emitted = {
        (event.get("leg"), event.get("phase"))
        for event in events
        if event.get("type") == FALLBACK_EVENT_TYPE
    }
    for leg, choice in ordered.items():
        if choice.rung != "fallback":
            continue
        if (leg, phase) not in emitted:
            raise MissingFallbackEvent(leg, phase)
