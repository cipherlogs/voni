"""Every billable unit comes from the wire, never from an estimate.

Spec: `.scratch/meta-cascade/spec.md` M3 "Money and eyes" — "Money is metered
from the wire, not from an estimate of what a turn probably cost." This module
is that meter. It reads only vendor reports:

* the model's usage chunk (``prompt``, ``completion``, ``cached`` and
  ``reasoning`` tokens), recorded per turn through :meth:`UsageMeter.record_llm`;
* the synthesis ``Termination`` summary's billed characters, and its audio and
  session seconds as facts, recorded per session through
  :meth:`UsageMeter.record_tts`;
* the speech vendor's usage frame, recorded per session through
  :meth:`UsageMeter.record_stt`, in whole seconds because that is how the
  vendor bills speech.

The invariant is one sentence: a quantity is a number only when a vendor frame
carried it. A unit the vendor did not report is ``quantity: None`` with
``measured: false`` and a source naming the absence — never zero, because zero
is a price the vendor did not quote. A measured zero (``cached_tokens: 0``) is
kept as zero: it says "none were cached", which is a measurement.

A call total is a sum of measured contributions, and one unmeasured contribution
makes the whole unit unmeasured: a partial sum is never presented as complete.
Two sessions or two tries are summed rather than deduplicated, because the
vendor bills every one of them — a reconnect replay is not free.

Ticket 101 prices these units with its versioned rate table; ticket 102 charges
them to a day bucket. Neither reads a vendor frame or invents a missing number,
and neither belongs here.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from cascade.breaker import LEGS
from cascade.meta_llm import TurnUsage, parse_usage

#: The priced token units the model vendor reports, in artifact order.
#: ``total_tokens`` is the vendor's derived sum, not a unit a rate table prices.
TOKEN_UNITS: tuple[str, ...] = (
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "reasoning_tokens",
)

#: The speech vendor's unit. No usage frame is in the realtime protocol today,
#: so this stays unmeasured until the vendor supplies one.
STT_UNITS: tuple[str, ...] = ("audio_seconds",)

#: The voice vendor's units: the billed characters, and the two durations it
#: reports in ``Termination`` as facts.
TTS_UNITS: tuple[str, ...] = ("characters", "audio_seconds", "session_seconds")

#: The source an empty leg reports: no frame, so no measurement.
NO_RECORD = "no vendor usage record"


class UsageError(ValueError):
    """One refused unit or record, named by the value that failed."""


class TerminationBilling(Protocol):
    """The voice vendor's ``Termination`` facts, as ticket 54 parsed them.

    A structural type so this module reads the vendor summary without importing
    the synthesis adapter: the character precedence (``billed_characters`` over
    ``total_input_char_length``) lives in one place, and the meter never
    re-derives it.
    """

    characters: int | None
    source: str
    audio_duration_seconds: float | None
    session_duration_seconds: int | None


@dataclass(frozen=True)
class Unit:
    """One billable quantity, or the honest absence of one.

    ``quantity`` is a number only when the vendor reported it. An unmeasured
    unit keeps ``quantity=None`` and a ``source`` naming why; it is never
    coerced to zero, and zero is only ever a measured zero.
    """

    name: str
    quantity: int | float | None = None
    source: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise UsageError(f"a unit needs a name, got {self.name!r}")
        if self.quantity is None:
            return
        if isinstance(self.quantity, bool) or not isinstance(
            self.quantity, (int, float)
        ):
            raise UsageError(
                f'unit "{self.name}" must be a number or None, got {self.quantity!r}'
            )
        if not math.isfinite(self.quantity):
            raise UsageError(
                f'unit "{self.name}" must be finite, got {self.quantity!r}'
            )
        if self.quantity < 0:
            raise UsageError(
                f'unit "{self.name}" cannot be negative: the vendor does not '
                f"refund billable units, got {self.quantity!r}"
            )

    @property
    def measured(self) -> bool:
        """Whether the vendor reported this unit."""
        return self.quantity is not None

    def to_document(self) -> dict[str, Any]:
        return {
            "quantity": self.quantity,
            "measured": self.measured,
            "source": self.source,
        }


@dataclass(frozen=True)
class Units:
    """One scope's units: a turn's tokens, a leg's totals, or one session.

    Units are ordered and unique by name. ``measured`` is true only when every
    unit in the scope was reported, so an unmeasured unit can never hide behind
    a measured sibling.
    """

    units: tuple[Unit, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        names = tuple(unit.name for unit in self.units)
        if len(set(names)) != len(names):
            raise UsageError(f"a unit set cannot repeat a name, got {names}")

    def unit(self, name: str) -> Unit | None:
        """The named unit, or ``None`` when this scope does not meter it."""
        return next((unit for unit in self.units if unit.name == name), None)

    @property
    def measured(self) -> bool:
        return bool(self.units) and all(unit.measured for unit in self.units)

    def to_document(self) -> dict[str, Any]:
        return {unit.name: unit.to_document() for unit in self.units}


@dataclass(frozen=True)
class CallUsage:
    """One call's units, per leg and per turn, as a stable document.

    ``legs`` carries the three call-level legs in :data:`LEGS` order. ``turns``
    carries the model's token units keyed by logical turn id: the model is the
    only leg whose vendor reports per turn, while speech is a session fact and
    synthesis is a call fact.
    """

    legs: tuple[tuple[str, Units], ...]
    turns: tuple[tuple[str, Units], ...] = ()

    def __post_init__(self) -> None:
        names = tuple(name for name, _ in self.legs)
        if names != LEGS:
            raise UsageError(
                f"call usage must name {LEGS} in order, got {names}"
            )
        turn_ids = tuple(turn for turn, _ in self.turns)
        if len(set(turn_ids)) != len(turn_ids):
            raise UsageError(f"call usage cannot repeat a turn, got {turn_ids}")

    def leg(self, name: str) -> Units:
        """One call-level leg's units; every leg is present."""
        for leg, units in self.legs:
            if leg == name:
                return units
        raise UsageError(f"unknown leg {name!r}; expected one of {LEGS}")

    def turn(self, turn: str) -> Units | None:
        """One turn's token units, or ``None`` when the turn was not recorded."""
        return next((units for name, units in self.turns if name == turn), None)

    @property
    def measured(self) -> bool:
        """Whether every leg reported every unit: a complete cost claim."""
        return all(units.measured for _, units in self.legs)

    def to_document(self) -> dict[str, Any]:
        return {
            "measured": self.measured,
            "legs": {
                leg: {"measured": units.measured, "units": units.to_document()}
                for leg, units in self.legs
            },
            "turns": {
                turn: units.to_document() for turn, units in self.turns
            },
        }


