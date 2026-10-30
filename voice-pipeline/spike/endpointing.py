"""Terms 1 and 2 of the M00 spike: endpointing and the post-processing gap.

Both terms are wall-clock gaps, and both are measured per Meta ``turnId`` over
the ticket 09 caller fixture streamed by the ticket 09 real-time pacer into an
injectable Meta STT transport. Nothing here opens a socket: the live transport
is supplied by the runner, so the whole measurement is replayable offline.

**Endpointing** is the gap between the last speech sample of the WAV and the
``speechEnd`` event. The last speech sample is not the stream's end and not the
stream's start: the pacer stamps every chunk with ``sent_at_s``, so the sample's
delivery instant is that stamp plus its offset into the chunk. The term is
cross-checked against the vendor's own clock, ``speechEnd.audioProcessedMs``
minus the fixture's known speech-end position. The two numbers are computed
independently and both survive: when they disagree the report says so and
carries both, because an average would hide which of them is wrong.

**The post-processing gap** is the gap between ``speechEnd`` and
``speechComplete`` for the same ``turnId``. It is the term the vendor does not
document. A turn that never receives a ``speechComplete`` is *unmeasured* — a
missing event is not a zero gap, and the producer line says which event is
missing instead of printing a number.

Every term carries its producer line. A live run that cannot execute (no key,
no transport) returns the terms as unmeasured with the reason, never a number.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Protocol

from . import fixture
from .pacer import CHUNK_MS, Blocked, Pacer, Send

#: The two M00 terms this module owns.
ENDPOINTING_TERM = "endpointing_ms"
POST_PROCESSING_TERM = "post_processing_ms"

#: The line a reviewer can trace each number back to.
ENDPOINTING_PRODUCER = (
    "spike.endpointing: Meta STT speechEnd.received_at minus spike.pacer sent_at "
    "of the fixture's last speech sample; cross-checked against "
    "speechEnd.audioProcessedMs minus spike.fixture speech_end_ms"
)
POST_PROCESSING_PRODUCER = (
    "spike.endpointing: Meta STT speechComplete.received_at minus "
    "speechEnd.received_at for the same turnId"
)

#: The two measurements cannot agree more finely than the chunk that carried the
#: last speech sample: the wall clock stamps chunk delivery, so the run's pacer
#: chunk is the timing quantum of the comparison, not a latency budget. The
#: default is the offline pacer's chunk; the live runner passes its own.
AGREEMENT_TOLERANCE_MS = float(CHUNK_MS)

META_KEY_ENV = "META_API_KEY"

SPEECH_START = "speechStart"
TRANSCRIPT = "transcript"
SPEECH_END = "speechEnd"
SPEECH_COMPLETE = "speechComplete"
ERROR = "error"

KNOWN_EVENTS = frozenset({SPEECH_START, TRANSCRIPT, SPEECH_END, SPEECH_COMPLETE, ERROR})


class SttStreamError(RuntimeError):
    """The vendor reported an ``error`` event; no term may be invented after it."""


@dataclass(frozen=True)
class SttEvent:
    """One Meta STT event, stamped with its wall-clock arrival.

    ``received_at_s`` is the transport's clock reading when the frame arrived,
    never the time the measurement loop got around to it.
    """

    kind: str
    received_at_s: float
    turn_id: str | None = None
    audio_processed_ms: float | None = None
    text: str | None = None


class MetaSttTransport(Protocol):
    """The seam that keeps the spike offline-replayable.

    ``poll`` returns the events received since the previous call and may block
    until the first one arrives (a live socket read); it must never busy-spin.
    ``drain`` reads through the vendor's close, so a pending ``speechComplete``
    that arrives after the caller's audio ends is still collected.
    """

    def open(self) -> None: ...

    def send_audio(self, chunk: bytes) -> None: ...

    def audio_processed_s(self) -> float:
        """The vendor's processed position in seconds, for the pacer's lead cap."""

    def poll(self) -> tuple[SttEvent, ...]: ...

    def end_stream(self) -> None: ...

    def drain(self) -> tuple[SttEvent, ...]: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class CrossCheck:
    """The vendor-clock counterpart of the endpointing term, kept side by side."""

    wall_ms: float
    vendor_ms: float
    delta_ms: float
    agrees: bool
    tolerance_ms: float


@dataclass(frozen=True)
class Term:
    """One measured term: a value (or ``None``), and the line that produced it."""

    name: str
    value_ms: float | None
    producer: str
    detail: str = ""
    cross_check: CrossCheck | None = None


@dataclass(frozen=True)
class TurnTerms:
    """The two terms for one Meta ``turnId``."""

    turn_id: str | None
    endpointing: Term
    post_processing: Term


@dataclass
class _Turn:
    turn_id: str
    end_at_s: float | None = None
    audio_processed_ms: float | None = None
    complete_at_s: float | None = None


def _ms(seconds: float) -> float:
    return round(seconds * 1000.0, 3)


def _last_speech_sent_at(
    send: Send, *, speech_end_sample: int, sample_rate: int
) -> float | None:
    """The delivery instant of the fixture's last speech sample, if in this chunk."""
    frames = len(send.chunk) // fixture.SAMPLE_WIDTH_BYTES
    start_sample = int(round(send.media_start_s * sample_rate))
    if start_sample <= speech_end_sample < start_sample + frames:
        offset_s = (speech_end_sample - start_sample) / sample_rate
        return send.sent_at_s + offset_s
    return None


