"""Which rung a leg's durable record selects for a new call.

The spec settles the rule: one record per leg, read before the first frame, and
"the record is the only thing that decides which rung a leg uses; no per-call
heuristic and no in-process cache may override it". This module is that one
read: :func:`choose_rung` is a pure function over a record already read, so a
call carries a frozen choice and a later write never moves it.

Two facts on the record select the rung, and nothing else:

* ``manualOverride: "fallback"`` wins over everything. It is written by a human
  (:mod:`cascade.override_audit`) and only a human write clears it.
* otherwise the read-time state does: ``closed`` uses the primary rung, while
  ``open`` — and a stale ``closed`` record that reads as ``half_open`` — uses
  the fallback rung. A leg that was never proven healthy is not primary.

A ladder with no fallback rung (synthesis has one rung and no second vendor)
selects ``none`` and says so; the caller fails the call visibly, which is the
settled price of "TTS: AssemblyAI only".

The choice always reports the stored ``state`` and ``lastProbeAt`` next to the
rung, so a pinned leg still shows why it is pinned and whether it is healthy.

:func:`read_choices` is the per-call read: one durable read per leg, frozen into
a :class:`RungChoice` the call carries. A record it cannot read raises
:class:`LegUnreadable` (a new call refuses; it never invents a closed leg).
:class:`CallRungs` is the live call's copy: breaker writes during a call are
bookkeeping for future calls, so a failed write alerts and the call keeps
talking on the rung it already chose.

Timestamps are epoch seconds (UTC).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any
from dataclasses import dataclass
from typing import Literal

from cascade.breaker import (
    LEGS,
    Breaker,
    BreakerLeg,
    BreakerRecordCorrupt,
    BreakerRecordMissing,
    BreakerState,
    BreakerTransitions,
    ProviderBreakerRecord,
    TransitionOutcome,
)
from cascade.failures import FailureVerdict
from cascade.store import StoreUnavailable


def _check_leg(leg: object) -> BreakerLeg:
    """Refuse an unknown leg by name, the way the breaker record does."""
    if leg not in LEGS:
        raise LadderError(f"unknown cascade leg {leg!r}; expected one of {LEGS}")
    return leg  # type: ignore[return-value]


#: The rung a record selects. ``none`` means the ladder has nothing to offer and
#: the call must fail visibly rather than open a socket it knows is unhealthy.
Rung = Literal["primary", "fallback", "none"]
RUNGS: tuple[Rung, ...] = ("primary", "fallback", "none")


class LadderError(ValueError):
    """A ladder or a record/ladder pairing the rungs cannot answer."""


@dataclass(frozen=True)
class Ladder:
    """One leg's rungs in order. Both names are the provider ids we record."""

    leg: BreakerLeg
    primary: str
    fallback: str | None

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        for field in ("primary", "fallback"):
            value = getattr(self, field)
            if value is None and field == "fallback":
                continue
            if not isinstance(value, str) or not value.strip():
                raise LadderError(
                    f"ladder {self.leg!r} needs a non-empty {field} provider, got {value!r}"
                )
        if self.fallback is not None and self.fallback == self.primary:
            raise LadderError(
                f"ladder {self.leg!r} names {self.primary!r} as both primary and "
                "fallback; a fallback rung is a different provider"
            )

    def provider(self, rung: Rung) -> str | None:
        """The provider id for ``rung``; ``None`` for ``"none"``."""
        if rung == "primary":
            return self.primary
        if rung == "fallback":
            return self.fallback
        if rung == "none":
            return None
        raise LadderError(f"unknown rung {rung!r}; expected one of {RUNGS}")


