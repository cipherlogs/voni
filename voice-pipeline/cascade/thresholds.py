"""The one registry for cascade bounds, and the refusal when one is missing.

The spec leaves operational numbers open (daily cap, per-call ceiling, deploy
drain wait, turn stall guard, tool loop cap, TTS keepalive, day boundary and
the browser E2E budget) and says a number invented in code is a review
failure. This module is where those numbers live, so a ticket that needs one
reads it here instead of growing a second copy.

A bound is one of three shapes, all stored in ``thresholds.json``:

* **open** — names its unit, the gate that consumes it and the ticket that
  owns it, and carries no value. ``require_bound`` raises
  :class:`UnsetBoundError` naming both the bound and the ticket.
* **literal** — carries ``value``, ``source`` and the ``date`` the value was
  taken. A value without a stated source, or without a date, is refused by
  the registry itself; nothing defaults it.
* **record-backed** — carries ``budget_key`` instead of a value. The value is
  read from the committed ``scoreboard-budgets.json`` at load time, so the
  frozen reply/cut budgets have exactly one home. Supplying a literal value
  alongside ``budget_key`` is refused (:class:`CopiedBudgetError`).

Ticket 04 records the open values by editing ``thresholds.json`` — a data
change, not a code change. Consumers call ``require_bound(name)`` (or the
``lookup`` alias) and never restate the number.

Settled constants that already have an owner in code (the floor arbitration
probability in ``turns.py``, for example) are deliberately *not* registered
here: copying one would create the second source this module exists to
prevent. When their owner moves them, they land here once.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: A bound's value. ``str`` exists for the day-boundary entry ("UTC").
BoundValue = int | float | str

#: The registry record that ships beside this module.
REGISTRY_PATH = Path(__file__).with_name("thresholds.json")

#: Deployment override for the budget record, matching the phone bridge.
BUDGET_RECORD_ENV = "VONI_SCOREBOARD_BUDGETS_JSON"

_FIELDS = frozenset(
    {"unit", "gate", "ticket", "value", "source", "date", "budget_key", "note"}
)
_DATE_SHAPE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SUPPORTED_REGISTRY_VERSION = 1


class ThresholdError(RuntimeError):
    """A cascade bound cannot be served honestly."""


class UnknownBoundError(ThresholdError):
    """No bound by that name is declared. A typo must not read as a default."""


class UnsetBoundError(ThresholdError):
    """A declared bound is open; the ticket that owns it must supply a value."""

    def __init__(self, entry: "Bound") -> None:
        self.name = entry.name
        self.ticket = entry.ticket
        self.gate = entry.gate
        super().__init__(
            f"bound {entry.name!r} is unset: ticket {entry.ticket} must supply a "
            f"value with a stated source and date (gate {entry.gate!r}); "
            "no default is substituted"
        )


class SourceRequiredError(ThresholdError):
    """A bound carries a value but does not say where the number came from."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(
            f"bound {name!r} carries a value without a stated source; "
            "a number invented in code is a review failure"
        )


class DateRequiredError(ThresholdError):
    """A bound carries a value but not the date the value was taken."""

    def __init__(self, name: str, detail: str = "missing or not YYYY-MM-DD") -> None:
        self.name = name
        super().__init__(
            f"bound {name!r} carries a value but its date is {detail}; "
            "record the date the value was taken"
        )


class CopiedBudgetError(ThresholdError):
    """A frozen budget was restated instead of read from its record."""

    def __init__(self, name: str, budget_key: str) -> None:
        self.name = name
        self.budget_key = budget_key
        super().__init__(
            f"bound {name!r} names budget_key {budget_key!r} and also carries a "
            "literal value; the frozen budget is read from the record, never copied"
        )


class DuplicateBoundError(ThresholdError):
    """The same bound is declared twice; one of the two would silently win."""

    def __init__(self, key: str) -> None:
        self.key = key
        super().__init__(
            f"duplicate declaration of {key!r} in the threshold registry; "
            "one entry per bound, or consumers disagree"
        )


class RegistryFormatError(ThresholdError):
    """The registry or the budget record cannot be read as declared."""


@dataclass(frozen=True)
class Bound:
    """One cascade bound with the provenance a reviewer needs to trust it."""

    name: str
    unit: str
    gate: str
    ticket: str
    value: BoundValue | None
    source: str
    date: str
    note: str = ""

    @property
    def is_open(self) -> bool:
        return self.value is None


class Registry:
    """An immutable view of every declared bound."""

    def __init__(self, bounds: Mapping[str, Bound]) -> None:
        self._bounds: dict[str, Bound] = dict(bounds)

    def names(self) -> tuple[str, ...]:
        return tuple(self._bounds)

    def bounds(self) -> tuple[Bound, ...]:
        return tuple(self._bounds.values())

    def open_bounds(self) -> tuple[Bound, ...]:
        return tuple(entry for entry in self._bounds.values() if entry.is_open)

    def bound(self, name: str) -> Bound:
        """Return the one entry for ``name`` (open entries included)."""
        try:
            return self._bounds[name]
        except KeyError:
            raise UnknownBoundError(
                f"unknown cascade bound {name!r}; declared bounds: "
                + ", ".join(sorted(self._bounds))
            ) from None

    def require(self, name: str) -> BoundValue:
        """Return the value for ``name`` or raise if the bound is still open."""
        entry = self.bound(name)
        if entry.value is None:
            raise UnsetBoundError(entry)
        return entry.value


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


