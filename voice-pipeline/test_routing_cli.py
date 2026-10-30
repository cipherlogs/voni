"""The routing-switch operator CLI: read the switch, then flip it (ticket 24).

``show`` prints the durable mode, its record version, when it was written and
the append-only audit trail. A never-written switch is not an error: it is
``off`` (fail-safe), because that is what every new call sees. A store that
cannot be read, or a row that is not a valid switch, is a named failure — the
operator must not mistake "unreadable" for "off".

``set`` flips future calls and leaves the audit entry. It refuses without an
operator and a reason, refuses a no-op, and refuses a lost compare-and-set by
name: there is no silent write and no unflagged flip.

The store is exactly one of ``--sqlite``/``CASCADE_STORE_PATH`` or
``--database-url``/``DATABASE_URL``. There is no hidden default, and the DSN is
never printed. Every test here writes a temporary SQLite file only.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import routing_switch  # noqa: E402

from cascade.routing import (  # noqa: E402
    KEY,
    RoutingRecord,
    RoutingSwitch,
    RoutingSwitchConflict,
)
from cascade.store import SqliteStore  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def read_row(path: Path) -> dict:
    with contextlib.closing(sqlite3.connect(path)) as connection:
        row = connection.execute(
            f"SELECT version, document FROM {SqliteStore(path).table} WHERE key = ?",
            (KEY,),
        ).fetchone()
    return {"version": row[0], "document": json.loads(row[1])} if row else {}


def write_corrupt_row(path: Path, version: int, document: dict) -> None:
    with contextlib.closing(sqlite3.connect(path)) as connection:
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {SqliteStore(path).table} "
            "(key TEXT PRIMARY KEY, version INTEGER NOT NULL, document TEXT NOT NULL)"
        )
        connection.execute(
            f"INSERT OR REPLACE INTO {SqliteStore(path).table} VALUES (?, ?, ?)",
            (KEY, version, json.dumps(document)),
        )
        connection.execute("COMMIT")


class CliCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "cascade.sqlite3"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def cli(self, *args: str, **kwargs):
        """Run ``main`` with captured streams; never read the process's env."""
        out, err = io.StringIO(), io.StringIO()
        code = routing_switch.main(
            list(args),
            environ=kwargs.pop("environ", {}),
            out=out,
            err=err,
            **kwargs,
        )
        return code, out.getvalue(), err.getvalue()

    def seed(self, **kwargs) -> None:
        switch = RoutingSwitch(SqliteStore(self.path), **kwargs)
        run(switch.set_mode("demo", actor="ops@voni", reason="seed"))


class StoreSelectionTest(CliCase):
    def test_no_store_is_refused_and_names_both_options(self):
        code, out, err = self.cli("show")

        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--sqlite", err)
        self.assertIn("CASCADE_STORE_PATH", err)
        self.assertIn("--database-url", err)
        self.assertIn("DATABASE_URL", err)
        self.assertIn("no store", err.lower())

    def test_both_stores_are_ambiguous_and_refuse_before_any_read(self):
        code, out, err = self.cli(
            "show",
            "--sqlite", str(self.path),
            "--database-url", "postgresql://ops:hunter2@db.invalid/cascade",
        )

        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("ambiguous", err.lower())
        self.assertNotIn("hunter2", err)
        self.assertFalse(self.path.exists(), "ambiguity must not open the sqlite store")

    def test_the_sqlite_environment_variable_is_the_same_source(self):
        code, out, err = self.cli(
            "show", environ={"CASCADE_STORE_PATH": str(self.path)}
        )

        self.assertEqual(code, 0, err)
        self.assertIn("off", out)

    def test_the_database_url_environment_variable_is_the_same_source(self):
        selection = routing_switch.resolve_selection(
            sqlite=None,
            database_url=None,
            environ={"DATABASE_URL": "postgresql://ops:hunter2@db.invalid/cascade"},
        )

        self.assertEqual(selection.kind, "postgres")
        self.assertNotIn("hunter2", repr(selection))
        self.assertNotIn("hunter2", str(selection))

    def test_a_flag_wins_over_its_own_environment_variable(self):
        selection = routing_switch.resolve_selection(
            sqlite=str(self.path),
            database_url=None,
            environ={"CASCADE_STORE_PATH": "/somewhere/else.sqlite3"},
        )

        self.assertEqual(selection.kind, "sqlite")
        self.assertEqual(selection.location, str(self.path))

    def test_a_blank_environment_variable_is_not_a_store(self):
        with self.assertRaises(routing_switch.StoreSelectionError) as caught:
            routing_switch.resolve_selection(
                sqlite=None, database_url=None, environ={"DATABASE_URL": "  "}
            )

        self.assertIn("no store", str(caught.exception).lower())


