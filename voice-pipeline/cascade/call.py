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
part of the turn layer: the lifecycle speaks the body's greeting through the
opened voice (ticket 77) before the stream starts, so no user audio can be
processed ahead of it.

Nothing unbounded sits in the audio path. The drain, the event-pump stop and
every vendor close read ``deploy.drain_max_wait_ms``; the greeting's synthesis
await reads the settled ``tts.idle_timeout_ms``; and the turn layer's reply
task, stall guard, tool hop and reconnect handshake run through
:meth:`CallLifecycle.run_reply_task`, :meth:`~CallLifecycle.run_stall_guard`,
:meth:`~CallLifecycle.run_tool` and
:meth:`~CallLifecycle.run_reconnect_handshake`, each reading its named bound
from :mod:`cascade.thresholds`. While a bound is open, the wait ends with a
named ``UnsetBoundError`` instead of inventing a number; a timeout is a
recorded :class:`BoundOutcome` and travels on the end message.

The end message carries the facts a reader can act on and never a guess:

* the ledger summary, as the managed path already writes it;
* the call-level provider table (``stt``, ``llm``, ``tts``), with a leg that
  never ran named as ``null`` rather than a fabricated provider;
* the cost, where an unmeasured unit is ``None`` and the total is ``null`` —
  never zero, because zero is a price;
* the eligibility facts, including the predicate and reason of a refusal;
* the greeting's outcome (spoken, or intentionally absent) and every bounded
  wait the call ran with the registry name it read.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from cascade.body_map import BodyFieldError, CascadeBody, adapt_body
from cascade.eligibility import EligibilityDecision
from cascade.envelope import EnvelopeError, verify_envelope
from cascade.greeting import AudioSink, CallGreeting, GreetingOutcome
from cascade.thresholds import ThresholdError, require_bound
from cascade.voice_binding import VoiceBindingError
from metrics import TimingLedger

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
}

#: The drain/close/event wait's bound name (ticket 76 owns the value in
#: ``thresholds.json``; this module never restates it).
DRAIN_BOUND = BOUNDED_WAITS["drain"][0]

#: The three call-level legs, in table order.
LEGS: tuple[str, ...] = ("stt", "llm", "tts")

#: How a call ended: the browser said stop, the socket dropped, the body was
#: refused, or a vendor/stream failure ended it.
ENDED_BY = ("stop", "dropped", "refused", "error")


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


@dataclass(frozen=True)
class AudioFrame:
    """One already-decoded caller audio frame."""

    pcm: bytes


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


# ---------------------------------------------------------------------------
# A refusal, and the end message's four fact groups
# ---------------------------------------------------------------------------


