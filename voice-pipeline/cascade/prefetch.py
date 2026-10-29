"""Speculative prefetch: read-only work that can never take a turn.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Floor arbitration. While the agent is silent a
growing partial may start speculative model work. Four rules make that safe,
and this module is the only place they live:

* **Read-only.** A prefetch calls ``LLMStream.prefetch`` and nothing else. It
  has no reply sink, no token consumer and no way to reach the caller: the
  completion is still the only event that may ask for a reply
  (:mod:`cascade.event_rules`).
* **Never a turn.** A partial is never a user message. The speculator does not
  build messages — the caller passes the request it might make — and adoption
  hands back a ticket, not text.
* **Cancellable.** Every speculation can be cancelled, idempotently, and is
  cancelled when it is replaced, dropped or adopted.
* **Adopted on an exact match only.** The final's request must equal the
  prefetched request word for word (canonical key over messages *and* tools,
  plus the text itself) and the final must be one that is going to be answered
  (``takes_floor``). Anything else is waste, counted and cancelled.

The floor guard comes from :class:`cascade.floor.FloorArbiter`: speculation
never runs while the agent holds the floor — speaking, thinking or with a live
reply. The boundary guard is the turn phase: nothing starts at or after
``speechEnd`` (ticket 73's negative suite pins zero model requests between
``speechEnd`` and ``speechComplete``).

Counting uses the existing ledger counters — ``prefetch_started``,
``prefetch_cancelled`` and ``prefetch_used`` — so a dropped speculation is
visible on the same scoreboard as the reply gap. A prefetch that fails is
counted as cancelled and never breaks the call: speculation must not be able to
fail a turn.

Pressure sheds the speculation first (spec M3 "Prefetch shedding"): a ``429``,
an STT ``1013``, an exhausted remaining-quota header, an STT concurrency limit
or a TTS control-frame signal cancels the live speculation and refuses new ones
until the provider says the pressure is gone. The caller's turn is never
refused by any of this — a prefetch is optional work, and its only resource
claim is capacity a real turn does not need.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from cascade.failures import Code, FailureClass, FailureVerdict, classify
from cascade.floor import FloorArbiter
from cascade.turn_state import TurnPhase
from metrics import TimingLedger
from providers import LLMStream, PrefetchHandle

_log = logging.getLogger(__name__)


def message_key(
    messages: Sequence[dict[str, Any]],
    tools: Sequence[dict[str, Any]] | None = None,
) -> str:
    """The canonical identity of one request: messages and tools, no order.

    Two requests are the same request only if this key is equal. The gateway's
    own adoption uses the same shape (canonical JSON), so the cascade cannot
    adopt one message list while the backend adopts another.
    """
    return json.dumps(
        {"messages": list(messages), "tools": list(tools or ())},
        sort_keys=True,
        default=str,
    )


class DropReason(str, Enum):
    """Why a speculation was cancelled. Every reason is reportable."""

    #: A newer partial arrived; it may start its own speculation.
    REPLACED = "replaced"
    #: The final's request or text differs from what was prefetched.
    MISMATCH = "mismatch"
    #: The final was suppressed (backchannel or echo): nothing to answer.
    SUPPRESSED = "suppressed"
    #: The caller cancelled the ticket directly.
    CANCELLED = "cancelled"
    #: ``prefetch`` raised; speculation is best effort, never a call failure.
    FAILED = "failed"
    #: The turn or the call ended before the final.
    CALL_END = "call_end"
    #: Provider pressure: the speculation is the first thing to go.
    SHED = "shed"


class PressureKind(str, Enum):
    """The rate-pressure signals the spec names, and nothing else."""

    #: A ``429`` on the model leg, or a speech ``1013`` ("try again later").
    RATE_LIMITED = "rate_limited"
    #: The provider's remaining-quota header says nothing is left.
    QUOTA_EXHAUSTED = "quota_exhausted"
    #: The speech leg is at its concurrency limit for this account.
    CONCURRENCY_LIMIT = "concurrency_limit"
    #: A synthesis control-frame/pacing signal (the vendor's ``3010``).
    CONTROL_FRAME = "control_frame"


#: The legs a pressure signal may name.
PRESSURE_LEGS: tuple[str, ...] = ("llm", "stt", "tts")


@dataclass(frozen=True, slots=True)
class PressureSignal:
    """One observation that speculative work must give way.

    ``remaining`` is the provider's own number of units left, when it sent one.
    ``None`` means "the provider did not say", which is never read as zero.
    """

    kind: PressureKind
    leg: str
    code: int | None = None
    remaining: int | None = None
    detail: str = ""

    def __post_init__(self) -> None:
        if self.leg not in PRESSURE_LEGS:
            raise ValueError(
                f"unknown pressure leg {self.leg!r}; expected one of "
                + ", ".join(PRESSURE_LEGS)
            )


#: The one model status the spec calls rate pressure.
LLM_RATE_LIMITED = 429
#: The one speech close the spec calls rate pressure ("try again later").
STT_RATE_LIMITED = 1013
#: The synthesis control-frame/pacing close: "shed prefetch and back off".
TTS_CONTROL_PACING = 3010


def pressure_from_llm_status(status: int) -> PressureSignal | None:
    """A model HTTP status as pressure, or ``None`` when it is not pressure."""
    if status == LLM_RATE_LIMITED:
        return PressureSignal(
            PressureKind.RATE_LIMITED, "llm", code=status, detail=f"llm {status}"
        )
    return None


def pressure_from_stt_close(code: int | None) -> PressureSignal | None:
    """A speech close as pressure, or ``None`` when it is not pressure."""
    if code == STT_RATE_LIMITED:
        return PressureSignal(
            PressureKind.RATE_LIMITED, "stt", code=code, detail=f"stt {code}"
        )
    return None


def pressure_from_tts_close(code: int | None) -> PressureSignal | None:
    """A synthesis close as pressure, or ``None`` when it is not pressure."""
    if code == TTS_CONTROL_PACING:
        return PressureSignal(
            PressureKind.CONTROL_FRAME, "tts", code=code, detail=f"tts {code}"
        )
    return None


def quota_pressure(leg: str, *, remaining: int | None) -> PressureSignal | None:
    """The provider's remaining-quota header, or ``None`` when it says nothing.

    An absent header and a positive count are both "no pressure": reading
    either as zero would take speculation off for a number nobody sent.
    """
    if remaining is None or remaining > 0:
        return None
    return PressureSignal(
        PressureKind.QUOTA_EXHAUSTED,
        leg,
        remaining=remaining,
        detail=f"{leg} remaining-quota header {remaining!r}",
    )


def concurrency_pressure(leg: str) -> PressureSignal:
    """A leg reporting that this account is at its concurrency limit."""
    return PressureSignal(
        PressureKind.CONCURRENCY_LIMIT, leg, detail=f"{leg} concurrency limit"
    )


def prefetch_failure_verdict(leg: str, code: Code = None) -> FailureVerdict:
    """The breaker verdict a *speculative* failure carries: never a trigger.

    The leg's real table still says what the failure means (so the reason and
    the code are the vendor's), but speculative work cannot demote a healthy
    provider: the class is always ``do_not_open``. A real turn's failure goes
    through :func:`cascade.failures.classify` untouched.
    """
    classified = classify(leg, code)
    return FailureVerdict(
        leg=classified.leg,
        code=classified.code,
        failure_class=FailureClass.DO_NOT_OPEN,
        reason=(
            f"speculative prefetch: {classified.reason}; "
            "speculation never opens a breaker"
        ),
    )


@dataclass(frozen=True, slots=True)
class ShedDecision:
    """What one pressure observation did to the speculation.

    ``verdict`` is the failure a *speculative* request carries: the shared
    classifier's class, downgraded so it can never open a leg. A real turn's
    own ``429`` keeps its trigger class and opens the leg as usual.
    """

    signal: PressureSignal
    cancelled: bool
    verdict: FailureVerdict


class RequestBudget(Protocol):
    """What a provider meter must report for speculation to claim a unit.

    ``remaining`` is the provider's own count of units left in the window, or
    ``None`` when it sent no such number. ``real_turns_waiting`` is how many
    callers' turns currently need a unit. A speculation may take one only when
    one remains beyond every waiting turn; the reserve is one unit per waiting
    turn, so no total is invented here.
    """

    def remaining(self) -> int | None:
        """Units the provider says are left, or ``None`` when it did not say."""

    def real_turns_waiting(self) -> int:
        """Turns currently waiting for a unit of the same capacity."""


@dataclass(slots=True)
class PrefetchTicket:
    """One in-flight speculation and the request it was started for.

    ``key`` is the canonical request identity the final must match exactly.
    ``cancel`` is idempotent and never raises: a backend handle that misbehaves
    on cancellation must not fail a call.
    """

    key: str
    partial_text: str
    handle: PrefetchHandle
    turn_id: str | None = None
    cancelled: bool = False

    def cancel(self) -> None:
        if self.cancelled:
            return
        self.cancelled = True
        try:
            self.handle.cancel()
        except Exception:  # pragma: no cover - defensive, handle contract says never
            _log.warning("prefetch handle raised on cancel; ignoring")


@dataclass(slots=True)
class PrefetchSpeculator:
    """The one speculator of a call: at most one live speculation at a time."""

    llm: LLMStream
    ledger: TimingLedger | None = None
    arbiter: FloorArbiter | None = None
    budget: RequestBudget | None = None
    _pending: PrefetchTicket | None = field(default=None, init=False)
    _last_partial: str = field(default="", init=False)
    _drops: dict[DropReason, int] = field(default_factory=dict, init=False)
    _shed: PressureSignal | None = field(default=None, init=False)

    @property
    def pending(self) -> PrefetchTicket | None:
        """The live speculation, if any."""
        return self._pending

    @property
    def shed(self) -> PressureSignal | None:
        """The pressure that is keeping speculation off, if any."""
        return self._shed

    def observe_pressure(self, signal: PressureSignal) -> ShedDecision:
        """Shed the speculation and refuse new ones until the pressure clears.

        The live ticket is cancelled first, so a speculation can never outlive
        the observation that the provider is under pressure. A refusal that
        follows is counted per attempt, like a failed prefetch.
        """
        if not isinstance(signal, PressureSignal):
            raise TypeError(
                f"observe_pressure wants a PressureSignal, got {type(signal).__name__}"
            )
        self._shed = signal
        return ShedDecision(
            signal=signal,
            cancelled=self.drop(DropReason.SHED),
            verdict=prefetch_failure_verdict(signal.leg, signal.code),
        )

    def pressure_relieved(self) -> bool:
        """Clear the pressure; True when speculation had been shed."""
        if self._shed is None:
            return False
        self._shed = None
        return True

    def drops(self) -> dict[DropReason, int]:
        """How many speculations died for each reason, as a copy."""
        return {reason: self._drops.get(reason, 0) for reason in DropReason}

    def offer(
        self,
        partial_text: str,
        *,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        phase: TurnPhase = TurnPhase.SPEAKING,
        turn_id: str | None = None,
    ) -> PrefetchTicket | None:
        """Maybe start speculative work for a partial. Never raises.

        Refused while the agent holds the floor, at or after ``speechEnd``,
        for empty text, for a partial identical to the one already prefetched,
        while the provider is under pressure, and when the meter says a real
        turn still needs the unit. A new partial replaces the previous
        speculation.
        """
        text = (partial_text or "").strip()
        if not text or phase is not TurnPhase.SPEAKING:
            return None
        if self._shed is not None:
            # The provider is under pressure: the caller's turn goes first.
            self._record(DropReason.SHED)
            self._count("prefetch_cancelled")
            return None
        if not self._has_headroom():
            self._record(DropReason.SHED)
            self._count("prefetch_cancelled")
            return None
        if self.arbiter is not None and self.arbiter.holds_floor:
            return None
        key = message_key(messages, tools)
        if self._pending is not None:
            if self._pending.key == key and not self._pending.cancelled:
                return None
            self.drop(DropReason.REPLACED)
        self._last_partial = text
        try:
            handle = self.llm.prefetch(messages=list(messages))
        except Exception as exc:
            # Speculation is best effort: a 429 or a dead socket is recorded,
            # never escalated. The real turn is still served.
            _log.info("prefetch unavailable (%s); serving the turn without it", exc)
            self._record(DropReason.FAILED)
            self._count("prefetch_cancelled")
            return None
        ticket = PrefetchTicket(key, text, handle, turn_id)
        self._pending = ticket
        self._count("prefetch_started")
        return ticket

    def adopt(
        self,
        final_text: str,
        *,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        takes_floor: bool,
    ) -> PrefetchTicket | None:
        """Hand the speculation to the reply path, or discard it.

        ``takes_floor`` is the caller's statement that this final is going to
        be answered (the final gate said reply or steer). A suppressed or
        empty final discards instead: there is nothing to warm. The returned
        ticket is the proof of an exact match; the caller still passes the
        final's own messages to ``complete()``.
        """
        ticket = self._pending
        if ticket is None:
            return None
        if not takes_floor:
            self.drop(DropReason.SUPPRESSED)
            return None
        exact = (
            not ticket.cancelled
            and ticket.key == message_key(messages, tools)
            and ticket.partial_text == (final_text or "").strip()
        )
        if not exact:
            self.drop(DropReason.MISMATCH)
            return None
        self._pending = None
        self._count("prefetch_used")
        return ticket

    def drop(self, reason: DropReason = DropReason.CANCELLED) -> bool:
        """Cancel the live speculation; True when there was one."""
        ticket, self._pending = self._pending, None
        if ticket is None:
            return False
        ticket.cancel()
        self._record(reason)
        self._count("prefetch_cancelled")
        return True

    def _has_headroom(self) -> bool:
        """Whether a speculation may take a unit no real turn is waiting for.

        With no meter configured there is nothing to consult. A meter that
        reports no remaining number is not evidence of pressure, so it is never
        read as zero -- the spec's rule is about units the provider said it has.
        """
        if self.budget is None:
            return True
        remaining = self.budget.remaining()
        if remaining is None:
            return True
        waiting = self.budget.real_turns_waiting()
        return remaining > (waiting if waiting > 0 else 0)

    def _record(self, reason: DropReason) -> None:
        self._drops[reason] = self._drops.get(reason, 0) + 1

    def _count(self, name: str) -> None:
        if self.ledger is not None:
            self.ledger.count(name)
