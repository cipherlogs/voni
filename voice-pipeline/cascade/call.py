"""The call lifecycle: verify, open, stream, drain, and the end message.

Ticket 75 owns the one order a call may open in. The stored body is verified
*before* anything vendor-facing exists, because a body or a binding the
cascade cannot represent must end the call with a named error while there is
still nothing to unwind. Only then are the speech, voice and (when the caller
passes one) model sessions opened, and only then does the turn layer start.

The browser transport is injected, not imported. :class:`CallTransport` is the
seam ticket 65 implements: ``receive()`` yields an already-decoded
:class:`AudioFrame`, :class:`BrowserStop` or :class:`ContextUpdate`, and returns
``None`` when the socket dropped; ``send()`` takes the one end message;
``close()`` releases the socket. Wire parsing, base64 and protocol versions stay
in the transport, so this module cannot become a second protocol.

:class:`CallStream` is the turn layer's seam: the stream start, each STT
event, a context update, the drain and the turn count. The orchestrator tickets
implement it; this module only orders the call around it. The greeting is not
part of the turn layer: the lifecycle starts the body's greeting through the
opened voice (ticket 77) only after the synthesis session acknowledged
``Begin``, and the opening is a listening window. Caller frames reach STT and
provider events are buffered while the greeting sounds; a ``speechStart`` or a
taking-the-floor partial cuts the greeting with ``Cancel`` (ticket 79) so the
caller's turn wins, and nothing reaches the turn layer before that boundary. A
greeting synthesis failure ends the call with the voice's own trigger on the
end message (ticket 80); there is no silent opening.

Nothing unbounded sits in the audio path. The drain, the event-pump stop and
every vendor close read ``deploy.drain_max_wait_ms``; the greeting's synthesis
await and the second-failure goodbye read the settled ``tts.idle_timeout_ms``;
and the turn layer's reply task, stall guard, tool hop and reconnect handshake
run through :meth:`CallLifecycle.run_reply_task`,
:meth:`~CallLifecycle.run_stall_guard`, :meth:`~CallLifecycle.run_tool` and
:meth:`~CallLifecycle.run_reconnect_handshake`, each reading its named bound
from :mod:`cascade.thresholds`. While a bound is open, the wait ends with a
named ``UnsetBoundError`` instead of inventing a number; a timeout is a
recorded :class:`BoundOutcome` and travels on the end message.

A second failure ends the call cleanly (ticket 99). The turn layer drains its
own turn-level failures and surfaces only the ones that end the call; an
exception escaping the event pump is that seam, so the supervisor stops waiting
for browser input instead of leaving a dead line open. The call drains, speaks
the localized goodbye (``GOODBYE_LINES``) through the voice only when the voice
is healthy — a second voice failure ends with no goodbye, because a dead socket
is never written into — and then sends the one end message. The reconnect
budget is the ticket-94 :class:`~cascade.reconnect.ReconnectBudget` the adapters
use; the call reports it and never counts a failure a second time, and a
planned reconnect is never a failure.

Every frame the call emits has one monotonic ``seq`` that belongs to the call,
not to the TTS ``flush_id`` and not to the provider session (ticket 98).
:class:`CallSequence` never resets, a reconnect advances only the epoch, and
:class:`CallPlayout` is the receiving contract: a frame that is not newer is
dropped, a gap is logged and playback continues, and a duplicate is never
played twice.

The end message carries the facts a reader can act on and never a guess:

* the ledger summary, as the managed path already writes it;
* the call-level provider table (``stt``, ``llm``, ``tts``), with a leg that
  never ran named as ``null`` rather than a fabricated provider;
* the cost, where an unmeasured unit is ``None`` and the total is ``null`` —
  never zero, because zero is a price;
* the eligibility facts, including the predicate and reason of a refusal;
* the reconnect budget's per-leg counters and its reconnect events;
* the greeting's outcome (spoken, or intentionally absent), the second-failure
  goodbye's outcome, and every bounded wait the call ran with the registry name
  it read.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Protocol

from cascade.body_map import BodyFieldError, CascadeBody, adapt_body
from cascade.cost import CallCost, RateTable, cost_call
from cascade.eligibility import EligibilityDecision
from cascade.envelope import EnvelopeError, verify_envelope
from cascade.greeting import CallGreeting, GreetingOutcome, GreetingPlayback
from cascade.meta_stt import SpeechPartial, SpeechStart
from cascade.reconnect import ReconnectBudget
from cascade.thresholds import ThresholdError, require_bound
from cascade.usage import UsageMeter
from cascade.voice_binding import VoiceBindingError, bind_voice
from metrics import TimingLedger
from providers import SentenceAudio
from turns import is_backchannel

_log = logging.getLogger(__name__)

#: Every wait that can outlive a turn, its registry bound and the named
#: outcome a timeout records. The numbers live in ``cascade/thresholds.json``;
#: this table only says which bound a step reads. An unset bound raises
#: ``UnsetBoundError`` by name — no default is substituted here.
BOUNDED_WAITS: dict[str, tuple[str, str]] = {
    "reply_task": ("turn.reply_task_ms", "ReplyTaskTimedOut"),
    "stall_guard": ("turn.stall_guard_ms", "StallGuardTimedOut"),
    "tool": ("tool.timeout_ms", "ToolTimedOut"),
    "drain": ("deploy.drain_max_wait_ms", "DrainTimedOut"),
    "close": ("deploy.drain_max_wait_ms", "DrainTimedOut"),
    "reconnect": ("reconnect.handshake_ms", "ReconnectHandshakeTimedOut"),
    "greeting": ("tts.idle_timeout_ms", "GreetingTimedOut"),
    # A second failure's goodbye is a synthesis request like the greeting, so
    # it reads the same settled synthesis idle bound; no new number is invented.
    "goodbye": ("tts.idle_timeout_ms", "GoodbyeTimedOut"),
}

#: The drain/close/event wait's bound name (ticket 76 owns the value in
#: ``thresholds.json``; this module never restates it).
DRAIN_BOUND = BOUNDED_WAITS["drain"][0]

#: The three call-level legs, in table order.
LEGS: tuple[str, ...] = ("stt", "llm", "tts")

#: How a call ended: the browser said stop, the socket dropped, the body was
#: refused, or a vendor/stream failure ended it.
ENDED_BY = ("stop", "dropped", "refused", "error")

#: The line the caller hears when a second failure ends a call, one per Locale
#: the catalogue can bind (ticket 99). It is the goodbye analogue of the
#: localized hold line (``cascade.tools.HOLD_LINES``): keyed by our Locale code,
#: never a vendor name, and an unknown Locale refuses by name instead of
#: inventing a language. Ticket 105's ceiling goodbye reads this same table.
GOODBYE_LINES: Mapping[str, str] = MappingProxyType(
    {
        "en": "Sorry, I have to end the call here. Goodbye.",
        "es": "Lo siento, tengo que terminar la llamada aquí. Adiós.",
        "fr": "Désolé, je dois mettre fin à l'appel ici. Au revoir.",
        "de": "Entschuldigung, ich muss das Gespräch hier beenden. Auf Wiedersehen.",
        "it": "Mi dispiace, devo terminare la chiamata qui. Arrivederci.",
        "pt": "Desculpe, preciso terminar a chamada aqui. Até logo.",
    }
)


class UnknownGoodbyeLineError(LookupError):
    """No goodbye line exists for this Locale, so nothing may be spoken."""

    def __init__(self, locale_code: str) -> None:
        self.locale_code = locale_code
        known = ", ".join(sorted(GOODBYE_LINES))
        super().__init__(
            f'no goodbye line for Locale "{locale_code}": the catalogue has '
            f"lines for {known}"
        )


def goodbye_line(locale_code: str) -> str:
    """The localized goodbye, or the named reason there is none."""
    line = GOODBYE_LINES.get(locale_code)
    if line is None:
        raise UnknownGoodbyeLineError(locale_code)
    return line


# ---------------------------------------------------------------------------
# The transport and turn-layer seams
# ---------------------------------------------------------------------------


class CallTransport(Protocol):
    """The browser side of one call, already decoded by ticket 65."""

    async def receive(self) -> object | None:
        """The next browser input, or ``None`` when the socket dropped."""

    async def send(self, message: Mapping[str, Any]) -> None:
        """Send the one end message."""

    async def close(self) -> None:
        """Release the socket."""


class CallStream(Protocol):
    """The turn layer's surface for one call."""

    async def start(self) -> None:
        """Begin the turn layer once the opening (the greeting) has been said."""

    async def event(self, event: Any) -> None:
        """One provider event, in arrival order."""

    async def context(self, text: str) -> None:
        """A browser context update for the next reply."""

    async def drain(self) -> None:
        """Finish in-flight work and stop producing."""

    def turn_count(self) -> int:
        """How many logical turns the call produced."""

    def turn_usage(self) -> Mapping[str, Any]:
        """Each logical turn's vendor usage chunk, keyed by logical turn id.

        Ticket 100's meter reads only vendor reports. The turn layer owns the
        model stream, so it is the one that sees the usage chunk; the call
        records it here and prices it. A stream with no model leg returns an
        empty mapping, which leaves the LLM leg unmeasured (never zero).
        """


