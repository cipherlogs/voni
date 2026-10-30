"""The deployment's shared durable store: Postgres over ``DATABASE_URL`` (139).

Ticket 135 recorded a Fly Postgres attachment as the concrete shared state: the
breaker record, the routing switch and the daily counter are read by both
machines through :class:`cascade.store.DurableStore`. This module is that
adapter. It keeps the store's contract exactly — a versioned document, reads
that always go to the database, and compare-and-set writes — so no caller
changes.

``asyncpg`` is imported lazily: the adapter constructs without a driver or a
reachable database, and the first operation reports an unreachable store
through :class:`cascade.store.StoreUnavailable`. Readiness (ticket 139) is the
caller that turns that into "not ready"; a live call keeps its last durable
record.

The connection string is never included in an error: a driver message can quote
it, and a database URL is a credential.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Mapping

from cascade.store import StoredDocument, StoreUnavailable

#: The table name is interpolated into SQL, so it is validated like the SQLite
#: adapter's before any statement is built.
_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

#: A small shared pool: two machines, one worker per container.
_POOL_MIN_SIZE = 1
_POOL_MAX_SIZE = 4


class PostgresStore:
    """A :class:`cascade.store.DurableStore` over one Postgres database."""

    def __init__(self, dsn: str, *, table: str = "cascade_records") -> None:
        if not isinstance(dsn, str) or not dsn.strip():
            raise ValueError(
                "DATABASE_URL must be a non-empty Postgres connection string"
            )
        if not _TABLE_NAME.match(table):
            raise ValueError(f"invalid table name {table!r}")
        self._dsn = dsn
        self.table = table
        self._pool: Any = None
        self._pool_lock = asyncio.Lock()

    async def _shared_pool(self) -> Any:
        if self._pool is not None:
            return self._pool
        try:
            import asyncpg
        except ImportError as exc:  # pragma: no cover - driver is a deploy dep
            raise StoreUnavailable(
                "the Postgres adapter needs asyncpg; install the service requirements"
            ) from exc
        async with self._pool_lock:
            if self._pool is None:
                try:
                    pool = await asyncpg.create_pool(
                        self._dsn,
                        min_size=_POOL_MIN_SIZE,
                        max_size=_POOL_MAX_SIZE,
                    )
                    async with pool.acquire() as connection:
                        await connection.execute(
                            f"CREATE TABLE IF NOT EXISTS {self.table} ("
                            "key TEXT PRIMARY KEY, "
                            "version INTEGER NOT NULL, "
                            "document TEXT NOT NULL)"
                        )
                except Exception as exc:
                    raise StoreUnavailable(
                        "the durable store could not be reached"
                    ) from exc
                self._pool = pool
        return self._pool

    async def read(self, key: str) -> StoredDocument | None:
        _check_key(key)
        pool = await self._shared_pool()
        try:
            async with pool.acquire() as connection:
                row = await connection.fetchrow(
                    f"SELECT version, document FROM {self.table} WHERE key = $1",
                    key,
                )
        except StoreUnavailable:
            raise
        except Exception as exc:
            raise StoreUnavailable(f"store read failed for {key!r}") from exc
        if row is None:
            return None
        return StoredDocument(version=row[0], document=json.loads(row[1]))

    async def compare_and_set(
        self, key: str, expected_version: int | None, stored: StoredDocument
    ) -> bool:
        _check_key(key)
        pool = await self._shared_pool()
        document = json.dumps(
            stored.document, sort_keys=True, separators=(",", ":")
        )
        try:
            async with pool.acquire() as connection:
                if expected_version is None:
                    row = await connection.fetchrow(
                        f"INSERT INTO {self.table} (key, version, document) "
                        "VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING "
                        "RETURNING key",
                        key,
                        stored.version,
                        document,
                    )
                    return row is not None
                result = await connection.execute(
                    f"UPDATE {self.table} SET version = $1, document = $2 "
                    "WHERE key = $3 AND version = $4",
                    stored.version,
                    document,
                    key,
                    expected_version,
                )
                return result == "UPDATE 1"
        except StoreUnavailable:
            raise
        except Exception as exc:
            raise StoreUnavailable(f"store write failed for {key!r}") from exc

    async def ping(self) -> None:
        pool = await self._shared_pool()
        try:
            async with pool.acquire() as connection:
                await connection.fetchval("SELECT 1")
        except StoreUnavailable:
            raise
        except Exception as exc:
            raise StoreUnavailable("store ping failed") from exc

    async def close(self) -> None:
        """Release the shared pool; safe when no connection was ever opened."""
        pool, self._pool = self._pool, None
        if pool is not None:
            await pool.close()

    def __repr__(self) -> str:
        # Never the DSN: a database URL is a credential.
        return f"PostgresStore(table={self.table!r})"


def _check_key(key: Any) -> str:
    if not isinstance(key, str) or not key:
        raise ValueError(f"store key must be a non-empty string, got {key!r}")
    return key
