"""The durable who/when/why trail behind a manual fallback pin (ticket 19).

The breaker record has no audit field (its shape is the spec's), so the trail
lives beside it under its own key, per leg, append-only, compare-and-set
written. One entry per human write: who did it, when, why, and the pin it moved
from and to. The chain is validated on read, the same way the routing switch
validates its changes, so an edited row is visible instead of silently
believed.

:meth:`OverrideAudit.pin` and :meth:`OverrideAudit.clear` are the only writers.
They write the record first and append the entry only when that write landed:
an entry for a pin that never persisted would be a lie, and a pin with no entry
is reported (``audited=False``) rather than hidden. No probe, canary or
staleness rule calls either one.

Timestamps are epoch seconds (UTC).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from cascade.breaker import (
    LEGS,
    BreakerLeg,
    BreakerTransitions,
    ManualOverride,
    ManualOverrideRefused,
    PIN_TARGETS,
    TransitionOutcome,
)
from cascade.store import DurableStore, StoreUnavailable, StoredDocument

KEY_PREFIX = "breaker_override"
RECORD_VERSION = 1

_ENTRY_FIELDS = ("leg", "at", "actor", "from", "to", "why")
_RECORD_FIELDS = ("leg", "recordVersion", "entries")


class OverrideAuditError(ValueError):
    """An audit entry or document does not match version 1."""


class UnsupportedAuditVersion(OverrideAuditError):
    """The stored ``recordVersion`` is not a version this code can read."""


class OverrideAuditCorrupt(RuntimeError):
    """The durable row and the document inside it disagree."""


class OverrideAuditConflict(RuntimeError):
    """Another writer appended first; re-read and retry."""


def override_key(leg: BreakerLeg) -> str:
    """Store key for one leg's override trail."""
    if leg not in LEGS:
        raise OverrideAuditError(f"unknown cascade leg {leg!r}; expected one of {LEGS}")
    return f"{KEY_PREFIX}:{leg}"


def _check_leg(leg: object) -> BreakerLeg:
    if leg not in LEGS:
        raise OverrideAuditError(f"unknown cascade leg {leg!r}; expected one of {LEGS}")
    return leg  # type: ignore[return-value]


def _check_override(value: object, field: str) -> ManualOverride:
    if value not in ("none", "fallback"):
        raise OverrideAuditError(
            f"{field} must be 'none' or 'fallback', got {value!r}"
        )
    return value  # type: ignore[return-value]


def _check_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise OverrideAuditError(f"an override entry needs a non-empty {field}")
    return value.strip()


def _reject_unknown(actual: set[str], expected: tuple[str, ...], where: str) -> None:
    unknown = actual - set(expected)
    if unknown:
        raise OverrideAuditError(f"unknown {where} field(s): {', '.join(sorted(unknown))}")
    missing = set(expected) - actual
    if missing:
        raise OverrideAuditError(f"missing {where} field(s): {', '.join(sorted(missing))}")


