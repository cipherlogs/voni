"""One failure reconnect per leg, and planned reconnects counted separately.

The spec's recovery rule is bounded (`.scratch/meta-cascade/spec.md`,
"Reconnect, sequence dedupe, partial reply"): each of the three call-level legs
— speech, model, voice — may fail over to a new session once per call, and a
second failure on that leg ends the call cleanly. A planned reconnect is not a
failure: the speech session's 60-minute limit, the voice session's
``expires_at``/``3008`` expiry and our own deliberate session rotation are
operational facts. They are counted in their own bucket, never spend the
failure budget and never open the breaker.

:class:`ReconnectBudget` is that one ledger. It decides only: it returns a
:class:`ReconnectDecision` and appends a :class:`ReconnectEvent`; it opens no
socket, replays no audio, drains nothing and sends no end message (tickets
95-99 own those mechanics). The per-leg counters are the end-message value
(:meth:`ReconnectBudget.to_document`), and a reconnect also writes the shared
ledger's ``reconnect`` mark so the call's timing ledger shows it.

The model leg has one extra rule. A failure after the completion already
handed text to synthesis may not restart the completion — the caller would
hear the same sentence twice. Such a failure drains what is queued and closes
the turn at the last complete sentence (ticket 96); this module reports
``DRAIN`` and never ``RECONNECT`` for it. It still counts as a failure on the
leg, so a later failure on that leg ends the call, exactly as a second failure
does everywhere else.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any

from cascade.failures import (
    SESSION_LIMIT,
    Code,
    FailureClass,
    FailureVerdict,
    classify,
)
from metrics import TimingLedger

#: The three call-level legs, in the call table's order.
LEGS: tuple[str, ...] = ("stt", "llm", "tts")

#: The spec's settled recovery policy: one failure reconnect per leg per call.
#: This is not an operational bound (nothing tunes it), so it is not a
#: threshold entry; a second failure must end the call.
RECONNECTS_PER_LEG = 1

#: A session rotation we chose (a deploy, a proactive lifetime rotation) has no
#: wire code. It is planned, so this sentinel never reaches a close-code table.
DELIBERATE = "deliberate"


class ReconnectAction(str, Enum):
    """What the call does after one leg event."""

    RECONNECT = "reconnect"
    PLANNED_RECONNECT = "planned_reconnect"
    DRAIN = "drain"
    FAIL = "fail"
    END = "end"


@dataclass(frozen=True)
class LegReconnects:
    """One leg's budget counters, as the end message reports them."""

    leg: str
    failures: int
    failure_reconnects: int
    planned_reconnects: int
    budget_left: int

    def to_document(self) -> dict[str, Any]:
        return {
            "failures": self.failures,
            "failureReconnects": self.failure_reconnects,
            "plannedReconnects": self.planned_reconnects,
            "budgetLeft": self.budget_left,
        }


class ReconnectError(ValueError):
    """A leg event the budget refuses to answer, named rather than guessed."""