def _read_json(path: Path, label: str) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise RegistryFormatError(f"cannot read {label} at {path}: {error}") from error
    try:
        return json.loads(text, object_pairs_hook=_unique_pairs)
    except _DuplicateKey as error:
        if label == "threshold registry":
            raise DuplicateBoundError(error.key) from None
        raise RegistryFormatError(
            f"duplicate key {error.key!r} in {label} at {path}"
        ) from None
    except json.JSONDecodeError as error:
        raise RegistryFormatError(
            f"{label} at {path} is not valid JSON: {error}"
        ) from error


def _declared_record(data: Mapping[str, Any], path: Path) -> dict[str, Any]:
    record = data.get("budget_record")
    if not isinstance(record, dict):
        raise RegistryFormatError(
            f"the threshold registry at {path} has no 'budget_record' object"
        )
    for field in ("path", "version", "date"):
        if field not in record:
            raise RegistryFormatError(
                f"the registry's budget_record at {path} is missing {field!r}"
            )
    if not isinstance(record["path"], str) or not record["path"]:
        raise RegistryFormatError(
            f"the registry's budget_record.path at {path} must be a path string"
        )
    if isinstance(record["version"], bool) or not isinstance(record["version"], int):
        raise RegistryFormatError(
            f"the registry's budget_record.version at {path} must be an integer"
        )
    if not isinstance(record["date"], str) or not _DATE_SHAPE.match(record["date"]):
        raise RegistryFormatError(
            f"the registry's budget_record.date at {path} must be YYYY-MM-DD"
        )
    return record


def _budget_record_path(declared: str, override: Path | None) -> Path:
    if override is not None:
        return Path(override).expanduser().resolve()
    from_env = os.environ.get(BUDGET_RECORD_ENV)
    if from_env:
        return Path(from_env).expanduser().resolve()
    relative = Path(declared)
    for parent in REGISTRY_PATH.resolve().parents:
        candidate = parent / relative
        if candidate.is_file():
            return candidate
    raise RegistryFormatError(
        f"cannot find {declared} above {REGISTRY_PATH}; "
        f"set {BUDGET_RECORD_ENV} to the record's path"
    )


def _load_budget_record(
    declared: Mapping[str, Any], override: Path | None
) -> tuple[dict[str, Any], Path, str]:
    path = _budget_record_path(declared["path"], override)
    record = _read_json(path, "budget record")
    if not isinstance(record, dict):
        raise RegistryFormatError(f"the budget record at {path} is not an object")
    if record.get("version") != declared["version"]:
        raise RegistryFormatError(
            f"the budget record at {path} is version {record.get('version')!r}, "
            f"but the registry expects {declared['version']!r}; a version bump "
            "needs a matching registry change"
        )
    budgets = record.get("budgets")
    if not isinstance(budgets, dict):
        raise RegistryFormatError(
            f"the budget record at {path} has no 'budgets' object"
        )
    return record, path, hashlib.sha256(path.read_bytes()).hexdigest()


def _text(entry: Mapping[str, Any], name: str, field: str) -> str:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RegistryFormatError(
            f"bound {name!r} must name its {field} (a non-empty string)"
        )
    return value.strip()


def _validate_value(name: str, value: Any) -> BoundValue:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise RegistryFormatError(
            f"bound {name!r} has a value that is not a number or string: {value!r}"
        )
    if isinstance(value, float) and not math.isfinite(value):
        raise RegistryFormatError(f"bound {name!r} has a non-finite value")
    if isinstance(value, str) and not value.strip():
        raise RegistryFormatError(f"bound {name!r} has a blank string value")
    return value


