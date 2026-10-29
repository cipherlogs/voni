"""A named rate table, and a call cost reproducible from recorded units.

Spec: `.scratch/meta-cascade/spec.md` M3 "Money and eyes" — "A named,
versioned table with per-leg rates... A price change is a new version, never an
edit. Every cost cites ``rateTableVersion``." Ticket 100's
:mod:`cascade.usage` records what the vendors reported; this module prices it
and never re-reads a vendor frame.

The table is data: one JSON file per version under ``cascade/rates/``. A rate is
USD per unit, stored as a decimal string so it loads exactly, and every rate
names its leg, unit, a human-readable source, the vendor price page and the date
the page was read. A rate that has no published source is recorded OPEN with the
reason and refuses to price anything; nothing defaults it.

Two absences are different and stay different:

* **unmeasured usage** — the vendor did not report the unit (ticket 100). The
  leg's cost is then unmeasured, never a partial sum.
* **an incomplete table** — the table declares no rate for a recorded unit. The
  leg's cost is unmeasured and the missing rate is named, never defaulted.

A sourced zero is neither: the TTS vendor reports audio and session seconds as
facts and bills only characters, so those two units carry an explicit ``0`` with
the vendor's billing statement as their source.

The LLM's cached and reasoning counts are details of prompt and completion
tokens, not separate purchases. ``cached_tokens`` is charged on its own line and
removed from the input charge; ``reasoning_tokens`` is charged on its own line
and removed from the completion charge. Charging both a parent and its detail
would bill the same token twice. The vendor's own frame says so: its
``total_tokens`` is ``prompt_tokens + completion_tokens`` while cached and
reasoning arrive inside their parent's details (ticket 100's captured usage
frame). If a frame ever contradicts that (a detail larger than its parent), the
leg is unmeasured and the contradiction is named; nothing is clamped.

Ticket 102 charges these costs to a day bucket and ticket 105 compares them with
a ceiling. Neither belongs here, and this module never invents a cap.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from cascade.usage import CallUsage, Units

#: The directory holding one record per price-table version.
RATES_DIR = Path(__file__).with_name("rates")

#: The version a caller gets when it does not ask for one.
DEFAULT_VERSION = 1

#: The record format this reader understands; a new price version is still a
#: new *price* version, not a new schema.
SUPPORTED_SCHEMA = 1

#: Units the vendor reports as a detail of another unit. The detail is a subset
#: of its parent, so it is priced on its own line and removed from the parent's
#: quantity; charging both would double-bill the same token.
DETAIL_UNITS: dict[str, str] = {
    "llm.cached_tokens": "prompt_tokens",
    "llm.reasoning_tokens": "completion_tokens",
}

_DATE_SHAPE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_RATE_FIELDS = frozenset(
    {"leg", "unit", "usd_per_unit", "source", "url", "date", "note"}
)
_TABLE_FIELDS = frozenset(
    {"schema", "name", "version", "currency", "date", "note", "rates"}
)


class CostError(RuntimeError):
    """A cost cannot be served honestly."""


class RateTableError(CostError):
    """The rate record cannot be read as declared."""


class UnknownRateError(CostError):
    """No rate by that name is declared; a typo must not read as a default."""

    def __init__(self, key: str, *declared: str) -> None:
        self.key = key
        super().__init__(
            f"unknown rate {key!r}; declared rates: " + ", ".join(sorted(declared))
        )


class OpenRateError(CostError):
    """A rate is declared but has no sourced price; it must not be defaulted."""

    def __init__(self, key: str, note: str = "") -> None:
        self.key = key
        super().__init__(
            f"rate {key!r} is OPEN: {note or 'no sourced price is recorded'}; "
            "record a value with a stated source and date instead of defaulting one"
        )


@dataclass(frozen=True)
class Rate:
    """One named price: USD per unit, with the provenance that justifies it."""

    key: str
    leg: str
    unit: str
    usd_per_unit: Decimal | None
    source: str
    url: str
    date: str
    note: str = ""

    @property
    def open(self) -> bool:
        """Whether this rate is still waiting for a sourced price."""
        return self.usd_per_unit is None

    def price(self, quantity: float) -> Decimal:
        """Price a quantity in USD, refusing an OPEN rate by name."""
        if self.usd_per_unit is None:
            raise OpenRateError(self.key, self.note)
        return _decimal(quantity) * self.usd_per_unit


@dataclass(frozen=True)
class RateTable:
    """An immutable, versioned set of named rates."""

    name: str
    version: int
    currency: str
    date: str
    entries: tuple[Rate, ...]

    def keys(self) -> tuple[str, ...]:
        return tuple(rate.key for rate in self.entries)

    def rates(self) -> tuple[Rate, ...]:
        return self.entries

    def get(self, key: str) -> Rate | None:
        """The named rate, or ``None`` when the table does not declare it."""
        return next((rate for rate in self.entries if rate.key == key), None)

    def require(self, key: str) -> Rate:
        """The named rate, refusing by name when it is absent or still open."""
        rate = self.get(key)
        if rate is None:
            raise UnknownRateError(key, *self.keys())
        if rate.open:
            raise OpenRateError(key, rate.note)
        return rate

    def price(self, key: str, quantity: float) -> Decimal:
        """Price one quantity in the table's currency, or refuse by name."""
        return self.require(key).price(quantity)

    def to_document(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "currency": self.currency,
        }


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


