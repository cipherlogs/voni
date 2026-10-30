#!/usr/bin/env python3
"""Read and flip the durable routing switch without a Python REPL (ticket 24).

    cd voice-pipeline
    # Read first: mode, recordVersion, decidedAt and the append-only audit trail.
    python scripts/routing_switch.py show --sqlite /srv/cascade.sqlite3
    python scripts/routing_switch.py show --database-url "$DATABASE_URL" --json

    # Then flip: future calls only, audited, and this is the runtime rollback.
    python scripts/routing_switch.py set --mode off \
        --operator ops@voni --reason "rollback rehearsal" \
        --database-url "$DATABASE_URL"

A never-written switch is ``off`` (fail-safe), because that is the answer every
new call already gets; it is not an error. A store that cannot be read, or a row
that is not a valid switch, is a named failure — the operator must never read
"unreadable" as "off".

The store is exactly one of ``--sqlite``/``CASCADE_STORE_PATH`` or
``--database-url``/``DATABASE_URL``. There is no hidden default, a flip needs a
named operator and a reason, and the DSN is never printed. A change governs new
calls only (ticket 24) and leaves who/when/from/to/reason behind, so tickets 153
(rehearsal), 155 (cutover) and 161 (decommission) can cite the record.

Exit codes: 0 read/flipped, 1 refused or unreadable (nothing written), 2 usage
or store-selection error. This command never records a gate verdict.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import inspect
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO

# Run as a script from `voice-pipeline/`; the flat module names live there.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cascade.pg_store import PostgresStore  # noqa: E402
from cascade.routing import (  # noqa: E402
    MODES,
    RoutingRecord,
    RoutingSwitch,
    RoutingSwitchConflict,
    RoutingSwitchCorrupt,
    RoutingSwitchError,
    RoutingSwitchMissing,
    RoutingSwitchUnchanged,
)
from cascade.store import SqliteStore, StoreUnavailable  # noqa: E402

USAGE = "Read or flip the durable routing switch (new calls only; no deploy)."

SQLITE_OPTIONS = "--sqlite PATH or CASCADE_STORE_PATH"
DSN_OPTIONS = "--database-url or DATABASE_URL"

_PASSWORD = re.compile(r"(://[^:/@\s]+:)[^@\s]+(@)")


class RoutingCliError(ValueError):
    """The operator's request cannot be carried out; nothing was written."""


class StoreSelectionError(RoutingCliError):
    """The durable store is missing or ambiguous, so there is no single switch."""


class RoutingUnreadable(RoutingCliError):
    """The switch exists or the store was named, but its value is not knowable."""


class RoutingConflictRefusal(RoutingCliError):
    """Another operator won the compare-and-set; the caller must re-read."""


@dataclass(frozen=True)
class StoreSelection:
    """The one store this command may touch; the DSN never appears in text."""

    kind: str
    location: str = field(repr=False)

    def __repr__(self) -> str:
        if self.kind == "sqlite":
            return f"StoreSelection(kind='sqlite', location={self.location!r})"
        return "StoreSelection(kind='postgres', location=<database-url>)"

    __str__ = __repr__

    def open_store(self):
        if self.kind == "sqlite":
            return SqliteStore(self.location)
        return PostgresStore(self.location)


