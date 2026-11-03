"""The cascade turn stream: the one ``CallStream`` the browser call serves.

:class:`cascade.call.CallLifecycle` owns the order a call opens, streams and
drains in. This module owns the turn layer inside that order, and it composes
the pieces the cascade already has rather than re-implementing them:

* :class:`cascade.event_rules.EventRules` applies provider events to the
  logical turn store. Only an authoritative ``speechComplete`` reaches the
  reply sink; ``speechEnd`` never asks the model for anything.
* ``MetaLLM.complete`` (or the body's BYO client) streams one reply. Sentence
  boundaries are found with :func:`cascade.meta_llm.last_complete_sentence`, so
  synthesis starts on the first whole sentence and never on a cut word.
* the opened synthesis session's ``speak`` yields the audio; every frame goes
  through ``CallLifecycle.emit_audio``, so the call owns the one monotonic
  ``seq`` and this module cannot invent a second counter.
* :class:`cascade.tools.ToolExecutor` runs a tool handoff through the app's
  existing route, and :func:`cascade.tools.continue_after_tool` continues the
  same logical turn with the ``role: "tool"`` results.

Barge-in is the caller winning the floor: a real ``speechStart`` while audio is
sounding sends the synthesis session's ``Cancel`` and stops the reply task. The
cancelled turn is settled so a later final is not held behind it.

A final is answered only once the caller's audio has been quiet for
``turn.hold_silence_ms``, bounded by ``turn.hold_max_ms``. The recogniser can
finalise the first half of a sentence ("Fine." before a 340 ms pause) while the
caller keeps talking; answering that fragment takes the floor from a caller who
still owns it. The pump reports every caller frame through
:meth:`CascadeTurnStream.caller_audio`, so a final that arrives while speech is
still arriving waits, new speech extends the wait, and a final that already
arrived after the quiet window is answered at once with no added latency. When
the caller resumes, the held fragment is dropped and carried into the next
final, so one reply answers the whole turn and nothing is said twice.

An acknowledgement opener ("Right,", "Got it —") is stripped before synthesis,
so the caller hears the substance and never the padding. A reply that was only
an opener is withheld; one bounded repair is asked, and a repair that is still
nothing but an opener fails the turn by name rather than speaking a bare "Got
it."

One ticker drives both time-based duties on the injected clock:
:meth:`EventRules.tick` at ``turn.stall_guard_ms`` while a final is held, and
``AssemblyAIStreamingTTS.keepalive_if_idle`` at ``tts.keepalive_interval_ms``
while no reply is sounding. A new held final wakes the wait, so the guard is
never later than its named bound and a test can drive the same loop with a fake
clock instead of sleeping.

The turn layer reports its own evidence (demo-verification 04): when a
:class:`cascade.events.TurnLedger` is wired, each caller final, reply start,
first reply frame, cut, tool call and result, goodbye and hangup is written as
one row against its logical turn, and a failed reply names the leg and the
error class. A trace failure is logged and never ends the call.

``end_call`` is call control (ticket 87): the signal's closing line is spoken
through the same voice, the logical turn is closed, and the call is asked to
drain and send its end message. Nothing generated after the signal is spoken.

The model request is gated on the LLM leg and synthesis on the TTS leg, so a
closed LLM leg never cuts audio that was already generated.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from cascade.assemblyai_tts import split_sentences
from cascade.end_intent import wants_to_end
from cascade.event_rules import EventKind, EventRules
from cascade.events import TurnLedger
from cascade.meta_llm import (
    MessageHistory,
    MetaLLMTurn,
    TurnUsage,
    last_complete_sentence,
)
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.thresholds import require_bound
from cascade.tools import (
    CALL_CONTROL_TOOLS,
    DeniedCall,
    EndCallSignal,
    ToolFailure,
    ToolLoop,
    closing_line_from,
    continue_after_tool,
    execute_turn_calls,
)
from cascade.turn_state import TurnState, TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript, TokenDelta, ToolCallRequest

#: One outbound audio frame: the call lifecycle's ``emit_audio``.
AudioEmitter = Callable[..., Awaitable[Any]]

#: Whether a vendor request may still be made on a leg (the call's ceiling).
RequestGate = Callable[[str], bool]

#: One browser caption: role, text and whether it is the final text.
CaptionSink = Callable[[str, str, bool], Awaitable[None]]

#: The client's playout flush after a barge-in.
InterruptSink = Callable[[], Awaitable[None]]

#: One recorded turn's usage is on the meter; the call checks its ceiling.
BilledSink = Callable[[], Awaitable[None]]

#: ``end_call`` has spoken its closing line; the call drains and hangs up.
EndCallSink = Callable[[], Awaitable[None]]

_log = logging.getLogger(__name__)

#: The idle keepalive cadence (ticket 53's bound; never a literal here).
KEEPALIVE_BOUND = "tts.keepalive_interval_ms"

#: How long a reply may stay silent before one short spoken ack covers it.
ACK_DELAY_BOUND = "reply.ack_delay_ms"

#: How quiet the caller's audio must be before a finalised turn is answered.
#: The owner's direction (2026-11-03): never take the floor while the caller is
#: still speaking. The value lives in the registry; this module names it.
HOLD_SILENCE_BOUND = "turn.hold_silence_ms"

#: The most a final may wait for that quiet, so a stream that never goes quiet
#: still gets its answer.
HOLD_MAX_BOUND = "turn.hold_max_ms"

#: How many replies the hidden no-reuse note lists. The exact-match guard
#: remembers every reply this call spoke, so a line repeated many turns later
#: (a second invite) is still withheld; the note stays short to keep the
#: per-turn prompt bounded.
REPEAT_NOTE_WINDOW = 2

#: The duplicate bar, in words, after normalisation. This is a rule, not a
#: tunable: one-word agreements ("Yes.") must never be dropped for agreeing
#: twice, while a measured two-word loop ("Not quite.") is caught.
REPEAT_MIN_WORDS = 2

#: Punctuation is a separator, not content: "what's" and "what s" are one form.
_NON_WORD = re.compile(r"[^\w\s]+", re.UNICODE)

#: Acknowledgement openers carry no answer. This is a rule, not a tunable: the
#: owner's decision (2026-11-03) is that no reply opens with one, in any
#: register. Each entry is the opener form only; a meaning-bearing word is not
#: an opener just because it appears inside a sentence ("the right answer").
_FILLER_OPENERS = (
    "right",
    "got it",
    "you got it",
    "okay",
    "ok",
    "alright",
    "fair enough",
    "no worries",
    "no problem",
    "sure",
    "of course",
    "you're welcome",
    "absolutely",
    "i see",
    "yeah",
    "yep",
    "mm-hmm",
    "uh-huh",
    "sounds good",
    "cool",
)

#: What ends an opener: comma, full stop, colon, ellipsis, or a spaced dash. A
#: hyphen glued to the next word is a compound ("right-click"), not a
#: separator, so the hyphen form needs whitespace on both sides.
_FILLER_SEPARATOR = (
    r"(?:\s*,\s*|\s*\.\.\.\s*|\s*…\s*|\s*\.\s*|\s*:\s*|\s*[—–]\s*|\s+-\s+)"
)

#: The anchored opener form. Longest phrase first so "okay" is tried before
#: "ok", and end-of-text counts as a separator so a bare "Got it" is all filler.
_FILLER_OPENER = re.compile(
    "^(?:"
    + "|".join(
        re.escape(phrase)
        for phrase in sorted(_FILLER_OPENERS, key=len, reverse=True)
    )
    + ")(?:"
    + _FILLER_SEPARATOR
    + r"|\s*$)",
    re.IGNORECASE,
)


def _strip_filler_openers(text: str) -> tuple[str, int]:
    """Remove every leading acknowledgement opener and count them.

    Repeats so "Right, got it — …" loses both. Only the anchored opener form
    with a separator matches, so a word inside a sentence is never touched.
    The remainder opens the spoken sentence, so its first letter is capitalised
    ("got it — showing" becomes "Showing").
    """
    removed = 0
    while True:
        match = _FILLER_OPENER.match(text)
        if match is None:
            text = text.strip()
            if removed and text:
                text = text[:1].upper() + text[1:]
            return text, removed
        text = text[match.end() :]
        removed += 1


class ReplyRepeatedOnly(RuntimeError):
    """The bounded repair still only repeated a line already spoken.

    The turn has nothing new to say. Naming the failure is deliberate: the
    caller hears nothing more and the trace records the turn as failed rather
    than looping the same sentence or going silent with no record.
    """


class ReplyQuestionOnly(RuntimeError):
    """The bounded repair only asked another unanswered question.

    The caller did not answer the last question, so every question sentence
    was withheld, including the repair's. Nothing speakable remained. Naming
    the failure is deliberate: the caller hears nothing and the trace records
    the turn as failed rather than looping the question or going silent with
    no record.
    """


class ReplyFillerOnly(RuntimeError):
    """The bounded repair was still nothing but an acknowledgement.

    The opener guard withheld every sentence of a reply that carried no
    substance, so the caller heard nothing. The repair may not open with
    another acknowledgement; if it still does, the turn fails by name rather
    than speaking a bare "Got it." Naming the failure is deliberate: the
    caller hears nothing and the trace records the turn as failed.
    """


class ReplyOfferOnly(RuntimeError):
    """The reply was only a test/invite offer the caller did not invite.

    The offer guard withheld every sentence that carried the product's offer
    vocabulary, because the caller's final was not willing. Nothing new
    remained to speak. An offer-only reply is never repaired: a repair would
    ask for the same offer again. Naming the failure is deliberate: the caller
    hears nothing further and the trace records the turn as failed rather than
    looping the offer.
    """


def _normal_form(text: str) -> str:
    """The duplicate rule's normal form: case-folded, punctuation to space."""
    return " ".join(_NON_WORD.sub(" ", text.casefold()).split())


