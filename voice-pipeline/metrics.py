"""Metric rig for the cascade pipeline.

Same scoreboard as the managed path so the P1 A/B is apples-to-apples:
- audio_in -> first_partial: screen latency
- speech_complete -> first_token: think start (cascade)
- final -> first_token: think start (managed)
- final -> first_playout: managed reply gap
- floor_take -> first_playout: cascade reply gap; N/A when the caller never
  took the floor
- counts: judge outcomes + prefetch lifecycle + tool denies

The cascade also records the marks its provider-owned turn boundary produces
(speech_end, speech_complete, floor_take, greeting start/first audio/done,
reconnect, cancelled). They are ordinary marks: first write wins and a
duplicate is ignored.

The three cascade gaps are derived from the marks mapping alone through
``cascade_gaps()``; there is no second scoreboard and no gap is invented from
a mark that was not recorded. A missing mark yields None, never a borrowed
value and never zero. Clock is injectable (time.monotonic in prod) so tests
are deterministic.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Optional


MARKS = (
    "audio_in",
    "first_partial",
    "speech_end",
    "speech_complete",
    "final",
    "floor_take",
    "first_token",
    "first_sentence_audio",
    "first_playout",
    "reply_done",
    "greeting_start",
    "greeting_first_audio",
    "greeting_done",
    "reconnect",
    "cancelled",
)

# (row name, start mark, end mark). The cascade reports these three gaps; the
# managed path can only produce the reply gap, which it reports as
# final_to_first_playout instead.
CASCADE_GAPS = (
    ("screen_latency_ms", "audio_in", "first_partial"),
    ("think_ms", "speech_complete", "first_token"),
    ("reply_gap_ms", "speech_complete", "first_playout"),
)

COUNTERS = (
    "backchannel",
    "yield",
    "interruption",
    "prefetch_started",
    "prefetch_cancelled",
    "prefetch_used",
    "tool_denied",
    "end_call",
    "overheard",
)


def cascade_gaps(marks: Mapping[str, float]) -> dict[str, Optional[float]]:
    """The three cascade gaps, computed from ledger marks alone.

    ``marks`` is what ``TimingLedger.summary()["marks"]`` carries, so a reader
    holding only the end-of-call ledger can derive every cascade gap without
    the ledger object. A gap whose start or end mark is absent is None.
    """
    gaps: dict[str, Optional[float]] = {}
    for row, start, end in CASCADE_GAPS:
        if start in marks and end in marks:
            gaps[row] = (marks[end] - marks[start]) * 1000.0
        else:
            gaps[row] = None
    return gaps


class TimingLedger:
    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now or time.monotonic
        self._marks: dict[str, float] = {}
        self._counts: dict[str, int] = {c: 0 for c in COUNTERS}

    def mark(self, name: str) -> None:
        if name not in MARKS:
            raise ValueError(f"unknown mark: {name}")
        if name not in self._marks:
            self._marks[name] = self._now()

    def count(self, name: str, n: int = 1) -> None:
        if name not in COUNTERS:
            raise ValueError(f"unknown counter: {name}")
        self._counts[name] += n

    def _gap(self, frm: str, to: str) -> Optional[float]:
        if frm not in self._marks or to not in self._marks:
            return None
        return (self._marks[to] - self._marks[frm]) * 1000.0

    def summary(self) -> dict:
        return {
            "marks": dict(self._marks),
            "gaps_ms": {
                "audio_in_to_first_partial": self._gap("audio_in", "first_partial"),
                "final_to_first_token": self._gap("final", "first_token"),
                "final_to_first_playout": self._gap("final", "first_playout"),
                "floor_take_to_first_playout": self._gap(
                    "floor_take", "first_playout"
                ),
            },
            "counts": dict(self._counts),
        }

    def reset(self) -> None:
        self._marks.clear()
        for key in self._counts:
            self._counts[key] = 0