@dataclass(frozen=True)
class RungChoice:
    """The frozen rung one new call uses for one leg.

    ``state`` is the stored state, ``effective_state`` the read-time view
    (staleness included), and ``last_probe_at`` the last probe the record
    knows. None of them is hidden by a pin.
    """

    leg: BreakerLeg
    rung: Rung
    provider: str | None
    reason: str
    state: BreakerState
    effective_state: BreakerState
    last_probe_at: float | None
    pinned: bool
    recorded_provider: str

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        if self.rung not in RUNGS:
            raise LadderError(f"unknown rung {self.rung!r}; expected one of {RUNGS}")
        if (self.provider is None) != (self.rung == "none"):
            raise LadderError(
                f"rung {self.rung!r} cannot carry provider {self.provider!r}"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise LadderError(f"a rung choice needs a reason, got {self.reason!r}")
        if self.state not in ("closed", "open", "half_open"):
            raise LadderError(f"unknown breaker state {self.state!r}")
        if self.effective_state not in ("closed", "open", "half_open"):
            raise LadderError(f"unknown effective state {self.effective_state!r}")

    @property
    def fails_visibly(self) -> bool:
        """True when the ladder has no rung left and the call must not open one."""
        return self.rung == "none"

    def to_document(self) -> dict[str, object]:
        return {
            "leg": self.leg,
            "rung": self.rung,
            "provider": self.provider,
            "reason": self.reason,
            "state": self.state,
            "effectiveState": self.effective_state,
            "lastProbeAt": self.last_probe_at,
            "pinned": self.pinned,
            "recordedProvider": self.recorded_provider,
        }


def choose_rung(
    record: ProviderBreakerRecord,
    ladder: Ladder,
    *,
    now: float,
    probe_interval_s: float,
) -> RungChoice:
    """The rung ``record`` selects for ``ladder`` right now.

    Pure: no store, no clock read (``now`` is injected), no cache. Refuses a
    record for another leg rather than answering from the wrong ladder.
    """
    if not isinstance(record, ProviderBreakerRecord):
        raise TypeError(f"choose_rung needs a ProviderBreakerRecord, got {record!r}")
    if not isinstance(ladder, Ladder):
        raise TypeError(f"choose_rung needs a Ladder, got {ladder!r}")
    if record.leg != ladder.leg:
        raise LadderError(
            f"breaker record is for leg {record.leg!r}, not {ladder.leg!r}; "
            "the ladder never answers for another leg"
        )

    effective = record.effective_state(now, probe_interval_s=probe_interval_s)
    common = {
        "leg": ladder.leg,
        "state": record.state,
        "effective_state": effective,
        "last_probe_at": record.last_probe_at,
        "recorded_provider": record.provider,
    }

    if record.manual_override == "fallback":
        rung: Rung = "fallback" if ladder.fallback is not None else "none"
        if rung == "none":
            reason = (
                f"leg is pinned to fallback but the {ladder.leg} ladder has no "
                f"fallback rung ({ladder.primary!r} only): the call fails visibly"
            )
        else:
            reason = (
                f"pinned to fallback for {ladder.leg}: {record.reason}; "
                "only a human write clears the pin"
            )
        return RungChoice(
            rung=rung,
            provider=ladder.provider(rung),
            reason=reason,
            pinned=True,
            **common,
        )

    if effective != "closed":
        rung = "fallback" if ladder.fallback is not None else "none"
        if rung == "none":
            reason = (
                f"{ladder.leg} leg reads {effective} (stored {record.state}, "
                f"{record.reason}) and the ladder has no fallback rung "
                f"({ladder.primary!r} only): the call fails visibly"
            )
        else:
            reason = (
                f"{ladder.leg} leg reads {effective} (stored {record.state}): "
                f"{record.reason}"
            )
        return RungChoice(
            rung=rung, provider=ladder.provider(rung), reason=reason, pinned=False, **common
        )

    return RungChoice(
        rung="primary",
        provider=ladder.primary,
        reason=f"{ladder.leg} leg is closed: primary rung {ladder.primary!r}",
        pinned=False,
        **common,
    )


# ---------------------------------------------------------------------------
# Reading the rungs for one call, and what a live call does when a leg fails
# ---------------------------------------------------------------------------


class LegUnreadable(RuntimeError):
    """The durable record for a leg cannot be read, so no rung can be chosen.

    A new call refuses rather than opening a socket on a guess: the spec's
    answer to a breaker-store outage is "new calls refused/managed". This is
    deliberately not a ``BreakerRecordMissing``/closed fallback — the state is
    unknown, and an unknown state is never healthy.
    """

    def __init__(self, leg: BreakerLeg, reason: str) -> None:
        self.leg = leg
        self.reason = reason
        super().__init__(
            f"the {leg} breaker record is unreadable ({reason}); "
            "a new call cannot select a rung and must not invent a closed leg"
        )


async def read_choices(
    breaker: Breaker, *, ladders: Sequence[Ladder]
) -> dict[BreakerLeg, RungChoice]:
    """Read every leg's record once and freeze the rungs one new call uses.

    Every read goes to the durable store (no in-process cache), so a call
    cannot be moved by a later write and cannot start from a stale rung. A leg
    whose record is missing, corrupt or behind an outage raises
    :class:`LegUnreadable` naming the leg.
    """
    if not isinstance(breaker, Breaker):
        raise TypeError(f"read_choices needs a Breaker, got {breaker!r}")
    choices: dict[BreakerLeg, RungChoice] = {}
    for ladder in ladders:
        if not isinstance(ladder, Ladder):
            raise TypeError(f"read_choices needs Ladders, got {ladder!r}")
        if ladder.leg in choices:
            raise LadderError(
                f"the {ladder.leg!r} leg has two ladders; one leg, one rung order"
            )
        try:
            record = await breaker.read(ladder.leg)
        except (StoreUnavailable, BreakerRecordMissing, BreakerRecordCorrupt) as exc:
            raise LegUnreadable(ladder.leg, str(exc)) from exc
        choices[ladder.leg] = choose_rung(
            record,
            ladder,
            now=breaker.now(),
            probe_interval_s=breaker.probe_interval_s,
        )
    if not choices:
        raise LadderError("a call needs at least one leg to read")
    return choices


@dataclass(frozen=True)
class ProviderAlert:
    """One operational alert a live call raised about its breaker bookkeeping."""

    leg: BreakerLeg
    kind: str
    error: str
    at: float
    rung: Rung

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        if not isinstance(self.kind, str) or not self.kind.strip():
            raise LadderError(f"an alert needs a kind, got {self.kind!r}")
        if not isinstance(self.error, str) or not self.error.strip():
            raise LadderError(f"an alert needs the error it reports, got {self.error!r}")
        if isinstance(self.at, bool) or not isinstance(self.at, (int, float)):
            raise LadderError(f"an alert needs a timestamp, got {self.at!r}")
        if self.rung not in RUNGS:
            raise LadderError(f"unknown rung {self.rung!r}; expected one of {RUNGS}")

    def to_document(self) -> dict[str, object]:
        return {
            "leg": self.leg,
            "kind": self.kind,
            "error": self.error,
            "at": self.at,
            "rung": self.rung,
        }


@dataclass(frozen=True)
class LegOutcome:
    """What recording one leg event did to the record (and to the alerting)."""

    leg: BreakerLeg
    written: bool
    error: str
    alerted: bool
    transition: TransitionOutcome


class CallRungs:
    """The rungs one live call selected, frozen for the life of the call.

    Breaker writes made during the call are bookkeeping for *new* calls: a write
    that fails alerts (``alerts`` plus the optional ``on_alert`` sink) and the
    call keeps talking on the rung it already selected. Nothing here re-selects
    a rung, so a call is never moved, cancelled or restarted by a breaker write.
    """

    def __init__(
        self,
        choices: Mapping[BreakerLeg, RungChoice],
        *,
        transitions: BreakerTransitions,
        on_alert: Callable[[ProviderAlert], None] | None = None,
    ) -> None:
        if not isinstance(transitions, BreakerTransitions):
            raise TypeError(
                f"CallRungs needs BreakerTransitions, got {transitions!r}"
            )
        if not choices:
            raise LadderError("a call needs at least one chosen rung")
        self._choices = dict(choices)
        self._transitions = transitions
        self._on_alert = on_alert
        self._alerts: list[ProviderAlert] = []

    def rung(self, leg: BreakerLeg) -> RungChoice:
        """The rung this call uses for ``leg``; never re-read, never re-selected."""
        try:
            return self._choices[leg]
        except KeyError:
            raise LadderError(
                f"this call never selected a rung for leg {leg!r}; "
                f"it has {sorted(self._choices)}"
            ) from None

    @property
    def choices(self) -> Mapping[BreakerLeg, RungChoice]:
        return dict(self._choices)

    @property
    def alerts(self) -> tuple[ProviderAlert, ...]:
        return tuple(self._alerts)

    async def failed(
        self,
        leg: BreakerLeg,
        *,
        verdict: FailureVerdict,
        phase: str,
        turn: int | None = None,
    ) -> LegOutcome:
        """Record a real-call failure for future calls; this call is unmoved."""
        choice = self.rung(leg)
        outcome = await self._transitions.record_failure(
            leg, verdict=verdict, phase=phase, turn=turn
        )
        return self._settle(leg, choice, outcome)

    async def succeeded(self, leg: BreakerLeg, *, phase: str = "call") -> LegOutcome:
        """Record a watched real-call success; only probes close a leg."""
        choice = self.rung(leg)
        outcome = await self._transitions.record_real_call_success(leg, phase=phase)
        return self._settle(leg, choice, outcome)

    def _settle(
        self, leg: BreakerLeg, choice: RungChoice, outcome: TransitionOutcome
    ) -> LegOutcome:
        alerted = False
        if not outcome.written and outcome.error:
            alert = ProviderAlert(
                leg=leg,
                kind="breaker_write_failed",
                error=outcome.error,
                at=self._transitions.breaker.now(),
                rung=choice.rung,
            )
            self._alerts.append(alert)
            alerted = True
            if self._on_alert is not None:
                self._on_alert(alert)
        return LegOutcome(
            leg=leg,
            written=outcome.written,
            error=outcome.error,
            alerted=alerted,
            transition=outcome,
        )


# ---------------------------------------------------------------------------
# The speech ladder (ticket 22)
# ---------------------------------------------------------------------------

#: Speech rungs in order: Meta, then AssemblyAI, then the call fails visibly.
STT_LADDER = Ladder(leg="stt", primary="meta", fallback="assemblyai")


class LegFailed(RuntimeError):
    """No rung of a leg can serve this call; it fails visibly, by name."""

    def __init__(self, leg: BreakerLeg, reason: str) -> None:
        self.leg = leg
        self.reason = reason
        super().__init__(f"the {leg} leg has no serving rung: {reason}")


@dataclass(frozen=True)
class ProviderAttribution:
    """Which provider actually served one leg of one call, and why.

    This is the value turn attribution reads: it names the leg, the rung and
    the provider that was used, never the provider we hoped for.
    """

    leg: BreakerLeg
    provider: str
    rung: Rung
    reason: str

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise LadderError(f"attribution needs a provider, got {self.provider!r}")
        if self.rung not in ("primary", "fallback"):
            raise LadderError(
                f"attribution names a rung that served, not {self.rung!r}"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise LadderError("attribution needs the reason the rung was chosen")

    def to_document(self) -> dict[str, object]:
        return {
            "leg": self.leg,
            "provider": self.provider,
            "rung": self.rung,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class SpeechSession:
    """The speech rung this call will use, plus its attribution."""

    stt: Any
    attribution: ProviderAttribution
    choice: RungChoice


#: A speech factory builds an unopened ``StreamingSTT``; ``open()`` is the
#: caller's, because the language bundle and sample rate belong to the call.
SpeechFactory = Callable[[], Any]


def _factory_for(
    leg: BreakerLeg, provider: str, factories: Mapping[str, Callable[[], Any]]
) -> Callable[[], Any]:
    factory = factories.get(provider)
    if factory is None:
        raise LegFailed(
            leg,
            f"no factory is registered for provider {provider!r} "
            f"(registered: {sorted(factories)})",
        )
    return factory


def _build(
    leg: BreakerLeg, choice: RungChoice, factories: Mapping[str, Callable[[], Any]]
) -> tuple[Any, str]:
    """Build the one rung ``choice`` names; ``None``/a raise fails the call."""
    if choice.fails_visibly or choice.provider is None:
        raise LegFailed(leg, choice.reason)
    provider = choice.provider
    factory = _factory_for(leg, provider, factories)
    try:
        return factory(), provider
    except Exception as error:  # noqa: BLE001 - a failed rung is a visible refusal
        raise LegFailed(
            leg,
            f"provider {provider!r} could not be built: "
            f"{type(error).__name__}: {error}",
        ) from error


async def _open_leg(
    breaker: Breaker, ladder: Ladder, factories: Mapping[str, Callable[[], Any]]
) -> tuple[Any, ProviderAttribution, RungChoice]:
    """One durable read, one factory call for the rung the record selected.

    The rung that loses is never built, so an open primary leg costs zero
    primary requests, and a chosen rung that cannot be built fails the call
    instead of silently trying the other provider.
    """
    choices = await read_choices(breaker, ladders=(ladder,))
    choice = choices[ladder.leg]
    instance, provider = _build(ladder.leg, choice, factories)
    attribution = ProviderAttribution(
        leg=ladder.leg,
        provider=provider,
        rung="primary" if choice.rung == "primary" else "fallback",
        reason=choice.reason,
    )
    return instance, attribution, choice


async def open_speech(
    breaker: Breaker, *, factories: Mapping[str, SpeechFactory]
) -> SpeechSession:
    """Read the speech record, select its rung and build that rung's session."""
    stt, attribution, choice = await _open_leg(breaker, STT_LADDER, factories)
    return SpeechSession(stt=stt, attribution=attribution, choice=choice)


# ---------------------------------------------------------------------------
# The model ladder (ticket 23)
# ---------------------------------------------------------------------------

#: Model rungs in order: Standard Spark, then the AI gateway, then the call
#: fails visibly. The gateway rung is never a mid-reply handover.
LLM_LADDER = Ladder(leg="llm", primary="spark", fallback="gateway")


@dataclass(frozen=True)
class ModelSession:
    """The model rung this call will use, plus its attribution."""

    llm: Any
    attribution: ProviderAttribution
    choice: RungChoice


#: A model factory builds an ``LLMStream``; ``complete()`` is the caller's.
ModelFactory = Callable[[], Any]


async def open_model(
    breaker: Breaker, *, factories: Mapping[str, ModelFactory]
) -> ModelSession:
    """Read the model record, select its rung and build that rung's stream."""
    llm, attribution, choice = await _open_leg(breaker, LLM_LADDER, factories)
    return ModelSession(llm=llm, attribution=attribution, choice=choice)