class ReconnectBudget:
    """The call's reconnect budget, per leg."""

    def __init__(
        self,
        *,
        ledger: TimingLedger | None = None,
        now: Callable[[], float] | None = None,
        legs: Sequence[str] = LEGS,
    ) -> None:
        self._clock = now if now is not None else time.monotonic
        self._ledger = ledger
        self._legs = _check_legs(legs)
        # ``failures`` is every classified failure the leg saw; the budget is
        # spent only by the retryable (trigger) ones, so a bug fails visibly
        # without silently disarming the leg's one reconnect.
        self._failures = {leg: 0 for leg in self._legs}
        self._trigger_failures = {leg: 0 for leg in self._legs}
        self._failure_reconnects = {leg: 0 for leg in self._legs}
        self._planned_reconnects = {leg: 0 for leg in self._legs}
        self._events: list[ReconnectEvent] = []

    def failed(
        self,
        verdict: FailureVerdict,
        *,
        mid_reply: bool = False,
        immediate: bool = True,
    ) -> ReconnectDecision:
        """Decide what one classified leg failure may do.

        ``mid_reply`` means the completion already handed text to synthesis.
        Only the model leg reacts to it: a restart there would say the same
        sentence twice, so the caller drains instead (ticket 96). Every
        failure still counts against its leg, so a second one ends the call.

        ``immediate=False`` is a retryable failure the adapter may not recover
        from on the spot — speech ``1013`` rate limiting, where an immediate
        reconnect would be a retry storm (spec "Trigger set is closed"). The
        failure still spends the leg's one reconnect, so no later failure can
        claim it, but no reconnect is reported because none happened.
        """
        if not isinstance(verdict, FailureVerdict):
            raise ReconnectError(
                f"the reconnect budget needs a FailureVerdict, got {verdict!r}"
            )
        leg = _check_leg(verdict.leg, self._legs)
        if verdict.failure_class is FailureClass.PLANNED_RECONNECT:
            return self._planned(verdict)
        if verdict.failure_class is not FailureClass.TRIGGER:
            # A deterministic bug or an unclassified code: no reconnect and no
            # budget spent. The leg fails visibly; the caller decides whether
            # that ends the call or only the turn.
            self._failures[leg] += 1
            return self._decide(
                leg=leg,
                action=ReconnectAction.FAIL,
                verdict=verdict,
                planned=False,
                reason=(
                    f"{verdict.reason}; the {leg} leg is not reconnected for a "
                    "non-retryable failure"
                ),
            )
        previous = self._trigger_failures[leg]
        self._failures[leg] += 1
        self._trigger_failures[leg] += 1
        if previous >= RECONNECTS_PER_LEG:
            return self._decide(
                leg=leg,
                action=ReconnectAction.END,
                verdict=verdict,
                planned=False,
                reason=(
                    f"the {leg} leg already spent its one failure reconnect; "
                    "a second failure ends the call"
                ),
            )
        if mid_reply and leg == "llm":
            return self._decide(
                leg=leg,
                action=ReconnectAction.DRAIN,
                verdict=verdict,
                planned=False,
                reason=(
                    f"{verdict.reason}; the reply is already being spoken, so "
                    "the completion is not restarted (a restart would repeat "
                    "speech); drain to the last complete sentence"
                ),
            )
        if not immediate:
            return self._decide(
                leg=leg,
                action=ReconnectAction.FAIL,
                verdict=verdict,
                planned=False,
                reason=(
                    f"{verdict.reason}; no immediate retry is allowed, so the "
                    "call fails now and the leg's one reconnect is spent"
                ),
            )
        self._failure_reconnects[leg] += 1
        return self._decide(
            leg=leg,
            action=ReconnectAction.RECONNECT,
            verdict=verdict,
            planned=False,
            reason=f"{verdict.reason}; reconnecting the {leg} leg once",
        )

    def planned(
        self,
        leg: str,
        *,
        code: Code = SESSION_LIMIT,
        reason: str | None = None,
    ) -> ReconnectDecision:
        """Record a planned reconnect: a session limit or our own rotation.

        A wire code that classifies as a failure is refused by name, so a
        caller cannot spend the failure budget under the planned label.
        """
        leg = _check_leg(leg, self._legs)
        if code == DELIBERATE:
            verdict = FailureVerdict(
                leg=leg,
                code=DELIBERATE,
                failure_class=FailureClass.PLANNED_RECONNECT,
                reason=reason or "deliberate session rotation",
            )
        else:
            verdict = classify(leg, code)
            if verdict.failure_class is not FailureClass.PLANNED_RECONNECT:
                raise ReconnectError(
                    f"{leg} code {code!r} classifies as "
                    f"{verdict.failure_class.value}, not a planned reconnect; "
                    "a failure must go through failed()"
                )
            if reason is not None:
                verdict = FailureVerdict(
                    leg=leg,
                    code=verdict.code,
                    failure_class=verdict.failure_class,
                    reason=reason,
                )
        return self._planned(verdict)

    def counters(self, leg: str) -> LegReconnects:
        """One leg's counters; a leg the call never touched reads zero."""
        leg = _check_leg(leg, self._legs)
        return LegReconnects(
            leg=leg,
            failures=self._failures[leg],
            failure_reconnects=self._failure_reconnects[leg],
            planned_reconnects=self._planned_reconnects[leg],
            budget_left=max(
                0, RECONNECTS_PER_LEG - self._trigger_failures[leg]
            ),
        )

    def _planned(self, verdict: FailureVerdict) -> ReconnectDecision:
        """Count one planned reconnect without touching the failure budget."""
        leg = _check_leg(verdict.leg, self._legs)
        self._planned_reconnects[leg] += 1
        return self._decide(
            leg=leg,
            action=ReconnectAction.PLANNED_RECONNECT,
            verdict=verdict,
            planned=True,
            reason=(
                f"{verdict.reason}; planned reconnect for the {leg} leg, "
                "no failure budget spent"
            ),
        )

    @property
    def counters_by_leg(self) -> Mapping[str, LegReconnects]:
        return {leg: self.counters(leg) for leg in self._legs}

    @property
    def events(self) -> tuple[ReconnectEvent, ...]:
        return tuple(self._events)

    def to_document(self) -> dict[str, Any]:
        """The budget as the call's end message reports it.

        ``legs`` names every call-level leg, including one the call never
        touched, so a missing reconnect count is a zero and never a guess.
        ``events`` is the first-class reconnect record (leg, reason,
        planned/failure) the spec asks for.
        """
        return {
            "budgetPerLeg": RECONNECTS_PER_LEG,
            "legs": {
                leg: self.counters(leg).to_document() for leg in self._legs
            },
            "events": [event.to_document() for event in self._events],
        }

    def _decide(
        self,
        *,
        leg: str,
        action: ReconnectAction,
        verdict: FailureVerdict,
        planned: bool,
        reason: str,
    ) -> ReconnectDecision:
        decision = ReconnectDecision(
            leg=leg,
            action=action,
            verdict=verdict,
            planned=planned,
            opens_breaker=verdict.opens_breaker and not planned,
            budget_left=max(
                0, RECONNECTS_PER_LEG - self._trigger_failures[leg]
            ),
            reason=reason,
        )
        event = ReconnectEvent(
            leg=leg,
            at=float(self._clock()),
            action=action,
            code=verdict.code,
            failure_class=verdict.failure_class.value,
            planned=planned,
            reason=reason,
        )
        self._events.append(event)
        if (
            action
            in (ReconnectAction.RECONNECT, ReconnectAction.PLANNED_RECONNECT)
            and self._ledger is not None
        ):
            self._ledger.mark("reconnect")
        return decision


