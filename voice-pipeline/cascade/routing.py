"""The routing switch: which new calls may open a cascade connection.

The switch is the operator's authority over *new* calls, and nothing else is:
``off`` opens zero cascade connections, ``demo`` makes the stored demo subjects
eligible while tenant calls route managed, and ``all`` makes every subject that
passes the other eligibility predicates eligible. It is durable
(:mod:`cascade.store`) and read exactly once, before the first frame; the read
produces a frozen :class:`RoutingDecision` that the call carries, so a later
flip never moves a call that is already running.

A refusal is a routing decision, not a fallback event: the decision routes the
call managed and records why. A body the adapter rejects is not a routing
failure — the caller passes the refusal in and this module keeps its reason
(routing's own refusal, when there is one, takes precedence because routing
forbids cascade for the whole mode). Whether a call is a stored demo subject or
a tenant call is declared by the stored-body path on :class:`CallSubject`; this
module never infers it from an id or a name.

The durable record is versioned and append-only in its audit trail: every
change records who, when, from and to, and the compare-and-set write means two
operators cannot silently overwrite each other (the loser re-reads).

Timestamps are epoch seconds (UTC).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Literal, Mapping, Protocol

from cascade.store import DurableStore, StoredDocument, StoreUnavailable

RoutingMode = Literal["off", "demo", "all"]
SubjectKind = Literal["demo", "tenant"]
Disposition = Literal["cascade", "managed"]

MODES: tuple[RoutingMode, ...] = ("off", "demo", "all")
SUBJECT_KINDS: tuple[SubjectKind, ...] = ("demo", "tenant")
DISPOSITIONS: tuple[Disposition, ...] = ("cascade", "managed")

#: A never-written switch is off: no operator action, no cascade connections.
DEFAULT_MODE: RoutingMode = "off"
#: The one store key the switch lives under.
KEY = "routing:switch"
RECORD_VERSION = 1
#: ``from`` for the first recorded change, when no switch was stored yet.
UNSET = "unset"

_RECORD_FIELDS = ("mode", "recordVersion", "changes")
_CHANGE_FIELDS = ("at", "actor", "from", "to", "reason")


class RoutingSwitchError(ValueError):
    """A switch record or document does not match version 1."""


class UnsupportedRoutingVersion(RoutingSwitchError):
    """The stored ``recordVersion`` is not a version this code can read."""


class RoutingSwitchMissing(LookupError):
    """No durable switch is stored; :meth:`RoutingSwitch.decide` treats that as off."""


class RoutingSwitchConflict(RuntimeError):
    """Another operator wrote the switch first; re-read and retry."""


class RoutingSwitchCorrupt(RuntimeError):
    """The durable row and the document inside it disagree."""


class RoutingSwitchUnchanged(ValueError):
    """The requested mode is already the stored mode, so there is nothing to record."""


class BudgetSnapshot(Protocol):
    """The daily counter's read view, as this module needs it (ticket 102).

    Structural on purpose: routing must not import the counter and create a
    second money authority. ``routing_refusal`` is the counter's own sentence
    for a new call, and it is empty only while the day is known and below the
    routing line.
    """

    @property
    def would_route_managed(self) -> bool:
        """Whether a new call must route managed."""

    @property
    def routing_refusal(self) -> str:
        """Why a new call may not cascade, or ``""`` when it may."""


class BudgetLine(Protocol):
    """One durable day bucket, read before a new call's first frame."""

    async def snapshot(self, *, at: float | None = None) -> BudgetSnapshot:
        """Read today's durable state; an outage raises, it never reads zero."""



def _check_mode(mode: object) -> RoutingMode:
    if mode not in MODES:
        raise ValueError(f"unknown routing mode {mode!r}; expected one of {MODES}")
    return mode  # type: ignore[return-value]


def _check_subject_kind(kind: object) -> SubjectKind:
    if kind not in SUBJECT_KINDS:
        raise ValueError(f"unknown subject kind {kind!r}; expected one of {SUBJECT_KINDS}")
    return kind  # type: ignore[return-value]