def _parse_bound(
    name: str,
    raw: Any,
    *,
    record: Mapping[str, Any],
    record_path: Path,
    record_digest: str,
    record_label: str,
    record_date: str,
) -> Bound:
    if not isinstance(raw, dict):
        raise RegistryFormatError(f"bound {name!r} must be an object, got {raw!r}")
    unknown = sorted(set(raw) - _FIELDS)
    if unknown:
        raise RegistryFormatError(
            f"bound {name!r} has unknown field(s) {', '.join(unknown)}; "
            f"allowed: {', '.join(sorted(_FIELDS))}"
        )

    unit = _text(raw, name, "unit")
    gate = _text(raw, name, "gate")
    ticket = _text(raw, name, "ticket")
    note = raw.get("note", "")
    if not isinstance(note, str):
        raise RegistryFormatError(f"bound {name!r} has a non-string note")

    budget_key = raw.get("budget_key")
    value = raw.get("value")
    source = raw.get("source", "")
    date = raw.get("date", "")

    if budget_key is not None:
        if value is not None:
            raise CopiedBudgetError(name, str(budget_key))
        if not isinstance(budget_key, str) or not budget_key.strip():
            raise RegistryFormatError(
                f"bound {name!r} has a budget_key that is not a key string"
            )
        budget_key = budget_key.strip()
        budgets = record["budgets"]
        if budget_key not in budgets:
            raise RegistryFormatError(
                f"bound {name!r} names budget_key {budget_key!r}, absent from "
                f"the budget record at {record_path}"
            )
        if source:
            raise RegistryFormatError(
                f"bound {name!r} is record-backed and also states a source; "
                "the record is the source"
            )
        if date:
            raise RegistryFormatError(
                f"bound {name!r} is record-backed and also states a date; "
                "the record's freeze date is the date"
            )
        return Bound(
            name=name,
            unit=unit,
            gate=gate,
            ticket=ticket,
            value=_validate_value(name, budgets[budget_key]),
            source=(
                f"{record_label}#{budget_key} "
                f"v{record.get('version')} sha256:{record_digest[:12]}"
            ),
            date=record_date,
            note=note,
        )

    if value is not None:
        if not isinstance(source, str) or not source.strip():
            raise SourceRequiredError(name)
        if not isinstance(date, str) or not _DATE_SHAPE.match(date.strip()):
            raise DateRequiredError(name)
        return Bound(
            name=name,
            unit=unit,
            gate=gate,
            ticket=ticket,
            value=_validate_value(name, value),
            source=source.strip(),
            date=date.strip(),
            note=note,
        )

    if source:
        raise RegistryFormatError(
            f"bound {name!r} states a source but carries no value; "
            "either supply the value or leave the bound open"
        )
    if date:
        raise RegistryFormatError(
            f"bound {name!r} states a date but carries no value; "
            "either supply the value or leave the bound open"
        )
    return Bound(
        name=name,
        unit=unit,
        gate=gate,
        ticket=ticket,
        value=None,
        source="",
        date="",
        note=note,
    )


def load_registry(
    *,
    path: Path | str | None = None,
    budgets_record: Path | str | None = None,
) -> Registry:
    """Load the registry, resolving record-backed bounds from the record.

    ``path`` overrides ``thresholds.json`` (tests and ticket 04's fixture).
    ``budgets_record`` overrides the budget record's location before the
    ``VONI_SCOREBOARD_BUDGETS_JSON`` deployment override.
    """
    registry_path = Path(path) if path is not None else REGISTRY_PATH
    data = _read_json(registry_path, "threshold registry")
    if not isinstance(data, dict):
        raise RegistryFormatError(
            f"the threshold registry at {registry_path} is not an object"
        )
    if data.get("version") != _SUPPORTED_REGISTRY_VERSION:
        raise RegistryFormatError(
            f"the threshold registry at {registry_path} is version "
            f"{data.get('version')!r}; this reader supports "
            f"{_SUPPORTED_REGISTRY_VERSION}"
        )

    declared = _declared_record(data, registry_path)
    record, record_path, record_digest = _load_budget_record(
        declared, Path(budgets_record) if budgets_record is not None else None
    )

    bounds_raw = data.get("bounds")
    if not isinstance(bounds_raw, dict) or not bounds_raw:
        raise RegistryFormatError(
            f"the threshold registry at {registry_path} declares no bounds"
        )

    parsed: dict[str, Bound] = {}
    for name, raw in bounds_raw.items():
        if not isinstance(name, str) or not name.strip():
            raise RegistryFormatError(
                f"the threshold registry at {registry_path} has a blank bound name"
            )
        parsed[name] = _parse_bound(
            name,
            raw,
            record=record,
            record_path=record_path,
            record_digest=record_digest,
            record_label=declared["path"],
            record_date=declared["date"],
        )
    return Registry(parsed)


REGISTRY: Registry = load_registry()


def reload() -> Registry:
    """Re-read the registry from disk, for a process that accepts new values."""
    global REGISTRY
    REGISTRY = load_registry()
    return REGISTRY


def bound(name: str) -> Bound:
    """Return the one entry for ``name``; open entries are included."""
    return REGISTRY.bound(name)


def require_bound(name: str) -> BoundValue:
    """Return a bound's value, or raise :class:`UnsetBoundError` by name."""
    return REGISTRY.require(name)


def lookup(name: str) -> BoundValue:
    """Consumer-facing alias for :func:`require_bound`."""
    return require_bound(name)


def bounds() -> tuple[Bound, ...]:
    """Every declared bound, open ones included."""
    return REGISTRY.bounds()


def open_bounds() -> tuple[Bound, ...]:
    """The bounds still waiting on ticket 04; each names its owning ticket."""
    return REGISTRY.open_bounds()
