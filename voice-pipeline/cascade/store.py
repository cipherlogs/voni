"""Versioned compare-and-set store for cascade control records.

The breaker record (``cascade.breaker``) and the routing switch are the only
things that decide which provider rung a new call uses, so every instance must
read the same durable value. This module is the storage seam:

* :class:`DurableStore` is the protocol every adapter implements. Every read
  goes to the adapter; there is no module-level cache.
* :class:`MemoryStore` is an offline fake for tests (it can also simulate an
  outage).
* :class:`SqliteStore` is the offline durable adapter. It is honest about its
  limit: SQLite is safe for one host, or for several processes on a shared
  filesystem with advisory locking. It is **not** a multi-instance production
  store; the deployment adapter (asyncpg over ``DATABASE_URL``, ticket 135)
  implements the same protocol without changing any caller.

A document is stored with an integer version. ``compare_and_set`` writes only
when the caller states the version it read, so two writers cannot silently
overwrite each other; the loser gets ``False`` and must re-read.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, runtime_checkable

_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class StoreUnavailable(RuntimeError):
    """The durable store could not be read or written.

    Callers decide what an outage means: the breaker fails closed to the last
    durable state and keeps a live call running (ticket 21), readiness reports
    not-ready (ticket 139).
    """


@dataclass(frozen=True)
class StoredDocument:
    """One JSON document plus the version it was written at."""

    version: int
    document: Mapping[str, Any]

    def __post_init__(self) -> None:
        if isinstance(self.version, bool) or not isinstance(self.version, int):
            raise ValueError(f"store version must be an int, got {self.version!r}")
        if self.version < 1:
            raise ValueError(f"store version must be >= 1, got {self.version!r}")
        if not isinstance(self.document, Mapping):
            raise ValueError("store document must be a mapping")


@runtime_checkable
class DurableStore(Protocol):
    """A versioned key/document store shared by every instance."""

    async def read(self, key: str) -> StoredDocument | None:
        """Return the durable document, or ``None`` when the key is unset.

        Raises :class:`StoreUnavailable` when the store cannot be reached.
        """

    async def compare_and_set(
        self, key: str, expected_version: int | None, stored: StoredDocument
    ) -> bool:
        """Write ``stored`` only when the durable version is ``expected_version``.

        ``expected_version`` is ``None`` for creation. Returns ``False`` when
        another writer got there first; the caller must re-read.
        """

    async def ping(self) -> None:
        """Raise :class:`StoreUnavailable` when the store is not reachable."""


def _check_key(key: str) -> str:
    if not isinstance(key, str) or not key:
        raise ValueError(f"store key must be a non-empty string, got {key!r}")
    return key


def _check_expected(expected_version: int | None) -> int | None:
    if expected_version is None:
        return None
    if isinstance(expected_version, bool) or not isinstance(expected_version, int):
        raise ValueError(f"expected_version must be an int or None, got {expected_version!r}")
    if expected_version < 1:
        raise ValueError(f"expected_version must be >= 1, got {expected_version!r}")
    return expected_version


class MemoryStore:
    """In-memory :class:`DurableStore` for tests, with an outage switch."""

    def __init__(self, initial: Mapping[str, StoredDocument] | None = None) -> None:
        self.rows: dict[str, StoredDocument] = dict(initial or {})
        self.fail_reads = False
        self.fail_writes = False
        self.fail_pings = False

    async def read(self, key: str) -> StoredDocument | None:
        _check_key(key)
        if self.fail_reads:
            raise StoreUnavailable(f"memory store read failed for {key!r}")
        return self.rows.get(key)

    async def compare_and_set(
        self, key: str, expected_version: int | None, stored: StoredDocument
    ) -> bool:
        _check_key(key)
        expected_version = _check_expected(expected_version)
        if self.fail_writes:
            raise StoreUnavailable(f"memory store write failed for {key!r}")
        current = self.rows.get(key)
        if expected_version is None:
            if current is not None:
                return False
        elif current is None or current.version != expected_version:
            return False
        self.rows[key] = stored
        return True

    async def ping(self) -> None:
        if self.fail_pings:
            raise StoreUnavailable("memory store ping failed")


class SqliteStore:
    """Offline durable :class:`DurableStore` backed by one SQLite file.

    Every operation opens its own connection and uses ``BEGIN IMMEDIATE`` for
    writes, so several instances on the same file agree and a crashed process
    never leaves a half-written row. ``read`` remembers the last document it
    successfully read per key and returns that when the file becomes
    unreadable, which is the "failed read returns the last durable state"
    rule. If the key was never read successfully, the read raises
    :class:`StoreUnavailable` rather than inventing a healthy record.

    Not a multi-instance production store: see the module docstring.
    """

    def __init__(self, path: str | Path, *, table: str = "cascade_records") -> None:
        if not _TABLE_NAME.match(table):
            raise ValueError(f"invalid table name {table!r}")
        self.path = str(path)
        self.table = table
        self._last_durable: dict[str, StoredDocument] = {}

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0, isolation_level=None)
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {self.table} ("
            "key TEXT PRIMARY KEY, "
            "version INTEGER NOT NULL, "
            "document TEXT NOT NULL)"
        )
        return connection

    async def read(self, key: str) -> StoredDocument | None:
        _check_key(key)
        try:
            stored = self._read_once(key)
        except (sqlite3.Error, OSError, ValueError) as exc:
            durable = self._last_durable.get(key)
            if durable is not None:
                return durable
            raise StoreUnavailable(f"store read failed for {key!r}") from exc
        if stored is not None:
            self._last_durable[key] = stored
        return stored

    def _read_once(self, key: str) -> StoredDocument | None:
        with self._connect() as connection:
            row = connection.execute(
                f"SELECT version, document FROM {self.table} WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        return StoredDocument(version=row[0], document=json.loads(row[1]))

    async def compare_and_set(
        self, key: str, expected_version: int | None, stored: StoredDocument
    ) -> bool:
        _check_key(key)
        expected_version = _check_expected(expected_version)
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT version FROM {self.table} WHERE key = ?", (key,)
            ).fetchone()
            current = None if row is None else row[0]
            if expected_version is None:
                if current is not None:
                    connection.execute("ROLLBACK")
                    return False
                connection.execute(
                    f"INSERT INTO {self.table} (key, version, document) VALUES (?, ?, ?)",
                    (key, stored.version, _dump(stored.document)),
                )
            else:
                if current != expected_version:
                    connection.execute("ROLLBACK")
                    return False
                connection.execute(
                    f"UPDATE {self.table} SET version = ?, document = ? "
                    "WHERE key = ? AND version = ?",
                    (stored.version, _dump(stored.document), key, expected_version),
                )
            connection.execute("COMMIT")
        except sqlite3.Error as exc:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise StoreUnavailable(f"store write failed for {key!r}") from exc
        finally:
            connection.close()
        self._last_durable[key] = stored
        return True

    async def ping(self) -> None:
        try:
            with self._connect() as connection:
                connection.execute("SELECT 1").fetchone()
        except (sqlite3.Error, OSError) as exc:
            raise StoreUnavailable("store ping failed") from exc


def _dump(document: Mapping[str, Any]) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))