def _nonblank(value: object) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def resolve_selection(
    *,
    sqlite: str | None = None,
    database_url: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> StoreSelection:
    """Exactly one store, from its flag or its environment variable."""
    env = os.environ if environ is None else environ
    sqlite_path = _nonblank(sqlite) or _nonblank(env.get("CASCADE_STORE_PATH"))
    dsn = _nonblank(database_url) or _nonblank(env.get("DATABASE_URL"))
    if sqlite_path and dsn:
        raise StoreSelectionError(
            f"ambiguous store: both {SQLITE_OPTIONS} and {DSN_OPTIONS} are set; "
            "pass exactly one, because one command must read one switch"
        )
    if sqlite_path:
        return StoreSelection("sqlite", sqlite_path)
    if dsn:
        return StoreSelection("postgres", dsn)
    raise StoreSelectionError(
        f"no store configured: pass {SQLITE_OPTIONS}, or pass {DSN_OPTIONS}; "
        "there is no hidden default"
    )


def open_switch(
    selection: StoreSelection, *, now: Callable[[], float] | None = None
) -> RoutingSwitch:
    """The routing switch over the selected store."""
    return RoutingSwitch(selection.open_store(), now=now or time.time)


def redact(message: str, selection: StoreSelection | None = None) -> str:
    """Never repeat a database URL or a password in operator-facing text."""
    if selection is not None and selection.kind == "postgres":
        message = message.replace(selection.location, "<database-url>")
    return _PASSWORD.sub(r"\1<redacted>\2", message)


def close_store(
    store: Any, err: TextIO, selection: StoreSelection | None
) -> None:
    """Release the store's pool when it owns one; a close failure is a warning.

    ``PostgresStore`` opens an asyncpg pool lazily. The CLI is a one-shot
    process, so leaving it open is a leaked connection, not a shutdown detail.
    """
    close = getattr(store, "close", None)
    if not callable(close):
        return
    try:
        result = close()
        if inspect.isawaitable(result):
            asyncio.run(result)
    except Exception as exc:  # noqa: BLE001 - a close failure is not the result
        err.write(
            "routing-switch: warning: store close failed: "
            f"{redact(str(exc), selection)}\n"
        )


def _number(value: float | None) -> str:
    return "none" if value is None else str(value)


def _changes(record: RoutingRecord) -> list[dict[str, Any]]:
    return [
        {
            "at": change.at,
            "actor": change.actor,
            "from": change.from_mode,
            "to": change.to_mode,
            "reason": change.reason,
        }
        for change in record.changes
    ]


async def read_view(switch: RoutingSwitch) -> dict[str, Any]:
    """The switch as data; missing is off, invalid/unreadable is a failure."""
    try:
        record = await switch.read()
    except RoutingSwitchMissing:
        return {
            "mode": "off",
            "recordVersion": None,
            "decidedAt": None,
            "missing": True,
            "failSafe": True,
            "changes": [],
        }
    except RoutingSwitchCorrupt as exc:
        raise RoutingUnreadable(f"routing switch is corrupt: {exc}") from None
    except RoutingSwitchError as exc:
        raise RoutingUnreadable(f"routing switch is unreadable: {exc}") from None
    except StoreUnavailable as exc:
        raise RoutingUnreadable(
            f"routing switch is unreadable: the durable store could not be reached ({exc})"
        ) from None
    except ValueError as exc:
        # A record whose mode/actor/timestamp is invalid is not an "off" switch.
        raise RoutingUnreadable(f"routing switch is unreadable: {exc}") from None
    return {
        "mode": record.mode,
        "recordVersion": record.record_version,
        "decidedAt": record.updated_at,
        "missing": False,
        "failSafe": False,
        "changes": _changes(record),
    }


def _check_set_request(mode: str, operator: object, reason: object) -> tuple[str, str]:
    """A flip needs a real mode, a named operator and a stated reason."""
    if mode not in MODES:
        raise RoutingCliError(f"unknown routing mode {mode!r}; expected one of {MODES}")
    if not isinstance(operator, str) or not operator.strip():
        raise RoutingCliError(
            "set needs a non-empty --operator: every change records who, when, from and to"
        )
    if not isinstance(reason, str) or not reason.strip():
        raise RoutingCliError(
            "set needs a non-empty --reason: a flip is a dated operator action, "
            "not a silent write"
        )
    return operator.strip(), reason.strip()


async def set_view(
    switch: RoutingSwitch, *, mode: str, operator: object, reason: object
) -> dict[str, Any]:
    """Flip future calls and return the audit entry that was written."""
    operator, reason = _check_set_request(mode, operator, reason)
    try:
        record = await switch.set_mode(mode, actor=operator, reason=reason)
    except RoutingSwitchUnchanged as exc:
        raise RoutingCliError(str(exc)) from None
    except RoutingSwitchConflict as exc:
        raise RoutingConflictRefusal(str(exc)) from None
    except StoreUnavailable as exc:
        raise RoutingCliError(f"the flip did not land: {exc}") from None
    except (RoutingSwitchError, ValueError) as exc:
        raise RoutingCliError(str(exc)) from None
    change = record.changes[-1]
    return {
        "previous": change.from_mode,
        "mode": record.mode,
        "recordVersion": record.record_version,
        "decidedAt": record.updated_at,
        "operator": change.actor,
        "reason": change.reason,
    }


def format_show(view: Mapping[str, Any]) -> str:
    if view["missing"]:
        return "\n".join(
            [
                "routing switch: off (fail-safe; no switch is stored)",
                "recordVersion: none",
                "decidedAt: none",
                "audit trail: none",
            ]
        )
    lines = [
        f"routing switch: {view['mode']}",
        f"recordVersion: {view['recordVersion']}",
        f"decidedAt: {_number(view['decidedAt'])}",
        "audit trail (append-only):",
    ]
    for change in view["changes"]:
        lines.append(
            f"  {_number(change['at'])}  {change['actor']}  "
            f"{change['from']} → {change['to']}  "
            f"reason: {change['reason'] or '(none)'}"
        )
    return "\n".join(lines)


def format_set(view: Mapping[str, Any]) -> str:
    lines = [
        f"routing switch: {view['previous']} → {view['mode']}",
        f"recordVersion: {view['recordVersion']}",
        f"decidedAt: {_number(view['decidedAt'])}",
        f"operator: {view['operator']}",
        f"reason: {view['reason']}",
    ]
    if view["previous"] == "unset":
        lines.append("note: no switch was stored; fail-safe was off")
    return "\n".join(lines)


def _emit_json(document: Mapping[str, Any], out: TextIO) -> None:
    out.write(f"{json.dumps(document, indent=2, sort_keys=False)}\n")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="routing_switch.py", description=USAGE)
    commands = parser.add_subparsers(dest="command", required=True)

    show = commands.add_parser("show", help="read the switch and its audit trail")
    show.add_argument("--json", action="store_true", help="print JSON")
    _add_store_arguments(show)

    flip = commands.add_parser("set", help="flip future calls; needs operator and reason")
    flip.add_argument("--mode", choices=MODES, required=True, help="off, demo or all")
    flip.add_argument("--operator", required=True, help="who is making the change")
    flip.add_argument("--reason", required=True, help="why the change is made")
    flip.add_argument("--json", action="store_true", help="print JSON")
    _add_store_arguments(flip)
    return parser


