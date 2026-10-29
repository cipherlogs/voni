"""Logical turn identity and the per-turn state the cascade keys on.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration". The identity is ``(sessionEpoch, providerTurnId)``
because the vendor reuses a ``turnId`` after a reconnect and turns may overlap:
a later ``speechStart`` can arrive before an earlier ``speechComplete``. The
provider id alone is not an identity, and the epoch alone is not a turn.

Every piece of turn state hangs off one :class:`TurnState`: partial text, the
speech start/end timestamps, the authoritative final text, the tool loop, the
reply, the audio cut point, which provider session produced the turn and which
providers served it (:attr:`TurnState.providers`). Two turns are two objects;
nothing is shared between them.

:class:`TurnStateStore` owns the lifecycle tickets 67-78 build on:

* :meth:`~TurnStateStore.open` — ``speechStart`` creates the turn (or refreshes
  it, including a replayed start after a reconnect).
* :meth:`~TurnStateStore.partial` — a ``transcript`` belongs to the most recent
  start, or to an explicitly named turn.
* :meth:`~TurnStateStore.end` — ``speechEnd`` records the boundary and nothing
  else; it never finalises.
* :meth:`~TurnStateStore.finalise` — ``speechComplete`` supplies the
  authoritative text; a duplicate is idempotent.
* :meth:`~TurnStateStore.reply` — the reply slot carries its own logical turn
  and the authoritative final it answers.
* :meth:`~TurnStateStore.attribute` — the providers that served the turn, keyed
  by its logical id, recorded after the turn closed as well as before.
* :meth:`~TurnStateStore.user_text` — the only text a user caption may carry;
  a partial is never a caption source.
* :meth:`~TurnStateStore.close` — the turn ended (answered, suppressed,
  abandoned or the call drained) and carries the reason.
* :meth:`~TurnStateStore.provider_table` — the end message's call-level
  ``{stt, llm, tts}`` table, derived from the turns so the two cannot disagree.

A stale event — one stamped with a session epoch the call has already replaced
— is ignored by every method and reported as ``None``. So is an unknown or
closed turn: this module records state, it does not decide what an orchestrator
logs. :meth:`~TurnStateStore.resolve` is how a caller tells "unknown turn in
the current epoch" (a protocol violation) from "late event from an old
session" (ignore quietly).

Timestamps come from the injected clock (``cascade/testing/clock.py`` in
tests, ``time.monotonic`` in production); nothing here reads the wall clock.
The store deliberately owns no thresholds, no queues and no I/O — the stall
guard, reply ordering and tool execution belong to the tickets that use it.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any

from cascade.breaker import LEGS
from cascade.events import (
    VENDOR_OWNED,
    AttributionError,
    LegAttribution,
    TurnAttribution,
    turn_key,
)

if TYPE_CHECKING:
    from cascade.call import ProviderTable

#: A callable clock in seconds. ``FakeClock`` satisfies it directly.
Clock = Callable[[], float]


class TurnPhase(str, Enum):
    """Where a logical turn is in its lifecycle."""

    SPEAKING = "speaking"
    ENDPOINTED = "endpointed"
    FINALISED = "finalised"
    CLOSED = "closed"


@dataclass(frozen=True, slots=True)
class LogicalTurnId:
    """A turn identity that a reconnect cannot reuse.

    ``provider_turn_id`` is the vendor's id; it resets on reconnect and may
    repeat. ``session_epoch`` is the local call-level session counter, so the
    pair stays unique for the life of the call.
    """

    session_epoch: int
    provider_turn_id: str

    @property
    def event_id(self) -> str:
        """The one string a turn is written as in an event's ``turn`` field."""
        return turn_key(self)


@dataclass(frozen=True, slots=True)
class ProviderAttribution:
    """Which provider session produced (or most recently replayed) a turn."""

    session_epoch: int
    provider_turn_id: str
    source: str = ""


@dataclass
class ToolLoopState:
    """The turn's tool-loop slot; the tool tickets own the loop itself.

    ``memo`` is the per-turn ``(name, canonical arguments)`` result memo the
    spec requires. Canonicalisation is the tool loop's job; this container only
    guarantees the memo lives and dies with the logical turn.
    """

    calls: list[Any] = field(default_factory=list)
    memo: dict[Any, Any] = field(default_factory=dict)
    rounds: int = 0


@dataclass
class ReplyState:
    """The turn's reply slot, keyed to the same logical turn as its input.

    ``turn_id`` names the logical turn the reply belongs to, so a caption or a
    history entry cannot be attributed to a later turn that happened to open
    while the reply was streaming. ``user_text`` is the authoritative final the
    reply answers — never the last partial of another turn.
    """

    text: str = ""
    turn_id: LogicalTurnId | None = None
    user_text: str = ""
    started_at: float | None = None
    first_audio_at: float | None = None
    finished_at: float | None = None
    cancelled: bool = False