@dataclass(frozen=True)
class AudioFrame:
    """One already-decoded caller audio frame."""

    pcm: bytes


# ---------------------------------------------------------------------------
# The call-level audio sequence
# ---------------------------------------------------------------------------

#: One audio frame on its way to the browser. ``seq`` is the call's own
#: monotonic number; ``flush_id`` is the TTS request that produced the audio
#: and never stands in for it.
@dataclass(frozen=True)
class OutboundAudio:
    seq: int
    epoch: int
    pcm: bytes
    sample_rate: int
    kind: str = "reply"
    flush_id: int | None = None


#: Where one outbound frame goes: the browser transport ticket 65 implements.
AudioSender = Callable[[OutboundAudio], Awaitable[None]]


@dataclass(frozen=True)
class SequenceGap:
    """The client expected ``expected`` and received ``received``."""

    expected: int
    received: int


@dataclass(frozen=True)
class DroppedFrame:
    """A frame the playout refused because its ``seq`` was not greater."""

    seq: int
    reason: str
    different_bytes: bool = False


class CallSequence:
    """The call's monotonic audio sequence; a reconnect never resets it.

    The counter belongs to the call, so a new provider session (a new
    ``epoch``) continues it. It is deliberately independent of the TTS
    ``flush_id``: the vendor's per-request id repeats after a ``Cancel`` and
    resets with a new session, and the browser must never replay audio because
    one of those ids came back around.
    """

    def __init__(self, *, start: int = 0, epoch: int = 0) -> None:
        if start < 0:
            raise ValueError(f"a call sequence cannot start negative: {start!r}")
        if epoch < 0:
            raise ValueError(f"a session epoch cannot start negative: {epoch!r}")
        self._current = int(start)
        self._epoch = int(epoch)

    @property
    def current(self) -> int:
        """The last sequence number handed out."""
        return self._current

    @property
    def epoch(self) -> int:
        """The current provider session epoch."""
        return self._epoch

    def next(self) -> int:
        """The next call-level sequence number."""
        self._current += 1
        return self._current

    def reconnect(self, *, epoch: int | None = None) -> int:
        """Begin a new session epoch; the sequence continues, never resets."""
        target = self._epoch + 1 if epoch is None else int(epoch)
        if target <= self._epoch:
            raise ValueError(
                f"a reconnect must advance the session epoch past {self._epoch}, "
                f"got {target}"
            )
        self._epoch = target
        return self._epoch

    def frame(
        self,
        *,
        pcm: bytes,
        sample_rate: int,
        kind: str = "reply",
        flush_id: int | None = None,
    ) -> OutboundAudio:
        """One outbound frame: the next call ``seq`` plus the current epoch."""
        return OutboundAudio(
            seq=self.next(),
            epoch=self._epoch,
            pcm=pcm,
            sample_rate=sample_rate,
            kind=kind,
            flush_id=flush_id,
        )


class CallPlayout:
    """The receiving contract: never play a frame that is not newer.

    This is the shape the browser's playout must implement (and the TS client
    mirrors). A frame whose ``seq`` is not greater than the highest played is
    dropped; a gap is recorded and playback continues; a duplicate carrying
    different bytes is dropped and recorded with that fact. The gate is keyed
    on ``seq`` alone, so it works across session epochs.
    """

    def __init__(self) -> None:
        self.played: list[OutboundAudio] = []
        self.gaps: list[SequenceGap] = []
        self.duplicates: list[DroppedFrame] = []
        self._pcm_by_seq: dict[int, bytes] = {}
        self._highest = 0

    @property
    def highest_played(self) -> int:
        return self._highest

    def accept(self, frame: OutboundAudio) -> bool:
        """Play the frame when it is newer, else drop and log it."""
        if frame.seq <= self._highest:
            previous = self._pcm_by_seq.get(frame.seq)
            different = previous is not None and previous != frame.pcm
            self.duplicates.append(
                DroppedFrame(frame.seq, "not greater than the highest played", different)
            )
            _log.warning(
                "dropped duplicate audio frame seq=%s; the highest played is %s%s",
                frame.seq,
                self._highest,
                "; different bytes from the frame already played"
                if different
                else "",
            )
            return False
        if frame.seq > self._highest + 1:
            self.gaps.append(SequenceGap(self._highest + 1, frame.seq))
            _log.warning(
                "audio sequence gap: expected seq %s, received %s; the call "
                "continues",
                self._highest + 1,
                frame.seq,
            )
        self.played.append(frame)
        self._pcm_by_seq[frame.seq] = frame.pcm
        self._highest = frame.seq
        return True


@dataclass(frozen=True)
class BrowserStop:
    """The browser asked the call to end."""


@dataclass(frozen=True)
class ContextUpdate:
    """A browser-supplied context line for the next reply."""

    text: str


class NullStream:
    """A stream that does nothing, for a lifecycle with no turn layer yet."""

    async def start(self) -> None:
        return None

    async def event(self, event: Any) -> None:
        return None

    async def context(self, text: str) -> None:
        return None

    async def drain(self) -> None:
        return None

    def turn_count(self) -> int:
        return 0

    def turn_usage(self) -> Mapping[str, Any]:
        return {}


# ---------------------------------------------------------------------------
# A refusal, and the end message's four fact groups
# ---------------------------------------------------------------------------


