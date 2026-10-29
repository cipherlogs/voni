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
Timestamps are epoch seconds (UTC).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cascade.breaker import LEGS, BreakerLeg, BreakerState, ProviderBreakerRecord


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
