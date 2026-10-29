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
``turn.final_text`` and never a partial. Everything else — message history,
reply ordering, floor arbitration — belongs to the tickets that build on this
one; this module keeps the trigger in one place.

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
from dataclasses import dataclass
from enum import Enum
from typing import Any

from cascade.meta_stt import SpeechComplete, SpeechEnd, SpeechStart
from cascade.turn_state import LogicalTurnId, TurnKey, TurnState, TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript

_log = logging.getLogger(__name__)

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


class EventRules:
    """Apply provider events to the logical turn store, in arrival order."""

    def __init__(
        self,
        *,
        turns: TurnStateStore,
        on_reply: ReplySink,
        ledger: TimingLedger | None = None,
    ) -> None:
        self._turns = turns
        self._on_reply = on_reply
        self._ledger = ledger
        self._endpointing: dict[LogicalTurnId, float] = {}
        self._no_speech_turns = 0
        self._ignored: dict[IgnoreReason, int] = {r: 0 for r in IgnoreReason}

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
        await self._on_reply(state)
        return EventOutcome(
            EventKind.SPEECH_COMPLETE,
            turn=state,
            user_text=state.final_text,
            reply_requested=True,
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
