"""Injectable clocks for cascade tests (ticket 01 — frozen API).

A cascade test must never read the wall clock, sleep, or depend on scheduling
luck. Every timeout, gap and hysteresis rule is measured against the clock the
test injects, so the same test produces the same numbers on every machine.

Public API (later tickets import these; do not rename):

    Clock           protocol: __call__() -> seconds, now(), advance(), sleep()
    FakeClock       virtual time; advances only when the test advances it
    ManualClock     alias for FakeClock
    FrozenClock     deliberately non-advancing (AC4 wire-check clock)
    RealClock       time.monotonic adapter for production call sites
    VirtualTimeout  TimeoutError raised when an armed deadline is crossed
    run_with_deadline(coro, clock=..., timeout_s=...) -> result
    TICK_MS         harness pacing constant, not a product bound

``FakeClock`` is a plain ``Callable[[], float]``, so it drops straight into
``TimingLedger(now=clock)`` and ``TurnOrchestrator(clock=clock)``.

Deadlines are enforced where virtual time moves: a provider that waits via
``await clock.sleep(...)`` raises ``VirtualTimeout`` the moment the armed
deadline is crossed. A coroutine that waits on a wall-clock event instead
will simply hang — that is the bug this kit exists to make impossible to
write accidentally.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable
from typing import Protocol, TypeVar

TICK_MS = 10.0
"""Harness pacing for waits that need the loop to run. Not a product bound."""

_Result = TypeVar("_Result")


class VirtualTimeout(TimeoutError):
    """Virtual deadline crossed while the injected clock was advancing.

    Subclasses ``TimeoutError`` (alias of ``asyncio.TimeoutError`` on 3.11+)
    so ``except asyncio.TimeoutError`` in production code still catches it.
    """


class Clock(Protocol):
    """The clock surface a cascade test may rely on."""

    def __call__(self) -> float:
        """Current time in seconds."""

    def now(self) -> float:
        """Current time in seconds (named form of ``__call__``)."""

    def advance(self, seconds: float) -> None:
        """Move time forward. Negative moves are a test bug."""

    async def sleep(self, seconds: float) -> None:
        """Wait for ``seconds`` of this clock's time."""


class FakeClock:
    """Virtual clock: time moves only when the test (or a script) moves it."""

    def __init__(self, start: float = 0.0) -> None:
        self._start = float(start)
        self._t = float(start)
        self._deadline: float | None = None

    def __call__(self) -> float:
        return self._t

    def now(self) -> float:
        return self._t

    @property
    def elapsed(self) -> float:
        """Seconds since construction."""
        return self._t - self._start

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError(f"clock cannot move backwards: {seconds!r}s")
        self._t += seconds
        if self._deadline is not None and self._t >= self._deadline:
            raise VirtualTimeout(
                f"virtual deadline {self._deadline:.3f}s crossed at {self._t:.3f}s"
            )

    def advance_ms(self, milliseconds: float) -> None:
        self.advance(milliseconds / 1000.0)

    async def sleep(self, seconds: float) -> None:
        self.advance(seconds)
        # Yield so already-runnable tasks observe the new time. Never a wall
        # clock wait: this is a loop turn, not a delay.
        await asyncio.sleep(0)

    def arm_deadline(self, timeout_s: float) -> Deadline:
        deadline = Deadline(self, timeout_s)
        self._deadline = deadline.at
        return deadline

    def disarm_deadline(self) -> None:
        self._deadline = None


class FrozenClock(FakeClock):
    """Non-advancing clock. Time is pinned no matter who waits.

    Used only to check that a timeout test is driven by the injected clock
    (ticket 01 AC4): swap this in and a deadline-driven test must fail,
    because the deadline can never be crossed.
    """

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError(f"clock cannot move backwards: {seconds!r}s")

    def advance_ms(self, milliseconds: float) -> None:
        if milliseconds < 0:
            raise ValueError(f"clock cannot move backwards: {milliseconds!r}ms")


ManualClock = FakeClock
"""Alias kept because the exploration map named both; same object."""


class RealClock:
    """Production adapter over ``time.monotonic``."""

    def __call__(self) -> float:
        return time.monotonic()

    def now(self) -> float:
        return time.monotonic()

    def advance(self, seconds: float) -> None:
        raise RuntimeError("RealClock cannot be advanced")

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class Deadline:
    """A point in an injected clock's time."""

    def __init__(self, clock: Clock, timeout_s: float) -> None:
        self.clock = clock
        self.timeout_s = timeout_s
        self.at = clock() + timeout_s

    def expired(self) -> bool:
        return self.clock() >= self.at

    def remaining(self) -> float:
        return max(0.0, self.at - self.clock())


async def run_with_deadline(
    awaitable: Awaitable[_Result], *, clock: FakeClock, timeout_s: float
) -> _Result:
    """Await ``awaitable`` under a deadline measured on ``clock``.

    Raises ``VirtualTimeout`` from the waiting provider code when virtual
    time crosses the deadline. The deadline is disarmed afterwards, so a
    later manual ``clock.advance()`` in the same test is unaffected.
    """
    if not isinstance(clock, FakeClock):
        raise TypeError(
            "run_with_deadline needs an injected FakeClock; got "
            f"{type(clock).__name__} — a wall clock cannot drive this deadline"
        )
    clock.arm_deadline(timeout_s)
    try:
        return await awaitable
    finally:
        clock.disarm_deadline()