@dataclass
class TurnState:
    """Everything the cascade knows about one logical turn."""

    id: LogicalTurnId
    seq: int
    speech_start: float
    attribution: ProviderAttribution
    phase: TurnPhase = TurnPhase.SPEAKING
    speech_starts: int = 1
    last_speech_start: float = 0.0
    speech_end: float | None = None
    partial_text: str = ""
    partial_updates: int = 0
    first_partial_at: float | None = None
    last_partial_at: float | None = None
    final_text: str = ""
    finalised_at: float | None = None
    duplicate_finals: int = 0
    tool_loop: ToolLoopState = field(default_factory=ToolLoopState)
    reply: ReplyState = field(default_factory=ReplyState)
    cut_point: float | None = None
    closed_at: float | None = None
    close_reason: str = ""
    attribution_history: list[ProviderAttribution] = field(default_factory=list)
    providers: TurnAttribution | None = None

    @property
    def is_open(self) -> bool:
        return self.phase is not TurnPhase.CLOSED

    @property
    def is_finalised(self) -> bool:
        return self.phase is TurnPhase.FINALISED

    @property
    def is_empty_final(self) -> bool:
        """A ``speechComplete`` with no speech is counted, never answered."""
        return self.is_finalised and not self.final_text.strip()

    def provider_attribution(self) -> TurnAttribution:
        """Which providers served this turn, or a named unmeasured record.

        A turn whose attribution was never recorded never returns a fabricated
        provider: it returns an ``unmeasured`` record naming the logical turn
        and the reason, so an operator can tell "no model ran" (a ``null`` leg)
        from "nobody wrote down what ran" (``unmeasured``).
        """
        if self.providers is not None:
            return self.providers
        return TurnAttribution.unmeasured(
            self.id.event_id,
            f"no attribution was recorded for turn {self.id.event_id}; its "
            "providers are unmeasured, not guessed",
        )


#: A turn may be named by its identity, its state, or the provider's id (which
#: resolves through the store's epoch binding).
TurnKey = str | LogicalTurnId | TurnState


