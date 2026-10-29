"""Real-time pacer for the spike's caller stream (M00).

Meta rejects a stream that runs ahead of real time and the spike's endpointing
term only means something if the audio was delivered at approximately real
time ("not as fast as the network allows"). Two laws, one seam:

1. A chunk is never handed out before its media start. The clock and the wait
   are injected, so this is proved with zero wall-clock sleeps.
2. A chunk is never handed out when its media end would be more than
   ``MAX_LEAD_S`` ahead of the vendor's ``audioProcessedMs`` (passed as
   seconds). Hitting the cap returns :class:`Blocked` instead of sleeping: the
   pacer never polls the vendor and never spins, the caller resumes when the
   vendor's processed position advances.

The schedule is absolute from the pacer's creation, so a stalled caller sends
overdue chunks immediately rather than drifting: the law is "never ahead", and
a run that fell behind is a harness failure to report, not something the pacer
hides by skipping audio.

The lead cap is the vendor's protocol constraint stated in the M00 spec ("Meta
rejects a stream that runs ahead"), not an open latency budget; callers may
narrow it, never widen it silently.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from .fixture import SAMPLE_RATE, SAMPLE_WIDTH_BYTES

CHUNK_MS = 100

#: Vendor constraint from spec M0: never more than this far ahead of the
#: vendor's processed position.
MAX_LEAD_S = 5.0

_LEAD_EPSILON_S = 1e-9


@dataclass(frozen=True)
class Send:
    """One chunk of caller audio, due and delivered at ``sent_at_s``."""

    index: int
    chunk: bytes
    media_start_s: float
    media_end_s: float
    sent_at_s: float


@dataclass(frozen=True)
class Blocked:
    """The lead cap refuses the next chunk until the vendor catches up."""

    index: int
    media_start_s: float
    media_end_s: float
    vendor_processed_s: float
    lead_s: float
    max_lead_s: float


class Pacer:
    def __init__(
        self,
        audio: bytes,
        *,
        vendor_processed_s: Callable[[], float],
        sample_rate: int = SAMPLE_RATE,
        chunk_ms: int = CHUNK_MS,
        max_lead_s: float = MAX_LEAD_S,
        clock: Callable[[], float] | None = None,
        wait: Callable[[float], None] | None = None,
    ) -> None:
        if chunk_ms <= 0:
            raise ValueError(f"chunk_ms must be positive, got {chunk_ms}")
        if max_lead_s <= 0:
            raise ValueError(f"max_lead_s must be positive, got {max_lead_s}")
        if chunk_ms / 1000.0 > max_lead_s:
            raise ValueError(
                f"chunk_ms={chunk_ms} cannot fit inside max_lead_s={max_lead_s}"
            )
        if len(audio) % SAMPLE_WIDTH_BYTES:
            raise ValueError("audio must be whole 16-bit samples")

        self._audio = bytes(audio)
        self._vendor_processed_s = vendor_processed_s
        self._max_lead_s = max_lead_s
        self._clock = clock or time.monotonic
        self._wait = wait or time.sleep
        self._bytes_per_second = sample_rate * SAMPLE_WIDTH_BYTES
        self._chunk_bytes = (
            int(round(sample_rate * chunk_ms / 1000.0)) * SAMPLE_WIDTH_BYTES
        )
        self._origin_s = self._clock()
        self._cursor = 0
        self._index = 0

    @property
    def done(self) -> bool:
        return self._cursor >= len(self._audio)

    def next_send(self) -> Send | Blocked | None:
        """Return the next chunk, the reason it is blocked, or ``None`` at EOF.

        A :class:`Blocked` return does not advance the stream; the caller waits
        for the vendor's processed position to move, then calls again.
        """
        if self.done:
            return None

        end = min(self._cursor + self._chunk_bytes, len(self._audio))
        media_start_s = self._cursor / self._bytes_per_second
        media_end_s = end / self._bytes_per_second
        processed_s = float(self._vendor_processed_s())
        lead_s = media_end_s - processed_s

        if lead_s > self._max_lead_s + _LEAD_EPSILON_S:
            return Blocked(
                index=self._index,
                media_start_s=media_start_s,
                media_end_s=media_end_s,
                vendor_processed_s=processed_s,
                lead_s=lead_s,
                max_lead_s=self._max_lead_s,
            )

        due_s = self._origin_s + media_start_s
        now_s = self._clock()
        if now_s < due_s:
            self._wait(due_s - now_s)

        chunk = self._audio[self._cursor : end]
        send = Send(
            index=self._index,
            chunk=chunk,
            media_start_s=media_start_s,
            media_end_s=media_end_s,
            sent_at_s=self._clock(),
        )
        self._cursor = end
        self._index += 1
        return send
