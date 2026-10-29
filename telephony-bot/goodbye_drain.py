"""The polled goodbye drain for the Telnyx bridge.

`agent_to_telnyx` used to sleep a computed tail — bytes pushed minus wall
clock since the first chunk — after the agent asked to hang up. On a jittery
link that estimate is wrong in both directions: Telnyx buffers what we push,
so "we have pushed it" is not "the caller heard it", and one late chunk after
the estimate runs out is chopped mid-word.

The browser answers the same question by polling its playout
(`VoiceSession.settleThenStop`, `voni/src/lib/voice/session.ts`): a single
settled poll is not proof of silence, because the buffer is also momentarily
empty between chunks, so the hang-up requires `GOODBYE_SETTLE_POLLS`
consecutive settled polls *and* `GOODBYE_AUDIO_GRACE_MS` since the last audio
arrived, bounded by `GOODBYE_DRAIN_TIMEOUT_MS` so a stuck playout can never
hold the line open forever.

This module is that handshake for the phone leg. It is deliberately its own
implementation (ADR 0007: the bridge is pinned to the browser's behaviour by
shared tests, not folded into the shared engine), and it knows nothing about
Telnyx beyond the two probes the caller passes in.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable

# Mirrors voni/src/lib/voice/session.ts and the end-call-drain budget record
# (voni/src/lib/demo/scoreboard-budgets.ts), which the freeze guard pins.
GOODBYE_POLL_MS = 250
GOODBYE_SETTLE_POLLS = 3
GOODBYE_AUDIO_GRACE_MS = 500
GOODBYE_DRAIN_TIMEOUT_MS = 10_000

# The phone leg is G.711 at 8 kHz: one byte per sample.
TELEPHONY_BYTES_PER_SEC = 8000.0


@dataclass(frozen=True)
class DrainOutcome:
    """How the drain ended, for the log and for the tests."""

    waited_ms: int
    polls: int
    # "already-settled" (nothing left to play), "drained" (the streak passed),
    # or "timeout" (the fail-safe fired: never hold the line longer).
    reason: str


class GoodbyeDrain:
    """Poll the playout until the goodbye has drained, then hang up.

    `playback_settled()` answers "nothing is left to play right now" and
    `last_audio_at()` gives the monotonic time the last audio arrived (None:
    nothing ever arrived). Both are cheap reads, safe to poll at 250 ms.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], "asyncio.Future"] = asyncio.sleep,
        poll_ms: int = GOODBYE_POLL_MS,
        settle_polls: int = GOODBYE_SETTLE_POLLS,
        audio_grace_ms: int = GOODBYE_AUDIO_GRACE_MS,
        timeout_ms: int = GOODBYE_DRAIN_TIMEOUT_MS,
    ) -> None:
        self.clock = clock
        self.sleep = sleep
        self.poll_ms = poll_ms
        self.settle_polls = settle_polls
        self.audio_grace_ms = audio_grace_ms
        self.timeout_ms = timeout_ms

    def _quiet(self, last_audio_at: float | None, now: float) -> bool:
        """`GOODBYE_AUDIO_GRACE_MS` since the last audio arrived.

        Covers audio still travelling to the caller plus output latency: a
        chunk that has left our pipe has not necessarily been heard yet.
        """
        if last_audio_at is None:
            return True
        return (now - last_audio_at) * 1000.0 >= self.audio_grace_ms

    def _drained(self, settled_polls: int, last_audio_at: float | None, now: float) -> bool:
        return settled_polls >= self.settle_polls and self._quiet(last_audio_at, now)

    async def drain(
        self,
        *,
        playback_settled: Callable[[], bool],
        last_audio_at: Callable[[], float | None],
    ) -> DrainOutcome:
        started = self.clock()
        # Already silent and already past the grace: nothing to wait for.
        if playback_settled() and self._quiet(last_audio_at(), started):
            return DrainOutcome(waited_ms=0, polls=0, reason="already-settled")

        settled_polls = 0
        polls = 0
        while True:
            await self.sleep(self.poll_ms / 1000.0)
            polls += 1
            now = self.clock()
            settled_polls = (
                settled_polls + 1
                if playback_settled() and self._quiet(last_audio_at(), now)
                else 0
            )
            if self._drained(settled_polls, last_audio_at(), now):
                return DrainOutcome(
                    waited_ms=int((now - started) * 1000), polls=polls, reason="drained"
                )
            if (now - started) * 1000.0 > self.timeout_ms:
                return DrainOutcome(
                    waited_ms=int((now - started) * 1000), polls=polls, reason="timeout"
                )


def playout_settled(stats: dict, now: float) -> bool:
    """True when Telnyx has nothing left to play from the reply just pushed.

    `reply_bytes` is what we handed Telnyx for the current reply and
    `first_audio_at` when its first chunk arrived, so a reply is played out
    once the wall clock since then covers every byte at 1x. A held partial
    frame (`pending`) is still going to be played, so it counts as queued.
    """
    if stats.get("pending"):
        return False
    first_audio_at = stats.get("first_audio_at")
    if first_audio_at is None:
        return True
    pushed_secs = stats.get("reply_bytes", 0) / TELEPHONY_BYTES_PER_SEC
    return now - first_audio_at >= pushed_secs
