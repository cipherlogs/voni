"""The barge-in cut path: ``Cancel``, stop, flush, drop — never a close.

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on ``Cancel``, tail resume
without LLM" — Cut. An interruption is the caller winning the floor. The
cascade cuts with the synthesis session's ``Cancel`` (ticket 52), because a
soft yield — finishing the current sentence before pivoting — is the managed
path and is explicitly rejected here: a long sentence can blow the cut budget.
The synthesis socket outlives every interruption, so the same call keeps
speaking afterwards.

One cut is one order of events:

1. the producer's generation is bumped, so a frame already in hand is never
   emitted after this line;
2. ``Cancel`` goes to the synthesis session, which stops in-flight synthesis
   and drops the old request's frames up to its ``Cancelled``;
3. the producer task is stopped, so nothing more is pulled from the cancelled
   request's audio;
4. the client is told to flush its playout;
5. the cut is recorded: the ledger's ``cancelled`` mark (first write wins, so
   once per call), the ``interruption`` count (one per cut), the measured stop
   latency against ``barge_in.real_cut_ms``, and the played position the
   client reported.

The played position is kept verbatim on the seam (it is the client's report,
not a measurement we made) and also located on the reply text (ticket 89): the
reported milliseconds become a whole sample at the session's own rate, so a
fractional report can never round past a word, and the session's own
``resume_point`` maps that sample to the first unheard word when its
``WordBoundaries`` are complete, or to the start of the first sentence not
fully played otherwise.

Ticket 90 speaks that located tail. The re-synthesis is the same opened session
(same voice, same language) on the vendor's next ``flush_id``; it continues the
reply that was cut — the resume record keeps the cut seam's turn and reply — and
it never asks the model anything, because the rest of an answer is speech, not
a new completion. A plan is spoken exactly once, and a new caller turn (or a
later cut) cancels a stale resume rather than letting the old tail finish over
the new answer. A reply that already played in full refuses by name instead of
repeating itself.

A **filler** interruption is the caller's backchannel, not a turn: it sends no
``Cancel``, starts no generation and asks for no reply (ticket 91). The agent
keeps speaking. If audio was cut for another reason, the cut's located tail is
still carried forward as a :class:`FillerResume` plan within the frozen
``fillerResumeTailMs`` budget; the plan is not a reply, never calls a model,
and a real reply (or a later cut) cancels it. Ticket 90 speaks the plan. The
next request is untouched by a cut — it starts on a later generation and takes
whatever ``flush_id`` the vendor assigns, which may skip numbers and is read
from the wire, never computed here.

This module owns no thresholds, no word lists and no wire shapes: the cut
budget comes from :mod:`cascade.thresholds`, the transport owns what a playout
flush looks like on the socket, and the synthesis session owns the ``Cancel``.
"""

from __future__ import annotations

import asyncio
import inspect
import math
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from cascade.assemblyai_tts import Cancellation, ResumeGranularity, ResumePoint
from cascade.thresholds import require_bound
from cascade.turn_state import Clock
from metrics import TimingLedger
from providers import SentenceAudio
from turns import FloorAction

#: The record-backed cut budget (``realCutMs``); restating it would be the
#: second source the threshold registry exists to prevent.
CUT_BUDGET_MS = float(require_bound("barge_in.real_cut_ms"))

#: The record-backed filler-resume budget (``fillerResumeTailMs``). The tail a
#: filler recovers must start playing inside it; the number is the frozen
#: scoreboard record's, never this module's.
FILLER_RESUME_BUDGET_MS = float(require_bound("barge_in.filler_resume_tail_ms"))

#: The three floor actions an interruption can carry. ``backchannel`` is the
#: filler case; it is not a cut and not a reply.
INTERRUPTION_ACTIONS: tuple[str, ...] = ("take_floor", "wait", "backchannel")

#: Why the floor was taken. ``speech_start`` and ``partial`` are the
#: interruption cases of :mod:`cascade.floor`; the others are the same cut
#: path applied to the greeting, the goodbye and a command overlap.
CUT_CAUSES: tuple[str, ...] = (
    "speech_start",
    "partial",
    "command",
    "greeting",
    "goodbye",
)