@dataclass(frozen=True)
class OverrideEntry:
    """One human override write: who, when, why and which way it moved."""

    leg: BreakerLeg
    at: float
    actor: str
    from_override: ManualOverride
    to_override: ManualOverride
    why: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "leg", _check_leg(self.leg))
        if isinstance(self.at, bool) or not isinstance(self.at, (int, float)):
            raise OverrideAuditError(f"entry.at must be epoch seconds, got {self.at!r}")
        if self.at < 0:
            raise OverrideAuditError(f"entry.at must not be negative, got {self.at!r}")
        object.__setattr__(self, "at", float(self.at))
        object.__setattr__(self, "actor", _check_text(self.actor, "actor"))
        object.__setattr__(
            self, "from_override", _check_override(self.from_override, "from")
        )
        object.__setattr__(self, "to_override", _check_override(self.to_override, "to"))
        object.__setattr__(self, "why", _check_text(self.why, "why"))
        if self.from_override == self.to_override:
            raise OverrideAuditError(
                f"an override entry must change the pin, got {self.to_override!r} twice"
            )

    def to_document(self) -> dict[str, Any]:
        return {
            "leg": self.leg,
            "at": self.at,
            "actor": self.actor,
            "from": self.from_override,
            "to": self.to_override,
            "why": self.why,
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "OverrideEntry":
        if not isinstance(document, Mapping):
            raise OverrideAuditError(f"override entry must be a mapping, got {document!r}")
        _reject_unknown(set(document), _ENTRY_FIELDS, "override entry")
        return cls(
            leg=document["leg"],
            at=document["at"],
            actor=document["actor"],
            from_override=document["from"],
            to_override=document["to"],
            why=document["why"],
        )


@dataclass(frozen=True)
class OverrideTrail:
    """One leg's override entries, in the order a human wrote them."""

    leg: BreakerLeg
    entries: tuple[OverrideEntry, ...] = ()
    record_version: int = RECORD_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(self, "leg", _check_leg(self.leg))
        entries = tuple(self.entries)
        if isinstance(self.record_version, bool) or not isinstance(self.record_version, int):
            raise OverrideAuditError(
                f"recordVersion must be an int, got {self.record_version!r}"
            )
        if self.record_version < 1:
            raise OverrideAuditError(
                f"recordVersion must be >= 1, got {self.record_version!r}"
            )
        previous: str = "none"
        for entry in entries:
            if not isinstance(entry, OverrideEntry):
                raise OverrideAuditError(
                    f"override entries must be OverrideEntry, got {entry!r}"
                )
            if entry.leg != self.leg:
                raise OverrideAuditError(
                    f"entry for leg {entry.leg!r} inside the trail for {self.leg!r}"
                )
            if entry.from_override != previous:
                raise OverrideAuditError(
                    f"audit trail is broken: entry starts at {entry.from_override!r} "
                    f"after {previous!r}"
                )
            previous = entry.to_override
        object.__setattr__(self, "entries", entries)

    @property
    def current(self) -> ManualOverride:
        """The pin the trail ends at; ``none`` when nobody ever wrote one."""
        return self.entries[-1].to_override if self.entries else "none"

    def appended(self, entry: OverrideEntry) -> "OverrideTrail":
        """The next version of the trail; every write must use this."""
        return OverrideTrail(
            leg=self.leg,
            entries=self.entries + (entry,),
            record_version=self.record_version + 1,
        )

    def to_document(self) -> dict[str, Any]:
        return {
            "leg": self.leg,
            "recordVersion": self.record_version,
            "entries": [entry.to_document() for entry in self.entries],
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "OverrideTrail":
        if not isinstance(document, Mapping):
            raise OverrideAuditError(f"override trail must be a mapping, got {document!r}")
        version = document.get("recordVersion")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise UnsupportedAuditVersion(
                f"unsupported recordVersion {version!r}; expected an int >= {RECORD_VERSION}"
            )
        _reject_unknown(set(document), _RECORD_FIELDS, "override trail")
        entries = document["entries"]
        if not isinstance(entries, (list, tuple)):
            raise OverrideAuditError("override entries must be a list")
        return cls(
            leg=document["leg"],
            entries=tuple(OverrideEntry.from_document(entry) for entry in entries),
            record_version=version,
        )


@dataclass(frozen=True)
class OverrideOutcome:
    """What one human write produced, including a pin that landed unaudited."""

    transition: TransitionOutcome
    entry: OverrideEntry | None
    audited: bool
    error: str = ""

    @property
    def written(self) -> bool:
        return self.transition.written


class OverrideAudit:
    """Reads and appends the override trail; the only writer of a manual pin."""

    def __init__(
        self, store: DurableStore, *, now: Callable[[], float] = time.time
    ) -> None:
        self.store = store
        self._now = now

    async def read(self, leg: BreakerLeg) -> tuple[OverrideEntry, ...]:
        """Every entry for ``leg`` in write order; none when nobody wrote one."""
        return (await self.trail(leg)).entries

    async def trail(self, leg: BreakerLeg) -> OverrideTrail:
        """The durable trail for ``leg``; a missing row is an empty trail."""
        leg = _check_leg(leg)
        stored = await self.store.read(override_key(leg))
        if stored is None:
            return OverrideTrail(leg=leg)
        trail = OverrideTrail.from_document(stored.document)
        if trail.record_version != stored.version:
            raise OverrideAuditCorrupt(
                f"override trail for {leg!r} is version {trail.record_version} "
                f"in a row at version {stored.version}"
            )
        return trail

    async def append(self, entry: OverrideEntry) -> None:
        """Append ``entry`` to its leg's trail, compare-and-set.

        Raises :class:`StoreUnavailable` on an outage and
        :class:`OverrideAuditConflict` when another writer got there first.
        """
        if not isinstance(entry, OverrideEntry):
            raise TypeError(f"append needs an OverrideEntry, got {entry!r}")
        stored = await self.store.read(override_key(entry.leg))
        if stored is None:
            trail = OverrideTrail(leg=entry.leg, entries=(entry,))
            expected: int | None = None
        else:
            trail = OverrideTrail.from_document(stored.document)
            trail = trail.appended(entry)
            expected = trail.record_version - 1
        written = await self.store.compare_and_set(
            override_key(entry.leg),
            expected,
            StoredDocument(version=trail.record_version, document=trail.to_document()),
        )
        if not written:
            raise OverrideAuditConflict(
                f"another writer appended to the {entry.leg!r} override trail; "
                "re-read and retry"
            )

    async def pin(
        self,
        transitions: BreakerTransitions,
        leg: BreakerLeg,
        *,
        actor: str,
        why: str,
        target: str = "fallback",
    ) -> OverrideOutcome:
        """Pin ``leg`` to its fallback rung and record who, when and why.

        The record write is ticket 17's: it refuses an anonymous or unexplained
        pin, refuses any target but ``fallback``, and survives a lost
        compare-and-set. The audit entry is appended only after that write
        landed.
        """
        if target not in PIN_TARGETS:
            raise ManualOverrideRefused(
                f"manualOverride {target!r} is refused by name: the only pin is "
                f"{PIN_TARGETS[0]!r}; there is no automated primary pin"
            )
        outcome = await transitions.pin(leg, target=target, actor=actor, why=why)
        return await self._audit(outcome, leg=leg, actor=actor, why=why, to="fallback")

    async def clear(
        self,
        transitions: BreakerTransitions,
        leg: BreakerLeg,
        *,
        actor: str,
        why: str,
    ) -> OverrideOutcome:
        """Return ``leg`` to ``none`` and record who, when and why."""
        outcome = await transitions.clear_pin(leg, actor=actor, why=why)
        return await self._audit(outcome, leg=leg, actor=actor, why=why, to="none")

    async def _audit(
        self,
        outcome: TransitionOutcome,
        *,
        leg: BreakerLeg,
        actor: str,
        why: str,
        to: ManualOverride,
    ) -> OverrideOutcome:
        event = outcome.event
        if not outcome.written or event is None or outcome.record is None:
            return OverrideOutcome(
                transition=outcome,
                entry=None,
                audited=False,
                error=outcome.error or "the pin write did not land, so nothing was audited",
            )
        try:
            current = (await self.trail(leg)).current
        except (StoreUnavailable, OverrideAuditCorrupt, OverrideAuditError) as exc:
            return OverrideOutcome(
                transition=outcome,
                entry=None,
                audited=False,
                error=f"pin landed but the audit trail is unreadable: {exc}",
            )
        if current == to:
            return OverrideOutcome(
                transition=outcome,
                entry=None,
                audited=False,
                error=f"the pin was already {to!r}; an unchanged write is not audited",
            )
        entry = OverrideEntry(
            leg=leg,
            at=event.at,
            actor=actor,
            from_override=current,
            to_override=to,
            why=why,
        )
        try:
            await self.append(entry)
        except (StoreUnavailable, OverrideAuditConflict) as exc:
            # The pin is durable but the trail is not: say so, never hide it.
            return OverrideOutcome(
                transition=outcome,
                entry=entry,
                audited=False,
                error=f"pin landed but the audit entry did not: {exc}",
            )
        return OverrideOutcome(transition=outcome, entry=entry, audited=True)

    def now(self) -> float:
        """The injected clock; the entry's time comes from the transition event."""
        return self._now()
