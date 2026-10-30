"""Provider event rules: the completion is the only thing that may be answered.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Event handling. The provider owns the turn
boundary, so this module maps the four provider events onto the logical turn
store and nothing else:

* ``speechStart`` creates or refreshes the open turn and leaves it speaking.
* ``transcript`` only updates the turn's cumulative partial text. It is never a
  user message and never asks for a reply.
* ``speechEnd`` records the boundary and the provider's endpointing latency and
  makes **no** model request. That is the rule a test pins: zero model requests
  between ``speechEnd`` and ``speechComplete``.
* ``speechComplete`` carries the authoritative text and is the one event that
  may request a reply. An empty completion is a counted no-speech turn: it is
  not answered.

A reply is requested through the injected ``on_reply`` sink with the finalised
:class:`~cascade.turn_state.TurnState`, so the text the model receives is
``turn.final_text`` and never a partial. Message history and floor arbitration
belong to the tickets that build on this one; this module keeps the trigger in
one place.

**Reply ordering** (:class:`ReplyOrder`, ticket 69) is the one queue between
that trigger and the sink. Finals are queued by logical turn id, so a later
turn's final is answered only after every earlier turn has settled — answering
turn 2 before turn 1 would invert the conversation. A turn settles when the
orchestrator says its reply finished (:meth:`EventRules.settle`) or when it is
closed for another reason. The wait is bounded by the named
:data:`STALL_GUARD_BOUND` (``turn.stall_guard_ms``), read from
:mod:`cascade.thresholds` when a wait actually starts: an earlier turn that
never finishes is closed with no reply, recorded as an
:class:`AbandonedTurn`, and the later turn is still answered. The guard is
measured on the injected clock; :meth:`EventRules.tick` is how a caller drives
the deadline, and nothing here sleeps or reads the wall clock.

When a :class:`~cascade.floor.FinalGate` is wired, the completion is classified
before the sink: a backchannel or echo final is counted and asked for nothing
(and the turn is closed so ordering cannot wait on it), a command final is
answered with the steering recorded on the outcome, and only those two reach
the reply seam. The gate never gains a second reply call site.

A stray event never corrupts a turn. Every event that changes nothing is
counted under one :class:`IgnoreReason` and logged (never with the caller's
words), and its :class:`EventOutcome` carries the reason:
an unknown event type, a start/end/completion naming no open logical turn, an
event from a replaced session epoch, a duplicate completion, and a transcript
that belongs to no open turn. Ignoring is the whole response: no reply, no user
message, no mutation of an open turn.

Event types this module does not know are ignored. A legacy
``providers.FinalTranscript`` is ignored too: it carries no provider turn id,
so it cannot be attributed to a logical turn; the Meta backend emits
``SpeechComplete`` for the cascade.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cascade.floor import FinalAction, FinalDecision, FinalGate
from cascade.meta_stt import SpeechComplete, SpeechEnd, SpeechStart
from cascade.thresholds import require_bound
from cascade.turn_state import Clock, LogicalTurnId, TurnKey, TurnState, TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript

_log = logging.getLogger(__name__)

#: The named bound that closes an abandoned turn (ticket 03's registry; ticket
#: 69 supplies the value, this module never restates it).
STALL_GUARD_BOUND = "turn.stall_guard_ms"

#: Why an abandoned turn was closed. It never names the caller's words.
ABANDONED_REASON = "no reply: the caller never finished the turn"

#: The reply seam: invoked once per finalised turn, exactly on the completion.
#: A sink that schedules the reply and returns keeps the event loop free to
#: read the next turn (needed for barge-in); awaiting the whole stream here
#: would serialise every later event behind the reply.
ReplySink = Callable[[TurnState], Awaitable[None]]


class EventKind(str, Enum):
    """What one provider event was understood as."""

    SPEECH_START = "speech_start"
    PARTIAL = "partial"
    SPEECH_END = "speech_end"
    SPEECH_COMPLETE = "speech_complete"
    NO_SPEECH = "no_speech"
    IGNORED = "ignored"


class IgnoreReason(str, Enum):
    """Why a provider event changed nothing.

    These are the spec's four "logged and ignored" cases plus the two an
    orchestrator can meet at a session boundary. They are the instrument an
    orchestrator reports: an ignored event is counted here, never answered.
    """

    #: Not part of the cascade event vocabulary (an additive vendor event, a
    #: binary frame mapped to an object, or a turnless legacy final).
    UNKNOWN_EVENT = "unknown_event"
    #: A start, end or completion that names no open logical turn in the
    #: current session, including a start for a closed turn and an empty id.
    UNKNOWN_TURN = "unknown_turn"
    #: Stamped with a session epoch the call has already replaced.
    LATE_EVENT = "late_event"
    #: A second completion for the same turn; the first reply stands.
    DUPLICATE_COMPLETE = "duplicate_complete"
    #: A transcript that belongs to no open turn, so there is nothing to
    #: attribute it to and no user message to make from it.
    UNATTRIBUTED_PARTIAL = "unattributed_partial"


@dataclass(frozen=True, slots=True)
class AbandonedTurn:
    """A turn the stall guard closed without inventing a reply.

    ``waited_ms`` is how long the later final waited before the guard fired and
    ``guard_ms`` is the bound it was measured against, so the record carries the
    comparison rather than a bare verdict. The close reason lives on the turn
    (``abandoned``) and never contains the caller's words.
    """

    turn_id: LogicalTurnId
    waited_ms: float
    guard_ms: float
    bound: str = STALL_GUARD_BOUND
    reason: str = ABANDONED_REASON


@dataclass(frozen=True, slots=True)
class StalledReply:
    """An answered turn whose reply never settled within the guard.

    The turn is not abandoned — it was answered — but it stopped blocking
    later finals once the bound expired, so the caller is never held hostage by
    a producer that will not finish.
    """

    turn_id: LogicalTurnId
    waited_ms: float
    guard_ms: float
    bound: str = STALL_GUARD_BOUND


@dataclass(frozen=True, slots=True)
class OrderedReply:
    """One reply delivery, with the wait ordering imposed on it.

    ``waited_ms`` is the gap between the turn's final being queued and its
    reply being requested; ``blocked_by`` names the earlier logical turns that
    made it wait. Together they are the recorded gap a reader checks instead of
    trusting that ordering happened.
    """

    turn_id: LogicalTurnId
    finalised_at: float
    queued_at: float
    answered_at: float
    waited_ms: float
    blocked_by: tuple[LogicalTurnId, ...] = ()


@dataclass(frozen=True, slots=True)
class ReplyDelivery:
    """What one ordering step did: answered here, still waiting, abandoned."""

    answered: tuple[OrderedReply, ...] = ()
    held: tuple[LogicalTurnId, ...] = ()
    abandoned: tuple[AbandonedTurn, ...] = ()
    stalled: tuple[StalledReply, ...] = ()
    dropped: tuple[LogicalTurnId, ...] = ()


@dataclass
class _Delivery:
    """A mutable accumulator; the public value is frozen once per step."""

    answered: list[OrderedReply] = field(default_factory=list)
    abandoned: list[AbandonedTurn] = field(default_factory=list)
    stalled: list[StalledReply] = field(default_factory=list)
    dropped: list[LogicalTurnId] = field(default_factory=list)

    def frozen(self, held: tuple[LogicalTurnId, ...] = ()) -> ReplyDelivery:
        return ReplyDelivery(
            answered=tuple(self.answered),
            held=held,
            abandoned=tuple(self.abandoned),
            stalled=tuple(self.stalled),
            dropped=tuple(self.dropped),
        )


class ReplyOrder:
    """Finals answered in logical turn order, with a bounded stall guard.

    One queue belongs to one call. A final is queued by its logical turn's
    ``seq``; the head is answered only when no earlier turn is still open.
    ``settle()`` is the orchestrator saying a reply finished; a final whose
    earlier turn never settles waits exactly ``turn.stall_guard_ms`` on the
    injected clock, after which the abandoned turn is closed with no reply and
    the head is answered anyway.

    Nothing here blocks on real time: the deadline is an absolute time on the
    injected clock (:meth:`due_at`), and ``tick()`` is what a caller (or a
    bounded timer) invokes when that time arrives.
    """

    def __init__(
        self,
        *,
        turns: TurnStateStore,
        on_reply: ReplySink,
        clock: Clock | None = None,
        stall_guard_ms: float | None = None,
    ) -> None:
        self._turns = turns
        self._on_reply = on_reply
        self._clock: Clock = clock if clock is not None else turns.now
        self._guard_override = stall_guard_ms
        self._held: list[TurnState] = []
        self._queued_at: dict[LogicalTurnId, float] = {}
        self._blockers: dict[LogicalTurnId, tuple[LogicalTurnId, ...]] = {}
        self._waiting_since: float | None = None
        # Turns that answered but never settled: they stopped blocking when the
        # guard expired, and start blocking again only if they are re-opened.
        self._released: set[LogicalTurnId] = set()
        self._answered: list[OrderedReply] = []
        self._answered_ids: set[LogicalTurnId] = set()
        self._abandoned: list[AbandonedTurn] = []

    # -- state ------------------------------------------------------------

    @property
    def guard_ms(self) -> float:
        """The guard's value, read from the named bound when a wait starts."""
        if self._guard_override is not None:
            return float(self._guard_override)
        return float(require_bound(STALL_GUARD_BOUND))

    @property
    def held(self) -> tuple[TurnState, ...]:
        """Finals waiting for an earlier turn, in logical order."""
        return tuple(self._held)

    @property
    def answered(self) -> tuple[OrderedReply, ...]:
        """Every reply this queue requested, in delivery order."""
        return tuple(self._answered)

    @property
    def abandonments(self) -> tuple[AbandonedTurn, ...]:
        """Every turn the guard closed, in the order it closed them."""
        return tuple(self._abandoned)

    def due_at(self) -> float | None:
        """When the current wait crosses the guard, or ``None`` if it is idle."""
        if not self._held or self._waiting_since is None:
            return None
        return self._waiting_since + self.guard_ms / 1000.0

    # -- ordering ---------------------------------------------------------

    async def submit(self, state: TurnState) -> ReplyDelivery:
        """Queue one finalised turn and answer whatever is now in order."""
        delivery = _Delivery()
        await self._expire_if_due(delivery)
        if state.id in self._answered_ids or any(
            held.id == state.id for held in self._held
        ):
            # A second submission of the same final is not a second reply.
            return delivery.frozen(self._held_ids())
        now = self._clock()
        self._queued_at.setdefault(state.id, now)
        self._blockers[state.id] = tuple(
            earlier.id for earlier in self._earlier_open(state)
        )
        self._held.append(state)
        self._held.sort(key=lambda held: held.seq)
        await self._flush(delivery)
        return delivery.frozen(self._held_ids())

    async def tick(self) -> ReplyDelivery:
        """Cross the guard's deadline if the clock has reached it, then flush.

        This is the seam a bounded timer drives (``CallLifecycle.run_stall_guard``
        supplies the same bound). It is idempotent: an idle queue does nothing.
        """
        delivery = _Delivery()
        await self._expire_if_due(delivery)
        await self._flush(delivery)
        return delivery.frozen(self._held_ids())

    async def settle(
        self, turn: TurnKey, *, reason: str = "answered"
    ) -> ReplyDelivery:
        """Record that a turn's reply finished; later finals may now proceed."""
        delivery = _Delivery()
        state = self._turns.close(turn=turn, reason=reason)
        if state is not None:
            self._released.discard(state.id)
        await self._flush(delivery)
        return delivery.frozen(self._held_ids())

    # -- internals --------------------------------------------------------

    def _held_ids(self) -> tuple[LogicalTurnId, ...]:
        return tuple(state.id for state in self._held)

    def _earlier_open(self, state: TurnState) -> tuple[TurnState, ...]:
        """Open turns that logically precede ``state`` and still block it."""
        return tuple(
            earlier
            for earlier in self._turns.open_turns()
            if earlier.seq < state.seq and earlier.id not in self._released
        )

    async def _expire_if_due(self, delivery: _Delivery) -> None:
        """Close the abandoned turn when the wait has outlived the bound."""
        if not self._held or self._waiting_since is None:
            return
        guard_ms = self.guard_ms
        waited_ms = round(
            max(0.0, (self._clock() - self._waiting_since) * 1000.0), 3
        )
        if waited_ms < guard_ms:
            return
        head = self._held[0]
        for earlier in self._turns.open_turns():
            if earlier.seq >= head.seq:
                continue
            if earlier.id in self._answered_ids:
                # Answered, still streaming: it blew its bound, so it stops
                # blocking later finals but is never relabelled abandoned.
                self._released.add(earlier.id)
                delivery.stalled.append(
                    StalledReply(earlier.id, waited_ms, guard_ms)
                )
                continue
            closed = self._turns.close(turn=earlier, reason="abandoned")
            if closed is None:
                continue
            record = AbandonedTurn(closed.id, waited_ms, guard_ms)
            self._abandoned.append(record)
            delivery.abandoned.append(record)
        self._waiting_since = None

    async def _flush(self, delivery: _Delivery) -> None:
        """Answer held finals while the front of the queue is in order."""
        while self._held:
            head = self._held[0]
            if not head.is_open and head.id not in self._answered_ids:
                # The orchestrator gave up on this final; it is not answered.
                self._held.pop(0)
                delivery.dropped.append(head.id)
                continue
            if self._earlier_open(head):
                break
            self._held.pop(0)
            await self._answer(head, delivery)
        if not self._held:
            self._waiting_since = None
            return
        head = self._held[0]
        self._waiting_since = self._queued_at.get(head.id, self._clock())

    async def _answer(self, state: TurnState, delivery: _Delivery) -> None:
        """Hand one turn to the reply sink and record the wait it served."""
        now = self._clock()
        queued_at = self._queued_at.get(state.id, now)
        answer: OrderedReply | None = None
        if state.id not in self._answered_ids:
            answer = OrderedReply(
                turn_id=state.id,
                finalised_at=(
                    state.finalised_at
                    if state.finalised_at is not None
                    else state.speech_start
                ),
                queued_at=queued_at,
                answered_at=now,
                waited_ms=round(max(0.0, (now - queued_at) * 1000.0), 3),
                blocked_by=self._blockers.get(state.id, ()),
            )
            self._answered.append(answer)
            self._answered_ids.add(state.id)
            delivery.answered.append(answer)
        await self._on_reply(state)


