"""Turn commit gate for the cascade pipeline (P0).

Answers ONE question per user partial: has intent arrived (commit), is this
backchannel noise (backchannel — never commit, never interrupt), or must the
pipeline keep waiting (wait)? Fail-closed: unsure means wait.

The barge probability comes from the existing judge heuristics
(telephony-bot/voice_judge.py); this gate adds the commit policy on top:
multi-word content from an established turn commits, early-turn speech and
thin partials wait even at high probability (talk-over/echo guard, same rule
as the browser gate's 800ms establishment window).

Backchannel wording is the third mirror of the canonical pattern
(telephony-bot/voice_judge.py, voni jev-judges.ts) — test_turns.py asserts
fixture parity with the bridge judge so the three can never silently drift.
"""

from __future__ import annotations

import re
from typing import Callable, Literal

CommitAction = Literal["commit", "wait", "backchannel"]

BARGE_IN_THRESHOLD = 0.65
ESTABLISHED_MS = 800.0
MIN_COMMIT_WORDS = 2

_BACKCHANNEL_RE = re.compile(
    r"^(uh[\s-]?huh|yeah?|yep|nope?|mhm+|mm+|ok(ay)?|right|sure|got it|thanks?|ah?[\s.,!?]*)[\s.,!?]*$",
    re.IGNORECASE,
)


def is_backchannel(text: str) -> bool:
    """True for acknowledgment noise that must never commit a turn."""
    return bool(text and text.strip() and _BACKCHANNEL_RE.match(text.strip()))


def _word_count(text: str) -> int:
    return len(text.strip().split())


def commit_decision(
    partial_text: str,
    agent_speaking_ms: float,
    barge_probability: float,
    *,
    threshold: float = BARGE_IN_THRESHOLD,
    is_backchannel_fn: Callable[[str], bool] = is_backchannel,
) -> CommitAction:
    """Decide what a user partial means. Pure; no I/O, no clock."""
    text = (partial_text or "").strip()
    if not text:
        return "wait"
    if is_backchannel_fn(text):
        return "backchannel"
    if agent_speaking_ms < ESTABLISHED_MS:
        return "wait"
    if barge_probability >= threshold and _word_count(text) >= MIN_COMMIT_WORDS:
        return "commit"
    return "wait"
