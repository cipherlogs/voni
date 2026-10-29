"""One durable, versioned breaker record per provider leg.

Shape and field names are the spec record (``spec.md`` M1 "Provider breaker and
routing switch"). The record is the only thing that selects a rung; this module
adds no threshold and no retry. :class:`BreakerTransitions` is the state
machine: closed opens on a trigger, open half-opens when a probe is due or the
record is stale, half-open closes only after three spaced probe successes and
reopens on any probe or real-call failure. It reads the same record through
:class:`Breaker`; it does not change the record shape or the store API.

Read/write contract:

* :meth:`Breaker.read` always asks the durable store. There is no in-process
  cache of the record, so two instances reading one leg cannot disagree.
* A missing record raises :class:`BreakerRecordMissing`; a store outage raises
  :class:`StoreUnavailable` (or, in the durable adapter, returns the last
  durable value it read). No path invents a ``closed`` record.
* :meth:`Breaker.write` is a compare-and-set on ``recordVersion``: the record
  being written must be the version after the one the writer read
  (:meth:`ProviderBreakerRecord.bumped`). The loser gets ``False`` and must
  re-read.

Timestamps are epoch seconds (UTC).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Literal, Mapping

from cascade.failures import FailureVerdict
from cascade.store import DurableStore, StoreUnavailable, StoredDocument

BreakerLeg = Literal["stt", "llm", "tts"]
BreakerState = Literal["closed", "open", "half_open"]
ManualOverride = Literal["none", "fallback"]

LEGS: tuple[BreakerLeg, ...] = ("stt", "llm", "tts")
STATES: tuple[BreakerState, ...] = ("closed", "open", "half_open")
MANUAL_OVERRIDES: tuple[ManualOverride, ...] = ("none", "fallback")

RECORD_VERSION = 1
MAX_PROBE_SUCCESSES = 3
KEY_PREFIX = "breaker"

#: The registry bound that holds the probe interval (ticket 18). One number
#: for both rules the spec states with it: a probe is due one interval after
#: the last probe, and counted successes must be one interval apart.
PROBE_INTERVAL_BOUND = "breaker.probe_interval_ms"

#: Trigger kind for a real call that failed inside the canary window: the
#: first real call after a probe closed the leg is watched (ticket 18).
CANARY_FAILURE_KIND = "canary_failure"

_RECORD_FIELDS = (
    "leg",
    "provider",
    "state",
    "openedAt",
    "lastFailureAt",
    "lastSuccessAt",
    "lastProbeAt",
    "probeSuccesses",
    "manualOverride",
    "trigger",
    "reason",
    "recordVersion",
)
_PROBE_FIELDS = ("at", "latencyMs")
_TRIGGER_FIELDS = ("kind", "code", "phase", "turn")


class BreakerRecordError(ValueError):
    """A breaker record or document does not match version 1."""


class UnsupportedRecordVersion(BreakerRecordError):
    """The stored ``recordVersion`` is not a version this code can read."""


class BreakerRecordMissing(LookupError):
    """No durable record exists for the leg; the caller must seed one."""


class BreakerRecordCorrupt(RuntimeError):
    """The durable row and the document inside it disagree."""


def breaker_key(leg: BreakerLeg) -> str:
    """Store key for one leg; the only way the record is addressed."""
    return f"{KEY_PREFIX}:{_check_leg(leg)}"


def probe_interval_s() -> float:
    """The probe interval in seconds, read from the threshold registry.

    The spec states one interval for two rules (probe due, minimum spacing
    between counted successes), so the registry holds one bound in ms. A
    missing or unset bound raises :class:`UnsetBoundError` naming it; nothing
    defaults the value.
    """
    from cascade.thresholds import require_bound

    return float(require_bound(PROBE_INTERVAL_BOUND)) / 1000.0


def canary_pending(record: ProviderBreakerRecord) -> bool:
    """True while the first real call after a probe close has not succeeded yet.

    Derived from the record alone, so it survives a process restart and needs no
    second state machine: a probe close is the only write that leaves a full
    window of counted probe successes with ``lastSuccessAt == lastProbeAt``. A
    routine probe moves ``lastProbeAt`` past ``lastSuccessAt``, a real-call
    success moves ``lastSuccessAt`` past ``lastProbeAt``, and reopening the leg
    leaves ``closed``, so each of them ends the window.
    """
    return (
        record.state == "closed"
        and record.last_probe_at is not None
        and record.last_success_at == record.last_probe_at
        and len(record.probe_successes) == MAX_PROBE_SUCCESSES
    )


def _check_leg(leg: object) -> BreakerLeg:
    if leg not in LEGS:
        raise BreakerRecordError(f"unknown breaker leg {leg!r}; expected one of {LEGS}")
    return leg  # type: ignore[return-value]


def _check_timestamp(value: object, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BreakerRecordError(f"{field} must be a timestamp or None, got {value!r}")
    if value < 0:
        raise BreakerRecordError(f"{field} must not be negative, got {value!r}")
    return float(value)


def _check_int(value: object, field: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BreakerRecordError(f"{field} must be an int, got {value!r}")
    if value < minimum:
        raise BreakerRecordError(f"{field} must be >= {minimum}, got {value!r}")
    return value


def _reject_unknown(actual: set[str], expected: tuple[str, ...], where: str) -> None:
    unknown = actual - set(expected)
    if unknown:
        raise BreakerRecordError(f"unknown {where} field(s): {', '.join(sorted(unknown))}")
    missing = set(expected) - actual
    if missing:
        raise BreakerRecordError(f"missing {where} field(s): {', '.join(sorted(missing))}")


def _check_number(value: object, field: str, *, minimum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BreakerRecordError(f"{field} must be a number, got {value!r}")
    if value < minimum:
        raise BreakerRecordError(f"{field} must be >= {minimum}, got {value!r}")
    return float(value)


@dataclass(frozen=True)
class ProbeSuccess:
    at: float
    latency_ms: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "at", _check_timestamp(self.at, "probe.at"))
        object.__setattr__(
            self, "latency_ms", _check_number(self.latency_ms, "probe.latencyMs", minimum=0)
        )

    def to_document(self) -> dict[str, Any]:
        return {"at": self.at, "latencyMs": self.latency_ms}

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "ProbeSuccess":
        if not isinstance(document, Mapping):
            raise BreakerRecordError(f"probe success must be a mapping, got {document!r}")
        _reject_unknown(set(document), _PROBE_FIELDS, "probeSuccesses")
        return cls(at=document["at"], latency_ms=document["latencyMs"])


@dataclass(frozen=True)
class BreakerTrigger:
    kind: str
    code: str | int | None = None
    phase: str = ""
    turn: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, str) or not self.kind:
            raise BreakerRecordError(f"trigger.kind must be a non-empty string, got {self.kind!r}")
        if not isinstance(self.phase, str) or not self.phase:
            raise BreakerRecordError(
                f"trigger.phase must be a non-empty string, got {self.phase!r}"
            )
        if self.code is not None and (
            isinstance(self.code, bool) or not isinstance(self.code, (str, int))
        ):
            raise BreakerRecordError(f"trigger.code must be a string, int or None, got {self.code!r}")
        if self.turn is not None:
            _check_int(self.turn, "trigger.turn", minimum=1)

    def to_document(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "code": self.code,
            "phase": self.phase,
            "turn": self.turn,
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "BreakerTrigger":
        if not isinstance(document, Mapping):
            raise BreakerRecordError(f"trigger must be a mapping, got {document!r}")
        _reject_unknown(set(document), _TRIGGER_FIELDS, "trigger")
        return cls(
            kind=document["kind"],
            code=document["code"],
            phase=document["phase"],
            turn=document["turn"],
        )


@dataclass(frozen=True)
class ProviderBreakerRecord:
    """The spec record, version 1. ``record_version`` increments on every write."""

    leg: BreakerLeg
    provider: str
    state: BreakerState = "closed"
    opened_at: float | None = None
    last_failure_at: float | None = None
    last_success_at: float | None = None
    last_probe_at: float | None = None
    probe_successes: tuple[ProbeSuccess, ...] = ()
    manual_override: ManualOverride = "none"
    trigger: BreakerTrigger | None = None
    reason: str = ""
    record_version: int = RECORD_VERSION

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        if not isinstance(self.provider, str) or not self.provider:
            raise BreakerRecordError(f"provider must be a non-empty string, got {self.provider!r}")
        if self.state not in STATES:
            raise BreakerRecordError(f"unknown breaker state {self.state!r}; expected one of {STATES}")
        if self.manual_override not in MANUAL_OVERRIDES:
            raise BreakerRecordError(
                f"unknown manualOverride {self.manual_override!r}; expected one of {MANUAL_OVERRIDES}"
            )
        object.__setattr__(self, "opened_at", _check_timestamp(self.opened_at, "openedAt"))
        object.__setattr__(
            self, "last_failure_at", _check_timestamp(self.last_failure_at, "lastFailureAt")
        )
        object.__setattr__(
            self, "last_success_at", _check_timestamp(self.last_success_at, "lastSuccessAt")
        )
        object.__setattr__(
            self, "last_probe_at", _check_timestamp(self.last_probe_at, "lastProbeAt")
        )
        probes = tuple(self.probe_successes)
        if len(probes) > MAX_PROBE_SUCCESSES:
            raise BreakerRecordError(
                f"probeSuccesses holds at most {MAX_PROBE_SUCCESSES}, got {len(probes)}"
            )
        for probe in probes:
            if not isinstance(probe, ProbeSuccess):
                raise BreakerRecordError(f"probeSuccesses entries must be ProbeSuccess, got {probe!r}")
        object.__setattr__(self, "probe_successes", probes)
        if self.trigger is not None and not isinstance(self.trigger, BreakerTrigger):
            raise BreakerRecordError(f"trigger must be BreakerTrigger or None, got {self.trigger!r}")
        if not isinstance(self.reason, str):
            raise BreakerRecordError(f"reason must be a string, got {self.reason!r}")
        _check_int(self.record_version, "recordVersion", minimum=1)
        if self.state != "closed" and self.opened_at is None:
            raise BreakerRecordError(f"state {self.state!r} requires openedAt")

    def to_document(self) -> dict[str, Any]:
        return {
            "leg": self.leg,
            "provider": self.provider,
            "state": self.state,
            "openedAt": self.opened_at,
            "lastFailureAt": self.last_failure_at,
            "lastSuccessAt": self.last_success_at,
            "lastProbeAt": self.last_probe_at,
            "probeSuccesses": [probe.to_document() for probe in self.probe_successes],
            "manualOverride": self.manual_override,
            "trigger": None if self.trigger is None else self.trigger.to_document(),
            "reason": self.reason,
            "recordVersion": self.record_version,
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "ProviderBreakerRecord":
        if not isinstance(document, Mapping):
            raise BreakerRecordError(f"breaker record must be a mapping, got {document!r}")
        version = document.get("recordVersion")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise UnsupportedRecordVersion(
                f"unsupported recordVersion {version!r}; expected an int >= {RECORD_VERSION}"
            )
        _reject_unknown(set(document), _RECORD_FIELDS, "breaker record")
        probes = document["probeSuccesses"]
        if not isinstance(probes, (list, tuple)):
            raise BreakerRecordError("probeSuccesses must be a list")
        trigger = document["trigger"]
        return cls(
            leg=document["leg"],
            provider=document["provider"],
            state=document["state"],
            opened_at=document["openedAt"],
            last_failure_at=document["lastFailureAt"],
            last_success_at=document["lastSuccessAt"],
            last_probe_at=document["lastProbeAt"],
            probe_successes=tuple(ProbeSuccess.from_document(probe) for probe in probes),
            manual_override=document["manualOverride"],
            trigger=None if trigger is None else BreakerTrigger.from_document(trigger),
            reason=document["reason"],
            record_version=version,
        )

    def bumped(self, **changes: Any) -> "ProviderBreakerRecord":
        """The next version of this record; every write must use this."""
        if "record_version" in changes:
            raise BreakerRecordError("bumped() owns record_version; pass the other fields only")
        return replace(self, record_version=self.record_version + 1, **changes)

    def is_stale(self, now: float, *, probe_interval_s: float) -> bool:
        """True when the last probe is older than twice the injected interval."""
        if self.last_probe_at is None:
            return False
        return now - self.last_probe_at > 2 * probe_interval_s

    def effective_state(self, now: float, *, probe_interval_s: float) -> BreakerState:
        """Read-time state: a stale ``closed`` record is ``half_open``.

        A crashed prober must not leave a leg silently green. Manual override
        and the stored state are reported unchanged; the pin is applied by the
        rung selection (ticket 19), not by this method.
        """
        if self.state == "closed" and self.is_stale(now, probe_interval_s=probe_interval_s):
            return "half_open"
        return self.state


class Breaker:
    """Reads and compare-and-set writes of one record per leg."""

    def __init__(
        self,
        store: DurableStore,
        *,
        probe_interval_s: float,
        now: Callable[[], float] = time.time,
    ) -> None:
        if not isinstance(probe_interval_s, (int, float)) or probe_interval_s <= 0:
            raise ValueError(
                f"probe_interval_s must be a positive number from the threshold registry, "
                f"got {probe_interval_s!r}"
            )
        self.store = store
        self.probe_interval_s = float(probe_interval_s)
        self._now = now

    @classmethod
    def from_registry(
        cls, store: DurableStore, *, now: Callable[[], float] = time.time
    ) -> "Breaker":
        """Build a breaker whose interval is the registry bound, never a literal."""
        return cls(store, probe_interval_s=probe_interval_s(), now=now)

    async def read(self, leg: BreakerLeg) -> ProviderBreakerRecord:
        """Read the durable record for ``leg``; never a synthetic closed one."""
        stored = await self.store.read(breaker_key(leg))
        if stored is None:
            raise BreakerRecordMissing(f"no durable breaker record for leg {leg!r}")
        record = ProviderBreakerRecord.from_document(stored.document)
        if record.leg != leg:
            raise BreakerRecordCorrupt(
                f"breaker record for leg {leg!r} holds leg {record.leg!r}"
            )
        if record.record_version != stored.version:
            raise BreakerRecordCorrupt(
                f"breaker record for leg {leg!r} is version {record.record_version} "
                f"in a row at version {stored.version}"
            )
        return record

    async def write(self, record: ProviderBreakerRecord) -> bool:
        """CAS-write ``record``; ``False`` means another writer got there first."""
        document = record.to_document()
        expected_version = (
            None if record.record_version == RECORD_VERSION else record.record_version - 1
        )
        return await self.store.compare_and_set(
            breaker_key(record.leg),
            expected_version,
            StoredDocument(version=record.record_version, document=document),
        )

    def effective_state(self, record: ProviderBreakerRecord) -> BreakerState:
        return record.effective_state(self._now(), probe_interval_s=self.probe_interval_s)

    def now(self) -> float:
        """The injected clock's current time; transitions never read another."""
        return self._now()