class UnknownCutCauseError(ValueError):
    """A cut that does not name why the caller took the floor."""

    def __init__(self, cause: Any) -> None:
        self.cause = cause
        super().__init__(
            f"unknown barge-in cause {cause!r}; a cut names one of {CUT_CAUSES}"
        )


class UnknownFloorActionError(ValueError):
    """An interruption that does not name one of the three floor actions."""

    def __init__(self, action: Any) -> None:
        self.action = action
        super().__init__(
            f"unknown floor action {action!r}; an interruption is one of "
            f"{INTERRUPTION_ACTIONS}"
        )


class ReplyInFlightError(RuntimeError):
    """A second reply was started while the first still owns the producer."""

    def __init__(self) -> None:
        super().__init__(
            "a reply is still being produced; stop or cut it before starting "
            "another (one producer per call)"
        )


class ResumeRefusedError(ValueError):
    """A tail resume that the call cannot honestly perform."""


class NoUnheardTailError(ResumeRefusedError):
    """There is nothing left to say: the whole reply played, or no plan."""

    def __init__(self, reason: str = "") -> None:
        self.reason = reason
        super().__init__(
            "no unheard tail to resume: the whole reply played, so speaking "
            f"again would repeat the answer ({reason or 'empty tail'})"
        )


class StaleResumeError(ResumeRefusedError):
    """The tail's plan was already spoken, or a newer turn cancelled it."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(
            f"this tail resume is stale and is never spoken: {reason}"
        )


@dataclass(frozen=True, slots=True)
class PlayoutFlush:
    """The client instruction that discards audio queued for the cut.

    ``generation`` is the call-local reply generation: every frame emitted
    before it belongs to the cancelled request and must not be played.
    ``flush_id`` is the cancelled synthesis request when the session knows it;
    it is ``None`` rather than invented.
    """

    generation: int
    flush_id: int | None
    cause: str
    at: float


class UnknownSampleRateError(ValueError):
    """A played position cannot be made sample-exact without a session rate."""

    def __init__(self) -> None:
        super().__init__(
            "no sample rate is known for the reply audio: a played position "
            "cannot be made sample-exact before a session format or a played "
            "chunk exists"
        )


@dataclass(frozen=True, slots=True)
class CutPoint:
    """The sample-exact point a reply was cut at, and the tail it leaves.

    ``played_ms`` is derived from ``played_samples`` at the session's own rate,
    never the raw client report: the cut is a whole sample that has already
    played, so a fractional report can only repeat a word, never lose one.
    ``resume`` is the session's own located tail (ticket 51); ``resume_error``
    names why there is none instead of inventing one.
    """

    played_samples: int
    sample_rate: int
    played_ms: float
    resume: ResumePoint | None = None
    resume_error: str = ""

    def __post_init__(self) -> None:
        if self.played_samples < 0:
            raise ValueError(
                f"a cut point cannot be before the audio start: "
                f"{self.played_samples!r} samples"
            )
        if self.sample_rate <= 0:
            raise ValueError(
                f"a cut point needs a positive sample rate: {self.sample_rate!r}"
            )

    @property
    def resume_text(self) -> str:
        """The unheard tail, or empty when the whole reply played or is unknown."""
        return "" if self.resume is None else self.resume.text

    @property
    def word_level(self) -> bool:
        """Whether the tail is word-level (boundaries complete) or sentence-level."""
        return (
            self.resume is not None
            and self.resume.granularity is ResumeGranularity.WORD
        )


@dataclass(frozen=True, slots=True)
class CutSeam:
    """What the resume tickets need: the report, the located tail, nothing said.

    ``played_ms`` is the position the client reported with the interruption,
    exactly as reported; ``None`` means it was not reported, never ``0.0``.
    ``cut_point`` is that position made sample-exact and mapped to reply text
    (ticket 89), or ``None`` when the client reported nothing or the rate is
    unknown. ``turn`` and ``reply`` name the reply being cut, opaquely: 90 owns
    how it keys the reply text.
    """

    played_ms: float | None
    flush_id: int | None
    generation: int
    turn: Any = None
    reply: str = ""
    cut_point: CutPoint | None = None

    @property
    def resume(self) -> ResumePoint | None:
        """The located resume point, or ``None`` when it could not be located."""
        return None if self.cut_point is None else self.cut_point.resume

    @property
    def resume_text(self) -> str:
        """The first word (or sentence) the caller did not hear, or empty."""
        return "" if self.cut_point is None else self.cut_point.resume_text


@dataclass(frozen=True, slots=True)
class BargeInCut:
    """One real cut: what stopped, how fast, and what the client was told."""

    cause: str
    generation: int
    decided_at: float
    stopped_at: float
    speech_started_at: float | None
    stop_latency_ms: float | None
    budget_ms: float
    within_budget: bool | None
    seam: CutSeam
    cancellation: Cancellation
    dropped_frames: int
    client_flushed: bool

    def __post_init__(self) -> None:
        if self.cause not in CUT_CAUSES:
            raise UnknownCutCauseError(self.cause)
        if self.generation < 1:
            raise ValueError(f"cut generation must be positive: {self.generation!r}")
        if self.budget_ms <= 0:
            raise ValueError(f"cut budget must be positive: {self.budget_ms!r}")

    @property
    def real_cut(self) -> bool:
        """Always true: the cascade has no soft-yield cut (spec, rejected)."""
        return True

    @property
    def played_ms(self) -> float | None:
        """The seam's played position, for a reader holding only the cut."""
        return self.seam.played_ms


