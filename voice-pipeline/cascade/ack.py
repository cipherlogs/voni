"""Short spoken acknowledgements that cover the model's first-token wait.

The demo's Meta turn measures p50 ~2 s to its first token. A listener reads that
silence as a broken line, so the cascade speaks one very short line through the
same voice at the registry's delay. It is not the reply:

* it is never captioned and never enters the reply text or history;
* it is skipped when the reply starts speaking first;
* it carries no model request and no tool call.

The table is per Locale because the demo roster is one voice per Locale.

Every line is a real word in its Locale. A listening sound spelled as letters
("Mhm.") is not one: the vendor synthesises it as the letters m-h-m, which no
caller has ever said, and because acks are never captioned the defect is
invisible in every transcript. The first line of each Locale used to be "Mhm."
and is now a word.

English has more than one sound because one sound does not fit every final.
The same flat "Okay." that acknowledges an address lands wrong after "this is
ridiculous", so the palette is grouped by what the caller hears in the line and
the group is chosen from the caller's final before the line is picked:

* thinking ("Mm.", "Hmm.", "So.", "Let's see.") — the caller asked something or
  said nothing legible, so the agent is visibly working the answer out;
* sympathetic ("Ah.", "Mm.") — the caller complained, so a cheerful "Okay."
  would sound tone-deaf at the caller's expense;
* acknowledging ("Okay.", "Yeah.", "Uh-huh.") — a neutral or positive final;
* surprise ("Oh.") — a mild, interested acknowledgement, used only with the
  neutral group.

The other Locales keep their small flat palette and rotate through it; only
English carries tone groups today.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

#: The English palette by what the line does, not by how it is spelled.
ACK_TONE_GROUPS: Mapping[str, Mapping[str, tuple[str, ...]]] = {
    "en": {
        "thinking": ("Mm.", "Hmm.", "So.", "Let's see."),
        "sympathetic": ("Ah.", "Mm."),
        "acknowledging": ("Okay.", "Yeah.", "Uh-huh."),
        "surprise": ("Oh.",),
    },
}

#: The flat palette per Locale: what the turn layer rotates over. English is
#: the union of its tone groups, in group order and without the duplicate "Mm.".
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

#: A small, deliberately coarse negativity heuristic. It is not sentiment
#: analysis: it exists only to keep a bright "Okay."/"Yeah." off a final that
#: complains, so it names the plain words a caller uses when something is
#: wrong. The phrase "not working" is matched as a phrase; every other cue is
#: one whole word (so "broken" does not fire on "broke").
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
#: question and an unreadable final get only the thinking sounds.
_TONE_GROUPS: Mapping[str, tuple[str, ...]] = {
    "negative": ("sympathetic", "thinking"),
    "question": ("thinking",),
    "neutral": ("acknowledging", "thinking", "surprise"),
    "unknown": ("thinking",),
}


def ack_lines(locale: str | None) -> tuple[str, ...]:
    """The lines for one Locale; an unknown Locale gets no acknowledgement.

    The demo roster is five Locales; a tenant or an unexpected code must not
    hear an English filler, so the fallback is silence rather than English.
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


def _stable_offset(text: str) -> int:
    """A deterministic fold of the text; ``hash()`` is salted per process."""
    return sum(
        (index + 1) * ord(character) for index, character in enumerate(text.lower())
    )


def ack_line(
    locale: str | None,
    caller_text: str = "",
    *,
    previous: str | None = None,
    lines: Sequence[str] | None = None,
) -> str | None:
    """Choose one line for this final, never repeating ``previous``.

    ``lines`` lets the turn layer pass the palette it was configured with (a
    test or a tenant may inject its own); the Locale's tone groups still decide
    which of those lines may answer, and if none of them belongs to the allowed
    groups (an injected palette outside the standard one) the whole palette is
    used. The choice is deterministic for one final: the same words and the same
    previous line always yield the same next line, and a second consecutive turn
    with the same words moves to a different line.
    """
    palette = tuple(lines) if lines is not None else ack_lines(locale)
    if not palette:
        return None
    groups = ACK_TONE_GROUPS.get((locale or "").lower())
    candidates: list[str] = []
    if groups:
        allowed = tuple(
            dict.fromkeys(
                line
                for tone in _TONE_GROUPS[ack_tone(caller_text)]
                for line in groups.get(tone, ())
            )
        )
        candidates = [line for line in allowed if line in palette]
    if not candidates:
        candidates = list(palette)
    varied = [line for line in candidates if line != previous]
    if varied:
        candidates = varied
    return candidates[_stable_offset(caller_text) % len(candidates)]