class ShowTest(CliCase):
    def test_a_missing_switch_is_off_and_fail_safe_not_an_error(self):
        code, out, err = self.cli("show", "--sqlite", str(self.path))

        self.assertEqual(code, 0, err)
        self.assertIn("off", out)
        self.assertIn("fail-safe", out)
        self.assertIn("no switch", out)
        self.assertIn("recordVersion: none", out)
        self.assertIn("decidedAt: none", out)

    def test_json_a_missing_switch_is_off_and_missing(self):
        code, out, err = self.cli("show", "--sqlite", str(self.path), "--json")

        self.assertEqual(code, 0, err)
        document = json.loads(out)
        self.assertEqual(document["mode"], "off")
        self.assertTrue(document["missing"])
        self.assertTrue(document["failSafe"])
        self.assertIsNone(document["recordVersion"])
        self.assertEqual(document["changes"], [])

    def test_show_prints_mode_version_decided_at_and_the_audit_trail(self):
        clock = iter([100.0, 200.0])
        switch = RoutingSwitch(SqliteStore(self.path), now=lambda: next(clock))
        run(switch.set_mode("demo", actor="ops@voni", reason="W1 rehearsal"))
        run(switch.set_mode("all", actor="sre@voni", reason="cutover"))

        code, out, err = self.cli("show", "--sqlite", str(self.path))

        self.assertEqual(code, 0, err)
        self.assertIn("routing switch: all", out)
        self.assertIn("recordVersion: 2", out)
        self.assertIn("decidedAt: 200.0", out)
        self.assertIn("ops@voni", out)
        self.assertIn("sre@voni", out)
        self.assertIn("unset → demo", out)
        self.assertIn("demo → all", out)
        self.assertIn("W1 rehearsal", out)
        self.assertIn("cutover", out)
        self.assertIn("100.0", out)

    def test_json_show_carries_the_whole_append_only_trail(self):
        clock = iter([100.0, 200.0])
        switch = RoutingSwitch(SqliteStore(self.path), now=lambda: next(clock))
        run(switch.set_mode("demo", actor="ops@voni", reason="W1 rehearsal"))
        run(switch.set_mode("all", actor="sre@voni", reason="cutover"))

        code, out, err = self.cli("show", "--sqlite", str(self.path), "--json")

        self.assertEqual(code, 0, err)
        document = json.loads(out)
        self.assertEqual(document["mode"], "all")
        self.assertEqual(document["recordVersion"], 2)
        self.assertEqual(document["decidedAt"], 200.0)
        self.assertFalse(document["missing"])
        self.assertEqual(
            document["changes"],
            [
                {"at": 100.0, "actor": "ops@voni", "from": "unset",
                 "to": "demo", "reason": "W1 rehearsal"},
                {"at": 200.0, "actor": "sre@voni", "from": "demo",
                 "to": "all", "reason": "cutover"},
            ],
        )