def _add_store_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--sqlite", default=None, help="local SQLite store path")
    parser.add_argument("--database-url", default=None, help="Postgres DSN (never printed)")


def main(
    argv: list[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
    now: Callable[[], float] | None = None,
    switch_factory: Callable[[StoreSelection], Any] | None = None,
) -> int:
    """Run one show/set command and return the process exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr

    with contextlib.redirect_stderr(err):
        try:
            args = _parser().parse_args(argv)
        except SystemExit as exc:
            return int(exc.code or 0)

    selection: StoreSelection | None = None
    try:
        if args.command == "set":
            # Refuse before touching a store: no operator/reason, no flip.
            _check_set_request(args.mode, args.operator, args.reason)
        selection = resolve_selection(
            sqlite=args.sqlite, database_url=args.database_url, environ=environ
        )
    except StoreSelectionError as exc:
        err.write(f"routing-switch: {redact(str(exc))}\n")
        return 2
    except RoutingCliError as exc:
        err.write(f"routing-switch: {redact(str(exc))}\n")
        return 1

    switch: Any = None
    try:
        switch = (
            switch_factory(selection)
            if switch_factory is not None
            else open_switch(selection, now=now)
        )
        if args.command == "show":
            view = asyncio.run(read_view(switch))
        else:
            view = asyncio.run(
                set_view(switch, mode=args.mode, operator=args.operator, reason=args.reason)
            )
    except RoutingConflictRefusal as exc:
        # The retry instruction belongs to the operator-facing layer; the
        # exception type, not its prose, decides that this was a CAS conflict.
        err.write(
            f"routing-switch: {redact(str(exc), selection)}; re-read and retry\n"
        )
        return 1
    except RoutingCliError as exc:
        err.write(f"routing-switch: {redact(str(exc), selection)}\n")
        return 1
    except Exception as exc:  # a store/driver failure is named, never a traceback
        err.write(
            f"routing-switch: {type(exc).__name__}: "
            f"{redact(str(exc), selection)}\n"
        )
        return 1
    finally:
        close_store(getattr(switch, "store", None), err, selection)

    if args.json:
        _emit_json(view, out)
    else:
        out.write(f"{format_show(view) if args.command == 'show' else format_set(view)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
