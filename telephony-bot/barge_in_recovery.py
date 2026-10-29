"""Unheard-tail barge-in recovery for the phone bridge (voice-parity 70).

The browser owns the behaviour (docs/adr/0003-barge-in-recovery.md): the
server stops the agent on a barge-in, and the session repairs the stops that
weren't real. A filler, a back-channel or a noise resumes the agent from the
exact unheard rest of the cut line; a real point is answered as a normal turn.
The browser's version is `voni/src/lib/voice/session.ts` (`heardWords`,
`unheardRest`, `resumeAfterBargeIn`) and `voni/src/lib/voice/barge-in.ts`.

The phone bridge keeps its own implementation (ADR 0007). This module is the
small pure half both tests read through the same case table
(`voni/src/lib/voice/barge-in-recovery.cases.json`): the words the caller heard
of a line, the exact tail from the last heard word, and the resume
instructions. Nothing here touches a socket, so the behaviour is testable
without a call.

Why the tail starts at the last heard word, not the next one: the cut lands
mid-word, so the browser says that word again. Why a tail of a few words says
nothing: the caller already got the point.
"""

from __future__ import annotations

CONTRACT = "barge-in-recovery/1"

# How the caller's heard words are derived when the playout cannot report
# consumed samples: ~58 ms per character, measured on the demo voices and the
# browser's own caption pace (`CAPTION_MS_PER_CHAR` in session.ts). The phone
# bridge forwards audio at the agent's rate, so wall-clock since the first
# audible chunk is the same estimate.
CAPTION_MS_PER_CHAR = 58

# A resume after a cut says the rest only when more than this many words were
# unheard. Mirrors `RESUME_MIN_WORDS` in the browser session.
RESUME_MIN_WORDS = 3


def heard_words(line: str, played_ms: float, ms_per_char: int = CAPTION_MS_PER_CHAR) -> str:
    """The words of `line` whose start has played after `played_ms` of its audio."""
    words = [word for word in line.split() if word]
    chars = 0
    count = 0
    for word in words:
        if chars * ms_per_char > played_ms:
            break
        chars += len(word) + 1
        count += 1
    return " ".join(words[:count])


def unheard_rest(line: str, heard: str) -> str:
    """What the caller didn't hear of a cut line, from the last heard word.

    It was cut mid-way, so that word is said again. "" when nothing was heard.
    """
    words = [word for word in line.split() if word]
    heard_count = len([word for word in heard.split() if word])
    return " ".join(words[max(0, heard_count - 1):])


def nothing_left_unheard(line: str, heard: str) -> bool:
    """Whether the caller already heard every word of the line."""
    total = len([word for word in line.split() if word])
    if total == 0:
        return True
    heard_count = len([word for word in heard.split() if word])
    return heard_count >= total


def worth_resuming(rest: str) -> bool:
    """A tail of a few words is the caller having got the point."""
    return len([word for word in rest.split() if word]) > RESUME_MIN_WORDS


def resume_instructions(caller_text: str, rest: str) -> str:
    """Tell the agent to say exactly the unheard rest, never the heard part."""
    rest = rest.strip()
    caller = caller_text.strip()
    cause = (
        f'The caller only said "{caller[:200]}" while you were speaking; '
        "it wasn't a request to stop."
        if caller
        else "A noise on the caller's side cut you off; they didn't say anything."
    )
    if rest:
        return (
            f"{cause} Finish your sentence: say exactly this and nothing else, "
            f'word for word: "{rest[:400]}"'
        )
    return f"{cause} Say your short goodbye once more, nothing else."


def resume_for_barge_in(caller_text: str, rest: str) -> str | None:
    """The resume line to send, or None when there is nothing worth saying."""
    if not worth_resuming(rest):
        return None
    return resume_instructions(caller_text, rest)


def cut_tail(line: str, played_ms: float) -> dict:
    """What an interrupted reply leaves behind: heard words, the tail, and
    whether the tail is worth resuming. The one place a cut is marked, so an
    interrupted reply can never be dropped without a record of what it lost."""
    heard = heard_words(line, played_ms)
    rest = unheard_rest(line, heard)
    return {"heard": heard, "rest": rest, "resumable": worth_resuming(rest)}