# ---------------------------------------------------------------------------
# Transitions (ticket 17)
# ---------------------------------------------------------------------------

#: The only automation a record may carry. A primary pin is an operator test,
#: not a write this API accepts.
PIN_TARGETS: tuple[str, ...] = ("fallback",)


class ManualOverrideRefused(ValueError):
    """A manual override write is not one an operator is allowed to make."""


@dataclass(frozen=True)
class BreakerTransition:
    """One emitted transition: what moved, why, and in which phase.

    ``trigger.phase`` is the phase the ticket asks every transition to emit
    (``stream``, ``turn``, ``probe``, ``read``, ``manual``). ``actor`` is set
    only for a human write so the caller can persist the audit trail; the
    durable record has no audit field and this type does not add one.
    """

    leg: BreakerLeg
    from_state: BreakerState
    to_state: BreakerState
    trigger: BreakerTrigger
    reason: str
    at: float
    record_version: int
    actor: str = ""

    def __post_init__(self) -> None:
        _check_leg(self.leg)
        for field, state in (("from_state", self.from_state), ("to_state", self.to_state)):
            if state not in STATES:
                raise BreakerRecordError(
                    f"transition {field} {state!r} is not one of {STATES}"
                )
        if not isinstance(self.trigger, BreakerTrigger):
            raise BreakerRecordError(
                f"transition trigger must be BreakerTrigger, got {self.trigger!r}"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise BreakerRecordError(
                f"transition reason must be a non-empty string, got {self.reason!r}"
            )
        object.__setattr__(self, "at", _check_timestamp(self.at, "transition.at"))
        _check_int(self.record_version, "transition.recordVersion", minimum=1)
        if not isinstance(self.actor, str):
            raise BreakerRecordError(f"transition actor must be a string, got {self.actor!r}")

    @property
    def phase(self) -> str:
        """The phase this transition happened in (from its trigger)."""
        return self.trigger.phase

    @property
    def changed_state(self) -> bool:
        return self.from_state != self.to_state


@dataclass(frozen=True)
class TransitionOutcome:
    """What a transition attempt produced, including a failed durable write.

    ``record`` is ``None`` only when the durable read failed; otherwise it is
    the record this attempt wanted to store, even when ``written`` is false, so
    the live call can keep serving from the rung it already chose.
    """

    record: ProviderBreakerRecord | None
    event: BreakerTransition | None
    written: bool
    error: str = ""


def _check_verdict_leg(verdict: FailureVerdict, leg: BreakerLeg) -> FailureVerdict:
    if not isinstance(verdict, FailureVerdict):
        raise TypeError(f"verdict must be a FailureVerdict, got {verdict!r}")
    if verdict.leg != leg:
        raise ValueError(
            f"failure verdict is for leg {verdict.leg!r}, not {leg!r}; "
            "the breaker never demotes across legs"
        )
    return verdict


def _require_audit(actor: object, why: object) -> tuple[str, str]:
    if not isinstance(actor, str) or not actor.strip():
        raise ManualOverrideRefused("a manual override needs a named actor (who)")
    if not isinstance(why, str) or not why.strip():
        raise ManualOverrideRefused("a manual override needs a stated reason (why)")
    return actor.strip(), why.strip()


def _spaced(successes: tuple[ProbeSuccess, ...], interval_s: float) -> bool:
    """True when every consecutive probe success is at least one interval apart."""
    if len(successes) < MAX_PROBE_SUCCESSES:
        return False
    return all(
        later.at - earlier.at >= interval_s
        for earlier, later in zip(successes, successes[1:])
    )


class BreakerTransitions:
    """The breaker state machine over one record, driven by an injected clock.

    Reads (:meth:`read_state`, :meth:`probe_due`) never write. Every write goes
    through :meth:`_apply`, which re-reads on a lost compare-and-set and never
    raises on a store outage: a failed breaker write alerts through
    :attr:`TransitionOutcome.error` and leaves the live call on the rung it
    already selected. A missing record (:class:`BreakerRecordMissing`) still
    propagates: that is a seeding bug, not an outage.

    ``trigger``/``reason`` always describe the last durable write, so a probe
    success says so; :class:`BreakerTransition` is the per-transition event the
    caller emits, and ``actor`` is the human-write audit row ticket 19 stores.
    """

    def __init__(self, breaker: Breaker) -> None:
        if not isinstance(breaker, Breaker):
            raise TypeError(f"BreakerTransitions needs a Breaker, got {breaker!r}")
        self.breaker = breaker
        self.probe_interval_s = breaker.probe_interval_s

    # -- read-time view ----------------------------------------------------

    def read_state(self, record: ProviderBreakerRecord) -> BreakerState:
        """The state a new call must see, before any write.

        A stale ``closed`` record reads ``half_open`` (a crashed prober must
        not leave a leg silently green), and an ``open`` record whose probe is
        due reads ``half_open``.
        """
        now = self.breaker.now()
        state = record.effective_state(now, probe_interval_s=self.probe_interval_s)
        if state == "open" and self._probe_due_at(record, now):
            return "half_open"
        return state

    def probe_due(self, record: ProviderBreakerRecord) -> bool:
        """True when the next probe for this leg may run now."""
        return self._probe_due_at(record, self.breaker.now())

    def _probe_due_at(self, record: ProviderBreakerRecord, now: float) -> bool:
        if record.state == "closed":
            return (
                record.effective_state(now, probe_interval_s=self.probe_interval_s)
                == "half_open"
            )
        # "At least one probe interval after the last probe". A leg opened and
        # never probed counts from openedAt, so a fresh open is not probed in a
        # storm on the same second it tripped.
        reference = record.last_probe_at if record.last_probe_at is not None else record.opened_at
        if reference is None:
            return True
        return now - reference >= self.probe_interval_s

    # -- pure transitions --------------------------------------------------

    def _to_open(
        self,
        record: ProviderBreakerRecord,
        *,
        trigger: BreakerTrigger,
        reason: str,
        now: float,
    ) -> tuple[ProviderBreakerRecord, BreakerTransition]:
        opened = record.bumped(
            state="open",
            opened_at=record.opened_at if record.state == "open" else now,
            last_failure_at=now,
            probe_successes=(),
            trigger=trigger,
            reason=reason,
        )
        return opened, BreakerTransition(
            leg=record.leg,
            from_state=record.state,
            to_state="open",
            trigger=trigger,
            reason=reason,
            at=now,
            record_version=opened.record_version,
        )

    def _to_half_open(
        self, record: ProviderBreakerRecord, *, now: float
    ) -> tuple[ProviderBreakerRecord, BreakerTransition] | None:
        view = self.read_state(record)
        if view != "half_open" or record.state == "half_open":
            return None
        stale = record.state == "closed"
        trigger = BreakerTrigger(
            kind="stale" if stale else "probe_due", phase="read" if stale else "probe"
        )
        reason = (
            "stale: last probe is older than twice the probe interval"
            if stale
            else "probe due: at least one probe interval since the last probe"
        )
        settled = record.bumped(
            state="half_open",
            # A leg that was never opened has no episode start; the unproven
            # window starts now, so the record keeps a truthful non-closed state.
            opened_at=record.opened_at if record.opened_at is not None else now,
            probe_successes=(),
            trigger=trigger,
            reason=reason,
        )
        return settled, BreakerTransition(
            leg=record.leg,
            from_state=record.state,
            to_state="half_open",
            trigger=trigger,
            reason=reason,
            at=now,
            record_version=settled.record_version,
        )

    # -- durable transitions ----------------------------------------------

    async def settle(self, leg: BreakerLeg) -> TransitionOutcome:
        """Write ``half_open`` when an open or stale leg is due for a probe."""

        def transition(record: ProviderBreakerRecord):
            return self._to_half_open(record, now=self.breaker.now()) or (record, None)

        return await self._apply(leg, transition)

    async def record_failure(
        self,
        leg: BreakerLeg,
        *,
        verdict: FailureVerdict,
        phase: str,
        turn: int | None = None,
    ) -> TransitionOutcome:
        """A real-call failure: open on a trigger, or from any non-closed state.

        The closed trigger set stays closed (a deterministic request error is
        our bug and must not hide behind a fallback); a half-open leg reopens on
        any failure because it was never proven healthy.

        A closed leg that a probe just closed is in its canary window: the first
        real call is watched, so a trigger failure there reopens immediately and
        is attributed as :data:`CANARY_FAILURE_KIND` rather than as an ordinary
        failure.
        """
        _check_leg(leg)
        _check_verdict_leg(verdict, leg)

        def transition(record: ProviderBreakerRecord):
            view = self.read_state(record)
            if view == "closed" and not verdict.opens_breaker:
                return record, None
            canary = canary_pending(record)
            trigger = BreakerTrigger(
                kind=CANARY_FAILURE_KIND if canary else "failure",
                code=verdict.code,
                phase=phase,
                turn=turn,
            )
            if canary:
                reason = (
                    f"canary failed ({verdict.code!r}, {view} -> open): {verdict.reason}; "
                    "the first real call after a probe close reopens immediately"
                )
            else:
                reason = f"{view} -> open: {verdict.reason}"
            return self._to_open(record, trigger=trigger, reason=reason, now=self.breaker.now())

        return await self._apply(leg, transition)

    async def record_probe_success(
        self, leg: BreakerLeg, *, latency_ms: float
    ) -> TransitionOutcome:
        """A successful probe: the third spaced success closes the leg."""
        _check_leg(leg)

        def transition(record: ProviderBreakerRecord):
            now = self.breaker.now()
            if record.state == "open" and not self._probe_due_at(record, now):
                return record, None
            probe = ProbeSuccess(at=now, latency_ms=latency_ms)
            view = self.read_state(record)
            if record.state == "closed" and view == "closed":
                successes = (record.probe_successes + (probe,))[-MAX_PROBE_SUCCESSES:]
                trigger = BreakerTrigger(kind="probe_success", phase="probe")
                reason = "routine probe success on a closed leg"
                routine = record.bumped(
                    last_probe_at=now,
                    probe_successes=successes,
                    trigger=trigger,
                    reason=reason,
                )
                return routine, BreakerTransition(
                    leg=record.leg,
                    from_state=record.state,
                    to_state=record.state,
                    trigger=trigger,
                    reason=reason,
                    at=now,
                    record_version=routine.record_version,
                )

            # A probe only counts from the moment the leg became half-open: an
            # old closed leg's routine successes are not the current run.
            run = () if record.state != "half_open" else record.probe_successes
            successes = (run + (probe,))[-MAX_PROBE_SUCCESSES:]
            closes = _spaced(successes, self.probe_interval_s)
            to_state: BreakerState = "closed" if closes else "half_open"
            reason = f"probe success {len(successes)}/{MAX_PROBE_SUCCESSES}"
            if closes:
                reason += ": three spaced successes, closing"
            elif len(successes) > 1 and successes[-1].at - successes[-2].at < self.probe_interval_s:
                reason += f": under one probe interval apart at {now:.3f}, not counted as spaced"
            trigger = BreakerTrigger(kind="probe_success", phase="probe")
            changes: dict[str, Any] = {
                "state": to_state,
                "last_probe_at": now,
                "probe_successes": successes,
                "trigger": trigger,
                "reason": reason,
            }
            if to_state == "closed":
                changes["last_success_at"] = now
            if record.opened_at is None:
                changes["opened_at"] = now
            updated = record.bumped(**changes)
            return updated, BreakerTransition(
                leg=record.leg,
                from_state=record.state,
                to_state=to_state,
                trigger=trigger,
                reason=reason,
                at=now,
                record_version=updated.record_version,
            )

        return await self._apply(leg, transition)

    async def record_probe_failure(
        self, leg: BreakerLeg, *, verdict: FailureVerdict
    ) -> TransitionOutcome:
        """A failed probe reopens a half-open leg; a closed leg needs a trigger."""
        _check_leg(leg)
        _check_verdict_leg(verdict, leg)

        def transition(record: ProviderBreakerRecord):
            now = self.breaker.now()
            if record.state == "open" and not self._probe_due_at(record, now):
                return record, None
            view = self.read_state(record)
            if view == "closed" and not verdict.opens_breaker:
                return record, None
            trigger = BreakerTrigger(kind="probe_failure", code=verdict.code, phase="probe")
            reason = f"probe failed ({view} -> open): {verdict.reason}"
            return self._to_open(record, trigger=trigger, reason=reason, now=now)

        return await self._apply(leg, transition)

    async def record_real_call_success(
        self, leg: BreakerLeg, *, phase: str = "call"
    ) -> TransitionOutcome:
        """Record a watched real call that succeeded; only probes close a leg."""
        _check_leg(leg)

        def transition(record: ProviderBreakerRecord):
            now = self.breaker.now()
            trigger = BreakerTrigger(kind="real_call_success", phase=phase)
            reason = f"real call succeeded in phase {phase!r}; lastSuccessAt recorded"
            updated = record.bumped(
                last_success_at=now, trigger=trigger, reason=reason
            )
            return updated, BreakerTransition(
                leg=record.leg,
                from_state=record.state,
                to_state=record.state,
                trigger=trigger,
                reason=reason,
                at=now,
                record_version=updated.record_version,
            )

        return await self._apply(leg, transition)

    async def pin(
        self,
        leg: BreakerLeg,
        *,
        target: str = "fallback",
        actor: str,
        why: str,
    ) -> TransitionOutcome:
        """Operator write: force the fallback rung until a human clears it.

        No probe, canary or staleness rule calls this, and none of them clears
        it. ``actor``/``why`` travel on the emitted transition so the caller
        can persist the audit trail the record has no field for.
        """
        _check_leg(leg)
        if target not in PIN_TARGETS:
            raise ManualOverrideRefused(
                f"manualOverride {target!r} is refused by name: the only pin "
                f"is {PIN_TARGETS[0]!r}; there is no automated primary pin"
            )
        actor, why = _require_audit(actor, why)

        def transition(record: ProviderBreakerRecord):
            now = self.breaker.now()
            trigger = BreakerTrigger(kind="manual_pin", phase="manual")
            reason = f"pinned to {target} by {actor}: {why}"
            updated = record.bumped(
                manual_override=target, trigger=trigger, reason=reason
            )
            return updated, BreakerTransition(
                leg=record.leg,
                from_state=record.state,
                to_state=record.state,
                trigger=trigger,
                reason=reason,
                at=now,
                record_version=updated.record_version,
                actor=actor,
            )

        return await self._apply(leg, transition)

    async def clear_pin(
        self, leg: BreakerLeg, *, actor: str, why: str
    ) -> TransitionOutcome:
        """Operator write: return a pinned leg to ``none``. Never automated."""
        _check_leg(leg)
        actor, why = _require_audit(actor, why)

        def transition(record: ProviderBreakerRecord):
            if record.manual_override == "none":
                return record, None
            now = self.breaker.now()
            trigger = BreakerTrigger(kind="manual_unpin", phase="manual")
            reason = f"pin cleared by {actor}: {why}"
            updated = record.bumped(
                manual_override="none", trigger=trigger, reason=reason
            )
            return updated, BreakerTransition(
                leg=record.leg,
                from_state=record.state,
                to_state=record.state,
                trigger=trigger,
                reason=reason,
                at=now,
                record_version=updated.record_version,
                actor=actor,
            )

        return await self._apply(leg, transition)

    async def _apply(self, leg: BreakerLeg, transition) -> TransitionOutcome:
        _check_leg(leg)
        error = ""
        updated: ProviderBreakerRecord | None = None
        event: BreakerTransition | None = None
        for _attempt in range(2):
            try:
                record = await self.breaker.read(leg)
            except StoreUnavailable as exc:
                return TransitionOutcome(
                    record=None, event=None, written=False, error=f"read failed: {exc}"
                )
            updated, event = transition(record)
            if event is None:
                return TransitionOutcome(record=updated, event=None, written=False)
            try:
                written = await self.breaker.write(updated)
            except StoreUnavailable as exc:
                return TransitionOutcome(
                    record=updated, event=event, written=False, error=f"write failed: {exc}"
                )
            if written:
                return TransitionOutcome(record=updated, event=event, written=True)
            error = "compare-and-set lost: another writer holds the record"
        return TransitionOutcome(record=updated, event=event, written=False, error=error)
