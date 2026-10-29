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

The agent's own voice is never an interruption. Before the command and filler
sets decide, a partial that is mostly the agent's current line coming back is
:func:`is_echo` and waits: the agent keeps speaking, nothing is cancelled and
nothing is answered. This is the same single classifier final suppression uses,
not a second list; the check comes before the command set so a played-back
"please stop" can never steer or cut.

The command and filler sets are the existing ones in :mod:`turns`; this module
adds no word list of its own and no second threshold. Unsure input waits: the
decision fails closed.

The same module owns **final suppression** (:class:`FinalGate`): the final is
the only reply trigger, so it is also the only place a reply can be withheld.
A final that is filler or the agent's own voice is counted and produces
nothing; a command final takes the floor and steers the next turn (and cancels
the agent's audio only when the agent actually holds the floor); anything else
is answered. Echo is the existing similarity rule — :func:`is_echo` is the one
Python port of ``judgeOverlap`` in ``voni/src/lib/voice/barge-in.ts``, and the
share is read back from that source by a parity test. The agent's own line is
checked *before* the command set, so a played-back "please stop" can never
steer the call.

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
    clean_tokens,
    floor_decision,
    is_backchannel,
    is_command_overlap,
)

#: Share of the caller's words already spoken by the agent that marks an echo.
#: Mirrors ``ECHO_SHARE`` in ``voni/src/lib/voice/barge-in.ts``; a parity test
#: reads that source so the two mirrors cannot drift.
ECHO_SHARE = 0.6


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
        is_echo_fn: Callable[[str, str], bool] | None = None,
    ) -> None:
        self._clock = clock
        self._ledger = ledger
        self._threshold = threshold
        self._is_backchannel = is_backchannel_fn
        # Resolved here because the one classifier is declared below.
        self._is_echo = is_echo if is_echo_fn is None else is_echo_fn
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
        self, text: str, *, barge_probability: float, agent_text: str = ""
    ) -> FloorDecision:
        """Decide what one cumulative partial means. No I/O; clock plus counts.

        ``agent_text`` is the line the agent is saying (or has just said). A
        partial that is mostly those words is the agent's own audio returning:
        it waits, so the agent keeps the floor and the cut path is never asked
        to cancel. Finishing without the agent's line fails closed — suppression
        needs evidence, not a guess.
        """
        text = text or ""
        if not self.holds_floor or self._hold_since is None:
            return FloorDecision("wait", self._hold, text)
        held_ms = max(0.0, (self._clock() - self._hold_since) * 1000.0)
        if self._hold is FloorHold.THINKING:
            # No agent audio is playing, so there is nothing to echo: the
            # existing establishment window is already satisfied.
            held_ms = max(held_ms, ESTABLISHED_MS)
        if text and self._is_echo(text, agent_text):
            # The agent's own voice is never an interruption or a command.
            return FloorDecision("wait", self._hold, text, held_ms)
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


def is_echo(text: str, agent_text: str) -> bool:
    """True when the caller's line is mostly the agent's own words coming back.

    The existing similarity rule (``judgeOverlap`` in the browser's
    ``barge-in.ts``): two words minimum, and at least :data:`ECHO_SHARE` of them
    already in the agent's current sentence. One-word lines are never echoes —
    a lone "no" over the agent is steering, and suppression needs evidence.
    An empty agent line proves nothing, so nothing is suppressed.
    """
    tokens = clean_tokens(text)
    if len(tokens) < 2:
        return False
    agent_words = set(clean_tokens(agent_text))
    if not agent_words:
        return False
    echoed = sum(1 for token in tokens if token in agent_words)
    return echoed / len(tokens) >= ECHO_SHARE


class FinalAction(str, Enum):
    """What one authoritative final means for the floor."""

    #: A normal final: the agent takes the floor and answers.
    REPLY = "reply"
    #: A command final: the caller took the floor; answer with a pivot, never
    #: by resuming the cut-off sentence.
    STEER = "steer"
    #: Filler or the agent's own voice: counted, never answered, never cut.
    SUPPRESSED = "suppressed"


class FinalReason(str, Enum):
    """Why the final was answered the way it was. Every reason is reportable."""

    NORMAL = "normal"
    COMMAND = "command"
    BACKCHANNEL = "backchannel"
    ECHO = "echo"
    EMPTY = "empty"


@dataclass(frozen=True, slots=True)
class FinalDecision:
    """What one final meant, decided before anything is said.

    ``text`` is the authoritative final. ``floor`` is who held the floor when
    it landed. ``cancel`` is true only when a command took the floor away from
    an agent that was actually holding it; a suppressed final never cancels.
    """

    action: FinalAction
    reason: FinalReason
    text: str = ""
    floor: FloorHold = FloorHold.SILENT
    cancel: bool = False

    @property
    def answered(self) -> bool:
        """Whether this final may reach the reply seam."""
        return self.action is not FinalAction.SUPPRESSED

    @property
    def steer_text(self) -> str:
        """The steering the reply must acknowledge, or empty."""
        return self.text if self.action is FinalAction.STEER else ""


class FinalGate:
    """Decide what one authoritative final means. No I/O; clock plus counts.

    The gate is not a reply trigger and holds no sink: it returns a
    :class:`FinalDecision` and the orchestrator keeps the one reply call site
    (:class:`cascade.event_rules.EventRules`). Counting uses the existing
    ledger counters — ``backchannel``, ``overheard`` and ``yield`` — so a
    suppressed final is visible on the same scoreboard as an arbitration.
    """

    def __init__(
        self,
        *,
        ledger: TimingLedger | None = None,
        arbiter: FloorArbiter | None = None,
        is_backchannel_fn: Callable[[str], bool] = is_backchannel,
        is_command_fn: Callable[[str], bool] = is_command_overlap,
        is_echo_fn: Callable[[str, str], bool] = is_echo,
    ) -> None:
        self._ledger = ledger
        self._arbiter = arbiter
        self._is_backchannel = is_backchannel_fn
        self._is_command = is_command_fn
        self._is_echo = is_echo_fn

    def classify(self, text: str, *, agent_text: str = "") -> FinalDecision:
        """Classify one final. Fail-closed: suppression needs evidence.

        Order matters. Filler is decided first (it is never a command), then
        the agent's own voice, then the command set: an echo that happens to
        contain "stop" is the agent's line played back, not a caller steering.
        """
        text = text or ""
        floor = self._floor()
        if not text.strip():
            # An empty completion is a no-speech turn: counted by the event
            # rules as a turn, never as a backchannel.
            return FinalDecision(FinalAction.SUPPRESSED, FinalReason.EMPTY, text, floor)
        if self._is_backchannel(text):
            self._count("backchannel")
            return FinalDecision(
                FinalAction.SUPPRESSED, FinalReason.BACKCHANNEL, text, floor
            )
        if self._is_echo(text, agent_text):
            self._count("overheard")
            return FinalDecision(
                FinalAction.SUPPRESSED, FinalReason.ECHO, text, floor
            )
        if self._is_command(text):
            # The caller steered: the agent yields the floor. There is only
            # something to cut when the agent was actually holding it.
            self._count("yield")
            return FinalDecision(
                FinalAction.STEER,
                FinalReason.COMMAND,
                text,
                floor,
                cancel=floor is not FloorHold.SILENT,
            )
        return FinalDecision(FinalAction.REPLY, FinalReason.NORMAL, text, floor)

    def _floor(self) -> FloorHold:
        return FloorHold.SILENT if self._arbiter is None else self._arbiter.hold

    def _count(self, name: str) -> None:
        if self._ledger is not None:
            self._ledger.count(name)