def total(name: str, records: list[Unit]) -> Unit:
    """Sum one unit across vendor records; one absence makes it unmeasured.

    Summing is the only honest aggregate here: the vendor bills every recorded
    session and every recorded turn, so a reconnect replay is added, not
    deduplicated. A partial sum is refused as a measurement by naming the first
    absence.
    """
    if not records:
        return Unit(name, None, NO_RECORD)
    for record in records:
        if not record.measured:
            return Unit(
                name,
                None,
                record.source or f"the vendor did not report {name}",
            )
    return Unit(
        name,
        sum(record.quantity for record in records),
        (
            records[0].source
            if len(records) == 1
            else f"{records[0].source}; summed over {len(records)} records"
        ),
    )


class UsageMeter:
    """One call's meter: every billable unit, recorded as the vendor reports it.

    The meter is append-only. Each ``record_*`` call is one vendor record, so a
    retried turn or a replaced session adds a second record instead of
    overwriting the first. A caller records a turn even when its usage is
    absent (:meth:`record_llm` with ``None`` or an unmeasured
    :class:`cascade.meta_llm.TurnUsage`), which is what keeps an interrupted
    stream from looking free.
    """

    def __init__(self) -> None:
        self._turns: dict[str, list[Units]] = {}
        self._stt: list[Units] = []
        self._tts: list[Units] = []

    # -- recording --------------------------------------------------------

    def record_llm(
        self, turn: str, usage: TurnUsage | Mapping[str, Any] | None
    ) -> None:
        """Record one turn's token units from the vendor's usage chunk.

        ``usage`` is the parsed :class:`cascade.meta_llm.TurnUsage` the stream
        already holds, the raw vendor usage object, or ``None`` for a turn that
        ended before a usage chunk. Every form records a record; an absent one
        records absence, never zero.
        """
        if not isinstance(turn, str) or not turn.strip():
            raise UsageError(f"a turn needs a logical id, got {turn!r}")
        record = (
            parse_usage(dict(usage)) if isinstance(usage, Mapping) else usage
        )
        if record is None:
            record = TurnUsage.unmeasured()
        if not isinstance(record, TurnUsage):
            raise UsageError(
                f"a turn's usage must be TurnUsage or a vendor mapping, "
                f"got {record!r}"
            )
        self._turns.setdefault(turn, []).append(self._token_units(record))

    def record_tts(self, billing: TerminationBilling) -> None:
        """Record one synthesis session's units from its ``Termination`` summary.

        The billed character count is the vendor's own meter (ticket 54 keeps
        ``billed_characters`` over ``total_input_char_length`` and names which
        one it used), so its source is carried through unchanged. The audio and
        session seconds are facts from the same summary, not estimates derived
        from the bytes we sent.

        One call per session: a reconnect replay is a second session and is
        summed, because the vendor bills both.
        """
        units = Units(
            (
                Unit(
                    "characters",
                    billing.characters,
                    billing.source
                    or (
                        "Termination.billed_characters"
                        if billing.characters is not None
                        else "no Termination summary was recorded"
                    ),
                ),
                _reported(
                    "audio_seconds",
                    billing.audio_duration_seconds,
                    "Termination.audio_duration_seconds",
                ),
                _reported(
                    "session_seconds",
                    billing.session_duration_seconds,
                    "Termination.session_duration_seconds",
                ),
            )
        )
        self._tts.append(units)

    def record_stt(self, usage: Mapping[str, Any] | None) -> None:
        """Record one speech session's audio units from the vendor's usage frame.

        Speech is billed in whole seconds, so the reported duration is metered
        down to whole seconds — that is the vendor's billing granularity, not an
        estimate. A session with no usage frame records absence: the realtime
        protocol has no usage frame today, and the audio we sent is not the
        vendor's meter.

        One call per session: a planned reconnect or a retry is a second session
        and is summed, because the vendor bills both.
        """
        self._stt.append(Units((_speech_seconds(usage),)))

    # -- reading ----------------------------------------------------------

    def usage(self) -> CallUsage:
        """A snapshot of the call's units, per leg and per turn."""
        turns = tuple(
            (turn, self._leg(TOKEN_UNITS, records))
            for turn, records in self._turns.items()
        )
        llm_records = [
            units for records in self._turns.values() for units in records
        ]
        return CallUsage(
            legs=(
                ("stt", self._leg(STT_UNITS, self._stt)),
                ("llm", self._leg(TOKEN_UNITS, llm_records)),
                ("tts", self._leg(TTS_UNITS, self._tts)),
            ),
            turns=turns,
        )

    def to_document(self) -> dict[str, Any]:
        """The stable shape ticket 101 prices and the end message carries."""
        return self.usage().to_document()

    # -- internals --------------------------------------------------------

    def _token_units(self, usage: TurnUsage) -> Units:
        if not usage.measured:
            reason = "no usage chunk was recorded for this turn"
        else:
            reason = "the vendor's usage chunk omitted {unit}"
        return Units(
            tuple(
                Unit(
                    name,
                    getattr(usage, name),
                    (
                        "vendor usage chunk (stream_options.include_usage)"
                        if getattr(usage, name) is not None
                        else reason.format(unit=name)
                    ),
                )
                for name in TOKEN_UNITS
            )
        )

    @staticmethod
    def _leg(names: tuple[str, ...], records: list[Units]) -> Units:
        return Units(
            tuple(
                total(name, _recorded(records, name)) for name in names
            )
        )


def _recorded(records: list[Units], name: str) -> list[Unit]:
    """Every report of one unit across records, dropping scopes that lack it."""
    found = [units.unit(name) for units in records]
    return [unit for unit in found if unit is not None]


def _reported(name: str, value: Any, source: str) -> Unit:
    """One vendor-reported number, or an unmeasured unit naming its absence."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return Unit(name, None, f"the vendor did not report {name}")
    return Unit(name, value, source)


def _speech_seconds(usage: Mapping[str, Any] | None) -> Unit:
    """The speech vendor's whole billed seconds, or why they are unknown."""
    if usage is None:
        return Unit(
            "audio_seconds", None, "no speech usage frame was recorded"
        )
    seconds = usage.get("audio_duration_seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
        return Unit(
            "audio_seconds",
            None,
            "the vendor's usage frame did not report audio_duration_seconds",
        )
    if not math.isfinite(seconds) or seconds < 0:
        raise UsageError(
            f"speech audio_duration_seconds must be finite and non-negative, "
            f"got {seconds!r}"
        )
    return Unit(
        "audio_seconds",
        math.floor(seconds),
        "usage frame: audio_duration_seconds, billed in whole seconds",
    )
