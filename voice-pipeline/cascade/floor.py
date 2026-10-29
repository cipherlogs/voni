"""Floor arbitration while the agent holds the floor.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Floor arbitration. The provider owns the turn
boundary, so this gate decides one thing only: while the agent holds the floor
— speaking, thinking or with a live reply in flight — what a caller partial
means. It is one of three:

* **take the floor** — a real interruption or a command overlap. The agent
  yields; the cancel path and the pivot belong to the barge-in tickets.
* **backchannel** — every token is filler. It is counted, never answered and
  never cuts the agent off.
* **wait** — anything else. The agent keeps the floor.

The command and filler sets are the existing ones in :mod:`turns`; this module
adds no word list of its own and no second threshold. Unsure input waits: the
decision fails closed.

Arbitration is not a reply. The final is the only reply trigger
(:mod:`cascade.event_rules`), so a partial or a ``speechStart`` here can never
start one — it can only take the floor away from the agent. While the agent is
silent this gate returns ``wait`` and does nothing; speculative work on a
silent floor is the prefetch ticket's and is never a reply either.

Time comes from the injected clock. ``agent_speaks`` starts the talk-over
window (the existing establishment guard) and is idempotent per speech
segment; ``agent_thinks`` is the no-audio phase of a reply, where there is no
agent audio to echo, so the window is already established.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from cascade.turn_state import Clock
from metrics import TimingLedger
from turns import (
    BARGE_IN_THRESHOLD,
    ESTABLISHED_MS,
    FloorAction,
    floor_decision,
    is_backchannel,
)


class FloorHold(str, Enum):
    """Who, if anyone, the agent-side floor is being held by."""

    SILENT = "silent"
    SPEAKING = "speaking"
    THINKING = "thinking"


@dataclass(frozen=True, slots=True)
class FloorDecision:
    """What one caller partial meant while the agent held the floor.

    ``action`` is the existing :data:`turns.FloorAction` vocabulary.
    ``floor_held_ms`` is what the talk-over guard measured (for a thinking
    hold it is at least the establishment window, since no agent audio plays).
    """

    action: FloorAction
    hold: FloorHold
    text: str = ""
    floor_held_ms: float = 0.0


class FloorArbiter:
    """The floor half of the orchestrator: hold tracking plus one decision."""

    def __init__(
        self,
        *,
        clock: Clock,
        ledger: TimingLedger | None = None,
        threshold: float = BARGE_IN_THRESHOLD,
        is_backchannel_fn: Callable[[str], bool] = is_backchannel,
    ) -> None:
        self._clock = clock
        self._ledger = ledger
        self._threshold = threshold
        self._is_backchannel = is_backchannel_fn
        self._hold = FloorHold.SILENT
        self._hold_since: float | None = None

    @property
    def hold(self) -> FloorHold:
        """The current hold."""
        return self._hold

    @property
    def holds_floor(self) -> bool:
        """Whether the agent currently holds the floor."""
        return self._hold is not FloorHold.SILENT

    def agent_speaks(self) -> None:
        """The agent has audio on the wire: start the talk-over window.

        Idempotent within one speech segment, so per-frame callers do not keep
        resetting the window and postponing the moment a cut is allowed.
        """
        if self._hold is not FloorHold.SPEAKING:
            self._hold = FloorHold.SPEAKING
            self._hold_since = self._clock()

    def agent_thinks(self) -> None:
        """The agent holds the floor with no audio yet (a reply is in flight)."""
        self._hold = FloorHold.THINKING
        self._hold_since = self._clock()

    def agent_silent(self) -> None:
        """The agent has released the floor."""
        self._hold = FloorHold.SILENT
        self._hold_since = None

    def arbitrate_speech_start(self) -> FloorDecision:
        """A caller ``speechStart`` while the agent holds the floor.

        A start carries no words, so it is never a reply trigger: it is the
        earliest evidence of an interruption and is arbitrated like any other
        floor event. With nothing said yet the decision is ``wait``; the
        cumulative partial that follows decides backchannel versus content.
        """
        return self.arbitrate("", barge_probability=0.0)

    def arbitrate(
        self, text: str, *, barge_probability: float
    ) -> FloorDecision:
        """Decide what one cumulative partial means. No I/O; clock plus counts."""
        text = text or ""
        if not self.holds_floor or self._hold_since is None:
            return FloorDecision("wait", self._hold, text)
        held_ms = max(0.0, (self._clock() - self._hold_since) * 1000.0)
        if self._hold is FloorHold.THINKING:
            # No agent audio is playing, so there is nothing to echo: the
            # existing establishment window is already satisfied.
            held_ms = max(held_ms, ESTABLISHED_MS)
        action = floor_decision(
            text,
            held_ms,
            barge_probability,
            threshold=self._threshold,
            is_backchannel_fn=self._is_backchannel,
        )
        if action == "take_floor":
            self._count("yield")
        elif action == "backchannel":
            self._count("backchannel")
        return FloorDecision(action, self._hold, text, held_ms)

    def _count(self, name: str) -> None:
        if self._ledger is not None:
            self._ledger.count(name)
