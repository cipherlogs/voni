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
import string
from typing import Callable, Literal

CommitAction = Literal["commit", "wait", "backchannel"]

BARGE_IN_THRESHOLD = 0.65
ESTABLISHED_MS = 800.0
MIN_COMMIT_WORDS = 2

# Command words that always commit once the turn is established, bypassing
# the word-count floor AND the probability threshold: stop/wait/no/repeat
# are steering, not content — the LLM (which sees the overlap in context)
# decides transition-vs-continue, the gate only guarantees it is heard.
# Phrases first ("hold on", "excuse me"), then single tokens. "yes"/"yeah"
# are deliberately ABSENT: assent without a command waits for the settled
# final's soft-confirm path instead of cutting in.
COMMAND_PHRASES = frozenset({"hold on", "hang on", "excuse me"})
COMMAND_TOKENS = frozenset(
    {"stop", "wait", "no", "nope", "repeat", "again", "sorry", "listen"}
)

# Filler-only tokens that must never commit a turn while the agent holds the
# floor (breath mishears, hmm, got-it continuers). "yes"/"no"/"yeah" are
# deliberately ABSENT: a bare confirmation is meaningful — it takes the
# soft-confirm path (finish the sentence, then "Sorry — did you say no?")
# instead of being dropped as junk. Mirrors telephony-bot/voice_judge.py and
# voni jev-judges.ts; test_turns.py asserts fixture parity across all three.
FILLER_TOKENS = frozenset(
    {
        "uh", "huh", "uhhuh", "um", "umm", "uhm", "er", "erm",
        "hmm", "hm", "ah", "oh", "mhm", "mmhm", "mmhmm", "mm",
        "yup", "okay", "ok", "right", "alright", "sure",
        "gotcha", "got", "it", "thanks",
    }
)

_PUNCT_STRIP = str.maketrans("", "", string.punctuation)


def is_backchannel(text: str) -> bool:
    """True when every token is filler — never commit, never interrupt."""
    words = (text or "").lower().translate(_PUNCT_STRIP).split()
    return bool(words) and all(token in FILLER_TOKENS for token in words)


def is_command_overlap(text: str) -> bool:
    """True when the overlap carries steering (stop/wait/no/repeat...)."""
    lowered = f" {(text or '').lower().translate(_PUNCT_STRIP)} "
    if any(f" {phrase} " in lowered for phrase in COMMAND_PHRASES):
        return True
    return any(token in COMMAND_TOKENS for token in lowered.split())


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
    # Command words bypass the floor and the threshold: steering must be
    # heard even as a single word ("no", "stop"). Non-command single words
    # (notably bare yes/yeah) still wait for the settled final's
    # soft-confirm path instead of hard-cutting audio.
    if is_command_overlap(text):
        return "commit"
    if barge_probability >= threshold and _word_count(text) >= MIN_COMMIT_WORDS:
        return "commit"
    return "wait"
