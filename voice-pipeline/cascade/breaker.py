"""One durable, versioned breaker record per provider leg.

Shape and field names are the spec record (``spec.md`` M1 "Provider breaker and
routing switch"). The record is the only thing that selects a rung; this module
adds no threshold, no retry and no state machine. Transition rules (probe due,
hysteresis, canary) live in ticket 17 and read the same record through
:class:`Breaker`.

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

from cascade.store import DurableStore, StoredDocument

BreakerLeg = Literal["stt", "llm", "tts"]
BreakerState = Literal["closed", "open", "half_open"]
ManualOverride = Literal["none", "fallback"]

LEGS: tuple[BreakerLeg, ...] = ("stt", "llm", "tts")
STATES: tuple[BreakerState, ...] = ("closed", "open", "half_open")
MANUAL_OVERRIDES: tuple[ManualOverride, ...] = ("none", "fallback")

RECORD_VERSION = 1
MAX_PROBE_SUCCESSES = 3
KEY_PREFIX = "breaker"

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