@dataclass(frozen=True, slots=True)
class EventOutcome:
    """The result of applying one provider event.

    ``turn`` is the logical turn the event landed on, if any. ``user_text`` is
    set only for a completion; ``reply_requested`` is true only for a
    non-empty completion. ``endpointing_ms`` is the provider's boundary delay,
    recorded on ``speechEnd`` and nowhere else. ``ignored_reason`` is set
    exactly when ``kind`` is ``IGNORED``.
    """

    kind: EventKind
    turn: TurnState | None = None
    user_text: str | None = None
    endpointing_ms: float | None = None
    reply_requested: bool = False
    ignored_reason: IgnoreReason | None = None
    #: Set on a completion when a final gate is wired. A suppressed or
    #: steering final still carries its authoritative text; only ``REPLY`` and
    #: ``STEER`` reach the reply seam.
    final: FinalDecision | None = None
    #: True when this final was queued behind an earlier open turn. The turn is
    #: finalised and will be answered once ordering allows it (or the guard
    #: closes the turn that blocks it).
    held: bool = False
    #: The replies this step requested, possibly including a held final that
    #: became answerable when an earlier turn settled or was abandoned.
    answered: tuple[OrderedReply, ...] = ()
    #: Turns the guard closed here, and answered turns that stopped blocking
    #: because their reply never settled.
    abandoned: tuple[AbandonedTurn, ...] = ()
    stalled: tuple[StalledReply, ...] = ()


