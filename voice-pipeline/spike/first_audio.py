"""The synthesis first-audio term and the configured playout cushion (M00).

Synthesis first-audio is the reply cost of speaking, not the cost of reaching the
vendor. So the session is opened and its ``Begin`` acknowledged **before** the
user turn; the open→``Begin`` gap is recorded separately as a call-start cost and
never lands inside the term. A measurement taken on a session opened at or after
the turn is refused, because the handshake would be counted as reply latency.

The term runs from the first sentence's committed request — ``Generate`` plus
``Flush``, anchored at the ``Flush`` — to the first ``Audio`` frame that follows
it. Audio already in flight from an earlier utterance does not count.

The playout cushion is a *configuration* value, not a buffer reading: it is read
from the one threshold registry under ``playout.cushion_ms`` and reported with
that name, its source and its date. It is never hardcoded here and never inferred
from frames. The registry's own value for it must be supplied by ticket 04 (the
worklet's ``TARGET_CUSHION_S`` in ``voni/public/playout-processor.js`` is the
single owner of the number today). If the bound is missing or open, this module
reports the cushion as unmeasured, naming the bound and the owning ticket — it
does not substitute a default.

Nothing here opens a socket. Recorded frames are replayed through
:func:`measure_first_audio`; the live producer is ``spike.run --live`` with an
AssemblyAI key. With no frames the term is ``None``, carries a producer line and
says why — never ``0.0`` and never a guess.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from cascade import thresholds

TERM_NAME = "synthesis.first_audio_ms"
HANDSHAKE_NAME = "synthesis.handshake_ms"
CUSHION_NAME = "playout.cushion_ms"

PRODUCER = (
    "recorded synthesis frames: Generate+Flush(first sentence) → first Audio "
    "frame, on a session opened and acknowledged before the turn"
)
HANDSHAKE_PRODUCER = "recorded synthesis frames: session open → Begin (call-start cost)"
CUSHION_PRODUCER = (
    f"cascade.thresholds:{CUSHION_NAME} "
    "(configured target cushion, not a buffer reading)"
)
LIVE_PRODUCER = "spike.run --live (requires ASSEMBLYAI_API_KEY)"

BEGIN = "Begin"
GENERATE = "Generate"
FLUSH = "Flush"
AUDIO = "Audio"


class FirstAudioError(RuntimeError):
    """A first-audio measurement cannot be reported honestly."""


class SessionOpenedAfterTurn(FirstAudioError):
    """The session was opened at or after the turn, so the term is not the reply."""


class HandshakeInTerm(FirstAudioError):
    """The session's Begin was not received before the turn; the gap includes it."""


class FrameOrderError(FirstAudioError):
    """The recorded frames cannot be read as one utterance's timeline."""


class CushionUnitError(FirstAudioError):
    """The cushion bound is declared in a unit this report cannot print as ms."""


@dataclass(frozen=True)
class Opening:
    """When the session was opened and when its ``Begin`` arrived, in seconds."""

    opened_at_s: float
    begin_at_s: float | None


@dataclass(frozen=True)
class Frame:
    """One synthesis frame: a client request or a vendor reply, timestamped.

    ``kind`` is the wire name (``Begin``, ``Generate``, ``Flush``, ``Audio``);
    other vendor frames in a recording are ignored rather than rejected.
    """

    kind: str
    at_s: float
    detail: str = ""


@dataclass(frozen=True)
class Cushion:
    """The configured playout cushion, or the named reason it is unset."""

    name: str
    ms: float | None
    source: str = ""
    date: str = ""
    producer: str = CUSHION_PRODUCER
    detail: str = ""

    @property
    def configured(self) -> bool:
        """True only when a value was actually declared with a source."""
        return self.ms is not None

    def entry(self) -> "ReportTerm":
        return ReportTerm(
            name=self.name,
            ms=self.ms,
            producer=self.producer,
            detail=self.detail,
            configured=self.configured,
        )


@dataclass(frozen=True)
class ReportTerm:
    """One line of the M00 report: a name, a number or ``None``, and a producer."""

    name: str
    ms: float | None
    producer: str
    detail: str = ""
    configured: bool = False


@dataclass(frozen=True)
class FirstAudio:
    """The measured term, the handshake it excludes, and the configured cushion."""

    first_audio_ms: float | None
    handshake_ms: float | None
    term: ReportTerm
    handshake: ReportTerm
    cushion: Cushion

    def cushion_entry(self) -> ReportTerm:
        return self.cushion.entry()

    def terms(self) -> tuple[ReportTerm, ReportTerm, ReportTerm]:
        """The term, the configured cushion, and the excluded call-start cost."""
        return (self.term, self.cushion_entry(), self.handshake)