def _check_timestamp(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RoutingSwitchError(f"{field} must be an epoch-seconds number, got {value!r}")
    if value < 0:
        raise RoutingSwitchError(f"{field} must not be negative, got {value!r}")
    return float(value)


def _check_actor(actor: object) -> str:
    if not isinstance(actor, str) or not actor.strip():
        raise RoutingSwitchError(
            f"routing changes need the operator identity, got {actor!r}; "
            "every change records who, when, from and to"
        )
    return actor.strip()


@dataclass(frozen=True)
class CallSubject:
    """The subject of one new call.

    ``kind`` is set by the stored-body path once it has proved what the subject
    is: ``demo`` for a stored demo subject, ``tenant`` for a tenant call. This
    module never guesses it from an id or a name.
    """

    subject_id: str
    kind: SubjectKind = "tenant"

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", _check_subject_kind(self.kind))
        if not isinstance(self.subject_id, str) or not self.subject_id.strip():
            raise ValueError(f"subject id must be a non-empty string, got {self.subject_id!r}")

    def to_document(self) -> dict[str, Any]:
        return {"id": self.subject_id, "kind": self.kind}


@dataclass(frozen=True)
class RoutingDecision:
    """A frozen routing snapshot for one new call.

    ``disposition`` is the routing verdict alone: ``cascade`` means the call may
    open cascade connections, ``managed`` means it opens none. ``mode`` is
    ``None`` only when the durable switch could not be read; the safe answer in
    every such case is ``managed``.
    """

    mode: RoutingMode | None
    subject: CallSubject
    disposition: Disposition
    reason: str = ""
    record_version: int | None = None
    decided_at: float | None = None

    def __post_init__(self) -> None:
        if self.mode is not None:
            _check_mode(self.mode)
        if self.disposition not in DISPOSITIONS:
            raise ValueError(
                f"unknown routing disposition {self.disposition!r}; expected one of {DISPOSITIONS}"
            )
        if not isinstance(self.subject, CallSubject):
            raise ValueError(f"subject must be a CallSubject, got {self.subject!r}")
        if not isinstance(self.reason, str):
            raise ValueError(f"reason must be a string, got {self.reason!r}")
        if self.record_version is not None and (
            isinstance(self.record_version, bool)
            or not isinstance(self.record_version, int)
            or self.record_version < 1
        ):
            raise ValueError(
                f"recordVersion must be an int >= 1 or None, got {self.record_version!r}"
            )
        if self.decided_at is not None:
            object.__setattr__(
                self, "decided_at", _check_timestamp(self.decided_at, "decidedAt")
            )
        if self.disposition == "cascade" and self.reason:
            raise ValueError(
                "a cascade decision cannot carry a refusal reason; refusals route managed"
            )
        if self.disposition == "managed" and not self.reason:
            raise ValueError(
                "a managed decision must name the reason it refused cascade"
            )
        if self.mode is None and self.disposition == "cascade":
            raise ValueError(
                "an unreadable routing switch cannot permit cascade"
            )

    @property
    def permitted(self) -> bool:
        """Whether routing permits this call to cascade."""
        return self.disposition == "cascade"

    @property
    def opens_cascade_connection(self) -> bool:
        """The connection count a new call may open: one, or zero when managed."""
        return self.opens_cascade_connections == 1

    @property
    def opens_cascade_connections(self) -> int:
        return 1 if self.disposition == "cascade" else 0

    def to_document(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "subject": self.subject.to_document(),
            "disposition": self.disposition,
            "reason": self.reason,
            "recordVersion": self.record_version,
            "decidedAt": self.decided_at,
        }


def routing_refusal(mode: RoutingMode, subject: CallSubject) -> str:
    """Why the mode refuses ``subject``; ``""`` when routing permits it.

    Pure, so ticket 25 can use it as its routing predicate in the eligibility
    conjunction without a store or a call.
    """
    _check_mode(mode)
    if not isinstance(subject, CallSubject):
        raise ValueError(f"subject must be a CallSubject, got {subject!r}")
    if mode == "off":
        return "routing is off; every new call routes managed"
    if mode == "demo" and subject.kind != "demo":
        return (
            f'routing is demo; "{subject.subject_id}" is a tenant call, '
            "and demo only makes stored demo subjects eligible"
        )
    return ""


def decide(
    mode: RoutingMode,
    subject: CallSubject,
    *,
    refusal: str = "",
    record_version: int | None = None,
    decided_at: float | None = None,
) -> RoutingDecision:
    """The routing decision for one new call, from a mode already read.

    ``refusal`` is the first failing predicate reported by a caller (the body
    adapter, the voice binding, the daily counter). Routing's own refusal wins,
    because routing forbids cascade for every subject of that mode.
    """
    reason = routing_refusal(mode, subject) or refusal
    return RoutingDecision(
        mode=mode,
        subject=subject,
        disposition="managed" if reason else "cascade",
        reason=reason,
        record_version=record_version,
        decided_at=decided_at,
    )


@dataclass(frozen=True)
class RoutingChange:
    """One operator action on the switch, kept forever in the record."""

    at: float
    actor: str
    from_mode: str
    to_mode: RoutingMode
    reason: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "at", _check_timestamp(self.at, "change.at"))
        object.__setattr__(self, "actor", _check_actor(self.actor))
        object.__setattr__(self, "to_mode", _check_mode(self.to_mode))
        if self.from_mode != UNSET:
            _check_mode(self.from_mode)
            if self.from_mode == self.to_mode:
                raise RoutingSwitchError(
                    f"a change must change the mode, got {self.from_mode!r} twice"
                )
        if not isinstance(self.reason, str):
            raise RoutingSwitchError(f"change reason must be a string, got {self.reason!r}")

    def to_document(self) -> dict[str, Any]:
        return {
            "at": self.at,
            "actor": self.actor,
            "from": self.from_mode,
            "to": self.to_mode,
            "reason": self.reason,
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "RoutingChange":
        if not isinstance(document, Mapping):
            raise RoutingSwitchError(f"routing change must be a mapping, got {document!r}")
        _reject_unknown(set(document), _CHANGE_FIELDS, "routing change")
        return cls(
            at=document["at"],
            actor=document["actor"],
            from_mode=document["from"],
            to_mode=document["to"],
            reason=document["reason"],
        )


@dataclass(frozen=True)
class RoutingRecord:
    """The durable switch: the current mode plus its complete audit trail."""

    mode: RoutingMode
    changes: tuple[RoutingChange, ...]
    record_version: int = RECORD_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(self, "mode", _check_mode(self.mode))
        if isinstance(self.record_version, bool) or not isinstance(self.record_version, int):
            raise RoutingSwitchError(
                f"recordVersion must be an int, got {self.record_version!r}"
            )
        if self.record_version < 1:
            raise RoutingSwitchError(
                f"recordVersion must be >= 1, got {self.record_version!r}"
            )
        changes = tuple(self.changes)
        if not changes:
            raise RoutingSwitchError("a routing record needs at least one audit entry")
        previous: str = UNSET
        for change in changes:
            if not isinstance(change, RoutingChange):
                raise RoutingSwitchError(
                    f"audit entries must be RoutingChange, got {change!r}"
                )
            if change.from_mode != previous:
                raise RoutingSwitchError(
                    f"audit trail is broken: change starts at {change.from_mode!r} "
                    f"after {previous!r}"
                )
            previous = change.to_mode
        if previous != self.mode:
            raise RoutingSwitchError(
                f"routing record says {self.mode!r} but its last change ends at {previous!r}"
            )
        object.__setattr__(self, "changes", changes)

    @property
    def updated_at(self) -> float:
        """When the current mode was written."""
        return self.changes[-1].at

    @property
    def updated_by(self) -> str:
        """Who wrote the current mode."""
        return self.changes[-1].actor

    def to_document(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "recordVersion": self.record_version,
            "changes": [change.to_document() for change in self.changes],
        }

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "RoutingRecord":
        if not isinstance(document, Mapping):
            raise RoutingSwitchError(f"routing record must be a mapping, got {document!r}")
        version = document.get("recordVersion")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise UnsupportedRoutingVersion(
                f"unsupported recordVersion {version!r}; expected an int >= {RECORD_VERSION}"
            )
        _reject_unknown(set(document), _RECORD_FIELDS, "routing record")
        changes = document["changes"]
        if not isinstance(changes, (list, tuple)):
            raise RoutingSwitchError("routing changes must be a list")
        return cls(
            mode=document["mode"],
            changes=tuple(RoutingChange.from_document(change) for change in changes),
            record_version=version,
        )

    @classmethod
    def seeded(
        cls, mode: RoutingMode, *, actor: str, at: float, reason: str = ""
    ) -> "RoutingRecord":
        """Version 1 of a switch that had no durable record before."""
        return cls(
            mode=mode,
            changes=(RoutingChange(at=at, actor=actor, from_mode=UNSET, to_mode=mode,
                                   reason=reason),),
            record_version=RECORD_VERSION,
        )

    def switched(
        self, mode: RoutingMode, *, actor: str, at: float, reason: str = ""
    ) -> "RoutingRecord":
        """The next version of this record; every write must use this."""
        mode = _check_mode(mode)
        if mode == self.mode:
            raise RoutingSwitchUnchanged(
                f"routing is already {mode!r}; an unchanged flip records nothing"
            )
        return replace(
            self,
            mode=mode,
            record_version=self.record_version + 1,
            changes=self.changes
            + (RoutingChange(at=at, actor=actor, from_mode=self.mode, to_mode=mode,
                             reason=reason),),
        )


def _reject_unknown(actual: set[str], expected: tuple[str, ...], where: str) -> None:
    unknown = actual - set(expected)
    if unknown:
        raise RoutingSwitchError(f"unknown {where} field(s): {', '.join(sorted(unknown))}")
    missing = set(expected) - actual
    if missing:
        raise RoutingSwitchError(f"missing {where} field(s): {', '.join(sorted(missing))}")


class RoutingSwitch:
    """Reads and compare-and-set writes of the one durable switch."""

    def __init__(
        self, store: DurableStore, *, now: Callable[[], float] = time.time
    ) -> None:
        self.store = store
        self._now = now

    async def read(self) -> RoutingRecord:
        """Read the durable switch; a missing record is not invented."""
        stored = await self.store.read(KEY)
        if stored is None:
            raise RoutingSwitchMissing(
                f"no durable routing switch is stored at {KEY!r}"
            )
        return _record_from_stored(stored)

    async def write(self, record: RoutingRecord) -> bool:
        """CAS-write ``record``; ``False`` means another operator got there first."""
        if not isinstance(record, RoutingRecord):
            raise RoutingSwitchError(f"expected a RoutingRecord, got {record!r}")
        expected_version = (
            None if record.record_version == RECORD_VERSION else record.record_version - 1
        )
        return await self.store.compare_and_set(
            KEY,
            expected_version,
            StoredDocument(version=record.record_version, document=record.to_document()),
        )

    async def set_mode(
        self, mode: RoutingMode, *, actor: str, reason: str = ""
    ) -> RoutingRecord:
        """Flip the switch for future calls and record who, when, from and to.

        A store outage raises :class:`StoreUnavailable`; an operator must know
        the flip did not land. A lost compare-and-set raises
        :class:`RoutingSwitchConflict`; re-read and retry.
        """
        mode = _check_mode(mode)
        actor = _check_actor(actor)
        if not isinstance(reason, str):
            raise RoutingSwitchError(f"reason must be a string, got {reason!r}")
        at = self._now()
        stored = await self.store.read(KEY)
        if stored is None:
            record = RoutingRecord.seeded(mode, actor=actor, at=at, reason=reason)
            expected_version: int | None = None
        else:
            current = _record_from_stored(stored)
            if current.mode == mode:
                raise RoutingSwitchUnchanged(
                    f"routing is already {mode!r}; an unchanged flip records nothing"
                )
            record = current.switched(mode, actor=actor, at=at, reason=reason)
            expected_version = current.record_version
        written = await self.store.compare_and_set(
            KEY,
            expected_version,
            StoredDocument(version=record.record_version, document=record.to_document()),
        )
        if not written:
            raise RoutingSwitchConflict(
                f"another operator wrote the routing switch before this {mode!r} flip"
            )
        return record

    async def decide(
        self,
        subject: CallSubject,
        *,
        refusal: str = "",
        budget: BudgetLine | None = None,
    ) -> RoutingDecision:
        """Read the switch exactly once and freeze one new call's decision.

        The returned object is the snapshot the call carries: no later flip can
        change it. An unreadable switch routes managed, because a call must
        never open sockets on a switch whose value is unknown.

        ``budget`` is ticket 102's daily counter. When one is passed, the day is
        consulted in the same pre-first-frame decision, so the 80% line moves
        this call and never a call already running. A counter read that fails
        routes managed: an unknown day's spend is never read as zero and never
        as permission to cascade.
        """
        decided_at = self._now()
        budget_refusal = await self._budget_refusal(subject, budget)
        try:
            record = await self.read()
        except RoutingSwitchMissing:
            reason = (
                "no durable routing switch is stored; "
                f"{routing_refusal(DEFAULT_MODE, subject)}"
            )
            return RoutingDecision(
                mode=DEFAULT_MODE,
                subject=subject,
                disposition="managed",
                reason=reason,
                record_version=None,
                decided_at=decided_at,
            )
        except (StoreUnavailable, RoutingSwitchCorrupt, ValueError) as exc:
            # A durable row that is not a valid switch is as unknown as an
            # unreadable one: route managed, never open sockets on a guess.
            return RoutingDecision(
                mode=None,
                subject=subject,
                disposition="managed",
                reason=f"routing switch is unreadable ({exc}); every new call routes managed",
                record_version=None,
                decided_at=decided_at,
            )
        return decide(
            record.mode,
            subject,
            refusal=refusal or budget_refusal,
            record_version=record.record_version,
            decided_at=decided_at,
        )

    async def _budget_refusal(
        self, subject: CallSubject, budget: BudgetLine | None
    ) -> str:
        """The day's own reason, or the named reason the day is unknown."""
        if budget is None:
            return ""
        try:
            snapshot = await budget.snapshot()
        except Exception as exc:  # a store outage is not a zero-spend day
            return (
                f"the daily counter is unreadable ({type(exc).__name__}: {exc}); "
                "a new call routes managed because an unknown day's spend is "
                "never read as zero"
            )
        reason = snapshot.routing_refusal
        if not isinstance(reason, str):
            return (
                "the daily counter returned no reason string; a new call routes "
                "managed rather than cascading on an unknown answer"
            )
        return reason


def _record_from_stored(stored: StoredDocument) -> RoutingRecord:
    record = RoutingRecord.from_document(stored.document)
    if record.record_version != stored.version:
        raise RoutingSwitchCorrupt(
            f"routing record is version {record.record_version} "
            f"in a row at version {stored.version}"
        )
    return record