@dataclass
class FillerResume:
    """What a filler interruption leaves: a tail to recover, never a reply.

    A filler is not a reply: it takes no reply generation, asks no model and
    plays no new answer. When an earlier cut left a located tail, the plan
    carries exactly that tail and the record-backed budget its resume must
    meet. :attr:`cancelled` becomes true when a real reply (or a later cut)
    takes over; a cancelled plan is discarded, never spoken.
    """

    text: str
    budget_ms: float
    cut: BargeInCut | None = None
    resume: ResumePoint | None = None
    cancelled: bool = False
    #: Set once the plan has been handed to the resume producer. A plan is
    #: spoken exactly once; a second attempt is stale, not a repeat.
    resumed: bool = False

    def __post_init__(self) -> None:
        if self.budget_ms <= 0:
            raise ValueError(
                f"a filler-resume budget must be positive: {self.budget_ms!r}"
            )

    @property
    def is_reply(self) -> bool:
        """Always false: a filler never takes the reply slot."""
        return False

    @property
    def model_calls(self) -> int:
        """Always zero: recovering a tail is synthesis, never a model request."""
        return 0

    @property
    def resumable(self) -> bool:
        """Whether there is an unheard tail worth resuming."""
        return bool(self.text.strip())

    def cancel(self) -> None:
        """A real reply or a later cut supersedes this plan (idempotent)."""
        self.cancelled = True


@dataclass
class TailResume:
    """One re-synthesis of the cut reply's tail; never a new answer.

    The record names the reply it continues (``turn`` and ``reply`` from the
    cut seam) and the request it was cut from, so a reader can prove the resume
    did not start a second answer. ``flush_id`` is read from the session's first
    audio frame after the resume, never computed; the vendor may skip ids.
    ``frames`` is how much of the tail actually played before it finished or
    was cancelled.
    """

    text: str
    granularity: ResumeGranularity
    turn: Any
    reply: str
    source_flush_id: int | None
    cause: str
    budget_ms: float
    generation: int
    flush_id: int | None = None
    frames: int = 0
    cancelled: bool = False

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise NoUnheardTailError()
        if self.budget_ms <= 0:
            raise ValueError(f"a resume budget must be positive: {self.budget_ms!r}")

    @property
    def is_reply(self) -> bool:
        """Always false: a resume is speech, not a model answer."""
        return False

    @property
    def continues_reply(self) -> bool:
        """Always true: the tail belongs to the reply that was being spoken."""
        return True

    @property
    def starts_new_answer(self) -> bool:
        """Always false: the caller hears the rest of the same answer."""
        return False

    @property
    def model_calls(self) -> int:
        """Always zero: the resume never asks the model anything."""
        return 0

    def cancel(self) -> None:
        """A newer caller turn owns the floor; the stale tail stops (idempotent)."""
        self.cancelled = True