def _collect(events: Iterable[SttEvent]) -> dict[str, _Turn]:
    turns: dict[str, _Turn] = {}
    for event in events:
        if event.kind not in KNOWN_EVENTS:
            continue  # unknown event types are ignored, per the Meta contract
        if event.kind == ERROR:
            raise SttStreamError(
                f"Meta STT error event at {event.received_at_s:.3f}s "
                f"for turn {event.turn_id!r}"
            )
        if event.kind == TRANSCRIPT:
            continue  # partial text belongs to the most recent speechStart
        if event.turn_id is None:
            raise SttStreamError(
                f"Meta STT {event.kind} event carries no turnId; "
                "the term cannot be attributed to a turn"
            )
        turn = turns.setdefault(event.turn_id, _Turn(turn_id=event.turn_id))
        if event.kind == SPEECH_END:
            turn.end_at_s = event.received_at_s
            turn.audio_processed_ms = event.audio_processed_ms
        elif event.kind == SPEECH_COMPLETE:
            turn.complete_at_s = event.received_at_s
    return turns


def _unmeasured(name: str, producer: str, detail: str) -> Term:
    return Term(name=name, value_ms=None, producer=producer, detail=detail)


def _endpointing_term(
    turn: _Turn,
    *,
    last_speech_sent_at_s: float | None,
    speech_end_ms: float,
    caller_turn: bool,
    tolerance_ms: float,
) -> Term:
    if turn.end_at_s is None:
        return _unmeasured(
            ENDPOINTING_TERM,
            ENDPOINTING_PRODUCER,
            f"turn {turn.turn_id} has no speechEnd; unmeasured, never zero",
        )
    if not caller_turn:
        return _unmeasured(
            ENDPOINTING_TERM,
            ENDPOINTING_PRODUCER,
            f"turn {turn.turn_id} is not the fixture's caller turn; the known "
            "speech-end position belongs to the first speechEnd only",
        )
    if last_speech_sent_at_s is None:
        return _unmeasured(
            ENDPOINTING_TERM,
            ENDPOINTING_PRODUCER,
            "the pacer never delivered the fixture's last speech sample",
        )

    wall_ms = _ms(turn.end_at_s - last_speech_sent_at_s)
    if turn.audio_processed_ms is None:
        return Term(
            name=ENDPOINTING_TERM,
            value_ms=wall_ms,
            producer=ENDPOINTING_PRODUCER,
            detail=(
                f"turn {turn.turn_id}: cross-check unmeasured, speechEnd carried "
                "no audioProcessedMs"
            ),
        )

    vendor_ms = round(turn.audio_processed_ms - speech_end_ms, 3)
    delta_ms = round(vendor_ms - wall_ms, 3)
    agrees = abs(delta_ms) <= tolerance_ms
    if agrees:
        comparison = "wall-clock and audioProcessedMs agree"
    else:
        comparison = (
            "DISAGREEMENT between wall-clock and audioProcessedMs; "
            "both are reported, not averaged"
        )
    return Term(
        name=ENDPOINTING_TERM,
        value_ms=wall_ms,
        producer=ENDPOINTING_PRODUCER,
        detail=(
            f"turn {turn.turn_id}: {comparison} "
            f"(wall={wall_ms:.3f}ms vendor={vendor_ms:.3f}ms delta={delta_ms:+.3f}ms "
            f"tolerance={tolerance_ms:.3f}ms)"
        ),
        cross_check=CrossCheck(
            wall_ms=wall_ms,
            vendor_ms=vendor_ms,
            delta_ms=delta_ms,
            agrees=agrees,
            tolerance_ms=tolerance_ms,
        ),
    )


def _post_processing_term(turn: _Turn) -> Term:
    if turn.end_at_s is None or turn.complete_at_s is None:
        missing = "speechEnd" if turn.end_at_s is None else "speechComplete"
        return _unmeasured(
            POST_PROCESSING_TERM,
            POST_PROCESSING_PRODUCER,
            f"turn {turn.turn_id} has no {missing}; unmeasured, never zero",
        )
    return Term(
        name=POST_PROCESSING_TERM,
        value_ms=_ms(turn.complete_at_s - turn.end_at_s),
        producer=POST_PROCESSING_PRODUCER,
        detail=f"turn {turn.turn_id}",
    )


