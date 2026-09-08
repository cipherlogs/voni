"""Persistence for the telephony bridge — Neon Postgres, via asyncpg.

Until now `server.py` held a good conversation and then threw all of it away:
it did not know who called, remembered nothing between calls, and stored no
transcript, outcome or recording. This module is the missing half. It writes
into the same Neon database the Next.js app reads (`voni/src/lib/db/schema.ts`),
so `/leads/[id]` and `/calls/[id]` have something real to render.

Three rules shape every design decision here, in priority order:

1. **A database problem must never break a live call.** The voice loop is the
   protected core of the plan; persistence is bookkeeping hanging off its side.
   Every public coroutine swallows its own exceptions and logs a warning. A
   dead database degrades us to exactly the behaviour we had before this file
   existed, which was shipping and acceptable.

2. **Nothing may run on the audio path.** `agent_to_telnyx` forwards 20 ms
   frames and the whole product was tuned, over five real calls, from 3.5s down
   to 2.5s of reply latency. A synchronous INSERT to Frankfurt inside that loop
   would hand back a chunk of that win. So per-turn writes are *enqueued*
   (`put_nowait`, no await on the DB) and drained by a background worker task.
   The queue is bounded: if the writer falls behind, turns are dropped with a
   warning rather than applying backpressure to the caller's audio.

3. **No DATABASE_URL means no persistence, not a crash.** The spike workflow
   (run the bridge, place a call, read the log) has to keep working untouched
   on a machine with no database configured.

Lifecycle, driven by `server.py`:

    call.initiated   -> open_call()      lead upsert + calls row
    session.ready    -> set_session_id()
    transcript.*     -> record_turn()    enqueued, off the hot path
    teardown         -> close_call()     ended_at + ordered transcript
    recording.saved  -> set_recording()
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import asyncpg
from loguru import logger

# Bounded on purpose. If the writer stalls, dropping transcript turns is the
# correct failure: losing bookkeeping beats adding jitter to a live phone call.
QUEUE_MAX = 500

# How long teardown waits for the writer to finish outstanding turns. Long
# enough to flush a normal call's backlog, short enough not to hold the
# WebSocket handler open if the database has gone away.
DRAIN_TIMEOUT = 5.0

_E164 = re.compile(r"[^\d+]")


def normalize_phone(raw: str | None) -> str | None:
    """Best-effort E.164. Telnyx already sends `+<digits>`; this just guards.

    Deliberately not a full libphonenumber parse — the canonical identity only
    has to be *stable*, and every number we see arrives from Telnyx in E.164
    already. A CSV import (plan Day 7-8) brings human-typed numbers and will
    need real parsing; do it there, not here, so this stays on the call path's
    budget.
    """
    if not raw:
        return None
    cleaned = _E164.sub("", raw.strip())
    if not cleaned:
        return None
    if not cleaned.startswith("+"):
        cleaned = "+" + cleaned
    return cleaned if len(cleaned) > 1 else None


class CallRecorder:
    """Owns the connection pool, the write queue, and per-call state."""

    def __init__(self) -> None:
        self._pool: asyncpg.Pool | None = None
        self._queue: asyncio.Queue[tuple[str, tuple[Any, ...]] | None] | None = None
        self._worker: asyncio.Task | None = None
        # call_control_id -> {"call_id", "lead_id", "turns": [...]}
        self._calls: dict[str, dict[str, Any]] = {}

    @property
    def enabled(self) -> bool:
        return self._pool is not None

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Open the pool and start the writer. Never raises."""
        url = os.environ.get("DATABASE_URL")
        if not url:
            logger.warning(
                "DATABASE_URL not set — calls will NOT be persisted. The bridge "
                "runs exactly as it did before persistence existed."
            )
            return
        try:
            # asyncpg speaks the binary protocol and rejects libpq-style query
            # args in the URL, which Neon's connection string carries.
            clean = url.split("?", 1)[0].replace("postgresql+asyncpg://", "postgresql://")
            self._pool = await asyncpg.create_pool(
                clean,
                min_size=1,
                # Small on purpose: one concurrent call needs one writer and one
                # occasional foreground read. This is a bridge, not a web app.
                max_size=4,
                # Neon scales to zero; the first connection after an idle period
                # pays a cold start. Fail fast rather than stalling call setup.
                timeout=10.0,
                command_timeout=10.0,
                ssl="require",
            )
            async with self._pool.acquire() as conn:
                await conn.execute("SELECT 1")
        except Exception as e:
            logger.warning(f"database unavailable, continuing without persistence: {e}")
            self._pool = None
            return

        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._worker = asyncio.create_task(self._drain())
        logger.info("persistence on — workspace comes from Voni bridge config")

    async def stop(self) -> None:
        """Flush outstanding writes and close the pool. Never raises."""
        try:
            if self._queue is not None and self._worker is not None:
                await self._queue.put(None)  # sentinel: finish and exit
                await asyncio.wait_for(self._worker, timeout=DRAIN_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("write queue did not drain in time; dropping the remainder")
            if self._worker:
                self._worker.cancel()
        except Exception as e:
            logger.warning(f"error stopping writer: {e}")
        finally:
            if self._pool is not None:
                try:
                    await self._pool.close()
                except Exception:
                    pass
                self._pool = None

    async def _drain(self) -> None:
        """Background writer. One statement at a time, order preserved."""
        assert self._queue is not None
        while True:
            item = await self._queue.get()
            try:
                if item is None:
                    return
                sql, args = item
                try:
                    async with self._pool.acquire() as conn:  # type: ignore[union-attr]
                        await conn.execute(sql, *args)
                except Exception as e:
                    # One bad write must not kill the writer — the next turn of
                    # the same call still deserves to land.
                    logger.warning(f"deferred write failed: {e}")
            finally:
                # Unconditional, including for the sentinel and for failed
                # writes: close_call() waits on queue.join(), and a single
                # missing task_done() would hang it until the drain timeout.
                self._queue.task_done()

    def _enqueue(self, sql: str, *args: Any) -> None:
        """Hand a write to the background worker. Never blocks, never raises."""
        if self._queue is None:
            return
        try:
            self._queue.put_nowait((sql, args))
        except asyncio.QueueFull:
            logger.warning("write queue full — dropping a row to protect call audio")

    # -- call lifecycle ----------------------------------------------------

    async def open_call(
        self,
        call_control_id: str,
        from_number: str | None,
        to_number: str | None,
        direction: str,
        organization_id: str,
        agent_id: str,
        campaign_id: str | None = None,
    ) -> None:
        """Upsert the Lead by phone and open a `calls` row.

        Awaited (not enqueued) because everything afterwards needs the ids, and
        it happens on the Telnyx *webhook* — a plain HTTP request handler that
        is not on the audio path. The media WebSocket has not been opened yet.
        """
        if not self.enabled:
            return
        # The lead is whoever is not us: the caller on an inbound call, the
        # person we dialled on an outbound one.
        lead_phone = normalize_phone(from_number if direction == "inbound" else to_number)
        if not lead_phone:
            logger.warning(
                f"no usable phone on {direction} call {call_control_id} "
                f"(from={from_number!r} to={to_number!r}); not persisting it"
            )
            return
        try:
            async with self._pool.acquire() as conn:  # type: ignore[union-attr]
                async with conn.transaction():
                    lead_id = await conn.fetchval(
                        """
                        INSERT INTO leads (organization_id, phone, source)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (organization_id, phone) DO UPDATE
                            SET updated_at = now()
                        RETURNING id
                        """,
                        organization_id,
                        lead_phone,
                        f"telephony:{direction}",
                    )
                    call_id = await conn.fetchval(
                        """
                        INSERT INTO calls (
                            lead_id, agent_id, campaign_id, direction, started_at,
                            telnyx_call_control_id
                        )
                        VALUES ($1, $2, $3, $4::direction, now(), $5)
                        RETURNING id
                        """,
                        lead_id,
                        agent_id,
                        campaign_id,
                        direction,
                        call_control_id,
                    )
            self._calls[call_control_id] = {
                "call_id": call_id,
                "lead_id": lead_id,
                "turns": [],
            }
            logger.info(
                f"call persisted: call_id={call_id} lead_id={lead_id} "
                f"phone={lead_phone} direction={direction}"
            )
        except Exception as e:
            logger.warning(f"could not open call row, continuing: {e}")

    def get_call_id(self, call_control_id: str) -> str | None:
        """Return the trusted Voni call id used by the tool API."""
        state = self._calls.get(call_control_id)
        return str(state["call_id"]) if state else None

    def set_session_id(self, call_control_id: str, session_id: str | None) -> None:
        """Attach the AssemblyAI session id — the key to its recording/timeline."""
        state = self._calls.get(call_control_id)
        if not state or not session_id:
            return
        self._enqueue(
            "UPDATE calls SET assemblyai_session_id = $1 WHERE id = $2",
            session_id,
            state["call_id"],
        )

    def record_turn(self, call_control_id: str, role: str, text: str | None) -> None:
        """Record one conversational turn. Called from the audio loop — enqueues only.

        Turns are written to `messages` with channel='call' as they happen, so a
        call that dies mid-conversation still keeps everything said up to that
        point. The ordered array is also written to `calls.transcript` at
        teardown: a deliberate denormalization so `/calls/[id]` is a single row
        read, while `messages` stays the one unified cross-channel timeline the
        plan's Section J is built around.
        """
        state = self._calls.get(call_control_id)
        if not state or not text:
            return
        direction = "inbound" if role == "user" else "outbound"
        state["turns"].append({"role": role, "text": text})
        self._enqueue(
            """
            INSERT INTO messages (lead_id, call_id, channel, direction, content)
            VALUES ($1, $2, 'call'::channel, $3::direction, $4)
            """,
            state["lead_id"],
            state["call_id"],
            direction,
            text,
        )

    def set_recording(self, call_control_id: str, url: str | None) -> None:
        """Store the Telnyx recording URL.

        Note this URL is presigned with a ten-minute expiry, so what lands in
        the column is a pointer that goes stale. Re-fetching or copying the
        audio into R2 is plan work (Section L), not something to do on the call
        path — storing it is still worth it because it names the object.
        """
        state = self._calls.get(call_control_id)
        if not state or not url:
            return
        self._enqueue(
            "UPDATE calls SET recording_url = $1 WHERE id = $2", url, state["call_id"]
        )

    async def close_call(self, call_control_id: str) -> None:
        """Write ended_at and the ordered transcript, then forget the call."""
        state = self._calls.pop(call_control_id, None)
        if not state or not self.enabled:
            return
        self._enqueue(
            "UPDATE calls SET ended_at = now(), transcript = $1::jsonb WHERE id = $2",
            json.dumps(state["turns"]),
            state["call_id"],
        )
        # Give the queue a moment to land this call's writes before the handler
        # returns. Bounded so a slow database cannot hold the WebSocket open.
        try:
            if self._queue is not None:
                await asyncio.wait_for(self._queue.join(), timeout=DRAIN_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("transcript writes still pending at teardown")
        logger.info(
            f"call closed: call_id={state['call_id']} turns={len(state['turns'])}"
        )


recorder = CallRecorder()