@dataclass
class _ReplyRun:
    """The producer's state for one reply."""

    generation: int
    iterator: AsyncIterator[SentenceAudio]
    flush_id: int | None
    turn: Any
    reply: str
    resume: TailResume | None = None
    dropped_frames: int = 0
    task: asyncio.Task | None = field(default=None, repr=False)


class BargeInCutPath:
    """One call's reply producer and the one cut that stops it.

    The producer is a task over the reply's ``SentenceAudio`` iterator; every
    chunk it plays passes the generation check first. A cut bumps the
    generation synchronously, so a chunk already pulled but not yet played is
    dropped, and a frame the vendor sends between ``Cancel`` and ``Cancelled``
    never reaches the client. The synthesis session itself stays open.
    """

    def __init__(
        self,
        *,
        tts: Any,
        on_audio: Callable[[SentenceAudio], Awaitable[None] | None],
        flush_playout: Callable[[PlayoutFlush], Awaitable[None] | None],
        clock: Clock,
        ledger: TimingLedger | None = None,
    ) -> None:
        self._tts = tts
        self._on_audio = on_audio
        self._flush_playout = flush_playout
        self._clock = clock
        self._ledger = ledger
        self._generation = 0
        self._run: _ReplyRun | None = None
        self._cuts: list[BargeInCut] = []
        self._cut_lock = asyncio.Lock()
        # The rate of the audio actually played, so a cut point is expressed
        # in the samples the caller heard, not in an assumed 24 kHz.
        self._sample_rate: int | None = None
        # The cut whose tail a filler may recover, and the plan it produced.
        self._resume_cut: BargeInCut | None = None
        self._pending_filler: FillerResume | None = None
        # The tail currently being re-synthesized, if any (ticket 90).
        self._active_resume: TailResume | None = None
        self._resumes: list[TailResume] = []

    # -- state ------------------------------------------------------------

    @property
    def generation(self) -> int:
        """The current reply generation; a frame from an older one is dropped."""
        return self._generation

    @property
    def cuts(self) -> tuple[BargeInCut, ...]:
        """Every cut of this call, in order (a double barge-in keeps both)."""
        return tuple(self._cuts)

    @property
    def reply_in_flight(self) -> bool:
        """Whether the producer still owns the reply slot."""
        return (
            self._run is not None
            and self._run.task is not None
            and not self._run.task.done()
        )

    @property
    def resumes(self) -> tuple[TailResume, ...]:
        """Every tail resume of this call, in order (a stale one keeps its record)."""
        return tuple(self._resumes)

    # -- producing --------------------------------------------------------

    def start(
        self,
        audio: AsyncIterator[SentenceAudio],
        *,
        flush_id: int | None = None,
        turn: Any = None,
        reply: str = "",
    ) -> int:
        """Start producing one reply's audio; returns its generation.

        ``flush_id`` is advisory bookkeeping for the cut record. The synthesis
        session owns the real id and may assign the next one only when its
        first post-``Cancelled`` frame arrives, so a reply started before that
        simply records ``None``.

        A new caller turn preempts a stale resume (ticket 90): the tail was for
        the reply the caller already talked over, so it is discarded rather
        than allowed to finish over the new answer. A live reply is not
        preempted; that stays a programming error.
        """
        if self.reply_in_flight:
            if self._run is None or self._run.resume is None:
                raise ReplyInFlightError()
            self._cancel_resume()
            self._preempt_producer()
        # A real reply supersedes a pending filler resume and the cut it came
        # from: a stale tail is never spoken over a new answer (ticket 90).
        self._cancel_pending_filler()
        self._resume_cut = None
        self._generation += 1
        run = _ReplyRun(
            generation=self._generation,
            iterator=audio,
            flush_id=flush_id,
            turn=turn,
            reply=reply,
        )
        run.task = asyncio.ensure_future(self._produce(run))
        self._run = run
        return run.generation

    async def _produce(self, run: _ReplyRun) -> None:
        async for chunk in run.iterator:
            if run.generation != self._generation:
                # A cut landed between the pull and the play: drop this frame
                # and close the cancelled request's generator.
                run.dropped_frames += 1
                await _aclose(run.iterator)
                return
            self._sample_rate = chunk.sample_rate
            if run.resume is not None:
                # The resume's first frame is where the vendor's new flush id
                # becomes known; it is read, never computed.
                run.resume.frames += 1
                current = self._current_flush_id()
                if current is not None and run.resume.flush_id is None:
                    run.resume.flush_id = current
                    run.flush_id = current
            await _invoke(self._on_audio, chunk)
        if (
            run.resume is not None
            and self._active_resume is run.resume
            and not run.resume.cancelled
        ):
            # Played to its end: a later caller turn must not mark it cancelled.
            self._active_resume = None

    async def join(self) -> None:
        """Wait for the current reply to finish; a synthesis failure surfaces."""
        run = self._run
        if run is None or run.task is None:
            return
        await run.task

    async def stop(self) -> None:
        """Stop the producer without a cut: the call is draining or ending."""
        self._cancel_pending_filler()
        self._cancel_resume()
        self._resume_cut = None
        self._generation += 1
        await self._stop_producer()

    # -- interruption: cut, wait, or filler -------------------------------

    async def interrupt(
        self,
        action: FloorAction,
        *,
        cause: str = "partial",
        speech_started_at: float | None = None,
        played_ms: float | None = None,
    ) -> BargeInCut | FillerResume | None:
        """Act on one floor decision while the agent holds the floor.

        ``take_floor`` is a real cut. ``backchannel`` is a filler: the agent
        keeps speaking and no reply is started; if an earlier cut left a tail,
        the filler plan carries it forward. ``wait`` neither cuts nor replies.
        Counting belongs to :class:`cascade.floor.FloorArbiter`, so this method
        never counts a backchannel twice.
        """
        if action not in INTERRUPTION_ACTIONS:
            raise UnknownFloorActionError(action)
        if action == "backchannel":
            return self.filler()
        if action == "wait":
            return None
        return await self.cut(
            cause,
            speech_started_at=speech_started_at,
            played_ms=played_ms,
        )

    def filler(self) -> FillerResume:
        """The plan a filler interruption leaves: the cut's tail, never a reply.

        It sends nothing to the synthesis session and starts no generation.
        The tail is the cut's located point (ticket 89); when the whole reply
        played, ``text`` is empty and there is nothing to resume.
        """
        self._cancel_pending_filler()
        cut = self._resume_cut
        resume = None if cut is None else cut.seam.resume
        plan = FillerResume(
            text="" if resume is None else resume.text,
            budget_ms=FILLER_RESUME_BUDGET_MS,
            cut=cut,
            resume=resume,
        )
        self._pending_filler = plan
        return plan

    def _cancel_pending_filler(self) -> None:
        """A real reply or a later cut discards the pending filler plan."""
        plan, self._pending_filler = self._pending_filler, None
        if plan is not None:
            plan.cancel()

    # -- the tail resume --------------------------------------------------

    async def resume(self, plan: FillerResume | None = None) -> TailResume:
        """Speak the unheard tail (ticket 90); zero model requests.

        The plan is what the filler path (ticket 91) carries forward, and the
        default is the one it left pending. The tail is re-synthesized through
        the *same* session, so the voice and language are the ones the call
        already bound, and the reply's identity is the cut seam's: this
        continues the answer the caller was hearing, it does not start a new
        one. The vendor's next ``flush_id`` is read from the first audio frame,
        never computed. A plan is spoken exactly once; an already-spoken or
        cancelled one is stale and is refused by name.
        """
        if self.reply_in_flight:
            raise ReplyInFlightError()
        plan = self._pending_filler if plan is None else plan
        if plan is None:
            raise NoUnheardTailError("no filler plan was carried forward")
        if plan.cancelled:
            raise StaleResumeError("a newer turn cancelled the plan")
        if plan.resumed:
            raise StaleResumeError("the plan was already spoken")
        if not plan.resumable:
            raise NoUnheardTailError("the tail is empty")
        if self._pending_filler is plan:
            # Consumed, not cancelled: the plan is becoming speech now.
            self._pending_filler = None
        plan.resumed = True

        cut = plan.cut
        seam = None if cut is None else cut.seam
        point = plan.resume
        self._generation += 1
        record = TailResume(
            text=plan.text,
            granularity=(
                ResumeGranularity.SENTENCE
                if point is None
                else point.granularity
            ),
            turn=None if seam is None else seam.turn,
            reply="" if seam is None else seam.reply,
            source_flush_id=None if seam is None else seam.flush_id,
            cause="" if cut is None else cut.cause,
            budget_ms=plan.budget_ms,
            generation=self._generation,
        )
        run = _ReplyRun(
            generation=record.generation,
            iterator=self._tts.speak(record.text),
            flush_id=record.source_flush_id,
            turn=record.turn,
            reply=record.reply,
            resume=record,
        )
        run.task = asyncio.ensure_future(self._produce(run))
        self._run = run
        self._active_resume = record
        self._resumes.append(record)
        return record

    def _cancel_resume(self) -> None:
        """Mark an in-flight tail stale; the generation bump silences it."""
        resume, self._active_resume = self._active_resume, None
        if resume is not None:
            resume.cancel()

    def _preempt_producer(self) -> None:
        """Stop a stale resume synchronously; a new turn owns the frame boundary.

        The generation was already bumped by the caller, so the task cannot emit
        another frame even before it observes the cancellation.
        """
        run, self._run = self._run, None
        if run is None or run.task is None or run.task.done():
            return
        run.task.cancel()

    # -- the played position ----------------------------------------------

    def cut_point(self, played_ms: float) -> CutPoint:
        """Locate the unheard tail at the client's reported played position.

        The position is made sample-exact first (whole samples at the rate of
        the audio actually played), then handed to the session's own
        ``resume_point``, which owns word boundaries, flush durations and the
        sentence fallback. This never re-synthesizes and never starts a
        request: it is a read of what was played.
        """
        _validate_played_ms(played_ms)
        rate = self._known_sample_rate()
        samples = math.floor(played_ms * rate / 1000.0)
        exact_ms = samples * 1000.0 / rate
        resume: ResumePoint | None = None
        error = ""
        locate = getattr(self._tts, "resume_point", None)
        if locate is None:
            error = "the synthesis session cannot locate a resume point"
        else:
            try:
                resume = locate(exact_ms)
            except Exception as exc:  # noqa: BLE001 - a cut must still stop the audio
                error = f"{type(exc).__name__}: {exc}"
        return CutPoint(
            played_samples=samples,
            sample_rate=rate,
            played_ms=exact_ms,
            resume=resume,
            resume_error=error,
        )

    def _known_sample_rate(self) -> int:
        """The played audio's rate, then the session format; else refuse by name."""
        if self._sample_rate is not None:
            return self._sample_rate
        session_format = getattr(self._tts, "format", None)
        rate = getattr(session_format, "sample_rate", None)
        if isinstance(rate, int) and rate > 0:
            return rate
        raise UnknownSampleRateError()

    # -- the cut ----------------------------------------------------------

    async def cut(
        self,
        cause: str,
        *,
        speech_started_at: float | None = None,
        played_ms: float | None = None,
    ) -> BargeInCut:
        """Take the floor with ``Cancel``; the socket stays open.

        Returns once the producer has stopped and the client has been told to
        flush. It does not wait for ``Cancelled``: the acknowledgement is
        consumed by the next request's first frame read, which is also where
        the next ``flush_id`` is learned (ticket 52).
        """
        if cause not in CUT_CAUSES:
            raise UnknownCutCauseError(cause)
        if played_ms is not None:
            _validate_played_ms(played_ms)
        if speech_started_at is not None and (
            isinstance(speech_started_at, bool)
            or not isinstance(speech_started_at, (int, float))
        ):
            raise ValueError(
                f"speech_started_at must be clock seconds or None, "
                f"got {speech_started_at!r}"
            )

        async with self._cut_lock:
            # A later cut supersedes any pending filler resume and the tail a
            # filler is still speaking: the latest caller turn wins.
            self._cancel_pending_filler()
            self._cancel_resume()
            run = self._run
            # The frame boundary: no chunk of the old reply may be emitted
            # after this synchronous line, even before Cancel is on the wire.
            self._generation += 1
            decided_at = self._clock()
            cancellation = await self._tts.cancel()
            dropped_frames = await self._stop_producer()
            stopped_at = self._clock()
            flush_id = self._current_flush_id()
            if flush_id is None and run is not None:
                flush_id = run.flush_id
            await _invoke(
                self._flush_playout,
                PlayoutFlush(
                    generation=self._generation,
                    flush_id=flush_id,
                    cause=cause,
                    at=stopped_at,
                ),
            )
            if self._ledger is not None:
                # First write wins: one cancelled mark per call, not per cut.
                self._ledger.mark("cancelled")
                self._ledger.count("interruption")

            stop_latency_ms = (
                None
                if speech_started_at is None
                else max(0.0, (stopped_at - speech_started_at) * 1000.0)
            )
            # A reported position is located against the reply text, sample-
            # exact. An unknown rate leaves the report on the seam unlocated;
            # it never delays or refuses the cut.
            point: CutPoint | None = None
            if played_ms is not None:
                try:
                    point = self.cut_point(played_ms)
                except UnknownSampleRateError:
                    point = None
            cut = BargeInCut(
                cause=cause,
                generation=self._generation,
                decided_at=decided_at,
                stopped_at=stopped_at,
                speech_started_at=speech_started_at,
                stop_latency_ms=stop_latency_ms,
                budget_ms=CUT_BUDGET_MS,
                within_budget=(
                    None
                    if stop_latency_ms is None
                    else stop_latency_ms <= CUT_BUDGET_MS
                ),
                seam=CutSeam(
                    played_ms=played_ms,
                    flush_id=flush_id,
                    generation=self._generation,
                    turn=None if run is None else run.turn,
                    reply="" if run is None else run.reply,
                    cut_point=point,
                ),
                cancellation=cancellation,
                dropped_frames=dropped_frames,
                client_flushed=True,
            )
            self._cuts.append(cut)
            # Remember the cut so a filler can recover its tail (ticket 91).
            self._resume_cut = cut
            return cut

    async def _stop_producer(self) -> int:
        """Cancel the producer task and wait for it; returns its drop count."""
        run, self._run = self._run, None
        if run is None or run.task is None:
            return 0
        if not run.task.done():
            run.task.cancel()
        # A producer failure is kept on the task: join() still raises it.
        await asyncio.gather(run.task, return_exceptions=True)
        return run.dropped_frames

    def _current_flush_id(self) -> int | None:
        """The synthesis request in flight, from the session, never computed."""
        flush_id = getattr(self._tts, "flush_id", None)
        return flush_id if isinstance(flush_id, int) else None


def _validate_played_ms(played_ms: Any) -> None:
    """A played position is non-negative milliseconds, never a bool or a string."""
    if (
        isinstance(played_ms, bool)
        or not isinstance(played_ms, (int, float))
        or played_ms < 0
    ):
        raise ValueError(
            f"played_ms must be a non-negative number of milliseconds, "
            f"got {played_ms!r}"
        )


async def _invoke(
    callback: Callable[[Any], Awaitable[None] | None], value: Any
) -> None:
    """Call one sink and await it when it is awaitable."""
    result = callback(value)
    if inspect.isawaitable(result):
        await result


async def _aclose(iterator: Any) -> None:
    """Close a cancelled request's async generator when it has one."""
    close = getattr(iterator, "aclose", None)
    if close is not None:
        await close()