class EventRules:
    """Apply provider events to the logical turn store, in arrival order."""

    def __init__(
        self,
        *,
        turns: TurnStateStore,
        on_reply: ReplySink,
        ledger: TimingLedger | None = None,
        final_gate: FinalGate | None = None,
        agent_text: Callable[[], str] | None = None,
        clock: Clock | None = None,
        stall_guard_ms: float | None = None,
    ) -> None:
        self._turns = turns
        self._on_reply = on_reply
        self._ledger = ledger
        self._final_gate = final_gate
        self._agent_text = agent_text or (lambda: "")
        self._endpointing: dict[LogicalTurnId, float] = {}
        self._no_speech_turns = 0
        self._ignored: dict[IgnoreReason, int] = {r: 0 for r in IgnoreReason}
        # One ordering queue per call: every reply goes through it, so a later
        # final can never overtake an earlier one (ticket 69).
        self._order = ReplyOrder(
            turns=turns,
            on_reply=on_reply,
            clock=clock,
            stall_guard_ms=stall_guard_ms,
        )

    @property
    def reply_order(self) -> ReplyOrder:
        """The ordering queue: held finals, delivered replies and abandonments."""
        return self._order

    async def tick(self) -> ReplyDelivery:
        """Drive the stall guard's deadline on the injected clock."""
        return await self._order.tick()

    async def settle(self, turn: TurnKey, *, reason: str = "answered") -> ReplyDelivery:
        """Record that a turn's reply finished, releasing the next final."""
        return await self._order.settle(turn, reason=reason)

    @property
    def no_speech_turns(self) -> int:
        """Empty completions: counted as turns, never answered."""
        return self._no_speech_turns

    def ignored_count(self, reason: IgnoreReason) -> int:
        """How many events were ignored for ``reason``."""
        return self._ignored[reason]

    def ignored_counts(self) -> dict[IgnoreReason, int]:
        """Every ignore reason and its count, as a copy."""
        return dict(self._ignored)

    def endpointing_ms(self, turn: TurnKey) -> float | None:
        """The endpointing latency recorded for ``turn`` when it ended."""
        state = self._turns.get(turn)
        return None if state is None else self._endpointing.get(state.id)

    async def apply(self, event: Any) -> EventOutcome:
        """Apply one provider event; unknown event types change nothing."""
        if isinstance(event, SpeechStart):
            return self._on_speech_start(event)
        if isinstance(event, PartialTranscript):
            return self._on_partial(event)
        if isinstance(event, SpeechEnd):
            return self._on_speech_end(event)
        if isinstance(event, SpeechComplete):
            return await self._on_speech_complete(event)
        return self._ignore(IgnoreReason.UNKNOWN_EVENT, event, level=logging.DEBUG)

    # -- handlers ---------------------------------------------------------

    def _on_speech_start(self, event: SpeechStart) -> EventOutcome:
        if not event.turn_id or self._is_late(event):
            return self._ignore(
                IgnoreReason.UNKNOWN_TURN
                if not event.turn_id
                else IgnoreReason.LATE_EVENT,
                event,
            )
        state = self._turns.open(event.turn_id, epoch=event.session_epoch)
        if state is None:
            # The provider replayed a start for a turn this call already closed.
            return self._ignore(IgnoreReason.UNKNOWN_TURN, event)
        return EventOutcome(EventKind.SPEECH_START, turn=state)

    def _on_partial(self, event: PartialTranscript) -> EventOutcome:
        """Cumulative caller text: state only, never a user message."""
        if self._is_late(event):
            return self._ignore(IgnoreReason.LATE_EVENT, event)
        state = self._turns.partial(event.text, epoch=self._epoch_of(event))
        if state is None:
            # No preceding start, a closed turn, or a partial after the final:
            # there is no open turn to attribute the words to.
            return self._ignore(IgnoreReason.UNATTRIBUTED_PARTIAL, event)
        self._mark("first_partial")
        return EventOutcome(EventKind.PARTIAL, turn=state)

    def _on_speech_end(self, event: SpeechEnd) -> EventOutcome:
        """The provider's boundary: record it, then stop. No model request."""
        if self._is_late(event):
            return self._ignore(IgnoreReason.LATE_EVENT, event)
        state = self._turns.end(turn=event.turn_id, epoch=event.session_epoch)
        if state is None or state.speech_end is None:
            return self._ignore(IgnoreReason.UNKNOWN_TURN, event)
        self._mark("speech_end")
        endpointing = self._record_endpointing(state)
        return EventOutcome(
            EventKind.SPEECH_END, turn=state, endpointing_ms=endpointing
        )

    async def _on_speech_complete(self, event: SpeechComplete) -> EventOutcome:
        """The authoritative final: the only event that may request a reply."""
        if self._is_late(event):
            return self._ignore(IgnoreReason.LATE_EVENT, event)
        state = self._turns.finalise(
            event.text, turn=event.turn_id, epoch=event.session_epoch
        )
        if state is None:
            return self._ignore(IgnoreReason.UNKNOWN_TURN, event)
        if state.duplicate_finals:
            # The second completion is not a second turn and not a second reply.
            return self._ignore(
                IgnoreReason.DUPLICATE_COMPLETE, event, turn=state
            )
        self._mark("speech_complete")
        if state.is_empty_final:
            self._no_speech_turns += 1
            return EventOutcome(EventKind.NO_SPEECH, turn=state)
        decision = self._decide(state)
        if decision is not None and not decision.answered:
            # Suppressed: counted by the gate, never answered, never a Cancel.
            # The turn is closed so reply ordering cannot wait on it forever.
            self._turns.close(turn=state, reason=decision.reason.value)
            return EventOutcome(
                EventKind.SPEECH_COMPLETE,
                turn=state,
                user_text=state.final_text,
                final=decision,
            )
        delivery = await self._order.submit(state)
        return EventOutcome(
            EventKind.SPEECH_COMPLETE,
            turn=state,
            user_text=state.final_text,
            reply_requested=any(
                answer.turn_id == state.id for answer in delivery.answered
            ),
            final=decision,
            held=any(held == state.id for held in delivery.held),
            answered=delivery.answered,
            abandoned=delivery.abandoned,
            stalled=delivery.stalled,
        )

    def _decide(self, state: TurnState) -> FinalDecision | None:
        """Classify the final through the gate, if one is wired."""
        if self._final_gate is None:
            return None
        return self._final_gate.classify(
            state.final_text, agent_text=self._agent_text()
        )

    def _record_endpointing(self, state: TurnState) -> float:
        """The provider's boundary delay for this turn, in ms.

        Producer: the ``speechEnd`` timestamp minus the turn's last speech
        evidence — the last ``transcript`` update, or the ``speechStart`` when
        no partial ever arrived. Both stamps come from the injected clock, so
        the value needs no wall clock read here.
        """
        last_evidence = (
            state.last_partial_at
            if state.last_partial_at is not None
            else state.last_speech_start
        )
        endpointing = round(max(0.0, (state.speech_end - last_evidence) * 1000.0), 3)
        self._endpointing[state.id] = endpointing
        return endpointing

    @staticmethod
    def _epoch_of(event: Any) -> int | None:
        """The session epoch an event is stamped with, if it carries one."""
        return getattr(event, "session_epoch", None)

    def _is_late(self, event: Any) -> bool:
        """True for an event from a provider session the call has replaced."""
        epoch = self._epoch_of(event)
        return epoch is not None and epoch != self._turns.epoch

    def _ignore(
        self,
        reason: IgnoreReason,
        event: Any,
        *,
        turn: TurnState | None = None,
        level: int = logging.WARNING,
    ) -> EventOutcome:
        """Count and log one ignored event. Never echoes the caller's words."""
        self._ignored[reason] += 1
        _log.log(
            level,
            "ignored [%s] %s turn=%r epoch=%s (current epoch %s)",
            reason.value,
            type(event).__name__,
            getattr(event, "turn_id", None),
            self._epoch_of(event),
            self._turns.epoch,
        )
        return EventOutcome(EventKind.IGNORED, turn=turn, ignored_reason=reason)

    def _mark(self, name: str) -> None:
        if self._ledger is not None:
            self._ledger.mark(name)