def configured_cushion(
    *,
    name: str = CUSHION_NAME,
    registry: thresholds.Registry | None = None,
) -> Cushion:
    """Read the named cushion from the threshold registry.

    Raises :class:`thresholds.UnknownBoundError` when nothing declares it and
    :class:`thresholds.UnsetBoundError` when it is still open. Both name the
    bound and, for an open bound, the ticket that owes the value. No default.
    """
    registry = thresholds.REGISTRY if registry is None else registry
    entry = registry.bound(name)
    value = registry.require(name)
    if entry.unit != "ms":
        raise CushionUnitError(
            f"bound {name!r} is declared in {entry.unit!r}; this report prints ms "
            "and will not convert a cushion behind the reader's back"
        )
    return Cushion(
        name=name,
        ms=float(value),
        source=entry.source,
        date=entry.date,
        detail="configured value; not measured from a live buffer",
    )


def _unset_cushion(error: thresholds.ThresholdError, name: str) -> Cushion:
    return Cushion(name=name, ms=None, detail=str(error))


def _ms(delta_s: float) -> float:
    return round(delta_s * 1000.0, 3)


def _require_chronological(frames: tuple[Frame, ...]) -> None:
    for previous, current in zip(frames, frames[1:]):
        if current.at_s < previous.at_s:
            raise FrameOrderError(
                f"frame {current.kind} at {current.at_s:.3f}s precedes "
                f"{previous.kind} at {previous.at_s:.3f}s; an out-of-order "
                "recording cannot be measured"
            )


def _first_sentence_flush(frames: tuple[Frame, ...]) -> Frame | None:
    generated = False
    for frame in frames:
        if frame.kind == GENERATE:
            generated = True
        elif frame.kind == FLUSH:
            if not generated:
                raise FrameOrderError(
                    "a Flush arrived before any Generate; the first sentence was "
                    "never committed, so there is no term to measure"
                )
            return frame
    return None


def _first_audio_after(frames: tuple[Frame, ...], anchor: Frame) -> Frame | None:
    for frame in frames:
        if frame.kind == AUDIO and frame.at_s >= anchor.at_s:
            return frame
    return None


def _unmeasured_producer(reason: str) -> str:
    return f"{PRODUCER} — {reason}; producer: {LIVE_PRODUCER}"


def measure_first_audio(
    *,
    opening: Opening,
    turn_at_s: float,
    frames: Iterable[Frame] = (),
    registry: thresholds.Registry | None = None,
) -> FirstAudio:
    """Measure first-audio on a session that was open before the turn.

    ``turn_at_s`` and the frame timestamps share one clock. The result's term is
    ``None`` when there is nothing recorded to measure; a session opened at or
    after the turn, or one whose ``Begin`` missed the turn, raises instead.
    """
    if opening.opened_at_s >= turn_at_s:
        raise SessionOpenedAfterTurn(
            f"session opened at {opening.opened_at_s:.3f}s, at or after the turn "
            f"at {turn_at_s:.3f}s: the handshake would be counted as reply "
            "latency, so this is not the first-audio term; open the synthesis "
            "session before the turn and measure again"
        )
    if opening.begin_at_s is not None and opening.begin_at_s < opening.opened_at_s:
        raise FrameOrderError(
            f"Begin arrived at {opening.begin_at_s:.3f}s, before the session "
            f"opened at {opening.opened_at_s:.3f}s; the recording is not a "
            "session timeline"
        )

    frames = tuple(frames)
    _require_chronological(frames)
    anchor = _first_sentence_flush(frames)
    audio = _first_audio_after(frames, anchor) if anchor is not None else None

    if opening.begin_at_s is None:
        handshake_ms = None
        handshake_detail = "Begin never received; the call-start cost is unmeasured"
    else:
        handshake_ms = _ms(opening.begin_at_s - opening.opened_at_s)
        handshake_detail = (
            f"call-start cost; excluded from {TERM_NAME} because the session is "
            "opened and acknowledged before the turn"
        )
    handshake = ReportTerm(
        name=HANDSHAKE_NAME,
        ms=handshake_ms,
        producer=HANDSHAKE_PRODUCER,
        detail=handshake_detail,
    )

    try:
        cushion = configured_cushion(registry=registry)
    except thresholds.ThresholdError as error:
        cushion = _unset_cushion(error, CUSHION_NAME)

    if audio is None:
        if not frames:
            reason = "no recorded frames"
        elif anchor is None:
            reason = "no Generate+Flush recorded for the first sentence"
        else:
            reason = "no Audio frame after the first sentence's Flush"
        term = ReportTerm(
            name=TERM_NAME,
            ms=None,
            producer=_unmeasured_producer(reason),
            detail=reason,
        )
        return FirstAudio(
            first_audio_ms=None,
            handshake_ms=handshake_ms,
            term=term,
            handshake=handshake,
            cushion=cushion,
        )

    if opening.begin_at_s is None:
        raise HandshakeInTerm(
            "an Audio frame was recorded but no Begin: the gap could include the "
            "handshake, so it cannot be reported as the first-audio term"
        )
    if opening.begin_at_s >= turn_at_s:
        raise HandshakeInTerm(
            f"Begin arrived at {opening.begin_at_s:.3f}s, at or after the turn at "
            f"{turn_at_s:.3f}s: the session was not acknowledged before the user "
            "turn, so the handshake cannot be excluded from the term"
        )

    first_audio_ms = _ms(audio.at_s - anchor.at_s)
    return FirstAudio(
        first_audio_ms=first_audio_ms,
        handshake_ms=handshake_ms,
        term=ReportTerm(
            name=TERM_NAME,
            ms=first_audio_ms,
            producer=PRODUCER,
            detail=(
                f"{anchor.kind} at {anchor.at_s:.3f}s → {AUDIO} at "
                f"{audio.at_s:.3f}s"
            ),
        ),
        handshake=handshake,
        cushion=cushion,
    )