#: Function words carry no answer: a caller who says "plumbing business" has
#: answered "What does your business do?" through "business", not "what",
#: "does" or "your". Deliberately small: ordinary nouns stay content words.
_STOP_WORDS = frozenset(
    "a an the and or but if then so to of in on at for from with by about as "
    "into over under up down out off again also just only very really too much "
    "many some any all no not yes is are was were be been being am do does did "
    "doing done have has had having will would can could should shall may might "
    "must i you your yours my mine me we us our ours he she it its they them "
    "their theirs his her this that these those there here what which who whom "
    "whose when where why how please okay ok well oh hi hello thanks thank sorry "
    "let lets s t re ve ll d m".split()
)

#: One word of a caller's final or a question, for the answer test.
_WORD = re.compile(r"\w+", re.UNICODE)


def _content_words(text: str) -> frozenset[str]:
    """The words an answer must share with a question: content, not grammar."""
    return frozenset(
        word for word in _WORD.findall(text.casefold()) if word not in _STOP_WORDS
    )


#: The words that open a question even when the sentence carries no "?".
#: Deliberately grammar only: a normal word ("your service is useless") never
#: makes a statement a question.
_QUESTION_OPENERS = frozenset(
    "what why how when where who which whose can could do does did are is was "
    "were would will should have has am".split()
)

#: A request for information ("Tell me what went wrong") asks its question
#: after an imperative frame. The measured hostile call's first question had
#: no "?" and did not start with a question word.
_QUESTION_REQUEST = re.compile(
    r"^(?:(?:tell|show)\s+(?:me|us)|explain)\s+", re.IGNORECASE
)


def _is_question(sentence: str) -> bool:
    """A spoken sentence is a question when it asks one, with or without "?".

    A question ends with "?", opens with a wh-word or auxiliary, or follows an
    information request frame ("tell me what ..."). The live hostile call asked
    "What exactly needs fixing right now ..." with no question mark at all.
    """
    if "?" in sentence:
        return True
    text = _QUESTION_REQUEST.sub("", sentence.strip(), count=1)
    words = _WORD.findall(text.casefold())
    return bool(words) and words[0] in _QUESTION_OPENERS


def _reply_sentences(text: str) -> list[str]:
    """Every spoken sentence in one reply, including an unterminated last one.

    ``last_complete_sentence`` deliberately returns the *longest* complete
    prefix so one ``_speak`` can carry several sentences. Duplicate matching
    needs the individual sentences, so this uses the synthesis session's one
    sentence splitter instead of re-deriving boundaries here.
    """
    return [piece.strip() for piece in split_sentences(text) if piece.strip()]


#: The product's own offer vocabulary: the live test and the invite. This is
#: deliberately the vocabulary of the thing being gated, not a corpus of
#: complaint words. A sentence that carries any of these is an offer sentence.
_OFFER_VOCABULARY = re.compile(
    r"\b(?:live test|test|email|send me|your screen|give it a shot|try it)\b",
    re.IGNORECASE,
)

#: Two small intent sets. A caller's final is willing only when it accepts the
#: test or asks what Voni can do. An acceptance is the caller's answer, so it
#: opens the final; a product question may appear anywhere in it. A complaint,
#: a neutral turn, small talk or a challenge is in neither set, so no offer
#: sentence may be spoken on that turn.
_WILLING_ACCEPTANCE = re.compile(
    r"^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|let'?s do it|try it|do it|"
    r"i'?m ready|i am ready)\b",
    re.IGNORECASE,
)
_WILLING_PRODUCT_QUESTION = re.compile(
    r"\b(?:what can you do|what do you do|how does it work|how do you work|"
    r"tell me what you (?:can )?(?:actually )?do|show me|check (?:my|your) email)\b",
    re.IGNORECASE,
)


def _caller_is_willing(text: str) -> bool:
    """Whether the caller's final accepts the test or asks what Voni does."""
    return bool(
        _WILLING_ACCEPTANCE.match(text)
        or _WILLING_PRODUCT_QUESTION.search(text)
    )


def _is_offer(sentence: str) -> bool:
    """Whether a spoken sentence carries the product's offer vocabulary."""
    return bool(_OFFER_VOCABULARY.search(sentence))


def _repeat_note(replies: Sequence[str]) -> str:
    """The general repeat guard: the last replies, verbatim, refused.

    Exact matching only ever catches a line already heard word for word. This
    note is what generalises it to a paraphrase: the model sees the lines it
    must not reuse, rather than the pipeline guessing which new words mean the
    same thing. Nothing here is captioned, recorded or spoken.
    """
    said = "\n".join(f"- {reply}" for reply in replies)
    return (
        "Lines you already said in this call, verbatim:\n"
        f"{said}\n"
        "Do not repeat or paraphrase any of these lines, questions or openers "
        "you already said. Answer only what the caller just said, in a new way."
    )


