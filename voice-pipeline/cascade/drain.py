"""Drain on deploy: fail readiness, refuse new calls, let live calls finish (140).

SIGTERM is the deploy's question, and this module is the supervisor that
answers it:

1. flip the :class:`cascade.health.DrainState` the server already reads, so
   ``/readyz`` fails and a new call is refused by name while live calls are
   untouched;
2. wait for every call being served to finish, bounded by the recorded
   ``deploy.drain_max_wait_ms`` from :mod:`cascade.thresholds` — reaching the
   bound is *reported*, never a reason to terminate a call;
3. ask the process to exit only after the wait returns.

The supervisor never cancels a call task: it observes :class:`LiveCalls` and
waits. A call that outlives the bound is left running and the exit is a
deployment-policy event (the platform's ``kill_timeout``), not this module
killing a call.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from cascade.health import DrainState
from cascade.thresholds import require_bound

#: The one operational bound this module consumes (ticket 04 recorded the value).
DRAIN_BOUND = "deploy.drain_max_wait_ms"

#: The reason a SIGTERM drain reports when no caller names one.
DEFAULT_REASON = "deploy"

LOGGER = logging.getLogger("cascade.drain")


class LiveCalls:
    """How many calls this process is serving right now, and when it is idle.

    ``started``/``finished`` bracket one served call; ``wait_idle`` resolves
    when the count reaches zero. The counter is the only thing the drain
    observes, so a live call is never inspected, cancelled or closed.
    """

    def __init__(self) -> None:
        self._count = 0
        self._idle = asyncio.Event()
        self._idle.set()

    def started(self) -> None:
        if self._count == 0:
            self._idle.clear()
        self._count += 1

    def finished(self) -> None:
        if self._count == 0:
            raise ValueError("a call finished that never started")
        self._count -= 1
        if self._count == 0:
            self._idle.set()

    @property
    def count(self) -> int:
        return self._count

    @property
    def idle(self) -> bool:
        return self._count == 0

    async def wait_idle(self) -> None:
        """Wait until no call is being served. Returns at once when idle."""
        await self._idle.wait()


@dataclass(frozen=True)
class DrainOutcome:
    """What the drain waited for and how it ended."""

    reason: str
    live_calls_at_start: int
    finished: bool
    timed_out: bool
    waited_ms: int
    remaining: int

    def to_document(self) -> dict[str, Any]:
        return {
            "drainReason": self.reason,
            "liveCallsAtStart": self.live_calls_at_start,
            "finished": self.finished,
            "timedOut": self.timed_out,
            "waitedMs": self.waited_ms,
            "remaining": self.remaining,
        }


class DrainSupervisor:
    """One deploy: flip the drain, wait for live calls, then let the process exit."""

    def __init__(
        self,
        *,
        drain: DrainState,
        live_calls: LiveCalls,
        max_wait_ms: int | None = None,
        logger: logging.Logger | None = None,
        now: Callable[[], float] = time.monotonic,
        wait_for: Callable[..., Awaitable[Any]] = asyncio.wait_for,
    ) -> None:
        self._drain = drain
        self._live = live_calls
        self._logger = logger if logger is not None else LOGGER
        self._now = now
        self._wait_for = wait_for
        self.max_wait_ms = int(
            require_bound(DRAIN_BOUND) if max_wait_ms is None else max_wait_ms
        )
        if self.max_wait_ms <= 0:
            raise ValueError(
                f"drain wait must be positive, got {self.max_wait_ms} ms"
            )
        self._outcome: DrainOutcome | None = None
        self._started_at: float | None = None

    @property
    def started(self) -> bool:
        return self._started_at is not None

    def start(self, reason: str = DEFAULT_REASON) -> None:
        """SIGTERM: fail readiness and refuse new calls; live calls continue."""
        self._drain.start(reason)
        if self._started_at is None:
            self._started_at = self._now()
            self._logger.info(
                "draining (%s): %d live call(s) may finish; new calls are refused",
                reason,
                self._live.count,
            )

    async def wait(self) -> DrainOutcome:
        """Wait for live calls to finish, at most the recorded bound."""
        if self._started_at is None:
            raise RuntimeError("the drain has not started; call start() on SIGTERM first")
        if self._outcome is not None:
            return self._outcome

        at_start = self._live.count
        timeout_s = self.max_wait_ms / 1000
        try:
            await self._wait_for(self._live.wait_idle(), timeout=timeout_s)
        except TimeoutError:
            outcome = DrainOutcome(
                reason=self._drain.reason,
                live_calls_at_start=at_start,
                finished=False,
                timed_out=True,
                waited_ms=self._elapsed_ms(),
                remaining=self._live.count,
            )
            self._logger.warning(
                "%s reached (%d ms); %d live call(s) still running — the drain "
                "does not terminate a call, the deployment policy does",
                DRAIN_BOUND,
                self.max_wait_ms,
                outcome.remaining,
            )
        else:
            outcome = DrainOutcome(
                reason=self._drain.reason,
                live_calls_at_start=at_start,
                finished=True,
                timed_out=False,
                waited_ms=self._elapsed_ms(),
                remaining=0,
            )
            self._logger.info(
                "drain finished: %d live call(s) finished in %d ms",
                at_start,
                outcome.waited_ms,
            )
        self._outcome = outcome
        return outcome

    def _elapsed_ms(self) -> int:
        assert self._started_at is not None
        return max(0, int(round((self._now() - self._started_at) * 1000)))


async def drain_then_exit(
    supervisor: DrainSupervisor,
    *,
    request_exit: Callable[[], None],
) -> DrainOutcome:
    """SIGTERM path: drain, then ask the process to stop. Never before."""
    supervisor.start()
    outcome = await supervisor.wait()
    request_exit()
    return outcome


__all__ = [
    "DRAIN_BOUND",
    "DEFAULT_REASON",
    "DrainOutcome",
    "DrainSupervisor",
    "LiveCalls",
    "drain_then_exit",
]