class CallFailure(RuntimeError):
    """A named call-ending failure: no anonymous ``Exception`` on the wire.

    ``trigger`` is the provider's own classified verdict (leg, code, class and
    reason) when the failure carries one. A greeting synthesis failure is the
    voice's failure, so the end message names the voice trigger rather than
    reducing it to the exception's type name.
    """

    def __init__(
        self,
        *,
        name: str,
        stage: str,
        message: str,
        trigger: Mapping[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.stage = stage
        self.message = message
        self.trigger = dict(trigger) if trigger is not None else None
        super().__init__(message)

    @classmethod
    def from_exception(cls, stage: str, error: BaseException) -> "CallFailure":
        """Keep the real exception's name and provider verdict, if any."""
        return cls(
            name=type(error).__name__,
            stage=stage,
            message=str(error),
            trigger=_trigger_document(error),
        )

    def to_document(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "name": self.name,
            "stage": self.stage,
            "message": self.message,
        }
        if self.trigger is not None:
            document["trigger"] = self.trigger
        return document


@dataclass(frozen=True)
class CallEligibility:
    """The eligibility facts the end message carries; never a fallback event."""

    disposition: str
    predicates: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.disposition not in ("cascade", "refused"):
            raise ValueError(
                f"unknown eligibility disposition {self.disposition!r}; "
                'expected "cascade" or "refused"'
            )

    @classmethod
    def from_decision(cls, decision: EligibilityDecision) -> "CallEligibility":
        return cls(
            disposition="cascade" if decision.permitted else "refused",
            predicates=decision.predicates,
            reasons=tuple(refusal.reason for refusal in decision.reasons),
        )

    def to_document(self) -> dict[str, Any]:
        return {
            "disposition": self.disposition,
            "predicates": list(self.predicates),
            "reasons": list(self.reasons),
        }


class CallRefused(CallFailure):
    """The body, the binding or the routing said no before any socket opened."""

    def __init__(
        self,
        *,
        name: str,
        stage: str,
        message: str,
        eligibility: CallEligibility | None = None,
    ) -> None:
        super().__init__(name=name, stage=stage, message=message)
        self.eligibility = eligibility or CallEligibility(
            "refused", (stage,), (message,)
        )

    @classmethod
    def from_exception(  # type: ignore[override]
        cls, stage: str, error: BaseException
    ) -> "CallRefused":
        return cls(name=type(error).__name__, stage=stage, message=str(error))


@dataclass(frozen=True)
class OpenedLeg:
    """One vendor leg this call actually opened, and the rung that served it."""

    leg: str
    provider: str
    rung: str
    reason: str
    session: Any = None

    def __post_init__(self) -> None:
        if self.leg not in LEGS:
            raise ValueError(f"unknown call leg {self.leg!r}; expected one of {LEGS}")
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise ValueError(f"leg {self.leg!r} needs the provider that served it")
        if self.rung not in ("primary", "fallback"):
            raise ValueError(
                f"leg {self.leg!r} names rung {self.rung!r}; only a rung that "
                "served is an attribution"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError(f"leg {self.leg!r} needs the reason its rung was chosen")


@dataclass(frozen=True)
class ProviderRow:
    """One leg of the call-level provider table."""

    leg: str
    provider: str | None
    rung: str | None
    reason: str

    def to_document(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "rung": self.rung,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ProviderTable:
    """What actually served each call-level leg; a missing leg is ``null``."""

    rows: tuple[ProviderRow, ...]

    def __post_init__(self) -> None:
        legs = tuple(row.leg for row in self.rows)
        if legs != LEGS:
            raise ValueError(
                f"the call-level provider table must name {LEGS} in order, got {legs}"
            )

    @classmethod
    def from_opened(
        cls,
        opened: tuple[OpenedLeg, ...] | list[OpenedLeg],
        *,
        missing_reason: str,
    ) -> "ProviderTable":
        by_leg = {leg.leg: leg for leg in opened}
        if len(by_leg) != len(opened):
            raise ValueError("a call cannot open the same leg twice")
        return cls(
            tuple(
                (
                    ProviderRow(
                        leg.leg, leg.provider, leg.rung, leg.reason
                    )
                    if (leg := by_leg.get(name)) is not None
                    else ProviderRow(name, None, None, missing_reason)
                )
                for name in LEGS
            )
        )

    def to_document(self) -> dict[str, Any]:
        return {row.leg: row.to_document() for row in self.rows}


@dataclass(frozen=True)
class LegCost:
    """One leg's metered units. ``quantity=None`` means unmeasured, not zero.

    A leg can bill more than one unit (the model's prompt, completion, cached
    and reasoning tokens), so ``units`` carries every reported quantity and
    ``amount_usd`` is what the rate table charged for them. ``unit``/``quantity``
    stay the one-unit shorthand the end message has always carried; a leg with
    several units sets ``unit="multiple"`` and ``quantity=None``.
    """

    leg: str
    unit: str
    quantity: float | None
    measured: bool
    source: str = ""
    #: The priced total for this leg, in USD, when it is measured.
    amount_usd: float | None = None
    #: Every unit the vendor reported for this leg, in artifact order.
    units: tuple[tuple[str, float], ...] = ()

    def __post_init__(self) -> None:
        if self.leg not in LEGS:
            raise ValueError(f"unknown cost leg {self.leg!r}; expected one of {LEGS}")
        if not isinstance(self.unit, str) or not self.unit.strip():
            raise ValueError(f"cost leg {self.leg!r} needs the unit it meters")
        if self.measured:
            if self.quantity is None and not self.units:
                raise ValueError(
                    f"cost leg {self.leg!r} is measured but carries no quantity"
                )
            if self.quantity is not None and (
                isinstance(self.quantity, bool)
                or not isinstance(self.quantity, (int, float))
            ):
                raise ValueError(
                    f"cost leg {self.leg!r} quantity must be a number, "
                    f"got {self.quantity!r}"
                )
            if self.quantity is not None and self.quantity < 0:
                raise ValueError(
                    f"cost leg {self.leg!r} quantity cannot be negative"
                )
        elif self.quantity is not None:
            raise ValueError(
                f"cost leg {self.leg!r} is unmeasured, so its quantity must be "
                "None; an unmeasured unit is never zero"
            )

    def to_document(self) -> dict[str, Any]:
        return {
            "unit": self.unit,
            "quantity": self.quantity,
            "measured": self.measured,
            "source": self.source,
            "amountUsd": self.amount_usd,
            "units": {name: quantity for name, quantity in self.units},
        }


@dataclass(frozen=True)
class CostSummary:
    """The call's cost facts. A partial sum is never presented as complete."""

    rate_table_version: str | None
    legs: tuple[LegCost, ...]
    total_usd: float | None = None
    reason: str = ""

    def __post_init__(self) -> None:
        legs = tuple(leg.leg for leg in self.legs)
        if len(set(legs)) != len(legs):
            raise ValueError("a cost summary cannot price the same leg twice")
        if self.total_usd is not None:
            if self.rate_table_version is None or not all(
                leg.measured for leg in self.legs
            ):
                raise ValueError(
                    "a priced total needs every leg measured and a rate table "
                    "version; an unmeasured unit is never priced"
                )

    @classmethod
    def unmeasured(cls, reason: str) -> "CostSummary":
        """No meter ran: every unit is ``None`` and the total is ``None``."""
        return cls(
            rate_table_version=None,
            legs=tuple(
                LegCost(leg, "unknown", None, False, reason) for leg in LEGS
            ),
            total_usd=None,
            reason=reason,
        )

    @classmethod
    def from_call_cost(cls, priced: CallCost) -> "CostSummary":
        """Carry a priced call's legs and total, and never a partial total.

        The meter recorded what the vendors reported and the rate table priced
        it (tickets 100/101). A leg with one unmeasured unit makes that leg and
        the total unmeasured, with the reason preserved; the rate-table version
        is still cited because it is what the measured legs were priced with.
        """
        legs: list[LegCost] = []
        for priced_leg in priced.legs:
            if priced_leg.measured:
                units = tuple(
                    (_unit_of(line.rate), line.reported) for line in priced_leg.lines
                )
                single = len(units) == 1
                legs.append(
                    LegCost(
                        leg=priced_leg.leg,
                        unit=units[0][0] if single else "multiple",
                        quantity=units[0][1] if single else None,
                        measured=True,
                        source="priced from the vendor's reported units",
                        amount_usd=float(priced_leg.amount),
                        units=units,
                    )
                )
                continue
            legs.append(
                LegCost(
                    leg=priced_leg.leg,
                    unit="unknown",
                    quantity=None,
                    measured=False,
                    source="; ".join(priced_leg.reasons),
                )
            )
        total = priced.amount
        return cls(
            rate_table_version=f"{priced.table.name} v{priced.table.version}",
            legs=tuple(legs),
            total_usd=None if total is None else float(total),
            reason="; ".join(priced.reasons),
        )

    @property
    def measured(self) -> bool:
        """Whether the cost claim is complete: units, version and a total."""
        return (
            bool(self.legs)
            and all(leg.measured for leg in self.legs)
            and self.rate_table_version is not None
            and self.total_usd is not None
        )

    def to_document(self) -> dict[str, Any]:
        return {
            "measured": self.measured,
            "rateTableVersion": self.rate_table_version,
            "totalUsd": self.total_usd if self.measured else None,
            "legs": {leg.leg: leg.to_document() for leg in self.legs},
            "unmeasuredReason": (
                ""
                if self.measured
                else self.reason or "the cost claim is incomplete"
            ),
        }


@dataclass(frozen=True)
class _UnreportedBilling:
    """A synthesis session that closed with no ``Termination`` summary.

    The meter records this as an absence: no characters, no audio or session
    seconds, and a source naming why. It is never a zero.
    """

    characters: int | None = None
    source: str = "no Termination summary was recorded"
    audio_duration_seconds: float | None = None
    session_duration_seconds: int | None = None


@dataclass(frozen=True)
class DrainOutcome:
    """What the end path actually achieved, and the first named failure."""

    ok: bool
    error: CallFailure | None = None

    def to_document(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "error": None if self.error is None else self.error.to_document(),
        }


@dataclass(frozen=True)
class BoundOutcome:
    """One bounded wait's outcome: which bound was read and whether it held.

    A timeout is a recorded, named outcome, never a hang and never an
    anonymous exception. ``bound`` is the registry name, so the end message
    shows the reviewer exactly which number governed the wait.
    """

    stage: str
    bound: str
    ok: bool
    error: CallFailure | None = None

    def to_document(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "bound": self.bound,
            "ok": self.ok,
            "error": None if self.error is None else self.error.to_document(),
        }


@dataclass(frozen=True)
class GoodbyeOutcome:
    """What the second-failure goodbye actually did, on the end message.

    ``spoken=False`` is a recorded decision, not a dropped step: a voice second
    failure has no voice left to speak it, and a closed session is never written
    into. ``reason`` names which of those it was.
    """

    spoken: bool
    reason: str
    text: str = ""
    frames: int = 0
    audio_bytes: int = 0
    sample_rate: int = 0

    def to_document(self) -> dict[str, Any]:
        return {
            "spoken": self.spoken,
            "reason": self.reason,
            "text": self.text,
            "frames": self.frames,
            "audioBytes": self.audio_bytes,
            "sampleRate": self.sample_rate,
        }


@dataclass(frozen=True)
class CallEnd:
    """The one message a finished call sends."""

    call_id: str
    metrics: Mapping[str, Any]
    providers: ProviderTable
    cost: CostSummary
    eligibility: CallEligibility
    turns: int
    ended_by: str
    drain: DrainOutcome
    greeting: GreetingOutcome | None = None
    bounds: tuple[BoundOutcome, ...] = ()
    error: CallFailure | None = None
    goodbye: GoodbyeOutcome | None = None
    reconnects: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.ended_by not in ENDED_BY:
            raise ValueError(
                f"unknown call ending {self.ended_by!r}; expected one of {ENDED_BY}"
            )

    def to_document(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "type": "end",
            "callId": self.call_id,
            "metrics": dict(self.metrics),
            "providers": self.providers.to_document(),
            "cost": self.cost.to_document(),
            "eligibility": self.eligibility.to_document(),
            "turns": self.turns,
            "endedBy": self.ended_by,
            "drain": self.drain.to_document(),
            "bounds": [outcome.to_document() for outcome in self.bounds],
        }
        if self.reconnects is not None:
            document["reconnect"] = dict(self.reconnects)
        if self.greeting is not None:
            document["greeting"] = self.greeting.to_document()
        if self.goodbye is not None:
            document["goodbye"] = self.goodbye.to_document()
        if self.error is not None:
            document["error"] = self.error.to_document()
        return document


# ---------------------------------------------------------------------------
# The lifecycle
# ---------------------------------------------------------------------------

LegFactory = Callable[[CascadeBody], Awaitable[OpenedLeg]]
CostMeter = Callable[[], CostSummary]


class CallLifecycle:
    """One call, from the signed body to the end message.

    The order is fixed: verify the body and its bindings, open speech, voice
    (and the optional model), speak the body's greeting, start the turn layer,
    pump audio and events until a stop or a dropped socket, drain under a named
    bound, then send the end message and close the transport. A refusal at
    verification opens nothing.
    """

    def __init__(
        self,
        *,
        message: Mapping[str, Any],
        secret: str | bytes,
        call_id: str,
        transport: CallTransport,
        open_speech: LegFactory,
        open_voice: LegFactory,
        open_model: LegFactory | None = None,
        stream: CallStream | None = None,
        send_audio: AudioSender | None = None,
        ledger: TimingLedger | None = None,
        clock: Callable[[], float] | None = None,
        envelope_clock: Callable[[], float] = time.time,
        drain_bound_ms: float | None = None,
        bounds: Mapping[str, float] | None = None,
        cost_meter: CostMeter | None = None,
        usage_meter: UsageMeter | None = None,
        cost_table: RateTable | None = None,
        eligibility: EligibilityDecision | None = None,
        chime: Callable[[], None] | None = None,
        reconnect_budget: ReconnectBudget | None = None,
    ) -> None:
        self._message = message
        self._secret = secret
        self._call_id = call_id
        self._transport = transport
        self._open_speech = open_speech
        self._open_voice = open_voice
        self._open_model = open_model
        self._stream: CallStream = stream if stream is not None else NullStream()
        self._send_audio = send_audio
        #: The call-level audio sequence and every frame this call emitted.
        self.sequence = CallSequence()
        self.audio_frames: list[OutboundAudio] = []
        self._clock = clock if clock is not None else time.monotonic
        self._ledger = (
            ledger if ledger is not None else TimingLedger(now=self._clock)
        )
        self._envelope_clock = envelope_clock
        self._drain_bound_ms = drain_bound_ms
        self._bound_overrides: dict[str, float] = {}
        for name, value in (bounds or {}).items():
            if name not in {bound for bound, _ in BOUNDED_WAITS.values()}:
                raise ValueError(
                    f"unknown bound override {name!r}; the bounded waits read "
                    + ", ".join(sorted({bound for bound, _ in BOUNDED_WAITS.values()}))
                )
            self._bound_overrides[name] = float(value)
        if drain_bound_ms is not None:
            self._bound_overrides[DRAIN_BOUND] = float(drain_bound_ms)
        #: Every bounded wait this call ran, in order, with its named outcome.
        self.bound_outcomes: list[BoundOutcome] = []
        self._cost_meter = cost_meter
        # Ticket 100's meter belongs to the call: every vendor frame the call
        # receives is recorded here as it arrives, and the end message prices
        # that record (ticket 101). An injected meter lets a caller observe the
        # units; without one the call still meters, so a real call cannot end
        # with a fabricated zero.
        self.usage_meter = usage_meter if usage_meter is not None else UsageMeter()
        self._cost_table = cost_table
        self._usage_error: str | None = None
        self._eligibility = eligibility
        #: The call's one reconnect ledger (ticket 94). The adapters are given
        #: this same object, so the call never counts a failure a second time;
        #: it only reports the budget and reacts to the decision it produced.
        self.reconnect_budget = (
            reconnect_budget
            if reconnect_budget is not None
            else ReconnectBudget(ledger=self._ledger, now=self._clock)
        )
        self._event_failure: CallFailure | None = None
        self._verified: CascadeBody | None = None
        self._greeting: GreetingOutcome | None = None
        self._goodbye: GoodbyeOutcome | None = None
        # The connected chime's trigger (ticket 78): the client's earcon fires
        # when the greeting's first audible sample reaches it. The call records
        # the trigger and passes it on; it never schedules or waits for it.
        self._chime = chime
        self.chime_calls = 0
        self.chime_at: float | None = None

    # -- verification -----------------------------------------------------

    def verify(self) -> CascadeBody:
        """Verify the signed body and its bindings; no socket exists yet."""
        try:
            verified = verify_envelope(
                self._message,
                secret=self._secret,
                call_id=self._call_id,
                clock=self._envelope_clock,
            )
        except EnvelopeError as error:
            raise CallRefused.from_exception("envelope", error) from error

        # The body and its binding are checked first, so a voice that cannot be
        # bound is named as the binding failure rather than as a routing fact.
        try:
            body = adapt_body(verified.body)
        except VoiceBindingError as error:
            raise CallRefused.from_exception("binding", error) from error
        except BodyFieldError as error:
            raise CallRefused.from_exception("body", error) from error

        if self._eligibility is not None and not self._eligibility.permitted:
            raise CallRefused(
                name="EligibilityRefused",
                stage="eligibility",
                message=self._eligibility.reason,
                eligibility=CallEligibility.from_decision(self._eligibility),
            )
        self._verified = body
        return body

    # -- the call ---------------------------------------------------------

    async def run(self) -> CallEnd:
        """Run one call to its end message."""
        try:
            body = self.verify()
        except CallRefused as refusal:
            return await self._finish(
                ended_by="refused",
                opened=(),
                error=refusal,
                drain=DrainOutcome(True),
                eligibility=refusal.eligibility,
                missing_reason=(
                    "the call was refused before any vendor socket opened"
                ),
            )

        opened: list[OpenedLeg] = []
        try:
            speech = await self._open(self._open_speech, body, "stt", opened)
            await self._open(self._open_voice, body, "tts", opened)
            if self._open_model is not None:
                await self._open(self._open_model, body, "llm", opened)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return await self._abort_before_stream(
                opened, CallFailure.from_exception("open", error)
            )

        try:
            greeting = self._start_greeting(body, opened)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return await self._abort_before_stream(opened, _failure("greeting", error))

        # The opening is a window, not a pause: the caller's frames reach STT
        # and the provider's events are read while the greeting sounds, so an
        # interruption is heard at the same moment it happens. Nothing reaches
        # the turn layer until the greeting has finished or been cut; the
        # buffer below is replayed in arrival order at that boundary.
        buffered_events: list[Any] = []
        buffered_contexts: list[str] = []
        barge = asyncio.Event()
        barge_causes: list[str] = []
        stop_reasons: list[str] = []
        delivery_lock = asyncio.Lock()
        streaming = False
        stream_started = False
        stream_failure: CallFailure | None = None
        # One leg failure that ends the call (a spent reconnect, a bug, a
        # dropped socket's final close) sets this: the supervisor stops waiting
        # for browser input instead of leaving a dead line open. It is the only
        # way a call ends without the browser asking (ticket 99).
        failure_event = asyncio.Event()

        async def deliver(event: Any) -> None:
            async with delivery_lock:
                if streaming:
                    await self._stream.event(event)
                else:
                    buffered_events.append(event)

        async def pump() -> None:
            try:
                async for event in speech.session.events():
                    if (
                        greeting is not None
                        and not greeting.done
                        and not barge.is_set()
                    ):
                        cause = _greeting_barge_cause(event)
                        if cause is not None:
                            barge_causes.append(cause)
                            barge.set()
                    await deliver(event)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # An exception escaping the turn layer is a call-ending leg
                # failure, never a hang: the turn layer drains its own
                # turn-level failures (a turn bug, an interrupted reply) and
                # surfaces only the ones that end the call.
                self._event_failure = _leg_failure(error)
                stop_reasons.append("error")
                failure_event.set()

        async def receive() -> None:
            nonlocal stream_failure
            try:
                while True:
                    item = await self._transport.receive()
                    if item is None:
                        stop_reasons.append("dropped")
                        return
                    if isinstance(item, BrowserStop):
                        stop_reasons.append("stop")
                        return
                    if isinstance(item, AudioFrame):
                        self._ledger.mark("audio_in")
                        await speech.session.send_audio(item.pcm)
                    elif isinstance(item, ContextUpdate):
                        if streaming:
                            await self._stream.context(item.text)
                        else:
                            buffered_contexts.append(item.text)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                stream_failure = CallFailure.from_exception("stream", error)
                stop_reasons.append("error")

        greeting_task = greeting.task if greeting is not None else None
        greeting_gate = (
            asyncio.ensure_future(self.run_bounded("greeting", lambda: greeting_task))
            if greeting_task is not None
            else None
        )
        event_task = asyncio.ensure_future(pump())
        receive_task = asyncio.ensure_future(receive())
        barge_task = asyncio.ensure_future(barge.wait())
        failure_task = asyncio.ensure_future(failure_event.wait())

        ended_by = "dropped"
        failure: CallFailure | None = None
        stage = "greeting"
        try:
            boundary = [
                task
                for task in (
                    greeting_task,
                    greeting_gate,
                    receive_task,
                    barge_task,
                    failure_task,
                )
                if task is not None
            ]
            while not (
                barge.is_set()
                or failure_event.is_set()
                or receive_task.done()
                or (greeting_gate is not None and greeting_gate.done())
                or (greeting_task is not None and greeting_task.done())
            ):
                pending = [task for task in boundary if not task.done()]
                if not pending:
                    break
                await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)

            browser_ended_first = (
                greeting is not None
                and receive_task.done()
                and not barge.is_set()
                and not failure_event.is_set()
                and not (greeting_gate is not None and greeting_gate.done())
                and not (greeting_task is not None and greeting_task.done())
            )
            if browser_ended_first:
                # The socket went away mid-opening. If the greeting has not
                # sounded at all, its own named bound still decides: a stop
                # must not be what hides a line that was never flushed.
                if greeting is not None and greeting.frames == 0:
                    assert greeting_gate is not None
                    result, outcome = await greeting_gate
                    if not outcome.ok:
                        assert outcome.error is not None
                        raise outcome.error
                    self._greeting = result
                else:
                    if greeting is not None:
                        await greeting.stop()
                    ended_by = stop_reasons[0] if stop_reasons else "dropped"
            else:
                if greeting is not None:
                    if barge.is_set() and not greeting.done:
                        self._greeting = await greeting.cancel(barge_causes[0])
                        await asyncio.gather(greeting_task, return_exceptions=True)
                    elif greeting_gate is not None:
                        result, outcome = await greeting_gate
                        if not outcome.ok:
                            assert outcome.error is not None
                            raise outcome.error
                        self._greeting = result
                    else:
                        self._greeting = await greeting_task
                if failure_event.is_set():
                    # The leg failed while the greeting sounded: the call is
                    # already over, so the turn layer is never started.
                    ended_by = "error"
                    failure = self._event_failure
                else:
                    stage = "stream"
                    await self._stream.start()
                    stream_started = True
                    async with delivery_lock:
                        for event in buffered_events:
                            await self._stream.event(event)
                        buffered_events.clear()
                        for text in buffered_contexts:
                            await self._stream.context(text)
                        buffered_contexts.clear()
                        streaming = True
                    stage = "call"
                    if not failure_event.is_set():
                        await asyncio.wait(
                            (receive_task, failure_task),
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    if failure_event.is_set():
                        # A leg failure ended the call: do not wait for the
                        # caller to hang up a line that is already dead.
                        ended_by = "error"
                        failure = self._event_failure
                    else:
                        await receive_task
                        ended_by = stop_reasons[0] if stop_reasons else "dropped"
                        if stream_failure is not None:
                            ended_by = "error"
                            failure = stream_failure
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failure = _failure(stage, error)
            ended_by = "error"

        for task in (barge_task, greeting_gate, failure_task):
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *[
                task
                for task in (barge_task, greeting_gate, failure_task)
                if task is not None
            ],
            return_exceptions=True,
        )
        drain = await self._close_all(
            opened,
            event_task=event_task,
            receive_task=receive_task,
            drain_stream=stream_started,
            failure=failure,
        )
        if self._event_failure is not None:
            if failure is None:
                failure = self._event_failure
                ended_by = "error"
                if drain.ok:
                    drain = DrainOutcome(False, self._event_failure)
        return await self._finish(
            ended_by=ended_by,
            opened=opened,
            error=failure,
            drain=drain,
            eligibility=self._eligibility_document(),
            missing_reason="not opened at connect",
        )

    # -- streaming and drain ----------------------------------------------

    async def emit_audio(
        self,
        audio: SentenceAudio,
        *,
        kind: str = "reply",
        flush_id: int | None = None,
    ) -> OutboundAudio:
        """Put one synthesized frame on the wire with the next call-level seq.

        The turn layer and the greeting both come through here, so no audio
        path can emit a frame without a sequence and none can restart the
        counter.
        """
        outbound = self.sequence.frame(
            pcm=audio.pcm,
            sample_rate=audio.sample_rate,
            kind=kind,
            flush_id=flush_id,
        )
        self.audio_frames.append(outbound)
        if self._send_audio is not None:
            await self._send_audio(outbound)
        return outbound

    def session_reconnected(self, *, epoch: int | None = None) -> int:
        """A provider leg opened a new session; the call seq keeps going.

        A planned reconnect (the speech session's 60-minute limit, the voice
        session's expiry, our own rotation) is recorded by the adapter that owns
        the leg, in the ticket-94 budget's planned bucket — never here, so the
        call can never count a planned reconnect twice or mistake it for a
        failure (ticket 99). The call only advances its own session epoch.
        """
        return self.sequence.reconnect(epoch=epoch)

    def _start_greeting(
        self, body: CascadeBody, opened: list[OpenedLeg]
    ) -> GreetingPlayback | None:
        """Start the body's greeting before the turn layer processes any audio.

        A body without a greeting is an intentional silent open and is recorded
        as such. A body with a greeting but no audio sink would open silently,
        so it fails by name instead of dropping the line. The returned playback
        runs under the greeting's named bound (``tts.idle_timeout_ms``) and can
        be cut with the synthesis session's ``Cancel`` (ticket 79).
        """
        if not body.has_greeting:
            self._greeting = GreetingOutcome.silent(
                "the body has no greeting; the call opens silently by design"
            )
            return None
        if self._send_audio is None:
            raise CallFailure(
                name="NoAudioSink",
                stage="greeting",
                message=(
                    "the body has a greeting but no audio sink is wired, so the "
                    "call would open silently"
                ),
            )
        voice = next(
            (leg.session for leg in opened if leg.leg == "tts"), None
        )

        async def greeting_audio(audio: SentenceAudio) -> None:
            await self.emit_audio(audio, kind="greeting")

        greeting = CallGreeting(
            voice=voice,
            ledger=self._ledger,
            sink=greeting_audio,
            chime=self._connected_chime,
        )
        return greeting.start(body)

    def _connected_chime(self) -> None:
        """The greeting's first audible sample: fire the connected chime once."""
        self.chime_calls += 1
        self.chime_at = self._clock()
        if self._chime is not None:
            self._chime()

    async def _close_all(
        self,
        opened: list[OpenedLeg],
        *,
        event_task: asyncio.Future | None,
        receive_task: asyncio.Future | None = None,
        drain_stream: bool = True,
        failure: CallFailure | None = None,
    ) -> DrainOutcome:
        """Drain the turn layer, say the failure goodbye, then close every leg.

        ``drain_stream`` is false when the call never reached the turn layer:
        there is nothing to drain, only sockets to unwind. The goodbye is
        spoken only for a call-ending leg failure and only through a voice that
        is still open (ticket 99); a voice second failure ends with no goodbye
        because there is no voice left to speak it.
        """
        failure_outcome = (
            await self._bounded("drain", self._stream.drain)
            if drain_stream
            else None
        )
        by_leg = {leg.leg: leg for leg in opened}
        # Stop the browser reader and the event pump before closing the speech
        # session: one reader of the vendor socket at a time, and no read left
        # running after drain.
        for task in (receive_task, event_task):
            if task is not None:
                candidate = await self._stop_task(task)
                failure_outcome = failure_outcome or candidate
        speech = by_leg.get("stt")
        if speech is not None:
            closer = _closer(speech.session)
            if closer is not None:
                candidate = await self._bounded("close", closer)
                failure_outcome = failure_outcome or candidate
        # The voice is still open here, and only here: the goodbye is spoken
        # after the reply has drained and before the synthesis socket is closed.
        # A call that never got past the opening has no second failure to say
        # goodbye to, and its greeting failure is already named on the message.
        if failure is not None and failure.stage != "greeting":
            try:
                await self._speak_goodbye(by_leg.get("tts"), failure)
            except Exception as error:  # the end message must still go out
                self._goodbye = GoodbyeOutcome(
                    spoken=False,
                    reason=(
                        "the goodbye path failed before it could speak: "
                        f"{type(error).__name__}: {error}"
                    ),
                )
        for name in ("tts", "llm"):
            leg = by_leg.get(name)
            if leg is not None:
                closer = _closer(leg.session)
                if closer is not None:
                    candidate = await self._bounded("close", closer)
                    failure_outcome = failure_outcome or candidate
        return DrainOutcome(failure_outcome is None, failure_outcome)

    async def _speak_goodbye(
        self, voice_leg: OpenedLeg | None, failure: CallFailure
    ) -> GoodbyeOutcome | None:
        """Speak the localized goodbye for a second failure, or record why not.

        Four facts decide, in this order, and each refusal is named on the end
        message rather than dropped: the failure must be a leg failure; the
        failing leg must not be the voice; a voice session must have opened;
        and that session must not already be closed. The attempt is bounded by
        ``tts.idle_timeout_ms`` and a synthesis error is recorded, never raised:
        the call is already ending and the end message must still go out.
        """
        outcome = self._goodbye_decision(voice_leg, failure)
        if outcome is not None:
            self._goodbye = outcome
            return outcome

        assert voice_leg is not None and voice_leg.session is not None
        voice = voice_leg.session
        body = self._verified
        assert body is not None
        try:
            text = goodbye_line(bind_voice(body.voice_id).locale.code)
        except (VoiceBindingError, UnknownGoodbyeLineError) as error:
            self._goodbye = GoodbyeOutcome(
                spoken=False, reason=f"the goodbye cannot be localized: {error}"
            )
            return self._goodbye

        async def speak() -> GoodbyeOutcome:
            frames = 0
            audio_bytes = 0
            sample_rate = 0
            speak_text = getattr(voice, "speak", None)
            if not callable(speak_text):
                raise CallFailure(
                    name="GoodbyeUnavailable",
                    stage="goodbye",
                    message=(
                        f'the opened voice has no speak path, so the localized '
                        f"goodbye {text!r} cannot be spoken"
                    ),
                )
            async for audio in speak_text(text):
                frames += 1
                audio_bytes += len(audio.pcm)
                sample_rate = audio.sample_rate
                await self.emit_audio(audio, kind="goodbye")
            return GoodbyeOutcome(
                spoken=frames > 0,
                reason=(
                    "spoken after the second failure"
                    if frames > 0
                    else "the synthesis path produced no audio"
                ),
                text=text,
                frames=frames,
                audio_bytes=audio_bytes,
                sample_rate=sample_rate,
            )

        result, bound = await self.run_bounded("goodbye", speak)
        if not bound.ok or result is None:
            assert bound.error is not None
            self._goodbye = GoodbyeOutcome(
                spoken=False,
                reason=(
                    f"the goodbye did not finish ({bound.bound}): "
                    f"{bound.error.name}: {bound.error.message}"
                ),
                text=text,
            )
            return self._goodbye
        self._goodbye = result
        return result

    def _goodbye_decision(
        self, voice_leg: OpenedLeg | None, failure: CallFailure
    ) -> GoodbyeOutcome | None:
        """``None`` means speak it; an outcome means it is refused, by name."""
        trigger = failure.trigger or {}
        leg = trigger.get("leg")
        if leg is None:
            return GoodbyeOutcome(
                spoken=False,
                reason=(
                    "the call did not end on a leg failure, so there is no "
                    "second-failure goodbye to speak"
                ),
            )
        if leg == "tts":
            return GoodbyeOutcome(
                spoken=False,
                reason=(
                    "the voice leg is the failure; there is no voice left to "
                    "speak a goodbye through, and a dead socket is never written "
                    "into"
                ),
            )
        if voice_leg is None or voice_leg.session is None:
            return GoodbyeOutcome(
                spoken=False,
                reason="the voice leg never opened, so there is no voice to speak it",
            )
        if _voice_closed(voice_leg.session):
            return GoodbyeOutcome(
                spoken=False,
                reason=(
                    "the voice session is already closed, so the goodbye is not "
                    "written into a dead socket"
                ),
            )
        return None

    # -- bounds -----------------------------------------------------------

    def _bound_for(
        self, stage: str
    ) -> tuple[float | None, str, CallFailure | None]:
        """The named bound in seconds, or the named reason it is unavailable."""
        try:
            name = BOUNDED_WAITS[stage][0]
        except KeyError:
            raise ValueError(
                f"unknown bounded wait stage {stage!r}; declared: "
                + ", ".join(sorted(BOUNDED_WAITS))
            ) from None
        value: float
        if name in self._bound_overrides:
            value = self._bound_overrides[name]
        else:
            try:
                value = float(require_bound(name))
            except ThresholdError as error:
                return None, name, _failure(stage, error)
            except (TypeError, ValueError) as error:
                return None, name, CallFailure(
                    name="InvalidBound",
                    stage=stage,
                    message=(
                        f"bound {name!r} is not a number: "
                        f"{type(error).__name__}: {error}"
                    ),
                )
        if value <= 0:
            return None, name, CallFailure(
                name="InvalidBound",
                stage=stage,
                message=(
                    f"bound {name!r} must be positive, got {value!r} ms; "
                    "a zero or negative bound is not a bound"
                ),
            )
        return value / 1000.0, name, None

    def _record(self, outcome: BoundOutcome) -> BoundOutcome:
        self.bound_outcomes.append(outcome)
        return outcome

    async def run_bounded(
        self, stage: str, factory: Callable[[], Any]
    ) -> tuple[Any, BoundOutcome]:
        """Await one step under its named bound; a timeout is a named outcome.

        ``factory`` may return a coroutine or a plain value. The bound is read
        from :mod:`cascade.thresholds` (or an injected test value), never from
        a literal here, and an unset bound ends the wait with
        ``UnsetBoundError`` rather than an invented number.
        """
        seconds, name, unavailable = self._bound_for(stage)
        if unavailable is not None:
            return None, self._record(BoundOutcome(stage, name, False, unavailable))
        assert seconds is not None
        try:
            result = await asyncio.wait_for(_invoke(factory), timeout=seconds)
        except asyncio.TimeoutError:
            failure = CallFailure(
                name=BOUNDED_WAITS[stage][1],
                stage=stage,
                message=(
                    f"{stage} did not finish within {seconds * 1000:g} ms "
                    f"({name}); the call moved on instead of hanging"
                ),
            )
            return None, self._record(BoundOutcome(stage, name, False, failure))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return None, self._record(
                BoundOutcome(stage, name, False, _failure(stage, error))
            )
        return result, self._record(BoundOutcome(stage, name, True))

    async def run_reply_task(self, factory: Callable[[], Any]):
        """The reply task's bounded await (``turn.reply_task_ms``)."""
        return await self.run_bounded("reply_task", factory)

    async def run_stall_guard(self, factory: Callable[[], Any]):
        """The reply-ordering stall guard's bounded await."""
        return await self.run_bounded("stall_guard", factory)

    async def run_tool(self, factory: Callable[[], Any]):
        """One tool hop's bounded await (``tool.timeout_ms``)."""
        return await self.run_bounded("tool", factory)

    async def run_reconnect_handshake(self, factory: Callable[[], Any]):
        """A reconnect handshake's bounded await (``reconnect.handshake_ms``)."""
        return await self.run_bounded("reconnect", factory)

    async def _bounded(
        self, stage: str, factory: Callable[[], Any]
    ) -> CallFailure | None:
        """Await one end-path step under the named bound; never hang."""
        _, outcome = await self.run_bounded(stage, factory)
        return None if outcome.ok else outcome.error

    async def _stop_task(self, task: asyncio.Future) -> CallFailure | None:
        """Cancel the event pump and wait for its cancellation under the bound.

        The pump and the speech session both read the vendor socket; stopping
        the pump first keeps a single reader. ``return_exceptions=True`` treats
        the task's own cancellation as success, not as a call failure.
        """
        if not task.done():
            task.cancel()
        _, outcome = await self.run_bounded(
            "close", lambda: asyncio.gather(task, return_exceptions=True)
        )
        return None if outcome.ok else outcome.error

    # -- opening ----------------------------------------------------------

    async def _open(
        self,
        factory: LegFactory,
        body: CascadeBody,
        leg: str,
        opened: list[OpenedLeg],
    ) -> OpenedLeg:
        """Build and open one leg; a failed open leaves the earlier ones listed."""
        result = await factory(body)
        if not isinstance(result, OpenedLeg):
            raise TypeError(
                f"the {leg} opener must return an OpenedLeg, got {result!r}"
            )
        if result.leg != leg:
            raise ValueError(
                f"the {leg} opener returned a {result.leg!r} leg; a factory "
                "cannot open another leg"
            )
        opened.append(result)
        return result

    # -- the end message --------------------------------------------------

    async def _abort_before_stream(
        self, opened: list[OpenedLeg], failure: CallFailure
    ) -> CallEnd:
        """Unwind a call that never reached the turn layer and end it by name.

        Opening a leg or starting the greeting can fail before the turn layer
        exists: there is nothing to drain, only sockets to close, so the same
        path serves both failures instead of a second copy.
        """
        drain = await self._close_all(
            opened, event_task=None, drain_stream=False
        )
        return await self._finish(
            ended_by="error",
            opened=opened,
            error=failure,
            drain=drain,
            eligibility=self._eligibility_document(),
            missing_reason="the call ended before this leg opened",
        )

    def _eligibility_document(self) -> CallEligibility:
        if self._eligibility is None:
            return CallEligibility("cascade")
        return CallEligibility.from_decision(self._eligibility)

    def _record_usage(self, opened: list[OpenedLeg]) -> None:
        """Record the vendor-reported units this call actually received.

        Nothing here estimates. Speech contributes its usage frame when the
        adapter recorded one; synthesis contributes the ``Termination`` billing
        the session closed with; the model's token units come from the turn
        layer, which is the only reader of the usage chunk. A leg that reported
        nothing records an absence, so the cost stays unmeasured by name.
        """
        try:
            by_leg = {leg.leg: leg for leg in opened}
            speech = by_leg.get("stt")
            if speech is not None:
                usage = getattr(speech.session, "usage", None)
                self.usage_meter.record_stt(
                    usage if isinstance(usage, Mapping) else None
                )
            voice = by_leg.get("tts")
            if voice is not None:
                billing = getattr(voice.session, "billing", None)
                self.usage_meter.record_tts(
                    billing if billing is not None else _UnreportedBilling()
                )
            reader = getattr(self._stream, "turn_usage", None)
            if callable(reader):
                for turn, usage in (reader() or {}).items():
                    self.usage_meter.record_llm(turn, usage)
        except Exception as error:  # the end message must still go out
            self._usage_error = (
                f"usage meter failed: {type(error).__name__}: {error}"
            )

    def _cost(self) -> CostSummary:
        """Price the meter's recorded units; a gap is unmeasured, never zero."""
        if self._usage_error is not None:
            return CostSummary.unmeasured(self._usage_error)
        if self._cost_meter is not None:
            try:
                return self._cost_meter()
            except Exception as error:
                return CostSummary.unmeasured(
                    f"cost meter failed: {type(error).__name__}: {error}"
                )
        try:
            priced = cost_call(
                self.usage_meter.usage(), table=self._cost_table
            )
        except Exception as error:
            return CostSummary.unmeasured(
                f"the cost cannot be priced: {type(error).__name__}: {error}"
            )
        return CostSummary.from_call_cost(priced)

    def _turns(self) -> int:
        try:
            return int(self._stream.turn_count())
        except Exception:
            return 0

    async def _finish(
        self,
        *,
        ended_by: str,
        opened: list[OpenedLeg],
        error: CallFailure | None,
        drain: DrainOutcome,
        eligibility: CallEligibility,
        missing_reason: str,
    ) -> CallEnd:
        """Build the end message, send it, then release the socket."""
        self._record_usage(opened)
        end = CallEnd(
            call_id=self._call_id,
            metrics=self._ledger.summary(),
            providers=ProviderTable.from_opened(
                opened, missing_reason=missing_reason
            ),
            cost=self._cost(),
            eligibility=eligibility,
            turns=self._turns(),
            ended_by=ended_by,
            drain=drain,
            greeting=self._greeting,
            bounds=tuple(self.bound_outcomes),
            error=error,
            goodbye=self._goodbye,
            reconnects=self.reconnect_budget.to_document(),
        )
        try:
            await self._transport.send(end.to_document())
        except Exception:
            # The socket may already be gone; the call is over either way.
            pass
        try:
            await self._transport.close()
        except Exception:
            pass
        return end


def _unit_of(rate_key: str) -> str:
    """The unit part of a ``<leg>.<unit>`` rate key."""
    leg, _, unit = rate_key.partition(".")
    return unit or leg


def _greeting_barge_cause(event: Any) -> str | None:
    """Why one provider event takes the floor away from a sounding greeting.

    A ``speechStart`` is enough during the opening: the caller has begun a real
    turn over the agent's first line, and the greeting has no establishment
    window to protect. A partial also takes the floor unless every word is
    filler (``mm-hmm`` is a backchannel, not an interruption).
    """
    if isinstance(event, SpeechStart):
        return "speech_start"
    if isinstance(event, SpeechPartial):
        text = getattr(event, "text", "") or ""
        if text.strip() and not is_backchannel(text):
            return "partial"
    return None


async def _invoke(factory: Callable[[], Any]) -> Any:
    """Call one step and await its result when it is awaitable."""
    result = factory()
    if inspect.isawaitable(result):
        result = await result
    return result


def _trigger_document(error: BaseException) -> dict[str, Any] | None:
    """A provider verdict as the end message's trigger, or ``None``.

    A synthesis/speech adapter puts its verdict on the exception; a model
    failure keeps it on its recorded decision. Both are read, so the end
    message always names the failure leg and the reason (ticket 99).
    """
    verdict = getattr(error, "verdict", None)
    if verdict is None:
        verdict = getattr(getattr(error, "decision", None), "verdict", None)
    if verdict is None:
        return None
    leg = getattr(verdict, "leg", None)
    failure_class = getattr(verdict, "failure_class", None)
    if leg is None or failure_class is None:
        return None
    return {
        "leg": leg,
        "code": getattr(verdict, "code", None),
        "class": getattr(failure_class, "value", str(failure_class)),
        "reason": getattr(verdict, "reason", ""),
    }


def _leg_failure(error: BaseException) -> CallFailure:
    """A failure that escaped the turn layer, named as the call-ending leg it is.

    A leg failure carries its provider verdict, so the end message names the leg
    and the reason. Anything else keeps its own exception name: it is still a
    call-ending failure, but not a provider's.
    """
    trigger = _trigger_document(error)
    if trigger is None:
        return CallFailure.from_exception("call", error)
    return CallFailure(
        name="LegFailure",
        stage="call",
        message=(
            f"the {trigger['leg']} leg's failure ends the call "
            f"({trigger['class']}, code {trigger['code']!r}): "
            f"{trigger['reason']}"
        ),
        trigger=trigger,
    )


def _voice_closed(voice: Any) -> bool:
    """Whether the opened voice is already closed, when it says so.

    The synthesis session exposes no health call, so this checks the states an
    adapter or a fake can report; an adapter that reports none is assumed open
    (the leg rule above already refuses a voice that is the failure).
    """
    for name, closed in (("closed", True), ("dead", True), ("is_open", False)):
        value = getattr(voice, name, None)
        if isinstance(value, bool) and value is closed:
            return True
    return False



def _failure(stage: str, error: BaseException) -> CallFailure:
    """Keep a named call failure as-is; wrap any other exception with its name."""
    if isinstance(error, CallFailure):
        return error
    return CallFailure.from_exception(stage, error)


def _closer(session: Any) -> Callable[[], Any] | None:
    """A session's ``close`` when it has one; an LLM stream may not."""
    close = getattr(session, "close", None)
    return close if callable(close) else None
