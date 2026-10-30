"""One durable daily spend bucket, shared by every instance (ticket 102).

Spec: `.scratch/meta-cascade/spec.md` M3 "Money and eyes" — "A durable, atomic,
shared counter with UTC day buckets. Every billable unit adds to the day it was
consumed, so a call spanning midnight contributes to both days." Ticket 101
prices the units; this module charges the price to a day and answers the two
money lines for ticket 103/104.

A day bucket is one versioned document in the shared store
(:mod:`cascade.store`), keyed by ``budget.daily:<YYYY-MM-DD>``. Every write is a
compare-and-set: the counter reads the durable document, applies the charge, and
writes only that version. A lost write is re-read and retried, so two instances
adding at the same moment produce one total and one crossing per line:

* the winner of a crossing records the line in the day's ``crossed`` set, so the
  next writer sees it already crossed and emits nothing (:class:`Crossing`);
* the crossing set is per day, so a new day crosses and alerts again.

The optional ``on_crossing`` sink hears each crossing exactly once, from the
writer that made it durable. Routing reads (``snapshot`` and its properties)
never alert: a crossing is spend, not a read, and ticket 103's new-call decision
consumes the day's line without producing a second notification.

Three absences are kept apart, because every one of them has a different answer:

* an **unwritten day** is zero spend — nothing was recorded, so nothing was
  spent;
* an **unreadable store** raises :class:`cascade.store.StoreUnavailable`; the
  counter never reads an outage as zero spend and never claims a charge landed;
* an **unmeasured cost** (:class:`cascade.cost.CallCost` with ``amount is None``)
  is charged as unmeasured, not as zero: no amount is added, the day records the
  reasons, and both money lines fail closed for *new* calls (route managed,
  refuse cascade) until the day is known again. That is the conservative rule:
  an unknown charge is never assumed to be free, and refusing cascade never
  refuses the call.

The counter only charges. It never moves a live call: the 80%/100% lines are
read by a new call's routing decision (103/104), so a call already running keeps
its cascade legs and keeps being charged — the per-call ceiling is ticket 105's
job, not this module's. A prefetch that produced no usage records nothing in
ticket 100's meter and therefore produces no charge here; a charge that was
handed over unmeasured fails closed rather than counting zero.

Reservations hold a measured amount (ticket 101's cost so far) for a call that
has not settled yet, so an in-flight call's known spend counts against the line
before its final charge lands. A settle releases the hold and charges the final
cost to the day it was consumed; an unmeasured settle keeps the hold (the spend
is known to be real even though the total is not) and flags the day. A release
drops a hold for a call that ended without a cost.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping

from cascade import thresholds
from cascade.cost import CallCost
from cascade.store import DurableStore, StoredDocument

#: The store key prefix; one document per UTC day.
KEY_PREFIX = "budget.daily"

#: The document format this reader writes and understands.
RECORD_VERSION = 1

#: The money lines a day can cross, in the order they are evaluated.
MANAGED_LINE = "route_managed"
REFUSED_LINE = "refuse_cascade"
LINES: tuple[str, ...] = (MANAGED_LINE, REFUSED_LINE)

#: The only day bucket this counter knows, until a bound says otherwise.
UTC = "UTC"

#: Bounds this counter reads; none of them is defaulted here.
CAP_BOUND = "budget.daily_cap"
MANAGED_BOUND = "budget.route_managed_ratio"
REFUSED_BOUND = "budget.refuse_cascade_ratio"
BOUNDARY_BOUND = "budget.day_boundary"

_MAX_ATTEMPTS = 8
_DOCUMENT_FIELDS = frozenset(
    {"recordVersion", "day", "spent", "reserved", "unmeasured", "crossed"}
)


class CounterError(RuntimeError):
    """The daily counter cannot serve an honest answer."""


class CounterCorrupt(CounterError):
    """The durable day document is not the record this version writes."""


class UnsupportedCounterVersion(CounterError):
    """The durable day document was written by a format this code cannot read."""


class UnsupportedDayBoundary(CounterError):
    """The registry names a day boundary this counter cannot bucket."""

    def __init__(self, boundary: object) -> None:
        self.boundary = boundary
        super().__init__(
            f"the day boundary {boundary!r} is not supported; the counter buckets "
            f"UTC days only, because a local boundary makes the day key depend on "
            "the reader's clock"
        )


class CounterConflict(CounterError):
    """Every compare-and-set attempt lost; the charge did not land."""


# --------------------------------------------------------------------------
# The day key
# --------------------------------------------------------------------------


def _check_boundary(boundary: object) -> str:
    if not isinstance(boundary, str) or boundary.strip().upper() != UTC:
        raise UnsupportedDayBoundary(boundary)
    return UTC


def day_key(at: float, *, boundary: str = UTC) -> str:
    """The bucket an epoch-seconds instant belongs to, from the UTC boundary.

    ``boundary`` is ticket 04's bound (``budget.day_boundary``); this counter
    validates it and refuses a non-UTC value by name instead of quietly
    bucketing in a different zone.
    """
    _check_boundary(boundary)
    instant = _epoch(at, "at")
    return datetime.fromtimestamp(instant, tz=timezone.utc).date().isoformat()


def record_key(day: str) -> str:
    """The one store key a day's document lives under."""
    if not isinstance(day, str) or not day:
        raise ValueError(f"a day key must be a non-empty string, got {day!r}")
    return f"{KEY_PREFIX}:{day}"