class CallFailure(RuntimeError):
    """A named call-ending failure: no anonymous ``Exception`` on the wire."""

    def __init__(self, *, name: str, stage: str, message: str) -> None:
        self.name = name
        self.stage = stage
        self.message = message
        super().__init__(message)

    @classmethod
    def from_exception(cls, stage: str, error: BaseException) -> "CallFailure":
        """Keep the real exception's name, so a caller can act on it."""
        return cls(name=type(error).__name__, stage=stage, message=str(error))

    def to_document(self) -> dict[str, str]:
        return {"name": self.name, "stage": self.stage, "message": self.message}


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
    """One leg's metered units. ``quantity=None`` means unmeasured, not zero."""

    leg: str
    unit: str
    quantity: float | None
    measured: bool
    source: str = ""

    def __post_init__(self) -> None:
        if self.leg not in LEGS:
            raise ValueError(f"unknown cost leg {self.leg!r}; expected one of {LEGS}")
        if not isinstance(self.unit, str) or not self.unit.strip():
            raise ValueError(f"cost leg {self.leg!r} needs the unit it meters")
        if self.measured:
            if self.quantity is None:
                raise ValueError(
                    f"cost leg {self.leg!r} is measured but carries no quantity"
                )
            if isinstance(self.quantity, bool) or not isinstance(
                self.quantity, (int, float)
            ):
                raise ValueError(
                    f"cost leg {self.leg!r} quantity must be a number, "
                    f"got {self.quantity!r}"
                )
            if self.quantity < 0:
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
        if self.greeting is not None:
            document["greeting"] = self.greeting.to_document()
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
        send_audio: AudioSink | None = None,
        ledger: TimingLedger | None = None,
        clock: Callable[[], float] | None = None,
        envelope_clock: Callable[[], float] = time.time,
        drain_bound_ms: float | None = None,
        bounds: Mapping[str, float] | None = None,
        cost_meter: CostMeter | None = None,
        eligibility: EligibilityDecision | None = None,
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
        self._eligibility = eligibility
        self._event_failure: CallFailure | None = None
        self._verified: CascadeBody | None = None
        self._greeting: GreetingOutcome | None = None

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
            failure = CallFailure.from_exception("open", error)
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

        try:
            self._greeting = await self._speak_greeting(body, opened)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failure = _failure("greeting", error)
            drain = await self._close_all(opened, event_task=None)
            return await self._finish(
                ended_by="error",
                opened=opened,
                error=failure,
                drain=drain,
                eligibility=self._eligibility_document(),
                missing_reason="the call ended before this leg opened",
            )

        try:
            await self._stream.start()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failure = CallFailure.from_exception("stream", error)
            drain = await self._close_all(opened, event_task=None)
            return await self._finish(
                ended_by="error",
                opened=opened,
                error=failure,
                drain=drain,
                eligibility=self._eligibility_document(),
                missing_reason="the call ended before this leg opened",
            )

        event_task = asyncio.ensure_future(self._pump(speech.session))
        ended_by = "dropped"
        failure: CallFailure | None = None
        try:
            while True:
                item = await self._transport.receive()
                if item is None:
                    ended_by = "dropped"
                    break
                if isinstance(item, BrowserStop):
                    ended_by = "stop"
                    break
                if isinstance(item, AudioFrame):
                    self._ledger.mark("audio_in")
                    await speech.session.send_audio(item.pcm)
                elif isinstance(item, ContextUpdate):
                    await self._stream.context(item.text)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            ended_by = "error"
            failure = CallFailure.from_exception("stream", error)

        drain = await self._close_all(opened, event_task=event_task)
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

    async def _speak_greeting(
        self, body: CascadeBody, opened: list[OpenedLeg]
    ) -> GreetingOutcome | None:
        """Say the body's greeting before the turn layer may process any audio.

        A body without a greeting is an intentional silent open and is recorded
        as such. A body with a greeting but no audio sink would open silently,
        so it fails by name instead of dropping the line.
        """
        if not body.has_greeting:
            return GreetingOutcome.silent(
                "the body has no greeting; the call opens silently by design"
            )
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
        greeting = CallGreeting(
            voice=voice, ledger=self._ledger, sink=self._send_audio
        )
        result, outcome = await self.run_bounded(
            "greeting", lambda: greeting.speak(body)
        )
        if not outcome.ok:
            assert outcome.error is not None
            raise outcome.error
        return result

    async def _pump(self, session: Any) -> None:
        """Forward provider events to the turn layer until the stream ends."""
        try:
            async for event in session.events():
                await self._stream.event(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._event_failure = CallFailure.from_exception("event", error)

    async def _close_all(
        self,
        opened: list[OpenedLeg],
        *,
        event_task: asyncio.Future | None,
        drain_stream: bool = True,
    ) -> DrainOutcome:
        """Drain the turn layer, then close every opened leg under the bound.

        ``drain_stream`` is false when the call never reached the turn layer:
        there is nothing to drain, only sockets to unwind.
        """
        failure = (
            await self._bounded("drain", self._stream.drain)
            if drain_stream
            else None
        )
        by_leg = {leg.leg: leg for leg in opened}
        # Stop the event pump before closing the speech session: one reader of
        # the vendor socket at a time, and no read left running after drain.
        if event_task is not None:
            candidate = await self._stop_task(event_task)
            failure = failure or candidate
        speech = by_leg.get("stt")
        if speech is not None:
            closer = _closer(speech.session)
            if closer is not None:
                candidate = await self._bounded("close", closer)
                failure = failure or candidate
        for name in ("tts", "llm"):
            leg = by_leg.get(name)
            if leg is not None:
                closer = _closer(leg.session)
                if closer is not None:
                    candidate = await self._bounded("close", closer)
                    failure = failure or candidate
        return DrainOutcome(failure is None, failure)

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

    def _eligibility_document(self) -> CallEligibility:
        if self._eligibility is None:
            return CallEligibility("cascade")
        return CallEligibility.from_decision(self._eligibility)

    def _cost(self) -> CostSummary:
        """Snapshot the meter; a missing or failed meter is unmeasured."""
        if self._cost_meter is None:
            return CostSummary.unmeasured("no cost meter is wired")
        try:
            return self._cost_meter()
        except Exception as error:
            return CostSummary.unmeasured(
                f"cost meter failed: {type(error).__name__}: {error}"
            )

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


async def _invoke(factory: Callable[[], Any]) -> Any:
    """Call one step and await its result when it is awaitable."""
    result = factory()
    if inspect.isawaitable(result):
        result = await result
    return result


def _failure(stage: str, error: BaseException) -> CallFailure:
    """Keep a named call failure as-is; wrap any other exception with its name."""
    if isinstance(error, CallFailure):
        return error
    return CallFailure.from_exception(stage, error)


def _closer(session: Any) -> Callable[[], Any] | None:
    """A session's ``close`` when it has one; an LLM stream may not."""
    close = getattr(session, "close", None)
    return close if callable(close) else None