class _DuplicateKey(Exception):
    def __init__(self, key: str) -> None:
        self.key = key


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise _DuplicateKey(key)
        seen[key] = value
    return seen


def _decimal(value: Any) -> Decimal:
    if isinstance(value, bool):
        raise RateTableError(f"a rate cannot be a boolean: {value!r}")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise RateTableError(
            f"a rate must be a decimal number, got {value!r}"
        ) from None
    if not number.is_finite():
        raise RateTableError(f"a rate must be finite, got {value!r}")
    if number < 0:
        raise RateTableError(f"a rate cannot be negative, got {value!r}")
    return number


def _text(entry: Mapping[str, Any], key: str, field: str) -> str:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RateTableError(f"rate {key!r} must name its {field} (a non-empty string)")
    return value.strip()


def _date(entry: Mapping[str, Any], key: str) -> str:
    value = _text(entry, key, "date")
    if not _DATE_SHAPE.match(value):
        raise RateTableError(
            f"rate {key!r} must state its date as YYYY-MM-DD, got {value!r}"
        )
    return value


def _table_text(data: Mapping[str, Any], field: str, path: Path) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RateTableError(
            f"the rate table at {path} must name its {field} (a non-empty string)"
        )
    return value.strip()


def _parse_rate(key: str, raw: Any) -> Rate:
    if not isinstance(raw, dict):
        raise RateTableError(f"rate {key!r} must be an object, got {raw!r}")
    unknown = sorted(set(raw) - _RATE_FIELDS)
    if unknown:
        raise RateTableError(
            f"rate {key!r} has unknown field(s) {', '.join(unknown)}; "
            f"allowed: {', '.join(sorted(_RATE_FIELDS))}"
        )
    leg = _text(raw, key, "leg")
    unit = _text(raw, key, "unit")
    if key != f"{leg}.{unit}":
        raise RateTableError(
            f"rate {key!r} must be keyed as '<leg>.<unit>', got {leg!r}.{unit!r}"
        )
    note = raw.get("note", "")
    if not isinstance(note, str):
        raise RateTableError(f"rate {key!r} has a non-string note")

    value = raw.get("usd_per_unit")
    if value is None:
        if raw.get("source") or raw.get("url") or raw.get("date"):
            raise RateTableError(
                f"rate {key!r} is OPEN and also states a source, url or date; "
                "either supply a price with its provenance or leave it open"
            )
        if not note.strip():
            raise RateTableError(
                f"rate {key!r} is OPEN but does not say why; record the missing "
                "vendor price in its note"
            )
        return Rate(
            key=key,
            leg=leg,
            unit=unit,
            usd_per_unit=None,
            source="",
            url="",
            date="",
            note=note,
        )

    source = _text(raw, key, "source")
    url = _text(raw, key, "url")
    if not url.startswith("https://"):
        raise RateTableError(
            f"rate {key!r} must cite its vendor price page as https://, got {url!r}"
        )
    date = _date(raw, key)
    return Rate(
        key=key,
        leg=leg,
        unit=unit,
        usd_per_unit=_decimal(value),
        source=source,
        url=url,
        date=date,
        note=note,
    )