class SetTest(CliCase):
    def test_set_from_a_missing_switch_records_the_first_audit_entry(self):
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "ops@voni", "--reason", "cutover",
            now=lambda: 300.0,
        )

        self.assertEqual(code, 0, err)
        self.assertIn("unset → all", out)
        self.assertIn("recordVersion: 1", out)
        self.assertIn("decidedAt: 300.0", out)
        self.assertIn("fail-safe", out)
        row = read_row(self.path)
        self.assertEqual(row["document"]["mode"], "all")
        self.assertEqual(row["version"], 1)
        self.assertEqual(row["document"]["changes"][0]["actor"], "ops@voni")
        self.assertEqual(row["document"]["changes"][0]["reason"], "cutover")

    def test_set_demo_then_off_keeps_the_whole_trail(self):
        clock = iter([100.0, 200.0, 300.0])
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "demo",
            "--operator", "ops@voni", "--reason", "W1",
            now=lambda: next(clock),
        )
        self.assertEqual(code, 0, err)

        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "sre@voni", "--reason", "cutover",
            now=lambda: next(clock),
        )
        self.assertEqual(code, 0, err)

        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "off",
            "--operator", "ops@voni", "--reason", "rollback rehearsal",
            now=lambda: next(clock),
        )
        self.assertEqual(code, 0, err)
        self.assertIn("all → off", out)
        self.assertIn("rollback rehearsal", out)

        code, out, err = self.cli("show", "--sqlite", str(self.path), "--json")
        document = json.loads(out)
        self.assertEqual(document["mode"], "off")
        self.assertEqual(document["recordVersion"], 3)
        self.assertEqual(
            [(change["from"], change["to"], change["reason"])
             for change in document["changes"]],
            [
                ("unset", "demo", "W1"),
                ("demo", "all", "cutover"),
                ("all", "off", "rollback rehearsal"),
            ],
        )

    def test_json_set_reports_previous_new_version_and_decided_at(self):
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "demo",
            "--operator", "ops@voni", "--reason", "W1 rehearsal",
            "--json", now=lambda: 300.0,
        )

        self.assertEqual(code, 0, err)
        self.assertEqual(
            json.loads(out),
            {
                "previous": "unset",
                "mode": "demo",
                "recordVersion": 1,
                "decidedAt": 300.0,
                "operator": "ops@voni",
                "reason": "W1 rehearsal",
            },
        )

    def test_a_no_op_is_refused_by_name_and_writes_nothing(self):
        self.seed()
        before = read_row(self.path)

        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "demo",
            "--operator", "ops@voni", "--reason", "again",
        )

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("already", err)
        self.assertIn("demo", err)
        self.assertEqual(read_row(self.path), before)

    def test_an_empty_operator_is_refused_without_touching_the_store(self):
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "   ", "--reason", "cutover",
        )

        self.assertEqual(code, 1)
        self.assertIn("operator", err)
        self.assertFalse(self.path.exists())

    def test_an_empty_reason_is_refused_without_touching_the_store(self):
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "ops@voni", "--reason", "  ",
        )

        self.assertEqual(code, 1)
        self.assertIn("reason", err)
        self.assertFalse(self.path.exists())

    def test_a_missing_operator_or_reason_is_a_usage_error(self):
        for missing in ("--operator", "--reason"):
            code, out, err = self.cli(
                "set", "--sqlite", str(self.path), "--mode", "all",
                *self.pair_without(missing),
            )
            self.assertEqual(code, 2, missing)
            self.assertIn(missing, err)

    @staticmethod
    def pair_without(missing: str) -> tuple[str, ...]:
        pairs = {
            "--operator": ("--operator", "ops@voni"),
            "--reason": ("--reason", "cutover"),
        }
        keep = [value for name, value in pairs.items() if name != missing]
        return tuple(keep)

    def test_an_invalid_mode_is_refused_before_any_write(self):
        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "sometimes",
            "--operator", "ops@voni", "--reason", "cutover",
        )

        self.assertEqual(code, 2)
        self.assertIn("sometimes", err)
        self.assertFalse(self.path.exists())

    def test_a_cas_conflict_is_named_and_the_flip_is_not_claimed(self):
        class ConflictingSwitch:
            async def read(self):
                raise AssertionError("the CLI must use set_mode")

            async def set_mode(self, mode, *, actor, reason):
                raise RoutingSwitchConflict(
                    "another operator wrote the routing switch before this flip"
                )

        code, out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "ops@voni", "--reason", "cutover",
            switch_factory=lambda selection: ConflictingSwitch(),
        )

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("another operator", err)
        self.assertIn("re-read and retry", err)

    def test_the_retry_suffix_comes_from_the_conflict_type_not_the_prose(self):
        class ConflictingSwitch:
            async def read(self):
                raise AssertionError("the CLI must use set_mode")

            async def set_mode(self, mode, *, actor, reason):
                raise RoutingSwitchConflict(
                    "another operator wrote the switch; see the re-read runbook"
                )

        code, _out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "ops@voni", "--reason", "cutover",
            switch_factory=lambda selection: ConflictingSwitch(),
        )

        self.assertEqual(code, 1)
        self.assertEqual(err.count("re-read and retry"), 1)

    def test_other_prose_that_mentions_re_read_gets_no_retry_suffix(self):
        class ExplodingSwitch:
            async def set_mode(self, mode, *, actor, reason):
                raise RuntimeError("do not re-read this message as a conflict")

        code, _out, err = self.cli(
            "set", "--sqlite", str(self.path), "--mode", "all",
            "--operator", "ops@voni", "--reason", "cutover",
            switch_factory=lambda selection: ExplodingSwitch(),
        )

        self.assertEqual(code, 1)
        self.assertNotIn("re-read and retry", err)


