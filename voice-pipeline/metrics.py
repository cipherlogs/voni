"""Metric rig for the cascade pipeline (P0).

Same scoreboard as the managed path so the P1 A/B is apples-to-apples:
- audio_in -> first_partial: screen latency (words visible while spoken)
- final -> first_token: think start (LLM engaged)
- final/commit -> first_playout: reply gap (commit wins when early-commit fires)
- counts: judge outcomes + prefetch lifecycle + tool denies

First mark wins; missing marks yield None gaps, never exceptions. Clock is
injectable (time.monotonic in prod) so tests are deterministic.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Optional


MARKS = (
    "audio_in",
    "first_partial",
    "final",
    "commit",
    "first_token",
    "first_sentence_audio",
    "first_playout",
    "reply_done",
)

COUNTERS = (
    "backchannel",
    "yield",
    "interruption",
    "prefetch_started",
    "prefetch_cancelled",
    "prefetch_used",
    "tool_denied",
)


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
                "commit_to_first_playout": self._gap(
                    "commit" if "commit" in self._marks else "final", "first_playout"
                ),
            },
            "counts": dict(self._counts),
        }

    def reset(self) -> None:
        self._marks.clear()
        for key in self._counts:
            self._counts[key] = 0