# --------------------------------------------------------------------------
# Values
# --------------------------------------------------------------------------


def _epoch(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CounterError(f"{field} must be epoch seconds, got {value!r}")
    if value < 0 or value != value or value == float("inf"):
        raise CounterError(
            f"{field} must be a finite non-negative instant, got {value!r}"
        )
    return float(value)


def _money(value: Any, field: str) -> Decimal:
    if isinstance(value, bool):
        raise CounterCorrupt(f"{field} cannot be a boolean: {value!r}")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise CounterCorrupt(
            f"{field} must be a decimal amount, got {value!r}"
        ) from None
    if not amount.is_finite() or amount < 0:
        raise CounterCorrupt(
            f"{field} must be a finite non-negative amount, got {value!r}"
        )
    return amount


def _money_text(amount: Decimal) -> str:
    """A fixed-point decimal string, never scientific notation."""
    return format(amount.normalize(), "f")


def limit_amount(value: Any, field: str) -> Decimal:
    """A finite decimal bound, from the registry or an explicit value."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError(f"{field} must be a number, got {value!r}")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f"{field} must be a decimal number, got {value!r}") from None
    if not amount.is_finite():
        raise ValueError(f"{field} must be finite, got {value!r}")
    return amount


@dataclass(frozen=True)
class Crossing:
    """One money line crossed by this write — the ``budget.crossing`` payload."""

    line: str
    day: str
    spend: Decimal
    cap: Decimal

    def __post_init__(self) -> None:
        if self.line not in LINES:
            raise ValueError(f"unknown money line {self.line!r}; expected {LINES}")

    @property
    def ratio(self) -> Decimal:
        return self.spend / self.cap

    def to_document(self) -> dict[str, Any]:
        return {
            "line": self.line,
            "day": self.day,
            "spend": _money_text(self.spend),
            "cap": _money_text(self.cap),
        }


@dataclass(frozen=True)
class UnmeasuredCharge:
    """A charge ticket 101 could not price, kept as a flag, never as zero."""

    call_id: str
    reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.call_id, str):
            raise ValueError(f"call id must be a string, got {self.call_id!r}")
        if not self.reasons:
            raise ValueError("an unmeasured charge must name at least one reason")

    def to_document(self) -> dict[str, Any]:
        return {"callId": self.call_id, "reasons": list(self.reasons)}

    def describe(self) -> str:
        return "; ".join(self.reasons)


@dataclass(frozen=True)
class Reservation:
    """One call's measured hold on one day, before its final charge."""

    call_id: str
    day: str
    amount: Decimal

    def __post_init__(self) -> None:
        if not isinstance(self.call_id, str) or not self.call_id:
            raise ValueError(f"a reservation needs a call id, got {self.call_id!r}")
        if not isinstance(self.day, str) or not self.day:
            raise ValueError(f"a reservation needs a day, got {self.day!r}")
        if _amount_invalid(self.amount):
            raise ValueError(
                f"a reservation amount must be a finite non-negative decimal, "
                f"got {self.amount!r}"
            )

    def to_document(self) -> dict[str, Any]:
        return {"day": self.day, "amount": _money_text(self.amount)}


def _amount_invalid(amount: Any) -> bool:
    return (
        not isinstance(amount, Decimal)
        or not amount.is_finite()
        or amount < 0
    )


def _check_call_id(call_id: Any) -> str:
    if not isinstance(call_id, str) or not call_id.strip():
        raise ValueError(f"a reservation needs a call id, got {call_id!r}")
    return call_id


def _with_hold(
    holds: tuple[Reservation, ...], hold: Reservation
) -> tuple[Reservation, ...]:
    """The holds with ``hold`` replacing the same call's earlier hold in place."""
    replaced = False
    updated: list[Reservation] = []
    for existing in holds:
        if existing.call_id == hold.call_id:
            updated.append(hold)
            replaced = True
        else:
            updated.append(existing)
    if not replaced:
        updated.append(hold)
    return tuple(updated)


@dataclass(frozen=True)
class DayBudget:
    """One day's durable money state, and the two lines it feeds.

    ``spent`` is charged money; ``reserved`` is measured money held for calls
    still running; ``committed`` is both, because a hold is real spend that has
    not landed yet. ``ratio`` is ``None`` while the day carries an unmeasured
    charge: the day's spend is then unknown, and both lines answer "managed"
    rather than assuming the unknown part was free.
    """

    day: str
    spent: Decimal
    reserved: tuple[Reservation, ...]
    unmeasured: tuple[UnmeasuredCharge, ...]
    crossed: tuple[str, ...]
    cap: Decimal
    managed_ratio: Decimal
    refuse_ratio: Decimal
    version: int | None = None

    @property
    def held(self) -> Decimal:
        return sum((hold.amount for hold in self.reserved), Decimal(0))

    @property
    def committed(self) -> Decimal:
        return self.spent + self.held

    @property
    def ratio(self) -> Decimal | None:
        if self.unmeasured:
            return None
        return self.committed / self.cap

    @property
    def would_route_managed(self) -> bool:
        if self.unmeasured:
            return True
        return self.committed >= self.cap * self.managed_ratio

    @property
    def would_refuse_cascade(self) -> bool:
        if self.unmeasured:
            return True
        return self.committed >= self.cap * self.refuse_ratio

    @property
    def routing_refusal(self) -> str:
        """Why a *new* call may not cascade, or ``""`` when it may."""
        if self.unmeasured:
            reasons = "; ".join(charge.describe() for charge in self.unmeasured)
            return (
                f"the day's spend is unmeasured ({reasons}); cascade cannot be "
                "proved to be inside the cap for a new call"
            )
        if self.would_refuse_cascade:
            return (
                f"the day's spend is {self.percent}% of the "
                f"{_money_text(self.cap)} USD cap; cascade is refused for new "
                "calls, which route managed; the call itself is never refused"
            )
        if self.would_route_managed:
            return (
                f"the day's spend is {self.percent}% of the "
                f"{_money_text(self.cap)} USD cap; new calls route managed"
            )
        return ""

    @property
    def percent(self) -> str:
        ratio = self.ratio
        if ratio is None:
            return "unknown"
        return format((ratio * 100).quantize(Decimal("0.1")), "f")

    def hold(self, call_id: str) -> Reservation | None:
        return next(
            (hold for hold in self.reserved if hold.call_id == call_id), None
        )

    def to_document(self) -> dict[str, Any]:
        """The read view 103/104 record; the stored record is smaller."""
        return {
            "day": self.day,
            "spent": _money_text(self.spent),
            "reserved": [hold.to_document() for hold in self.reserved],
            "committed": _money_text(self.committed),
            "unmeasured": [charge.to_document() for charge in self.unmeasured],
            "crossed": list(self.crossed),
            "cap": _money_text(self.cap),
            "ratio": None if self.ratio is None else _money_text(self.ratio),
            "wouldRouteManaged": self.would_route_managed,
            "wouldRefuseCascade": self.would_refuse_cascade,
            "version": self.version,
        }


@dataclass(frozen=True)
class Charge:
    """What one charge did: the amount (or its absence), and any new crossing."""

    day: str
    amount: Decimal | None
    spent: Decimal
    held: Decimal
    version: int
    unmeasured: tuple[UnmeasuredCharge, ...] = ()
    crossings: tuple[Crossing, ...] = ()

    @property
    def charged(self) -> bool:
        """Whether a measured amount was added; ``False`` means unmeasured."""
        return self.amount is not None

    @property
    def committed(self) -> Decimal:
        return self.spent + self.held

    def to_document(self) -> dict[str, Any]:
        return {
            "day": self.day,
            "charged": self.charged,
            "amount": None if self.amount is None else _money_text(self.amount),
            "spent": _money_text(self.spent),
            "committed": _money_text(self.committed),
            "unmeasured": [charge.to_document() for charge in self.unmeasured],
            "crossings": [crossing.to_document() for crossing in self.crossings],
            "version": self.version,
        }


# --------------------------------------------------------------------------
# The counter
# --------------------------------------------------------------------------


def _bound(registry: thresholds.Registry, name: str) -> Any:
    return registry.require(name)


class DailyCounter:
    """The shared, atomic, UTC-bucketed spend counter.

    Reads come straight from the store on every call (no cache), because the
    point is that two instances see one total. Construction reads the four
    bounds from the threshold registry; an unset bound raises there, by name.
    """

    def __init__(
        self,
        store: DurableStore,
        *,
        registry: thresholds.Registry | None = None,
        cap: Any = None,
        managed_ratio: Any = None,
        refuse_ratio: Any = None,
        boundary: str | None = None,
        now: Callable[[], float] = time.time,
        attempts: int = _MAX_ATTEMPTS,
        on_crossing: Callable[[Crossing], None] | None = None,
    ) -> None:
        registry = thresholds.REGISTRY if registry is None else registry
        self.store = store
        if on_crossing is not None and not callable(on_crossing):
            raise ValueError(
                f"on_crossing must be callable, got {on_crossing!r}; the alert "
                "sink hears each line exactly once"
            )
        self._on_crossing = on_crossing
        self.boundary = _check_boundary(
            _bound(registry, BOUNDARY_BOUND) if boundary is None else boundary
        )
        self.cap = (
            limit_amount(_bound(registry, CAP_BOUND), "budget.daily_cap")
            if cap is None
            else limit_amount(cap, "cap")
        )
        self.managed_ratio = (
            limit_amount(_bound(registry, MANAGED_BOUND), "budget.route_managed_ratio")
            if managed_ratio is None
            else limit_amount(managed_ratio, "managed_ratio")
        )
        self.refuse_ratio = (
            limit_amount(_bound(registry, REFUSED_BOUND), "budget.refuse_cascade_ratio")
            if refuse_ratio is None
            else limit_amount(refuse_ratio, "refuse_ratio")
        )
        if self.cap <= 0:
            raise ValueError(f"the daily cap must be positive, got {self.cap!r}")
        for name, ratio in (
            ("managed_ratio", self.managed_ratio),
            ("refuse_ratio", self.refuse_ratio),
        ):
            if not Decimal(0) < ratio <= Decimal(1):
                raise ValueError(f"{name} must be in (0, 1], got {ratio!r}")
        if self.managed_ratio > self.refuse_ratio:
            raise ValueError(
                "the managed line must not sit above the refusal line: "
                f"{self.managed_ratio} > {self.refuse_ratio}"
            )
        if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
            raise ValueError(f"attempts must be an int >= 1, got {attempts!r}")
        self._now = now
        self._attempts = attempts

    # -- reading ----------------------------------------------------------

    def day_key(self, at: float) -> str:
        return day_key(at, boundary=self.boundary)

    async def snapshot(self, *, at: float | None = None) -> DayBudget:
        """Read one day's durable state; an outage raises, it never reads zero."""
        day = self.day_key(self._now() if at is None else at)
        return await self._read(day)

    async def ratio(self, *, at: float | None = None) -> Decimal | None:
        return (await self.snapshot(at=at)).ratio

    async def would_route_managed(self, *, at: float | None = None) -> bool:
        return (await self.snapshot(at=at)).would_route_managed

    async def would_refuse_cascade(self, *, at: float | None = None) -> bool:
        return (await self.snapshot(at=at)).would_refuse_cascade

    # -- writing ----------------------------------------------------------

    async def charge(self, call_cost: CallCost, *, at: float | None = None) -> Charge:
        """Charge one priced cost to the day it was consumed.

        A measured cost adds its amount. An unmeasured cost adds nothing and is
        recorded as unmeasured; it is never counted as zero. Call this once per
        recorded vendor unit set — a reconnect replay and a fallback leg are
        separate charges and both are counted.
        """
        if not isinstance(call_cost, CallCost):
            raise CounterError(f"expected a CallCost, got {call_cost!r}")
        day = self.day_key(self._now() if at is None else at)
        return await self._charge(day, call_cost)

    async def reserve(
        self, call_id: str, call_cost: CallCost, *, at: float | None = None
    ) -> Reservation:
        """Hold a call's measured cost so an in-flight call counts on the line.

        The hold is not spend: it moves the routing decision for *new* calls
        (``committed`` includes it) and never fires a crossing by itself. Only a
        measured cost can be held; an unmeasured one raises
        :class:`cascade.cost.UnmeasuredCostError`, because an unknown amount
        cannot be reserved.
        """
        _check_call_id(call_id)
        if not isinstance(call_cost, CallCost):
            raise CounterError(f"expected a CallCost, got {call_cost!r}")
        amount = call_cost.require_amount()
        day = self.day_key(self._now() if at is None else at)
        hold = Reservation(call_id, day, amount)

        def mutate(current: DayBudget) -> tuple[DayBudget, None]:
            return replace(current, reserved=_with_hold(current.reserved, hold)), None

        await self._write(day, mutate)
        return hold

    async def settle(
        self, reservation: Reservation, call_cost: CallCost, *, at: float | None = None
    ) -> Charge:
        """End a call's hold and charge its final cost to the consumption day.

        A measured cost releases the hold and charges the money to the day of
        ``at`` (which may be a later bucket than the hold's). An unmeasured cost
        releases nothing: the hold stays, the day is flagged unmeasured, and the
        caller sees ``charged is False``. That is the conservative rule — the
        spend is known to be real even when its total is not.
        """
        if not isinstance(reservation, Reservation):
            raise CounterError(f"expected a Reservation, got {reservation!r}")
        if not isinstance(call_cost, CallCost):
            raise CounterError(f"expected a CallCost, got {call_cost!r}")
        if call_cost.amount is None:
            return await self._charge(
                reservation.day, call_cost, call_id=reservation.call_id
            )
        day = self.day_key(self._now() if at is None else at)
        if day == reservation.day:
            return await self._charge(
                day,
                call_cost,
                call_id=reservation.call_id,
                release_hold=reservation.call_id,
            )
        charged = await self._charge(day, call_cost, call_id=reservation.call_id)
        await self._release_on(reservation.day, reservation.call_id)
        return charged

    async def release(self, reservation: Reservation) -> bool:
        """Drop a hold for a call that ended without a cost; idempotent."""
        if not isinstance(reservation, Reservation):
            raise CounterError(f"expected a Reservation, got {reservation!r}")
        return await self._release_on(reservation.day, reservation.call_id)

    # -- internals --------------------------------------------------------

    async def _read(self, day: str) -> DayBudget:
        stored = await self.store.read(record_key(day))
        return self._budget(day, stored)

    async def _charge(
        self,
        day: str,
        call_cost: CallCost,
        *,
        call_id: str = "",
        release_hold: str | None = None,
    ) -> Charge:
        amount = call_cost.amount

        def mutate(current: DayBudget) -> tuple[DayBudget, Charge]:
            holds = current.reserved
            if release_hold is not None:
                holds = tuple(
                    hold for hold in holds if hold.call_id != release_hold
                )
            if amount is None:
                unmeasured = current.unmeasured + (
                    UnmeasuredCharge(call_id, call_cost.reasons),
                )
                updated = replace(current, reserved=holds, unmeasured=unmeasured)
                return updated, Charge(
                    day=day,
                    amount=None,
                    spent=updated.spent,
                    held=updated.held,
                    version=-1,
                    unmeasured=unmeasured,
                )
            updated, crossings = self._with_spend(
                replace(current, reserved=holds), current.spent + amount
            )
            return updated, Charge(
                day=day,
                amount=amount,
                spent=updated.spent,
                held=updated.held,
                version=-1,
                crossings=crossings,
            )

        final, result = await self._write(day, mutate)
        self._alert(result.crossings)
        return replace(
            result,
            spent=final.spent,
            held=final.held,
            version=final.version,
        )

    def _alert(self, crossings: tuple[Crossing, ...]) -> None:
        """Tell the alert sink about each line this write crossed.

        The crossing set is stored in the durable day document, so exactly one
        writer produces each crossing and no instance alerts twice for one day
        and one line. A sink failure must not un-land a charge that already
        committed: the crossing is durable, and the charge is what the caller
        asked for.
        """
        if self._on_crossing is None:
            return
        for crossing in crossings:
            try:
                self._on_crossing(crossing)
            except Exception:
                continue

    async def _release_on(self, day: str, call_id: str) -> bool:
        def mutate(current: DayBudget) -> tuple[DayBudget, bool]:
            holds = tuple(
                hold for hold in current.reserved if hold.call_id != call_id
            )
            return replace(current, reserved=holds), len(holds) != len(current.reserved)

        _, released = await self._write(day, mutate)
        return released

    def _with_spend(
        self, current: DayBudget, spent: Decimal
    ) -> tuple[DayBudget, tuple[Crossing, ...]]:
        crossed = list(current.crossed)
        crossings: list[Crossing] = []
        lines = (
            (MANAGED_LINE, self.cap * self.managed_ratio),
            (REFUSED_LINE, self.cap * self.refuse_ratio),
        )
        for line, threshold in lines:
            if spent >= threshold and line not in crossed:
                crossed.append(line)
                crossings.append(Crossing(line, current.day, spent, self.cap))
        return replace(current, spent=spent, crossed=tuple(crossed)), tuple(crossings)

    async def _write(
        self,
        day: str,
        mutate: Callable[[DayBudget], tuple[DayBudget, Any]],
    ) -> tuple[DayBudget, Any]:
        key = record_key(day)
        for _ in range(self._attempts):
            stored = await self.store.read(key)
            current = self._budget(day, stored)
            updated, result = mutate(current)
            version = 1 if stored is None else stored.version + 1
            written = await self.store.compare_and_set(
                key,
                None if stored is None else stored.version,
                StoredDocument(version=version, document=_document(updated)),
            )
            if written:
                return replace(updated, version=version), result
        raise CounterConflict(
            f"the day bucket {day!r} changed under every one of "
            f"{self._attempts} attempts; the charge did not land"
        )

    def _budget(self, day: str, stored: StoredDocument | None) -> DayBudget:
        limits = {
            "cap": self.cap,
            "managed_ratio": self.managed_ratio,
            "refuse_ratio": self.refuse_ratio,
        }
        if stored is None:
            return DayBudget(
                day=day,
                spent=Decimal(0),
                reserved=(),
                unmeasured=(),
                crossed=(),
                version=None,
                **limits,
            )
        document = stored.document
        if not isinstance(document, Mapping):
            raise CounterCorrupt(f"the day bucket {day!r} is not a record")
        version = document.get("recordVersion")
        if version != RECORD_VERSION:
            raise UnsupportedCounterVersion(
                f"the day bucket {day!r} is recordVersion {version!r}; "
                f"this reader supports {RECORD_VERSION}"
            )
        unknown = sorted(set(document) - _DOCUMENT_FIELDS)
        if unknown:
            raise CounterCorrupt(
                f"the day bucket {day!r} has unknown field(s) {', '.join(unknown)}"
            )
        missing = sorted(_DOCUMENT_FIELDS - set(document))
        if missing:
            raise CounterCorrupt(
                f"the day bucket {day!r} is missing field(s) {', '.join(missing)}"
            )
        if document["day"] != day:
            raise CounterCorrupt(
                f"the day bucket at {record_key(day)!r} says it is "
                f"{document['day']!r}"
            )
        reserved = document["reserved"]
        if not isinstance(reserved, Mapping):
            raise CounterCorrupt(f"the day bucket {day!r} has no reserved map")
        holds = tuple(
            _hold(call_id, day, value) for call_id, value in reserved.items()
        )
        unmeasured_raw = document["unmeasured"]
        if not isinstance(unmeasured_raw, (list, tuple)):
            raise CounterCorrupt(f"the day bucket {day!r} has no unmeasured list")
        unmeasured = tuple(_unmeasured(entry, day) for entry in unmeasured_raw)
        crossed_raw = document["crossed"]
        if not isinstance(crossed_raw, (list, tuple)):
            raise CounterCorrupt(f"the day bucket {day!r} has no crossed list")
        crossed = tuple(crossed_raw)
        unknown_lines = sorted(set(crossed) - set(LINES))
        if unknown_lines:
            raise CounterCorrupt(
                f"the day bucket {day!r} records unknown money line(s) "
                f"{', '.join(map(str, unknown_lines))}"
            )
        return DayBudget(
            day=day,
            spent=_money(document["spent"], "spent"),
            reserved=holds,
            unmeasured=unmeasured,
            crossed=crossed,
            version=stored.version,
            **limits,
        )


def _hold(call_id: Any, day: str, value: Any) -> Reservation:
    try:
        return Reservation(str(call_id), day, _money(value, f"reserved[{call_id!r}]"))
    except (ValueError, CounterCorrupt) as exc:
        raise CounterCorrupt(
            f"the day bucket {day!r} has an unreadable hold for {call_id!r}: {exc}"
        ) from None


def _unmeasured(entry: Any, day: str) -> UnmeasuredCharge:
    if not isinstance(entry, Mapping):
        raise CounterCorrupt(
            f"the day bucket {day!r} has an unmeasured entry that is not a record"
        )
    reasons = entry.get("reasons")
    if not isinstance(reasons, (list, tuple)) or not all(
        isinstance(reason, str) for reason in reasons
    ):
        raise CounterCorrupt(
            f"the day bucket {day!r} has an unmeasured entry without reasons"
        )
    call_id = entry.get("callId")
    if not isinstance(call_id, str):
        raise CounterCorrupt(
            f"the day bucket {day!r} has an unmeasured entry without a call id"
        )
    try:
        return UnmeasuredCharge(call_id, tuple(reasons))
    except ValueError as exc:
        raise CounterCorrupt(
            f"the day bucket {day!r} has an unreadable unmeasured entry: {exc}"
        ) from None


def _document(budget: DayBudget) -> dict[str, Any]:
    return {
        "recordVersion": RECORD_VERSION,
        "day": budget.day,
        "spent": _money_text(budget.spent),
        "reserved": {
            hold.call_id: _money_text(hold.amount) for hold in budget.reserved
        },
        "unmeasured": [
            {"callId": charge.call_id, "reasons": list(charge.reasons)}
            for charge in budget.unmeasured
        ],
        "crossed": [line for line in LINES if line in budget.crossed],
    }
