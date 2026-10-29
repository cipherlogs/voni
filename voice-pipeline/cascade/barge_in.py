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
   latency against ``barge_in.real_cut_ms``, and the played-position seam that
   ticket 89 maps to reply text.

The played position is recorded verbatim and never interpreted: locating the
unheard tail (89), re-synthesizing it (90) and the filler rule (91) belong to
the tickets that own them. The next request is untouched by a cut — it starts
on a later generation and takes whatever ``flush_id`` the vendor assigns, which
may skip numbers and is read from the wire, never computed here.

This module owns no thresholds, no word lists and no wire shapes: the cut
budget comes from :mod:`cascade.thresholds`, the transport owns what a playout
flush looks like on the socket, and the synthesis session owns the ``Cancel``.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from cascade.assemblyai_tts import Cancellation
from cascade.thresholds import require_bound
from cascade.turn_state import Clock
from metrics import TimingLedger
from providers import SentenceAudio

#: The record-backed cut budget (``realCutMs``); restating it would be the
#: second source the threshold registry exists to prevent.
CUT_BUDGET_MS = float(require_bound("barge_in.real_cut_ms"))

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


class ReplyInFlightError(RuntimeError):
    """A second reply was started while the first still owns the producer."""

    def __init__(self) -> None:
        super().__init__(
            "a reply is still being produced; stop or cut it before starting "
            "another (one producer per call)"
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


@dataclass(frozen=True, slots=True)
class CutSeam:
    """What the resume tickets need, recorded and nothing resolved.

    ``played_ms`` is the position the client reported with the interruption,
    exactly as reported; ``None`` means it was not reported, never ``0.0``.
    ``turn`` and ``reply`` name the reply being cut, opaquely: 89/90 own how
    they key the reply text.
    """

    played_ms: float | None
    flush_id: int | None
    generation: int
    turn: Any = None
    reply: str = ""


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
class _ReplyRun:
    """The producer's state for one reply."""

    generation: int
    iterator: AsyncIterator[SentenceAudio]
    flush_id: int | None
    turn: Any
    reply: str
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
        """
        if self.reply_in_flight:
            raise ReplyInFlightError()
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
            await _invoke(self._on_audio, chunk)

    async def join(self) -> None:
        """Wait for the current reply to finish; a synthesis failure surfaces."""
        run = self._run
        if run is None or run.task is None:
            return
        await run.task

    async def stop(self) -> None:
        """Stop the producer without a cut: the call is draining or ending."""
        self._generation += 1
        await self._stop_producer()

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
        if played_ms is not None and (
            isinstance(played_ms, bool)
            or not isinstance(played_ms, (int, float))
            or played_ms < 0
        ):
            raise ValueError(
                f"played_ms must be a non-negative number of milliseconds, "
                f"got {played_ms!r}"
            )
        if speech_started_at is not None and (
            isinstance(speech_started_at, bool)
            or not isinstance(speech_started_at, (int, float))
        ):
            raise ValueError(
                f"speech_started_at must be clock seconds or None, "
                f"got {speech_started_at!r}"
            )

        async with self._cut_lock:
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
                ),
                cancellation=cancellation,
                dropped_frames=dropped_frames,
                client_flushed=True,
            )
            self._cuts.append(cut)
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