@dataclass(frozen=True)
class ReconnectDecision:
    """One budget answer, with the facts the caller needs to act and report."""

    leg: str
    action: ReconnectAction
    verdict: FailureVerdict
    planned: bool
    opens_breaker: bool
    budget_left: int
    reason: str


@dataclass(frozen=True)
class ReconnectEvent:
    """One first-class reconnect event: leg, reason, planned or failure."""

    leg: str
    at: float
    action: ReconnectAction
    code: Code
    failure_class: str
    planned: bool
    reason: str

    def to_document(self) -> dict[str, Any]:
        return {
            "leg": self.leg,
            "at": self.at,
            "action": self.action.value,
            "code": self.code,
            "failureClass": self.failure_class,
            "planned": self.planned,
            "reason": self.reason,
        }


def _check_legs(legs: Sequence[str]) -> tuple[str, ...]:
    chosen = tuple(legs)
    if not chosen:
        raise ReconnectError("a reconnect budget needs at least one leg")
    for leg in chosen:
        _check_leg(leg, chosen)
    if len(set(chosen)) != len(chosen):
        raise ReconnectError(f"a reconnect budget cannot name a leg twice: {chosen}")
    return chosen


def _check_leg(leg: object, legs: Sequence[str]) -> str:
    if leg not in legs:
        raise ReconnectError(
            f"unknown cascade leg {leg!r}; expected one of {tuple(legs)}"
        )
    return str(leg)