class ScriptedSynthesisSession:
    """A deterministic stand-in for the synthesis socket, driven by a clock.

    Used by the offline harness and the tests: delays advance the injected clock
    only, so a scripted two-second handshake costs nothing. The session records
    timestamped frames and hands them to :func:`measure_first_audio`.
    """

    def __init__(
        self,
        *,
        turn_at_s: float,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._clock = clock or time.monotonic
        self.turn_at_s = float(turn_at_s)
        self._frames: list[Frame] = []
        self._opened_at_s: float | None = None
        self._begin_at_s: float | None = None

    @property
    def frames(self) -> tuple[Frame, ...]:
        return tuple(self._frames)

    def _stamp(self, delay_ms: float) -> float:
        if delay_ms < 0:
            raise ValueError(f"delay_ms cannot be negative: {delay_ms!r}")
        advance = getattr(self._clock, "advance", None)
        if advance is None:
            raise TypeError(
                "the scripted session needs a clock with advance(seconds); got "
                f"{type(self._clock).__name__}"
            )
        advance(delay_ms / 1000.0)
        return self._clock()

    def open(self, *, delay_ms: float = 0.0) -> float:
        at = self._stamp(delay_ms)
        self._opened_at_s = at
        return at

    def receive_begin(self, *, delay_ms: float = 0.0) -> Frame:
        frame = Frame(kind=BEGIN, at_s=self._stamp(delay_ms))
        self._begin_at_s = frame.at_s
        self._frames.append(frame)
        return frame

    def send_generate(self, text: str, *, delay_ms: float = 0.0) -> Frame:
        frame = Frame(kind=GENERATE, at_s=self._stamp(delay_ms), detail=text)
        self._frames.append(frame)
        return frame

    def send_flush(self, *, delay_ms: float = 0.0) -> Frame:
        frame = Frame(kind=FLUSH, at_s=self._stamp(delay_ms))
        self._frames.append(frame)
        return frame

    def receive_audio(self, *, delay_ms: float = 0.0, detail: str = "") -> Frame:
        frame = Frame(kind=AUDIO, at_s=self._stamp(delay_ms), detail=detail)
        self._frames.append(frame)
        return frame

    def opening(self) -> Opening:
        if self._opened_at_s is None:
            raise FirstAudioError("the scripted session was never opened")
        return Opening(opened_at_s=self._opened_at_s, begin_at_s=self._begin_at_s)

    def measure(
        self, *, registry: thresholds.Registry | None = None
    ) -> FirstAudio:
        return measure_first_audio(
            opening=self.opening(),
            turn_at_s=self.turn_at_s,
            frames=self.frames,
            registry=registry,
        )