class TurnStateStore:
    """The logical turns of one call, keyed by :class:`LogicalTurnId`."""

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        source: str = "",
        start_epoch: int = 0,
    ) -> None:
        self._clock: Clock = clock if clock is not None else time.monotonic
        self._source = source
        self._epoch = start_epoch
        self._turns: dict[LogicalTurnId, TurnState] = {}
        self._bindings: dict[tuple[int, str], LogicalTurnId] = {}
        self._latest: LogicalTurnId | None = None
        self._seq = 0

    # -- identity ---------------------------------------------------------

    @property
    def epoch(self) -> int:
        """The session epoch new events must carry."""
        return self._epoch

    @property
    def source(self) -> str:
        """The provider attribution given to a turn opened without one."""
        return self._source

    def now(self) -> float:
        return float(self._clock())

    def new_epoch(self, *, source: str | None = None) -> int:
        """Start a new provider session after a reconnect; returns the epoch.

        Provider turn ids restart with the session, so the epoch is what keeps
        a reused id distinct. The most recent start is forgotten: a partial
        that arrives before the replayed ``speechStart`` is unattributed.
        """
        if source is not None:
            self._source = source
        self._epoch += 1
        self._latest = None
        return self._epoch

    def bind(
        self,
        provider_turn_id: str,
        turn: LogicalTurnId | TurnState,
        *,
        epoch: int | None = None,
        source: str | None = None,
    ) -> LogicalTurnId | None:
        """Map a new provider ``turnId`` onto an existing logical turn.

        This is the reconnect path: the vendor has no resume token, so the
        adapter replays the turn's audio into a new session and the new id must
        land in the old turn. Attribution moves to the new session and the
        previous one is kept in ``attribution_history``.
        """
        target = self._epoch if epoch is None else epoch
        if target != self._epoch or not provider_turn_id:
            return None
        state = self._state(turn, open_only=False)
        if state is None or not state.is_open:
            return None
        self._bindings[(target, provider_turn_id)] = state.id
        state.attribution_history.append(state.attribution)
        state.attribution = ProviderAttribution(
            target, provider_turn_id, source or self._source
        )
        return state.id

    def resolve(
        self, provider_turn_id: str, *, epoch: int | None = None
    ) -> LogicalTurnId | None:
        """The logical turn a provider id names in ``epoch``, if any.

        ``None`` with the current epoch is an unknown turn (a protocol
        violation); ``None`` with an older epoch is a late event from a
        replaced session (ignored).
        """
        if not self._accepts(epoch):
            return None
        key = (self._epoch if epoch is None else epoch, provider_turn_id)
        return self._bindings.get(key)

    # -- lifecycle --------------------------------------------------------

    def open(
        self,
        provider_turn_id: str,
        *,
        epoch: int | None = None,
        source: str | None = None,
    ) -> TurnState | None:
        """``speechStart``: create the turn, or refresh a bound/replayed one."""
        if not self._accepts(epoch):
            return None
        if not provider_turn_id:
            raise ValueError("a provider turn id must not be empty")
        now = self.now()
        logical = self._bindings.get((self._epoch, provider_turn_id))
        if logical is not None:
            state = self._turns[logical]
            if not state.is_open:
                return None
            state.speech_starts += 1
            state.last_speech_start = now
            self._latest = state.id
            return state

        self._seq += 1
        state = TurnState(
            id=LogicalTurnId(self._epoch, provider_turn_id),
            seq=self._seq,
            speech_start=now,
            last_speech_start=now,
            attribution=ProviderAttribution(
                self._epoch, provider_turn_id, source or self._source
            ),
        )
        self._turns[state.id] = state
        self._bindings[(self._epoch, provider_turn_id)] = state.id
        self._latest = state.id
        return state

    def partial(
        self,
        text: str,
        *,
        turn: TurnKey | None = None,
        epoch: int | None = None,
    ) -> TurnState | None:
        """``transcript``: cumulative text for the most recent start.

        A partial never becomes a final and is never sent to the model. One
        that arrives after the authoritative completion is ignored, so it
        cannot overwrite ``final_text``.
        """
        state = self._state(turn, epoch=epoch)
        if state is None or state.phase is TurnPhase.FINALISED:
            return None
        now = self.now()
        state.partial_text = text
        state.partial_updates += 1
        state.last_partial_at = now
        if state.first_partial_at is None:
            state.first_partial_at = now
        return state

    def end(
        self, *, turn: TurnKey | None = None, epoch: int | None = None
    ) -> TurnState | None:
        """``speechEnd``: record the boundary and do nothing else."""
        state = self._state(turn, epoch=epoch)
        if state is None:
            return None
        if state.phase is TurnPhase.SPEAKING:
            state.speech_end = self.now()
            state.phase = TurnPhase.ENDPOINTED
            return state
        if state.phase is TurnPhase.ENDPOINTED:
            return state
        return None

    def finalise(
        self,
        text: str,
        *,
        turn: TurnKey | None = None,
        epoch: int | None = None,
    ) -> TurnState | None:
        """``speechComplete``: the authoritative text, set exactly once."""
        state = self._state(turn, epoch=epoch)
        if state is None:
            return None
        if state.phase is TurnPhase.FINALISED:
            state.duplicate_finals += 1
            return state
        if state.phase is TurnPhase.CLOSED:
            return None
        state.final_text = text
        state.finalised_at = self.now()
        state.phase = TurnPhase.FINALISED
        return state

    def reply(
        self,
        text: str = "",
        *,
        turn: TurnKey | None = None,
        at: float | None = None,
        epoch: int | None = None,
    ) -> ReplyState | None:
        """Record reply text on the logical turn that produced it.

        The reply carries the turn's own id and the authoritative final it
        answers, so a later turn opening mid-reply cannot be captioned with
        this reply's user text. The start stamp is first-write-wins.
        """
        state = self._state(turn, epoch=epoch)
        if state is None:
            return None
        reply = state.reply
        if reply.started_at is None:
            reply.started_at = self.now() if at is None else float(at)
        reply.turn_id = state.id
        reply.user_text = state.final_text
        if text:
            reply.text = text
        return reply

    def user_text(
        self, turn: TurnKey, *, epoch: int | None = None
    ) -> str | None:
        """The only text a user caption may carry: the turn's own final.

        A partial is never a caption source, and a turn that has not received
        its authoritative completion has no user text at all.
        """
        state = self._state(turn, epoch=epoch, open_only=False)
        if state is None or not state.is_finalised:
            return None
        return state.final_text

    def cut(
        self,
        turn: TurnKey | None = None,
        *,
        at: float | None = None,
        epoch: int | None = None,
    ) -> TurnState | None:
        """Record where the turn's reply audio was cut. First write wins."""
        state = self._state(turn, epoch=epoch)
        if state is None:
            return None
        if state.cut_point is None:
            state.cut_point = self.now() if at is None else float(at)
        return state

    def attribute(
        self,
        attribution: TurnAttribution,
        *,
        turn: TurnKey | None = None,
        epoch: int | None = None,
    ) -> TurnState | None:
        """Record which providers served the turn, keyed by its logical id.

        One attribution per turn: a later record for the same turn replaces the
        earlier one (a mid-turn rung change is a new snapshot of the same turn,
        never a merge with another turn's legs). The record's ``turn`` must be
        the turn it lands on, so a reply for another turn cannot rewrite this
        one's model. It may land after the turn closed — the reply's providers
        are known at the end — but never from a replaced session epoch.
        """
        if not isinstance(attribution, TurnAttribution):
            raise TypeError(
                f"attribute needs a TurnAttribution, got {attribution!r}"
            )
        state = self._state(turn, epoch=epoch, open_only=False)
        if state is None:
            return None
        if attribution.turn != state.id.event_id:
            raise AttributionError(
                "turn",
                f'the attribution is for turn "{attribution.turn}", not '
                f'"{state.id.event_id}"; a turn never carries another turn\'s providers',
            )
        state.providers = attribution
        return state

    def provider_table(self, *, missing_reason: str) -> "ProviderTable":
        """The call-level ``{stt, llm, tts}`` table, derived from the turns.

        Deriving the end message's table from the attributions is what keeps a
        turn and the table from disagreeing: each row is the provider of the
        most recent turn that used that leg, so a mid-call rung change shows the
        rung that is actually serving. A backchannel turn does not erase a leg,
        an unmeasured turn contributes no provider, and a leg no turn used is
        ``null`` with ``missing_reason`` rather than a guess.

        The managed pipeline has no vendor choice: if any turn is vendor-owned,
        every row is ``N/A — vendor-owned``.
        """
        if not isinstance(missing_reason, str) or not missing_reason.strip():
            raise ValueError(
                "a derived provider table needs the reason a leg is missing, "
                f"got {missing_reason!r}"
            )
        # Deferred: the event schema and the turn layer must not import the call
        # lifecycle at module load (the lifecycle's owner imports them).
        from cascade.call import ProviderRow, ProviderTable

        recorded = [
            state.providers for state in self._turns.values() if state.providers is not None
        ]
        if any(record.vendor_owned for record in recorded):
            return ProviderTable(
                tuple(
                    ProviderRow(
                        name,
                        VENDOR_OWNED,
                        None,
                        "the managed pipeline is vendor-owned",
                    )
                    for name in LEGS
                )
            )

        latest: dict[str, LegAttribution] = {}
        for record in recorded:
            if record.state != "measured":
                continue
            for name in LEGS:
                served = record.leg(name)
                if served is not None:
                    latest[name] = served
        return ProviderTable(
            tuple(
                ProviderRow(
                    name,
                    latest[name].provider,
                    latest[name].rung,
                    latest[name].reason,
                )
                if name in latest
                else ProviderRow(name, None, None, missing_reason)
                for name in LEGS
            )
        )

    def close(
        self,
        turn: TurnKey | None = None,
        *,
        reason: str = "",
        at: float | None = None,
        epoch: int | None = None,
    ) -> TurnState | None:
        """End the turn; ``reason`` says answered, suppressed or abandoned."""
        state = self._state(turn, epoch=epoch, open_only=False)
        if state is None:
            return None
        if not state.is_open:
            return state
        state.phase = TurnPhase.CLOSED
        state.closed_at = self.now() if at is None else float(at)
        state.close_reason = reason
        if self._latest == state.id:
            self._latest = None
        return state

    # -- lookup -----------------------------------------------------------

    def get(self, turn: TurnKey, *, epoch: int | None = None) -> TurnState | None:
        """A turn by identity, including a closed one.

        ``epoch`` is the stamp the caller's event carried: an event from a
        replaced session cannot even read a live turn, let alone close it.
        """
        return self._state(turn, epoch=epoch, open_only=False)

    def turns(self) -> tuple[TurnState, ...]:
        """Every turn of the call, in the order the provider opened them."""
        return tuple(self._turns.values())

    def open_turns(self) -> tuple[TurnState, ...]:
        """Turns that have not been closed, in logical (open) order."""
        return tuple(state for state in self._turns.values() if state.is_open)

    # -- internals --------------------------------------------------------

    def _accepts(self, epoch: int | None) -> bool:
        return (self._epoch if epoch is None else epoch) == self._epoch

    def _state(
        self,
        turn: TurnKey | None,
        *,
        epoch: int | None = None,
        open_only: bool = True,
    ) -> TurnState | None:
        state: TurnState | None
        # The epoch guard comes first for every key shape. A state or logical
        # id can still be named by a late event from a replaced session, and
        # applying it would let that event mutate a live turn.
        if not self._accepts(epoch):
            return None
        if turn is None:
            state = (
                self._turns.get(self._latest) if self._latest is not None else None
            )
        elif isinstance(turn, TurnState):
            state = self._turns.get(turn.id)
        elif isinstance(turn, LogicalTurnId):
            state = self._turns.get(turn)
        elif isinstance(turn, str):
            if not self._accepts(epoch) or not turn:
                return None
            logical = self._bindings.get(
                (self._epoch if epoch is None else epoch, turn)
            )
            state = self._turns.get(logical) if logical is not None else None
        else:
            raise TypeError(f"not a turn key: {turn!r}")
        if state is None or (open_only and not state.is_open):
            return None
        return state
