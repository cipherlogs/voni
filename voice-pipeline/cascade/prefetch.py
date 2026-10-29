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
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

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
    _pending: PrefetchTicket | None = field(default=None, init=False)
    _last_partial: str = field(default="", init=False)
    _drops: dict[DropReason, int] = field(default_factory=dict, init=False)

    @property
    def pending(self) -> PrefetchTicket | None:
        """The live speculation, if any."""
        return self._pending

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
        for empty text, and for a partial identical to the one already
        prefetched. A new partial replaces the previous speculation.
        """
        text = (partial_text or "").strip()
        if not text or phase is not TurnPhase.SPEAKING:
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

    def _record(self, reason: DropReason) -> None:
        self._drops[reason] = self._drops.get(reason, 0) + 1

    def _count(self, name: str) -> None:
        if self.ledger is not None:
            self.ledger.count(name)