def _terms(
    events: Iterable[SttEvent],
    *,
    last_speech_sent_at_s: float | None,
    speech_end_ms: float,
    tolerance_ms: float = AGREEMENT_TOLERANCE_MS,
) -> tuple[TurnTerms, ...]:
    turns = _collect(events)
    caller_turn = next(
        (turn for turn in turns.values() if turn.end_at_s is not None), None
    )
    built = []
    for turn in turns.values():
        endpointing = _endpointing_term(
            turn,
            last_speech_sent_at_s=last_speech_sent_at_s,
            speech_end_ms=speech_end_ms,
            caller_turn=turn is caller_turn,
            tolerance_ms=tolerance_ms,
        )
        built.append(
            TurnTerms(
                turn_id=turn.turn_id,
                endpointing=endpointing,
                post_processing=_post_processing_term(turn),
            )
        )
    return tuple(built)


def measure(
    transport: MetaSttTransport,
    *,
    pcm: bytes | None = None,
    speech_end_sample: int | None = None,
    sample_rate: int = fixture.SAMPLE_RATE,
    chunk_ms: int = CHUNK_MS,
    clock: Callable[[], float] | None = None,
    wait: Callable[[float], None] | None = None,
) -> tuple[TurnTerms, ...]:
    """Stream the fixture through ``transport`` and measure both terms per turn.

    The pacer drives the vendor at approximately real time, using the vendor's
    ``audioProcessedMs`` as its lead reference. The transport stamps each event
    with the clock reading at arrival; the fixture's speech-end sample reaches
    the vendor at the pacer's ``sent_at`` for that sample. ``chunk_ms`` is the
    wire frame size; the offline default is the pacer's own, and the live runner
    passes the production 200 ms. The cross-check tolerance follows the frame,
    because one frame is the timing quantum of the comparison.
    """
    audio = fixture.render_pcm() if pcm is None else pcm
    if speech_end_sample is None:
        speech_end_sample = fixture.last_speech_sample(audio)
    if speech_end_sample < 0:
        raise ValueError("the fixture has no speech sample to measure from")

    events: list[SttEvent] = []
    last_speech_sent_at_s: float | None = None
    transport.open()
    try:
        pacer = Pacer(
            audio,
            vendor_processed_s=transport.audio_processed_s,
            sample_rate=sample_rate,
            chunk_ms=chunk_ms,
            clock=clock,
            wait=wait,
        )
        while not pacer.done:
            for event in transport.poll():
                events.append(event)
            item = pacer.next_send()
            if item is None:
                break
            if isinstance(item, Blocked):
                continue
            transport.send_audio(item.chunk)
            sent_at = _last_speech_sent_at(
                item, speech_end_sample=speech_end_sample, sample_rate=sample_rate
            )
            if sent_at is not None:
                last_speech_sent_at_s = sent_at

        for event in transport.poll():
            events.append(event)
        transport.end_stream()
        events.extend(transport.drain())
    finally:
        transport.close()

    return _terms(
        events,
        last_speech_sent_at_s=last_speech_sent_at_s,
        speech_end_ms=round(speech_end_sample / sample_rate * 1000.0, 3),
        tolerance_ms=float(chunk_ms),
    )


def unmeasured_terms(reason: str) -> TurnTerms:
    """Both terms, honestly unmeasured, with the producer line and the reason."""
    return TurnTerms(
        turn_id=None,
        endpointing=_unmeasured(ENDPOINTING_TERM, ENDPOINTING_PRODUCER, reason),
        post_processing=_unmeasured(
            POST_PROCESSING_TERM, POST_PROCESSING_PRODUCER, reason
        ),
    )


def measure_live(
    transport: MetaSttTransport | None = None,
    *,
    env: Mapping[str, str] | None = None,
    **kwargs,
) -> tuple[TurnTerms, ...]:
    """A live measurement when a transport and key exist; otherwise unmeasured.

    :mod:`spike.live` supplies the owner-gated socket transport; this function
    still refuses to invent one, so a caller without that transport gets the
    named reason rather than a number.
    """
    if transport is None:
        environment = os.environ if env is None else env
        if not environment.get(META_KEY_ENV):
            reason = (
                f"live run not executed: {META_KEY_ENV} is not set; "
                "Meta STT transport unavailable"
            )
        else:
            reason = (
                f"{META_KEY_ENV} is set but no Meta STT transport was supplied; "
                "live run not executed"
            )
        return (unmeasured_terms(reason),)
    return measure(transport, **kwargs)
