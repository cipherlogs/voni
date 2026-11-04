"""Short spoken acknowledgements that cover the model's first-token wait.

The demo's Meta turn measures p50 ~2 s to its first token. A listener reads that
silence as a broken line, so the cascade speaks one very short line through the
same voice when Jev is highly confident. It is not the reply:

* it is captioned as an agent final but never enters reply text or history;
* it is skipped when the reply starts speaking first;
* it is skipped outright on greeting turns, filler-only turns, end-intent turns
  ("hang up", "bye", "that's all"), and Locales with no palette;
* a missing, slow, failing, low-confidence, or unknown-tone judge is silence,
  never a hash fallback (owner direction: Jev-only, no hash);
* it carries no model request and no tool call.

The table is per Locale because the demo roster is one voice per Locale.
English carries the owner-approved bounded palette (ticket 04): tone groups
plus short statement covers. Jev picks caller-tone-or-None; silence is obeyed.
Neutral never includes the statement bridge, so "Good question, one sec." only
answers a real question.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

#: The English palette by what the line does, not by how it is spelled.
#: Owner-approved bounded set (ticket 04, approved as-is): 13 lines.
ACK_TONE_GROUPS: Mapping[str, Mapping[str, tuple[str, ...]]] = {
    "en": {
        "thinking": ("Let's see.", "One moment.", "Let me think."),
        "sympathetic": ("Ah, I see.", "Sorry to hear that."),
        "acknowledging": ("Okay.", "Yeah.", "Got it."),
        "surprise": ("Oh.", "Oh, nice."),
        "statement": (
            "Got it, one moment.",
            "Let me check that.",
            "Good question, one sec.",
        ),
    },
}

#: The flat palette per Locale: what the turn layer rotates over. English is
#: the union of its tone groups, in group order and without duplicates.
ACK_LINES: Mapping[str, tuple[str, ...]] = {
    "en": tuple(
        dict.fromkeys(
            line
            for group in ACK_TONE_GROUPS["en"].values()
            for line in group
        )
    ),
    "de": ("Okay.", "Alles klar.", "Genau."),
    "es": ("Vale.", "Claro.", "De acuerdo."),
    "fr": ("D'accord.", "Très bien.", "Voilà."),
    "pt": ("Certo.", "Claro.", "Tá."),
}

#: Words that are only a greeting. A caller turn made solely of these never
#: hears a cover: silence is better than a robotic "Mm" back to a "Hi".
GREETING_TOKENS: frozenset[str] = frozenset(
    {
        "hi",
        "hello",
        "hey",
        "yo",
        "howdy",
        "hiya",
        "good",
        "morning",
        "afternoon",
        "evening",
    }
)

#: The fast-judge time cap's bound. The judge must answer well inside the ack
#: delay so a slow judge never delays the cover; a timeout fails open.
JUDGE_TIMEOUT_BOUND = "reply.judge_timeout_ms"

#: Fallback cap when the registry has no judge bound (tests, tenants): the
#: judge still answers well inside the 300 ms ack delay.
_JUDGE_TIMEOUT_FALLBACK_S = 0.12

#: A small, deliberately coarse negativity heuristic. It exists only to keep
#: a bright "Okay."/"Yeah." off a final that complains, so it names the plain
#: words a caller uses when something is wrong. The phrase "not working" is
#: matched as a phrase; every other cue is one whole word (so "broken" does
#: not fire on "broke").
NEGATIVE_CUES: tuple[str, ...] = (
    "useless",
    "rubbish",
    "ridiculous",
    "terrible",
    "awful",
    "broken",
    "not working",
    "fed up",
    "hate",
    "worst",
    "angry",
)

_NEGATIVE = re.compile(
    r"\b(?:" + "|".join(re.escape(cue) for cue in NEGATIVE_CUES) + r")\b",
    re.IGNORECASE,
)

#: A final that opens with one of these asks something even when the recogniser
#: dropped the question mark. Coarse on purpose: a false question only narrows
#: the ack to the thinking group, which is always safe.
_QUESTION_OPENER = re.compile(
    r"^(?:what|why|how|when|where|who|whose|which|can|could|do|does|did|"
    r"is|are|was|were|will|would|should|shall|have|has|am|may|might)\b",
    re.IGNORECASE,
)

#: Which tone groups may answer each tone read from the caller's final. A
#: complaint never reaches "acknowledging" (so never "Okay."/"Yeah."); a
#: question gets a thinking sound or a short statement bridge; a neutral final
#: gets acknowledging, thinking, or surprise -- never the statement bridge, so
#: "Good question, one sec." only answers a real question.
_TONE_GROUPS: Mapping[str, tuple[str, ...]] = {
    "negative": ("sympathetic", "thinking"),
    "question": ("thinking", "statement"),
    "neutral": ("acknowledging", "thinking", "surprise"),
    "unknown": ("thinking",),
}

#: Tones the fast judge may return. ``None`` is silence-when-better, never a
#: fallback: a judge that chooses silence is obeyed, not overruled.
_JUDGE_TONES = frozenset({"negative", "question", "neutral", "unknown"})


def ack_lines(locale: str | None) -> tuple[str, ...]:
    """The lines for one Locale; an unknown Locale gets no acknowledgement.

    The demo roster is one voice per Locale; a tenant or an unexpected code must
    not hear an English filler, so the fallback is silence rather than English.
    """
    return ACK_LINES.get((locale or "").lower(), ())


def ack_tone(caller_text: str | None) -> str:
    """Read one coarse tone from the caller's final.

    ``negative`` beats ``question``: "is this broken?" is a complaint first.
    An empty or whitespace-only final is ``unknown`` and gets a thinking sound.
    """
    text = " ".join((caller_text or "").split())
    if not text:
        return "unknown"
    if _NEGATIVE.search(text):
        return "negative"
    if "?" in text or _QUESTION_OPENER.match(text):
        return "question"
    return "neutral"


def is_greeting_turn(caller_text: str | None) -> bool:
    """True when the caller's turn is only a greeting, so the cover stays silent.

    "Hi" never hears a line back; "Hi, I'm calling about the flat" is a real
    turn with content and may still be covered. Tokenisation matches the
    cascade's one tokenizer so a browser rule cannot disagree about a word.
    """
    from turns import clean_tokens

    words = clean_tokens(caller_text or "")
    return bool(words) and all(token in GREETING_TOKENS for token in words)


def should_cover(locale: str | None, caller_text: str | None) -> bool:
    """Whether this final may hear a cover at all. Silence-when-better lives here.

    False on greeting turns, filler-only turns, end-intent turns
    ("hang up", "bye", "that's all"), and Locales with no palette.
    Anything else may be covered (or silenced later by the judge's ``None``).
    """

    from cascade.end_intent import wants_to_end
    from turns import is_backchannel

    if not ack_lines(locale):
        return False
    if is_greeting_turn(caller_text):
        return False
    if is_backchannel(caller_text or ""):
        return False
    if wants_to_end(caller_text or "", locale or "en"):
        return False
    return True


def _stable_offset(text: str) -> int:
    """A deterministic fold of the text; ``hash()`` is salted per process."""
    return sum(
        (index + 1) * ord(character) for index, character in enumerate(text.lower())
    )


def cover_line(
    locale: str | None,
    caller_text: str = "",
    *,
    previous: str | None = None,
    lines: Sequence[str] | None = None,
    tone: str | None = ...,
) -> str | None:
    """Choose one line for this final inside one tone, never repeating ``previous``.

    ``tone`` is Jev's pick: ``None`` is silence-when-better and returns
    ``None`` without a fallback. The default (``...``) means no judge answered,
    which is also silence (Jev-only: no hash fallback). An unknown tone name
    is silence rather than failing the turn. Within a tone the first
    non-repeating candidate wins, so the choice is stable without a hash.
    """
    palette = tuple(lines) if lines is not None else ack_lines(locale)
    if not palette:
        return None
    if tone is ...:
        return None
    resolved = tone
    if resolved is None:
        return None
    if not isinstance(resolved, str) or resolved not in _TONE_GROUPS:
        return None
    groups = ACK_TONE_GROUPS.get((locale or "").lower())
    candidates: list[str] = []
    if groups:
        allowed = tuple(
            dict.fromkeys(
                line
                for name in _TONE_GROUPS[resolved]
                for line in groups.get(name, ())
            )
        )
        candidates = [line for line in allowed if line in palette]
    if not candidates:
        return None
    varied = [line for line in candidates if line != previous]
    if varied:
        candidates = varied
    return candidates[0]


def judge_timeout_s(default: float = _JUDGE_TIMEOUT_FALLBACK_S) -> float:
    """The fast-judge time cap in seconds, from the bounds registry when present."""
    try:
        from cascade.thresholds import require_bound

        return float(require_bound(JUDGE_TIMEOUT_BOUND)) / 1000.0
    except Exception:
        return default


def resolve_tone_result(
    caller_text: str,
    judge_result: Any,
    *,
    timed_out: bool = False,
    failed: bool = False,
) -> str | None:
    """The single tone resolver both judge seams share.

    Jev-only: ``None``, timeouts, failures, and unknown tone names are all
    silence. There is no hash fallback; a wrong line is worse than none.
    """
    if timed_out or failed:
        return None
    if judge_result is None:
        return None
    if judge_result not in _JUDGE_TONES:
        return None
    return judge_result


async def resolve_cover_tone(
    caller_text: str,
    judge: Callable[[str], Awaitable[str | None]] | None,
    timeout_s: float | None = None,
) -> str | None:
    """Pick tone-or-None through Jev with fail-silence.

    ``None`` from the judge is obeyed silence. A timeout, an exception, an
    unknown tone name, or a missing judge is also silence -- never the hash.
    """
    if judge is None:
        return None
    cap = timeout_s if timeout_s is not None else judge_timeout_s()
    try:
        picked = await asyncio.wait_for(judge(caller_text), timeout=cap)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return None
    except Exception:
        return None
    return resolve_tone_result(caller_text, picked)


def resolve_cover_tone_sync(
    caller_text: str,
    judge_result: Any,
    *,
    timed_out: bool = False,
    failed: bool = False,
) -> str | None:
    """The synchronous half of the judge contract, for tests and non-async seams.

    Jev-only: timeouts, failures, and unknown tones are silence;
    ``None`` is obeyed silence.
    """
    return resolve_tone_result(
        caller_text, judge_result, timed_out=timed_out, failed=failed
    )