class UnreadableStoreTest(CliCase):
    def test_a_corrupt_switch_is_a_named_failure_not_off(self):
        write_corrupt_row(self.path, 2, {
            "mode": "all", "recordVersion": 1,
            "changes": [{"at": 1.0, "actor": "ops@voni", "from": "unset",
                         "to": "all", "reason": ""}],
        })

        code, out, err = self.cli("show", "--sqlite", str(self.path))

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("corrupt", err)

    def test_an_unreadable_switch_is_a_named_failure_not_off(self):
        write_corrupt_row(self.path, 1, {
            "mode": "sometimes", "recordVersion": 1,
            "changes": [{"at": 1.0, "actor": "ops@voni", "from": "unset",
                         "to": "sometimes", "reason": ""}],
        })

        code, out, err = self.cli("show", "--sqlite", str(self.path))

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("unreadable", err)
        self.assertNotIn("off (fail-safe", out)

    def test_a_dead_store_is_a_named_failure_on_show_and_set(self):
        class DeadStore:
            async def read(self, key):
                raise routing_switch.StoreUnavailable("the durable store could not be reached")

            async def compare_and_set(self, key, expected_version, stored):
                raise routing_switch.StoreUnavailable("the durable store could not be reached")

            async def ping(self):
                raise routing_switch.StoreUnavailable("the durable store could not be reached")

        for args in (
            ("show",),
            ("set", "--mode", "all", "--operator", "ops@voni", "--reason", "cutover"),
        ):
            code, out, err = self.cli(
                *args, "--sqlite", str(self.path),
                switch_factory=lambda selection: RoutingSwitch(DeadStore()),
            )
            self.assertEqual(code, 1, args)
            self.assertIn("could not be reached", err)

    def test_the_output_never_repeats_a_database_password(self):
        dsn = "postgresql://ops:hunter2@db.invalid/cascade"

        class ExplodingSwitch:
            async def read(self):
                raise RuntimeError(f"connect failed for {dsn}")

            async def set_mode(self, mode, *, actor, reason):
                raise RuntimeError(f"connect failed for {dsn}")

        for args in (("show",), ("set", "--mode", "all", "--operator", "ops@voni",
                                 "--reason", "cutover")):
            code, out, err = self.cli(
                *args, "--database-url", dsn,
                switch_factory=lambda selection: ExplodingSwitch(),
            )
            self.assertEqual(code, 1, args)
            self.assertNotIn("hunter2", out + err)
            self.assertIn("database-url", (out + err).lower())


class StoreCloseTest(CliCase):
    RECORD = RoutingRecord.seeded("all", actor="ops@voni", at=1.0, reason="seed")

    class Store:
        def __init__(self, *, asynchronous: bool = False) -> None:
            self.closed = False
            self.asynchronous = asynchronous

        def close(self):
            self.closed = True
            if self.asynchronous:
                async def _done():
                    return None

                return _done()

    def switch(self, store, *, failure=None):
        record = self.RECORD

        class FakeSwitch:
            async def read(self):
                if failure is not None:
                    raise failure
                return record

            async def set_mode(self, mode, *, actor, reason):
                if failure is not None:
                    raise failure
                return record

        fake = FakeSwitch()
        fake.store = store
        return fake

    def test_the_store_is_closed_after_a_successful_show_and_set(self):
        for args in (
            ("show",),
            ("set", "--mode", "all", "--operator", "ops@voni", "--reason", "cutover"),
        ):
            store = self.Store(asynchronous=True)
            switch = self.switch(store)
            code, _out, err = self.cli(
                *args, "--sqlite", str(self.path),
                switch_factory=lambda selection: switch,
            )

            self.assertEqual(code, 0, err)
            self.assertTrue(store.closed, args)

    def test_the_store_is_closed_when_the_command_fails(self):
        store = self.Store()
        switch = self.switch(store, failure=RuntimeError("store blew up"))
        code, _out, err = self.cli(
            "show", "--sqlite", str(self.path),
            switch_factory=lambda selection: switch,
        )

        self.assertEqual(code, 1)
        self.assertIn("store blew up", err)
        self.assertTrue(store.closed)


class CliContractTest(unittest.TestCase):
    def test_help_lists_show_and_set_and_exits_zero(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = routing_switch.main(["--help"], environ={}, out=out, err=err)

        self.assertEqual(code, 0)
        self.assertIn("show", out.getvalue())
        self.assertIn("set", out.getvalue())
        self.assertIn("flip", out.getvalue().lower())

    def test_no_subcommand_is_a_usage_error(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = routing_switch.main([], environ={}, out=out, err=err)

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