def _read_record(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise RateTableError(
            f"cannot read the rate table at {path}: {error}"
        ) from error
    try:
        data = json.loads(text, object_pairs_hook=_unique_pairs)
    except _DuplicateKey as error:
        raise RateTableError(f"duplicate rate {error.key!r} in {path}") from None
    except json.JSONDecodeError as error:
        raise RateTableError(
            f"the rate table at {path} is not valid JSON: {error}"
        ) from error
    if not isinstance(data, dict):
        raise RateTableError(f"the rate table at {path} is not an object")
    unknown = sorted(set(data) - _TABLE_FIELDS)
    if unknown:
        raise RateTableError(
            f"the rate table at {path} has unknown field(s) {', '.join(unknown)}"
        )
    if data.get("schema") != SUPPORTED_SCHEMA:
        raise RateTableError(
            f"the rate table at {path} is schema {data.get('schema')!r}; "
            f"this reader supports {SUPPORTED_SCHEMA}"
        )
    return data


def load_rate_table(
    *, version: int | None = None, path: Path | str | None = None
) -> RateTable:
    """Load one price version; the version file is its own history.

    ``path`` pins a record explicitly (fixtures, a rollback to an older
    version). Otherwise ``version`` selects ``cascade/rates/v<version>.json`` and
    defaults to :data:`DEFAULT_VERSION`.
    """
    if path is not None:
        table_path = Path(path)
    else:
        table_path = (
            RATES_DIR / f"v{DEFAULT_VERSION if version is None else version}.json"
        )
    data = _read_record(table_path)

    name = _table_text(data, "name", table_path)
    table_version = data.get("version")
    if isinstance(table_version, bool) or not isinstance(table_version, int):
        raise RateTableError(
            f"the rate table at {table_path} must state an integer version"
        )
    if table_version < 1:
        raise RateTableError(
            f"the rate table at {table_path} must be version 1 or later, "
            f"got {table_version}"
        )
    if version is not None and table_version != version:
        raise RateTableError(
            f"asked for rate table version {version}, but {table_path} is version "
            f"{table_version}"
        )
    currency = _table_text(data, "currency", table_path)
    date = _table_text(data, "date", table_path)
    if not _DATE_SHAPE.match(date):
        raise RateTableError(
            f"the rate table at {table_path} must date itself as YYYY-MM-DD"
        )

    rates_raw = data.get("rates")
    if not isinstance(rates_raw, dict) or not rates_raw:
        raise RateTableError(f"the rate table at {table_path} declares no rates")
    entries = tuple(_parse_rate(key, raw) for key, raw in rates_raw.items())
    return RateTable(
        name=name,
        version=table_version,
        currency=currency,
        date=date,
        entries=entries,
    )


RATE_TABLE: RateTable = load_rate_table()


# --------------------------------------------------------------------------
# Pricing a call
# --------------------------------------------------------------------------


class UnmeasuredCostError(CostError):
    """A total was demanded while at least one leg has no measured cost."""

    def __init__(self, reasons: tuple[str, ...]) -> None:
        self.reasons = reasons
        super().__init__("the call's cost is unmeasured: " + "; ".join(reasons))


@dataclass(frozen=True)
class Line:
    """One unit's charge: what the vendor reported, what was billed, and why."""

    rate: str
    reported: int | float
    billed: int | float
    amount: Decimal

    def to_document(self) -> dict[str, Any]:
        return {
            "rate": self.rate,
            "reported": self.reported,
            "billed": self.billed,
            "amount": _amount_text(self.amount),
        }


@dataclass(frozen=True)
class LegCost:
    """One leg's cost, or the named reasons it has none."""

    leg: str
    amount: Decimal | None
    lines: tuple[Line, ...] = ()
    reasons: tuple[str, ...] = ()

    @property
    def measured(self) -> bool:
        return self.amount is not None

    def to_document(self) -> dict[str, Any]:
        return {
            "measured": self.measured,
            "amount": None if self.amount is None else _amount_text(self.amount),
            "lines": [line.to_document() for line in self.lines],
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class CallCost:
    """A priced call: per leg and in total, in the table's currency.

    The total is a sum only when every leg is measured. One unmeasured leg (an
    absent vendor unit, an incomplete table, an OPEN rate) makes the total
    unmeasured: a partial sum is never presented as a complete cost.
    """

    table: RateTable
    legs: tuple[LegCost, ...]

    @property
    def measured(self) -> bool:
        return bool(self.legs) and all(leg.measured for leg in self.legs)

    @property
    def amount(self) -> Decimal | None:
        if not self.measured:
            return None
        return sum((leg.amount for leg in self.legs), Decimal(0))

    @property
    def reasons(self) -> tuple[str, ...]:
        return tuple(
            f"{leg.leg}: {reason}" for leg in self.legs for reason in leg.reasons
        )

    def leg(self, name: str) -> LegCost:
        for leg in self.legs:
            if leg.leg == name:
                return leg
        raise CostError(f"no such leg {name!r} in this call cost")

    def require_amount(self) -> Decimal:
        """The total, or :class:`UnmeasuredCostError` naming every reason."""
        amount = self.amount
        if amount is None:
            raise UnmeasuredCostError(self.reasons)
        return amount

    def to_document(self) -> dict[str, Any]:
        return {
            "rateTable": self.table.to_document(),
            "measured": self.measured,
            "amount": None if self.amount is None else _amount_text(self.amount),
            "legs": {leg.leg: leg.to_document() for leg in self.legs},
        }


def _amount_text(value: Decimal) -> str:
    """A fixed-point decimal string, never scientific notation."""
    return format(value.normalize(), "f")


def _billed_quantities(
    leg: str, quantities: dict[str, int | float]
) -> tuple[dict[str, int | float] | None, str]:
    """Net a parent unit of its vendor-reported detail.

    Returns the billed quantities, or ``None`` and the reason when the vendor's
    own numbers contradict each other (a detail larger than its parent). The
    caller turns that reason into an unmeasured leg; nothing is clamped.
    """
    billed = dict(quantities)
    for key, parent in DETAIL_UNITS.items():
        detail_leg, detail = key.split(".", 1)
        if detail_leg != leg or detail not in quantities or parent not in quantities:
            continue
        if quantities[detail] > quantities[parent]:
            return (
                None,
                (
                    f"{key}={quantities[detail]} is larger than its parent "
                    f"{leg}.{parent}={quantities[parent]}; a detail cannot "
                    "exceed the unit that contains it"
                ),
            )
        billed[parent] = quantities[parent] - quantities[detail]
    return billed, ""


def _price_leg(leg: str, units: Units, table: RateTable) -> LegCost:
    if not units.units:
        return LegCost(
            leg,
            None,
            reasons=(f"the meter recorded no units for the {leg} leg",),
        )

    reasons: list[str] = []
    rates: dict[str, Rate] = {}
    for unit in units.units:
        key = f"{leg}.{unit.name}"
        rate = table.get(key)
        if rate is None:
            reasons.append(f"{table.name} v{table.version} declares no rate for {key}")
        elif rate.open:
            reasons.append(
                f"rate {key} is OPEN in {table.name} v{table.version}: "
                f"{rate.note or 'no sourced price is recorded'}"
            )
        elif not unit.measured:
            reasons.append(
                f"{key} is unmeasured: {unit.source or 'the vendor did not report it'}"
            )
        else:
            rates[unit.name] = rate

    if reasons:
        return LegCost(leg, None, reasons=tuple(reasons))

    quantities = {unit.name: unit.quantity for unit in units.units}
    billed, contradiction = _billed_quantities(leg, quantities)
    if billed is None:
        return LegCost(leg, None, reasons=(contradiction,))
    lines = tuple(
        Line(
            rate=f"{leg}.{name}",
            reported=quantities[name],
            billed=billed[name],
            amount=rates[name].price(billed[name]),
        )
        for name in quantities
    )
    return LegCost(leg, sum((line.amount for line in lines), Decimal(0)), lines)


def cost_call(call_usage: CallUsage, *, table: RateTable | None = None) -> CallCost:
    """Price every recorded unit of one call against one rate-table version.

    Pricing never reads a vendor frame and never estimates a quantity: it
    multiplies ticket 100's recorded units by this table's rates. An unmeasured
    unit, a missing rate or an OPEN rate makes that leg unmeasured and names the
    reason; no leg is ever defaulted to zero.
    """
    selected = RATE_TABLE if table is None else table
    return CallCost(
        selected,
        tuple(_price_leg(leg, units, selected) for leg, units in call_usage.legs),
    )