def _merged_usage(first: TurnUsage, second: TurnUsage) -> TurnUsage:
    """One logical turn's two requests, summed only where both are measured."""
    if not first.measured:
        return second
    if not second.measured:
        return first

    def add(left: int | None, right: int | None) -> int | None:
        if left is None or right is None:
            return None
        return left + right

    return TurnUsage(
        prompt_tokens=add(first.prompt_tokens, second.prompt_tokens),
        completion_tokens=add(first.completion_tokens, second.completion_tokens),
        total_tokens=add(first.total_tokens, second.total_tokens),
        cached_tokens=add(first.cached_tokens, second.cached_tokens),
        reasoning_tokens=add(first.reasoning_tokens, second.reasoning_tokens),
        measured=True,
    )


class CascadeTurnStream:
    """The turn layer for one cascade call, on the lifecycle's seams."""

    def __init__(
        self,
        *,
        llm: Any,
        tts: Any,
        tools: Sequence[Mapping[str, Any]] = (),
        emit_audio: AudioEmitter,
        may_request: RequestGate | None = None,
        tool_executor: Any | None = None,
        locale_code: str = "en",
        ledger: TimingLedger | None = None,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        stall_guard_ms: float | None = None,
        on_caption: CaptionSink | None = None,
        on_interrupted: InterruptSink | None = None,
        on_turn_billed: BilledSink | None = None,
        on_end_call: EndCallSink | None = None,
        history: Sequence[Mapping[str, Any]] = (),
        ack_lines: Sequence[str] = (),
        ack_delay_ms: float | None = None,
        turn_events: TurnLedger | None = None,
    ) -> None:
        self._llm = llm
        self._tts = tts
        self._tools = tuple(tools)
        self._emit_audio = emit_audio
        self._may_request = may_request
        self._tool_executor = tool_executor
        self._locale_code = locale_code
        self._ledger = ledger
        self._clock = clock if clock is not None else time.monotonic
        self._sleep = sleep if sleep is not None else asyncio.sleep
        self._on_caption = on_caption
        self._on_interrupted = on_interrupted
        self._on_turn_billed = on_turn_billed
        self._on_end_call = on_end_call
        #: The call's turn ledger: one row per event, through the one stream.
        #: ``None`` means the caller wired no trace and no row is emitted.
        self._turn_events = turn_events
        self._first_audio_turns: set[str] = set()
        #: The leg the reply task was working on when it failed, so a failed
        #: turn names the leg that actually broke instead of assuming the model.
        self._active_leg = "llm"
        self._ack_lines = tuple(ack_lines)
        self._ack_delay_s = (
            (float(require_bound(ACK_DELAY_BOUND)) if ack_delay_ms is None else float(ack_delay_ms))
            / 1000.0
        )
        #: One ack watcher per reply; never spoken as the reply or captioned.
        self._ack_task: asyncio.Task | None = None
        self._ack_index = 0
        #: Serialises the ack and the reply on the one synthesis session.
        self._voice_lock = asyncio.Lock()

        #: The quiet-window hold (the owner's direction, 2026-11-03). The pump
        #: stamps every caller speech frame here; a final waits for the quiet
        #: window before the model request starts, bounded by the max wait.
        self._hold_silence_s: float | None = None
        self._hold_max_s: float | None = None
        self._caller_speech_at: float | None = None
        self._hold_wake = asyncio.Event()
        #: Set by ``drain``: the call is ending, so a held final is released
        #: instead of waiting out its window.
        self._draining = False
        #: The fragment of a turn the caller kept talking through. It is
        #: carried into the next final so one reply answers the whole turn.
        self._carried_final = ""
        #: Evidence counters: how many finals waited, how many were merged
        #: into the next final, and how long the last wait added.
        self.holds = 0
        self.hold_dropped = 0
        self.hold_waited_ms = 0.0

        self._turns = TurnStateStore(clock=self._clock, source="meta")
        self._rules = EventRules(
            turns=self._turns,
            on_reply=self._request_reply,
            ledger=ledger,
            clock=self._clock,
            stall_guard_ms=stall_guard_ms,
        )
        # The system prompt belongs to the model client; this history holds the
        # conversation and the browser's hidden context only. A hold return
        # seeds it with the signed body's carried turns.
        self._history = MessageHistory()
        self._history.seed(history)
        self._tool_loop: ToolLoop | None = None

        self._reply_task: asyncio.Task | None = None
        self._active: TurnState | None = None
        self._speaking = False
        #: The text spoken in the current reply, so the browser gets one final
        #: caption after the audio (not only sentence partials).
        self._reply_text = ""
        #: Every reply the caller actually heard this call, oldest first. A
        #: duplicate is a duplicate of any of these, because the product rule
        #: is one line per call (a second invite included); seeded hold-return
        #: history is not a reply this call spoke and is never consulted.
        self._spoken_replies: list[str] = []
        #: This reply's new sentences, and the duplicates withheld from it.
        self._reply_new_sentences = 0
        self._reply_dropped: list[str] = []
        #: One repair request per logical turn, never retried.
        self._repeat_repaired = False
        #: Metric counters: a repair was asked for, and a sentence was withheld.
        self.repeat_repair = 0
        self.repeat_dropped = 0
        #: The last question this call asked and the content words it carried.
        #: Only a spoken question is recorded; a withheld one was never heard.
        self._last_question = ""
        self._last_question_words: frozenset[str] = frozenset()
        #: Whether this reply may not ask a question: the previous question was
        #: left unanswered. Computed from the caller's final, once per turn.
        self._must_not_ask = False
        #: This reply's withheld question sentences, and its one repair flag.
        self._reply_question_withheld: list[str] = []
        self._question_repaired = False
        #: Metric counters: a question was withheld, a repair was asked for.
        self.question_withheld = 0
        self.question_repair = 0
        #: This reply's acknowledgement-only sentences, and its one repair flag.
        self._reply_filler_withheld: list[str] = []
        self._filler_repaired = False
        #: Metric counter: one per acknowledgement opener removed before speech.
        self.filler_stripped = 0
        #: Whether the caller's final this turn is willing: an acceptance or a
        #: question about what Voni does. Decided once per turn from the final.
        self._willing_turn = False
        #: This reply's withheld offer sentences, and the metric counter. An
        #: offer-only reply fails by name; it is never repaired.
        self._reply_offer_withheld: list[str] = []
        self.offer_withheld = 0
        #: Whether the caller's final asked to end (call control, not a tool).
        self._caller_wants_end = False
        self._buffer = ""
        self._failure: BaseException | None = None
        self._records: dict[str, MetaLLMTurn] = {}
        self._completed: list[str] = []
        #: How many model requests this call actually made. A greeting-only
        #: call makes none, so the cost meter can price that leg as a measured
        #: zero from the pipeline's own count.
        self._requests = 0
        #: ``end_call`` won: no model request or spoken content follows it.
        self._ending = False
        #: The hangup the turn layer asked for, once the closing line played.
        #: A barge-in before it withdraws the decision and keeps the call live.
        self._hangup_requested = False
        #: The one ticker: the stall guard's deadline and the idle keepalive.
        self._tick_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._next_keepalive_at: float | None = None
        self._keepalive_interval_s: float | None = None
        #: Idle ticks that found a reply in flight (audio is its own traffic).
        self.keepalives_skipped = 0

    # -- CallStream -------------------------------------------------------

    async def start(self) -> None:
        """The opening is over; the turn layer may answer finals.

        The ticker starts here because both of its duties only exist once the
        call is streaming: the stall guard's deadline on a held final, and the
        synthesis session's idle keepalive between replies.
        """
        if self._tick_task is None:
            self._next_keepalive_at = self._clock() + self._keepalive_interval()
            self._tick_task = asyncio.ensure_future(self._tick_loop())
        return None

    async def event(self, event: Any) -> None:
        """Apply one provider event, and cut a sounding reply on a real start."""
        if self._failure is not None:
            raise self._failure
        if isinstance(event, SpeechStart) and self._speaking:
            await self._cancel_reply()
        outcome = await self._rules.apply(event)
        if (
            outcome.kind is EventKind.SPEECH_COMPLETE
            and outcome.turn is not None
            and outcome.user_text
            and (outcome.reply_requested or outcome.held)
        ):
            self._user_final(outcome.turn, outcome.user_text)
        if isinstance(event, PartialTranscript):
            await self._caption("user", event.text, False)
        elif isinstance(event, SpeechComplete):
            await self._caption("user", event.text, True)
        if isinstance(event, (SpeechStart, PartialTranscript, SpeechComplete)):
            # A held final re-checks its quiet window when the provider's turn
            # boundary moves: a later open turn is the caller still talking.
            self._hold_wake.set()
        # A new held final (or a settled one) moves the ticker's next deadline;
        # the wake interrupts a keepalive wait so the guard is never late.
        self._wake.set()

    async def context(self, text: str) -> None:
        """Hold a browser context line for the next request only."""
        self._history.add_hidden_context(text)

    async def drain(self) -> None:
        """Finish the in-flight reply, then stop; a failure still surfaces."""
        ticker, self._tick_task = self._tick_task, None
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        # A held final is not left waiting out its quiet window while the call
        # is ending: the window is released and the scheduled reply finishes.
        self._draining = True
        self._hold_wake.set()
        task = self._reply_task
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self._failure is not None:
            raise self._failure

    @property
    def model(self) -> str | None:
        """The model id this call's stream is serving, if it names one.

        The call prices its llm leg from this, so a demo override is priced
        from its own model's rates rather than the default model's.
        """
        value = getattr(self._llm, "model", None)
        return value if isinstance(value, str) and value else None

    def turn_count(self) -> int:
        """How many logical turns produced a model reply."""
        return len(self._completed)

    def turn_usage(self) -> Mapping[str, Any]:
        """Each completed logical turn's vendor usage chunk, by turn id.

        An in-flight turn is absent, so the lifecycle records it once, when its
        usage chunk exists. A turn that never saw a chunk reports unmeasured,
        never zero.
        """
        return {
            turn: self._records[turn].usage
            for turn in self._completed
            if turn in self._records
        }

    def request_count(self) -> int:
        """How many model requests this call actually made.

        A greeting-only call makes none: the count is the pipeline's own fact,
        so the call can price that leg as a measured zero. A request that ended
        before its usage chunk still counts, which keeps that leg unmeasured.
        """
        return self._requests

    # -- the reply --------------------------------------------------------

    async def _request_reply(self, state: TurnState) -> None:
        """Schedule one reply; the event loop stays free for barge-in."""
        if self._ending:
            return
        if self._may_request is not None and not self._may_request("llm"):
            return
        self._active = state
        self._reply_task = asyncio.ensure_future(self._answer_after_quiet(state))
        self._reply_task.add_done_callback(
            lambda task, state=state: self._reply_done(task, state)
        )

    def _reply_done(self, task: asyncio.Task, state: TurnState) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._turn_failed(state, error)
            self._failure = error

    # -- the quiet window -------------------------------------------------

    def caller_audio(self, *, speech: bool) -> None:
        """One caller audio frame, from the call's pump.

        ``speech`` is the frame's own loudness verdict, not the provider's
        event: the browser streams room tone continuously, so only speech
        frames are the caller holding the floor. A new speech frame extends a
        held final's quiet window and wakes its wait.
        """
        if not speech:
            return
        self._caller_speech_at = self._clock()
        self._hold_wake.set()

    def _hold_silence(self) -> float:
        """The quiet window's value, read once from the named bound."""
        if self._hold_silence_s is None:
            self._hold_silence_s = float(require_bound(HOLD_SILENCE_BOUND)) / 1000.0
        return self._hold_silence_s

    def _hold_max(self) -> float:
        """The bounded wait's value, read once from the named bound."""
        if self._hold_max_s is None:
            self._hold_max_s = float(require_bound(HOLD_MAX_BOUND)) / 1000.0
        return self._hold_max_s

    def _later_turn_open(self, state: TurnState) -> bool:
        """Whether the caller has already begun a turn after this final.

        A final can be emitted for the first half of a sentence while the
        caller keeps talking; the provider then opens the next turn before the
        held reply was answered. That is the caller still owning the floor, so
        the fragment is merged rather than answered.
        """
        return any(other.seq > state.seq for other in self._turns.open_turns())

    async def _hold_for_quiet(self, state: TurnState) -> float | None:
        """Wait for caller quiet; ``None`` means this final was a fragment.

        The common case adds nothing: a final that arrived after the quiet
        window is answered immediately. A final that arrives while the caller's
        audio is still arriving waits for the window, and a caller who resumes
        (new speech, or a later turn already open) drops the held fragment.
        The wait is bounded by ``turn.hold_max_ms`` so a stalled stream never
        blocks the reply.
        """
        speech_at = self._caller_speech_at
        started = self._clock()
        if speech_at is None or started - speech_at >= self._hold_silence():
            return 0.0
        silence_s = self._hold_silence()
        max_s = self._hold_max()
        while True:
            if self._draining:
                now = self._clock()
                return round(max(0.0, (now - started) * 1000.0), 3)
            if self._later_turn_open(state):
                return None
            now = self._clock()
            quiet_for = now - self._caller_speech_at
            if quiet_for >= silence_s or now - started >= max_s:
                return round(max(0.0, (now - started) * 1000.0), 3)
            await self._wait_for_hold(
                min(silence_s - quiet_for, max_s - (now - started))
            )

    async def _wait_for_hold(self, delay: float) -> None:
        """Wait ``delay`` on the injected clock, woken early by new caller audio."""
        sleeper = asyncio.ensure_future(self._sleep(max(0.0, delay)))
        waker = asyncio.ensure_future(self._hold_wake.wait())
        try:
            await asyncio.wait(
                {sleeper, waker}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (sleeper, waker):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sleeper, waker, return_exceptions=True)
            self._hold_wake.clear()

    def _carry_fragment(self, text: str) -> None:
        """Keep a dropped fragment for the next final that answers this turn."""
        fragment, _ = _strip_filler_openers(text.strip())
        if not fragment:
            return
        self._carried_final = f"{self._carried_final} {fragment}".strip()

    def _caller_text(self, state: TurnState) -> str:
        """The caller's words for this turn, with any carried fragment merged."""
        if not self._carried_final:
            return state.final_text
        merged = f"{self._carried_final} {state.final_text}".strip()
        self._carried_final = ""
        return merged

    async def _answer_after_quiet(self, state: TurnState) -> None:
        """Take the floor only once the caller's audio has been quiet.

        The floor-take mark, the spoken ack and the model request all sit after
        the hold: the reply gap measures the agent's own wait, not the caller's.
        """
        held_ms = await self._hold_for_quiet(state)
        if held_ms is None:
            await self._merge_fragment(state)
            return
        self.hold_waited_ms = held_ms
        if held_ms > 0.0:
            self.holds += 1
            self._count_metric("reply_held")
        if self._ending:
            return
        if self._ledger is not None:
            self._ledger.mark("floor_take")
        if self._ack_lines:
            self._ack_task = asyncio.ensure_future(self._ack_if_slow())
        await self._reply(state)

    async def _merge_fragment(self, state: TurnState) -> None:
        """Drop the held reply and carry its words into the next final.

        The turn is settled so reply ordering cannot wait on a reply that will
        never come, and the fragment is not counted as a turn with a reply.
        """
        self.hold_dropped += 1
        self._count_metric("reply_merged")
        self._carry_fragment(state.final_text)
        self._active = None
        await self._rules.settle(state, reason="merged")

    async def _reply(self, state: TurnState) -> None:
        # The model request starts here, after the caller-final row landed: the
        # reply ordering queue may hold the request, so the row is written when
        # the request really starts, not when the final was queued.
        self._reply_start(state)
        # One loop turn so a context update delivered with the final lands in
        # this request: the lifecycle replays buffered events before buffered
        # contexts, and the caller's context is for the next reply.
        await asyncio.sleep(0)
        key = state.id.event_id
        # The caller's words this reply answers: a fragment the caller talked
        # through is merged into the final that completed the turn.
        caller_text = self._caller_text(state)
        self._buffer = ""
        self._reply_new_sentences = 0
        self._reply_dropped = []
        self._repeat_repaired = False
        self._reply_question_withheld = []
        self._question_repaired = False
        self._reply_filler_withheld = []
        self._filler_repaired = False
        self._reply_offer_withheld = []
        # The willingness rule is decided from the caller's final, once per
        # turn: a complaint, a neutral turn, small talk or a challenge is not
        # willing, so no offer sentence may be spoken.
        self._willing_turn = _caller_is_willing(caller_text)
        # The unanswered-question rule is decided from the caller's final, once
        # per turn: it consumes the last question so it cannot fire twice.
        self._must_not_ask = self._question_was_unanswered(caller_text)
        # The caller's words end the call, not the model's tool choice: Spark
        # does not call the hang-up tool on a caller request (measured 0/20).
        self._caller_wants_end = wants_to_end(caller_text, self._locale_code)
        record = MetaLLMTurn()
        cancelled = False
        try:
            self._history.append_user(caller_text)
            self._add_repeat_note()
            record = await self._run_turn(state, record)
            if (
                not self._ending
                and self._reply_new_sentences == 0
                and self._reply_offer_withheld
            ):
                # Withhold, never repair: a repair would ask for the same
                # offer again. The caller hears nothing further and the turn
                # fails by name instead of looping.
                raise ReplyOfferOnly(
                    "the reply was only a test offer the caller did not invite"
                )
            if self._should_repair_unanswered_question():
                await self._repair_unanswered_question(record)
            elif self._should_repair_repeated_reply():
                await self._repair_repeated_reply(record)
            elif self._should_repair_filler_reply():
                await self._repair_filler_reply(record)
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            ack_task = self._ack_task
            self._ack_task = None
            if ack_task is not None and not ack_task.done():
                ack_task.cancel()
                await asyncio.gather(ack_task, return_exceptions=True)
            record.close()
            self._records[key] = record
            if key not in self._completed:
                self._completed.append(key)
            self._speaking = False
            self._active = None
            # One final agent caption per reply: the browser appends the turn
            # once, after the audio, instead of holding a partial forever.
            spoken = self._reply_text.strip()
            self._reply_text = ""
            if spoken:
                self._remember_reply(spoken)
                await self._caption("agent", spoken, True)
            if not cancelled:
                # The turn's usage chunk exists now: the call records and
                # prices it before the next utterance, not at the next event.
                await self._notify_billed()
                await self._rules.settle(state)

    async def _run_turn(self, state: TurnState, record: MetaLLMTurn) -> MetaLLMTurn:
        """One logical turn: a reply, then any bounded tool rounds."""
        while True:
            if self._ending:
                return record
            if self._may_request is not None and not self._may_request("llm"):
                return record
            calls: list[ToolCallRequest] = []
            self._active_leg = "llm"
            async for item in self._complete(record):
                if isinstance(item, ToolCallRequest):
                    calls.append(item)
                    self._tool_call(state, item, index=len(calls) - 1)
                    if item.name in CALL_CONTROL_TOOLS and closing_line_from(
                        item.arguments
                    ) is not None:
                        # The model has already decided to end the call: the
                        # closing line is the only speakable content left.
                        self._stop_speech()
                elif isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
            if not record.tool_calls or self._tool_executor is None:
                if self._caller_wants_end:
                    await self._request_hangup(state, reason="caller_end")
                return record
            self._active_leg = "tool"
            outcomes = await execute_turn_calls(self._tool_executor, record, calls)
            self._tool_results(state, outcomes)
            signal = next(
                (item for item in outcomes if isinstance(item, EndCallSignal)), None
            )
            if signal is not None:
                await self._finish_end_call(signal, state)
                return record
            if self._caller_wants_end and any(
                isinstance(item, DeniedCall) and item.name in CALL_CONTROL_TOOLS
                for item in outcomes
            ):
                # The model asked to hang up with no closing line; the caller
                # already asked to end, so the spoken reply is the goodbye.
                await self._request_hangup(state, reason="caller_end")
                return record
            self._active_leg = "llm"
            record = await self._continue_after_tools(record, outcomes)
            if not record.tool_calls:
                if self._caller_wants_end:
                    await self._request_hangup(state, reason="caller_end")
                return record

    def _complete(self, record: MetaLLMTurn):
        """One model request for this logical turn, streaming its deltas."""
        self._count_request()
        return self._llm.complete(
            messages=self._history.request_messages(),
            tools=list(self._tools) or None,
            turn=record,
        )

    def _count_request(self) -> None:
        """One model request is about to be made: count it as the pipeline's."""
        self._requests += 1

    async def _continue_after_tools(self, record: MetaLLMTurn, outcomes: Any):
        next_record = MetaLLMTurn()
        async for item in continue_after_tool(
            llm=self._llm,
            history=self._history,
            turn=record,
            outcome=outcomes,
            tools=list(self._tools) or None,
            record=next_record,
            ledger=self._ledger,
            loop=self._loop(),
            on_request=self._count_request,
        ):
            if isinstance(item, TokenDelta):
                await self._say(item.text)
        await self._flush()
        return next_record

    def _loop(self) -> ToolLoop:
        if self._tool_loop is None:
            self._tool_loop = ToolLoop(locale_code=self._locale_code)
        return self._tool_loop

    # -- end call ---------------------------------------------------------

    def _stop_speech(self) -> None:
        """No model request or spoken sentence follows the end-call signal."""
        self._ending = True
        self._buffer = ""

    async def _finish_end_call(self, signal: EndCallSignal, state: TurnState) -> None:
        """Speak the closing line through the bound voice, then end the call.

        The line is the one content still allowed after the signal; the logical
        turn is closed as ``end_call`` and the lifecycle is asked to drain and
        send its one end message.
        """
        self._stop_speech()
        self._goodbye(state)
        line = (signal.closing_line or "").strip()
        # The model often streams its goodbye as content and then calls the
        # tool with the same line as `closing_line` (Gemini does; Spark does
        # not). The caller must hear one goodbye: speak the argument only when
        # the turn spoke nothing, and treat the spoken text as the closing.
        spoken = self._reply_text.strip()
        if line and not spoken:
            await self._speak(line, force=True)
        await self._request_hangup(state)

    async def _request_hangup(
        self, state: TurnState, *, reason: str = "end_call"
    ) -> None:
        """Close the turn as ``end_call`` and ask the call to drain.

        The spoken reply (the goodbye) is already on the wire; nothing else is
        synthesized. A barge-in before the hangup is taken withdraws the
        decision and keeps the call live.
        """
        self._stop_speech()
        self._turns.close(turn=state.id, reason="end_call")
        self._hangup(state, reason=reason)
        # Armed only after the line played: a barge-in before this point
        # cancels the closing speech and withdraws the end-call decision.
        self._hangup_requested = True
        if self._on_end_call is not None:
            await self._on_end_call()

    async def _notify_billed(self) -> None:
        """Tell the call a turn's usage is recorded; a sink failure surfaces."""
        if self._on_turn_billed is None:
            return
        try:
            await self._on_turn_billed()
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._failure = error

    # -- the ticker -------------------------------------------------------

    def _keepalive_interval(self) -> float:
        """The idle keepalive cadence, read once from the named bound."""
        if self._keepalive_interval_s is None:
            self._keepalive_interval_s = float(require_bound(KEEPALIVE_BOUND)) / 1000.0
        return self._keepalive_interval_s

    def _next_tick_at(self) -> float:
        """The earliest of the stall guard's deadline and the keepalive's."""
        deadlines = [self._next_keepalive_at]
        due = self._rules.reply_order.due_at()
        if due is not None:
            deadlines.append(due)
        return min(value for value in deadlines if value is not None)

    async def _tick_loop(self) -> None:
        """One ticker for the stall guard's deadline and the idle keepalive.

        Both are measured on the injected clock, so a fake clock drives the
        same loop a real call drives and no test sleeps. A new held final wakes
        the sleep, so the guard is never later than its named bound.
        """
        try:
            while True:
                delay = max(0.0, self._next_tick_at() - self._clock())
                if delay > 0:
                    await self._sleep_until(delay)
                await self._service_ticks()
        except asyncio.CancelledError:
            raise
        except BaseException as error:  # a ticker failure is the call's failure
            self._failure = error

    async def _sleep_until(self, delay: float) -> None:
        sleeper = asyncio.ensure_future(self._sleep(delay))
        waker = asyncio.ensure_future(self._wake.wait())
        try:
            await asyncio.wait(
                {sleeper, waker}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (sleeper, waker):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sleeper, waker, return_exceptions=True)
            self._wake.clear()

    async def _service_ticks(self) -> None:
        now = self._clock()
        if self._next_keepalive_at is not None and now >= self._next_keepalive_at:
            self._next_keepalive_at = now + self._keepalive_interval()
            await self._keepalive_if_idle()
        due = self._rules.reply_order.due_at()
        if due is not None and self._clock() >= due:
            await self._rules.tick()

    async def _keepalive_if_idle(self) -> None:
        """Keep the synthesis session alive between replies; never over audio."""
        if self._ending:
            return
        task = self._reply_task
        if self._speaking or (task is not None and not task.done()):
            # A reply in flight is not idle: its frames are their own traffic.
            self.keepalives_skipped += 1
            return
        keepalive = getattr(self._tts, "keepalive_if_idle", None)
        if not callable(keepalive):
            return
        await keepalive()

    # -- speech -----------------------------------------------------------

    async def _say(self, text: str) -> None:
        """Buffer generated text and speak every whole sentence it completes."""
        if not text or self._ending:
            return
        self._buffer += text
        while True:
            sentence = last_complete_sentence(self._buffer)
            if not sentence:
                return
            self._buffer = self._buffer[len(sentence) :].lstrip()
            await self._speak(sentence)

    async def _flush(self) -> None:
        """Speak the reply's final, unterminated sentence."""
        if self._ending:
            self._buffer = ""
            return
        sentence = self._buffer.strip()
        self._buffer = ""
        if sentence:
            await self._speak(sentence)

    def _question_was_unanswered(self, caller_text: str) -> bool:
        """Whether the last spoken question is still unanswered by this final.

        One shared content word counts as answered and closes the pending
        question. An unanswered question stays pending: withholding the
        follow-up question does not make the original answered, so the rule
        keeps applying until the caller supplies a content word. A first reply
        and a hold return have no pending question and never fire.
        """
        if not self._last_question:
            return False
        if self._last_question_words & _content_words(caller_text):
            self._last_question = ""
            self._last_question_words = frozenset()
            return False
        return True

    def _should_repair_unanswered_question(self) -> bool:
        """Whether withholding left nothing to say and one repair may be asked."""
        return (
            not self._ending
            and self._must_not_ask
            and not self._question_repaired
            and self._reply_new_sentences == 0
            and bool(self._reply_question_withheld)
            and (self._may_request is None or self._may_request("llm"))
        )

    async def _repair_unanswered_question(self, record: MetaLLMTurn) -> None:
        """One bounded re-ask that must answer the caller, not question them.

        The guard has already withheld every question in the first reply, so
        the caller has heard nothing this turn. The repair may still ask; that
        question is withheld too and only a statement remainder is spoken. If
        nothing remains, the turn fails by name rather than looping. One
        repair per turn, counted, never retried.
        """
        self._question_repaired = True
        self.question_repair += 1
        self._count_metric("question_repair")
        self._history.add_hidden_context(
            "They did not answer your last question. Respond to what they just "
            "said; do not ask another question."
        )
        repair = MetaLLMTurn()
        self._count_request()
        try:
            async for item in self._llm.complete(
                messages=self._history.request_messages(),
                tools=None,
                turn=repair,
            ):
                if isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
        finally:
            repair.close()
        record.usage = _merged_usage(record.usage, repair.usage)
        if self._reply_new_sentences == 0:
            raise ReplyQuestionOnly(
                "the repair reply only asked a question the caller did not answer"
            )

    def _should_repair_filler_reply(self) -> bool:
        """Whether this turn spoke nothing but an acknowledgement."""
        return (
            not self._ending
            and not self._filler_repaired
            and self._reply_new_sentences == 0
            and bool(self._reply_filler_withheld)
            and (self._may_request is None or self._may_request("llm"))
        )

    async def _repair_filler_reply(self, record: MetaLLMTurn) -> None:
        """One bounded re-ask that must begin with the substance, not an ack.

        The opener guard has already withheld every sentence of the first
        reply, so the caller has heard nothing this turn. The repair may still
        open with an acknowledgement; that is stripped again, and if nothing
        else remains the turn fails by name rather than speaking a bare
        "Got it." One repair per turn, never retried.
        """
        self._filler_repaired = True
        self._history.add_hidden_context(
            "You said nothing but an acknowledgement. Answer what they just "
            "said with the substance itself; do not open with an "
            "acknowledgement or filler."
        )
        repair = MetaLLMTurn()
        self._count_request()
        try:
            async for item in self._llm.complete(
                messages=self._history.request_messages(),
                tools=None,
                turn=repair,
            ):
                if isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
        finally:
            repair.close()
        record.usage = _merged_usage(record.usage, repair.usage)
        if self._reply_new_sentences == 0:
            raise ReplyFillerOnly(
                "the repair reply was nothing but an acknowledgement"
            )

    def _should_repair_repeated_reply(self) -> bool:
        """Whether this turn spoke nothing new and may ask one repair."""
        return (
            not self._ending
            and not self._repeat_repaired
            and self._reply_new_sentences == 0
            and bool(self._reply_dropped)
            and (self._may_request is None or self._may_request("llm"))
        )

    async def _repair_repeated_reply(self, record: MetaLLMTurn) -> None:
        """One bounded re-ask naming the line already said, then speak it.

        The guard has already withheld every sentence of the first reply, so
        the caller has heard nothing this turn. The repair must produce new
        content: a repair that only repeats again fails the turn by name rather
        than looping. One repair per turn, counted, never retried.
        """
        self._repeat_repaired = True
        line = self._reply_dropped[0]
        self.repeat_repair += 1
        self._count_metric("repeat_repair")
        self._history.add_hidden_context(
            f"You already said, verbatim: '{line}'. Do not repeat it; "
            "answer only what the caller just said."
        )
        repair = MetaLLMTurn()
        self._count_request()
        try:
            async for item in self._llm.complete(
                messages=self._history.request_messages(),
                tools=None,
                turn=repair,
            ):
                if isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
        finally:
            repair.close()
        record.usage = _merged_usage(record.usage, repair.usage)
        if self._reply_new_sentences == 0:
            raise ReplyRepeatedOnly(
                "the repair reply only repeated a line already spoken"
            )

    def _add_repeat_note(self) -> None:
        """Hold the recent replies for this request as a refusal to reuse them.

        Added once per logical turn, before its first model request, and only
        when the caller has already heard a reply from this call: a first reply
        and a hold return have nothing to avoid. The note lists the last
        :data:`REPEAT_NOTE_WINDOW` replies; the exact-match guard above it
        remembers every reply this call spoke, so a repeat after many turns
        (a second invite) is still withheld. The repair path names its own
        duplicate, so it never stacks this note on top.
        """
        if not self._spoken_replies:
            return
        recent = self._spoken_replies[-REPEAT_NOTE_WINDOW:]
        self._history.add_hidden_context(_repeat_note(recent))

    def _remember_reply(self, text: str) -> None:
        """Keep every reply the caller actually heard this call, oldest first."""
        self._spoken_replies.append(text)

    def _is_repeat(self, sentence: str) -> bool:
        """Whether this sentence duplicates any already spoken in this call.

        The comparison covers the replies already heard and the sentences
        already spoken in the current reply, so a model that emits the same
        line twice inside one reply cannot say it twice.
        """
        normal = _normal_form(sentence)
        if len(normal.split()) < REPEAT_MIN_WORDS:
            return False
        replies = list(self._spoken_replies)
        if self._reply_text.strip():
            replies.append(self._reply_text)
        return any(
            _normal_form(prior) == normal
            for reply in replies
            for prior in _reply_sentences(reply)
        )

    def _drop_repeat(self, sentence: str) -> None:
        """Withhold one duplicate sentence before its audio is generated."""
        self._reply_dropped.append(sentence)
        self.repeat_dropped += 1
        self._count_metric("repeat_dropped")

    def _drop_question(self, sentence: str) -> None:
        """Withhold a question sentence the caller has not answered."""
        self._reply_question_withheld.append(sentence)
        self.question_withheld += 1
        self._count_metric("question_withheld")

    def _drop_filler(self, sentence: str) -> None:
        """Withhold an acknowledgement-only sentence before its audio exists."""
        self._reply_filler_withheld.append(sentence)

    def _drop_offer(self, sentence: str) -> None:
        """Withhold a test/invite offer sentence the caller did not invite."""
        self._reply_offer_withheld.append(sentence)
        self.offer_withheld += 1
        self._count_metric("offer_withheld")

    def _count_metric(self, name: str) -> None:
        """Count one guard metric; an unreadable sink never ends the call."""
        counter = getattr(self._ledger, "count", None)
        if not callable(counter):
            return
        try:
            counter(name)
        except Exception:
            _log.exception(f"the {name} metric could not be counted")

    async def _speak(self, text: str, *, force: bool = False) -> None:
        if not text:
            return
        if self._ending and not force:
            return
        # Synthesis is the TTS leg's request: a closed model leg must not cut
        # audio that was already generated (ticket 105 drains, never truncates).
        if (
            not force
            and self._may_request is not None
            and not self._may_request("tts")
        ):
            return
        if not force:
            # The opener guard runs before every other rule, because the same
            # sentence must be judged on the words the caller would hear. A
            # batched chunk that carries an acknowledgement-only sentence is
            # split so that sentence is withheld without losing the rest.
            pieces = _reply_sentences(text) or [text]
            if len(pieces) > 1 and any(
                _FILLER_OPENER.match(piece) for piece in pieces
            ):
                for piece in pieces:
                    await self._speak(piece)
                return
            original = text
            text, stripped = _strip_filler_openers(text)
            if stripped:
                self.filler_stripped += stripped
                self._count_metric("filler_stripped")
            if not text:
                self._drop_filler(original)
                return
        # The offer guard: on a turn the caller did not invite, no sentence
        # that carries the product's offer vocabulary may be spoken. Withhold
        # only the offer sentences; the rest of the reply still speaks. A
        # batched chunk is split so a statement beside an offer survives.
        if not force and not self._willing_turn:
            pieces = _reply_sentences(text) or [text]
            if len(pieces) > 1 and any(_is_offer(piece) for piece in pieces):
                for piece in pieces:
                    await self._speak(piece)
                return
            if _is_offer(text):
                self._drop_offer(text)
                return
        # The exact-repeat guard keeps precedence: a line already spoken is a
        # repeat first, and its own repair runs before this rule. One _speak
        # may carry several sentences (the synthesis session batches them), so
        # a repeated sentence embedded beside a new one must be withheld on its
        # own rather than letting the whole chunk through. Only split a chunk
        # when a duplicate is actually in it, so ordinary batching is unchanged.
        if not force:
            pieces = _reply_sentences(text) or [text]
            if len(pieces) > 1:
                normals = [_normal_form(piece) for piece in pieces]
                duplicated = any(
                    len(normals[index].split()) >= REPEAT_MIN_WORDS
                    and (
                        self._is_repeat(pieces[index])
                        or normals[index] in normals[:index]
                    )
                    for index in range(len(pieces))
                )
                if duplicated:
                    # Speak sentence by sentence so the exact guard can see
                    # each new sentence in _reply_text before the next one is
                    # compared; a duplicate inside this one chunk is withheld.
                    for piece in pieces:
                        await self._speak(piece)
                    return
            if self._is_repeat(text):
                self._drop_repeat(text)
                return
        if not force and self._must_not_ask and _is_question(text):
            # A batched piece may carry a statement and a question: withhold
            # only the question sentences and speak the remainder.
            for piece in _reply_sentences(text) or [text]:
                if _is_question(piece):
                    self._drop_question(piece)
                else:
                    await self._speak(piece)
            return
        self._reply_text = f"{self._reply_text} {text}".strip()
        if not force:
            self._reply_new_sentences += 1
            asked = [piece for piece in _reply_sentences(text) if _is_question(piece)]
            if asked:
                # Only a question the caller heard can be left unanswered.
                self._last_question = asked[-1]
                self._last_question_words = _content_words(self._last_question)
        self._active_leg = "tts"
        await self._caption("agent", text, False)
        async with self._voice_lock:
            async for audio in self._tts.speak(text):
                self._speaking = True
                frame = await self._emit_audio(
                    audio, kind="reply", flush_id=getattr(self._tts, "flush_id", None)
                )
                self._first_audio(frame)

    async def _cancel_reply(self) -> None:
        """Cut the sounding reply with ``Cancel``, then release the floor."""
        state = self._active
        ack_task = self._ack_task
        self._ack_task = None
        if ack_task is not None and not ack_task.done():
            ack_task.cancel()
            await asyncio.gather(ack_task, return_exceptions=True)
        if state is not None:
            self._cut(state)
        task = self._reply_task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._cancel_voice()
        self._speaking = False
        self._buffer = ""
        if self._ending and not self._hangup_requested:
            # The caller talked over the closing line: cancelling the goodbye
            # withdraws the end-call decision. The call keeps listening, so the
            # next final is answered instead of dead-ending the line.
            self._ending = False
        if state is not None:
            await self._rules.settle(state, reason="barge_in")
        self._active = None
        if self._on_interrupted is not None:
            await self._on_interrupted()

    async def _ack_if_slow(self) -> None:
        """Speak one short line if the reply has not started by the bound.

        The ack is not a turn: it writes no reply text, sends no caption and
        makes no model or tool request. It holds the voice lock only while its
        own short line plays, so the reply follows it instead of overlapping.
        """
        if not self._ack_lines:
            return
        try:
            await self._sleep(self._ack_delay_s)
        except asyncio.CancelledError:
            return
        if self._ending or self._speaking or self._reply_text.strip():
            return
        line = self._ack_lines[self._ack_index % len(self._ack_lines)]
        self._ack_index += 1
        if self._may_request is not None and not self._may_request("tts"):
            return
        async with self._voice_lock:
            if self._ending or self._speaking or self._reply_text.strip():
                return
            try:
                async for audio in self._tts.speak(line):
                    await self._emit_audio(
                        audio, kind="ack", flush_id=getattr(self._tts, "flush_id", None)
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed filler is not the reply: the turn still speaks.
                return

    async def _cancel_voice(self) -> None:
        cancel = getattr(self._tts, "cancel", None)
        if not callable(cancel):
            return
        result = cancel()
        if inspect.isawaitable(result):
            await result


    # -- the turn ledger --------------------------------------------------

    def _write_turn_row(self, row: str, *args: Any, **kwargs: Any) -> None:
        """Write one turn row; a trace failure is logged, never fatal.

        The trace is a record of the call, not a precondition for it (the same
        rule the call's operational events follow). The ledger itself refuses a
        duplicate, so a replayed event cannot become a second row.
        """
        ledger = self._turn_events
        if ledger is None:
            return
        try:
            getattr(ledger, row)(*args, **kwargs)
        except Exception:
            _log.exception(
                f"the {row} turn row could not be written; the call continues"
            )

    def _user_final(self, state: TurnState, text: str) -> None:
        """The authoritative final: its length and intent, never the words."""
        self._write_turn_row(
            "user_final",
            state.id.event_id,
            chars=len(text),
            empty=not text.strip(),
            wants_end=wants_to_end(text, self._locale_code),
        )

    def _reply_start(self, state: TurnState) -> None:
        self._write_turn_row("reply_start", state.id.event_id)

    def _first_audio(self, frame: Any) -> None:
        """The turn's first reply frame; later frames of the turn are not rows."""
        state = self._active
        if state is None:
            return
        key = state.id.event_id
        if key in self._first_audio_turns:
            return
        self._first_audio_turns.add(key)
        self._write_turn_row("first_audio", key, seq=getattr(frame, "seq", 0))

    def _cut(self, state: TurnState) -> None:
        self._write_turn_row("cut", state.id.event_id, reason="barge_in")

    def _tool_call(self, state: TurnState, call: Any, *, index: int) -> None:
        """One requested tool: name and ids, never the model's arguments."""
        call_id = getattr(call, "call_id", "")
        if not isinstance(call_id, str) or not call_id.strip():
            # A call with no identity cannot be cited by a defect card and has
            # no row; the denial is recorded on the turn and the end document.
            return
        self._write_turn_row(
            "tool_call",
            state.id.event_id,
            name=_call_name(call),
            call_id=call_id,
            index=index,
        )

    def _tool_results(self, state: TurnState, outcomes: Any) -> None:
        """One row per answered call: its identity and success, not its payload."""
        for outcome in outcomes:
            call_id = getattr(outcome, "tool_call_id", "")
            if not isinstance(call_id, str) or not call_id.strip():
                continue
            if isinstance(outcome, EndCallSignal):
                ok, code = True, "end_call"
            elif isinstance(outcome, DeniedCall):
                ok, code = False, "denied"
            else:
                ok = bool(getattr(outcome, "ok", False))
                code = (
                    getattr(outcome, "code", "")
                    if isinstance(outcome, ToolFailure)
                    else ""
                )
            self._write_turn_row(
                "tool_result",
                state.id.event_id,
                name=_call_name(outcome),
                call_id=call_id,
                ok=ok,
                code=code,
            )

    def _goodbye(self, state: TurnState) -> None:
        self._write_turn_row("goodbye", state.id.event_id, reason="end_call")

    def _hangup(self, state: TurnState, *, reason: str) -> None:
        self._write_turn_row("hangup", state.id.event_id, reason=reason)

    def _turn_failed(self, state: TurnState, error: BaseException) -> None:
        """One failed reply: the leg and the error class, never its message."""
        if isinstance(error, ReplyQuestionOnly):
            reason = "the reply only asked a question the caller did not answer"
        elif isinstance(error, ReplyRepeatedOnly):
            reason = "the reply only repeated a line already spoken"
        elif isinstance(error, ReplyFillerOnly):
            reason = "the reply was nothing but an acknowledgement"
        elif isinstance(error, ReplyOfferOnly):
            reason = "the reply was only a test offer the caller did not invite"
        else:
            reason = "the reply failed"
        self._write_turn_row(
            "turn_failed",
            state.id.event_id,
            leg=self._active_leg,
            name=type(error).__name__,
            reason=reason,
        )

    async def _caption(self, role: str, text: str, final: bool) -> None:
        if self._on_caption is None:
            return
        await self._on_caption(role, text, final)


def _call_name(outcome: Any) -> str:
    """A tool's name, or the outcome's own type when it carries none."""
    name = getattr(outcome, "name", "")
    return name if isinstance(name, str) and name.strip() else type(outcome).__name__


__all__ = [
    "CascadeTurnStream",
    "ReplyFillerOnly",
    "ReplyOfferOnly",
    "ReplyQuestionOnly",
    "ReplyRepeatedOnly",
]
