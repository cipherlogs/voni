"""Jev fast-judge client for the PSTN bridge.

Mirrors the voni TypeScript heuristics (`voni/src/lib/voice/jev-judges.ts`)
with identical thresholds — one rule in two languages, fail-closed in both:
an unsure barge-in never reads as an interruption.

Hot-path rule (see server.py): the audio-forwarding loop never awaits a
network round trip. Everything here is synchronous except `sample_judge`,
which is fire-and-forget (create_task, never awaited) and only runs when
`VOICE_JUDGE_URL` is set — Jev probabilities for tuning, never gating audio.
"""

from __future__ import annotations

import os
import re
import string
from typing import Any, Optional

import aiohttp

# Canonical thresholds. If these change, change the TS mirror too.
BARGE_IN_THRESHOLD = 0.65
JUDGE_TIMEOUT_S = 1.5

# Filler-only tokens that must never read as interruptions (breath mishears,
# hmm, got-it continuers). "yes"/"yeah" are deliberately ABSENT from filler
# but are NOT commands either: assent waits for the settled final's
# soft-confirm path. Mirrors voice-pipeline/turns.py and voni jev-judges.ts.
FILLER_TOKENS = frozenset(
    {
        "uh", "huh", "uhhuh", "um", "umm", "uhm", "er", "erm",
        "hmm", "hm", "ah", "oh", "mhm", "mmhm", "mmhmm", "mm",
        "yup", "okay", "ok", "right", "alright", "sure",
        "gotcha", "got", "it", "thanks",
    }
)

# Steering that always reads as an interruption once established, bypassing
# the word-count floor: stop/wait/no/repeat. Mirrors turns.COMMAND_*.
COMMAND_PHRASES = frozenset({"hold on", "hang on", "excuse me"})
COMMAND_TOKENS = frozenset(
    {"stop", "wait", "no", "nope", "repeat", "again", "sorry", "listen"}
)

_PUNCT_STRIP = str.maketrans("", "", string.punctuation)


def is_backchannel(text: str) -> bool:
    """True when every token is filler — never an interruption."""
    words = (text or "").lower().translate(_PUNCT_STRIP).split()
    return bool(words) and all(token in FILLER_TOKENS for token in words)


def is_command_overlap(text: str) -> bool:
    """True when the overlap carries steering (stop/wait/no/repeat...)."""
    lowered = f" {(text or '').lower().translate(_PUNCT_STRIP)} "
    if any(f" {phrase} " in lowered for phrase in COMMAND_PHRASES):
        return True
    return any(token in COMMAND_TOKENS for token in lowered.split())


def _word_count(text: str) -> int:
    words = text.strip().split()
    return len(words)


def heuristic_barge_in_score(partial_text: str, agent_speaking_ms: float) -> float:
    """Offline probability that user speech is a real interruption."""
    text = (partial_text or "").strip()
    if not text:
        return 0.0
    if is_backchannel(text):
        return 0.12
    if agent_speaking_ms < 800:
        return 0.3
    # Steering bypasses the word-count floor: a single "no" or "stop" is
    # heard even though a single "yes" still waits for the settled final.
    if is_command_overlap(text):
        return 0.9
    words = _word_count(text)
    if words >= 4:
        return 0.88
    if words >= 2:
        return 0.72
    return 0.45


def classify_user_turn(
    partial_text: str,
    agent_speaking_ms: float,
    threshold: float = BARGE_IN_THRESHOLD,
) -> tuple[str, float]:
    """Return ("yield" | "keep-speaking", probability). Fail-closed."""
    prob = heuristic_barge_in_score(partial_text, agent_speaking_ms)
    return ("yield" if prob >= threshold else "keep-speaking", prob)


def choose_reply_action(
    has_final: bool, silence_ms: float, tool_active: bool
) -> tuple[str, float]:
    if tool_active:
        return ("play_filler", 0.8)
    if has_final and silence_ms >= 600:
        return ("reply_now", 0.85)
    if not has_final and silence_ms < 300:
        return ("wait_300ms", 0.75)
    if has_final:
        return ("reply_now", 0.7)
    return ("play_filler", 0.62)


def allow_tool_call(name: Any) -> tuple[bool, float]:
    """Verify-before-apply for bridge tool calls. Malformed names are denied."""
    if not isinstance(name, str) or not re.match(r"^[a-z][a-z0-9_]*$", name, re.IGNORECASE):
        return (False, 0.9)
    return (True, 0.55)


def judge_url() -> Optional[str]:
    """Where Jev samples go. Explicit URL wins; otherwise derive it from the
    bridge's Voni base URL, so dev/prod falls out of the existing VONI_API_URL
    per host — local dev URL on a dev machine, the deployed Worker in prod."""
    explicit = os.environ.get("VOICE_JUDGE_URL")
    if explicit:
        return explicit
    base = (os.environ.get("VONI_API_URL") or "").rstrip("/")
    return f"{base}/api/voice-judge" if base else None


def judge_enabled() -> bool:
    return judge_url() is not None


def judge_payload(kind: str, state: dict[str, Any]) -> dict[str, Any]:
    return {"kind": kind, "state": state}


async def sample_judge(
    kind: str,
    state: dict[str, Any],
    url: Optional[str] = None,
    service_token: Optional[str] = None,
    timeout_s: float = JUDGE_TIMEOUT_S,
) -> Optional[dict[str, Any]]:
    """Fire-and-forget Jev sample. Returns parsed JSON or None. Never raises.

    Authenticates with the bridge bearer secret (VONI_TOOL_SECRET, same shape
    as the internal bridge routes) since the bridge holds no user session.
    """
    target = url or judge_url()
    if not target:
        return None
    token = service_token or os.environ.get("VONI_TOOL_SECRET")
    headers = {"authorization": f"Bearer {token}"} if token else None
    try:
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                target, json=judge_payload(kind, state), headers=headers
            ) as res:
                if res.status != 200:
                    return None
                data = await res.json()
                return data if isinstance(data, dict) else None
    except Exception:
        return None
