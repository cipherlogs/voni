"""The M00 feasibility report: five named terms, their sum, and the verdict.

The spike measures five terms, and the verdict is only honest when all five are
traceable: the report refuses to be built without one of them, and refuses a
term that carries no producer line. Every number arrives already measured by
its owning ticket 10-12 module; this module composes, sums and judges, and does
not measure anything itself.

The budgets are the frozen reply-gap budgets, read from the one threshold
registry (``reply_gap.p50_ms`` / ``reply_gap.p95_ms``, record-backed by
``voni/src/lib/demo/scoreboard-budgets.json``). A literal ``1500`` or ``2500``
here would be a second source, so there is none.

Offline — no keys, no vendor transport — the four measured terms arrive as
``None`` and the configured cushion may be open. That is ``AT RISK`` with the
missing terms named, never ``PASS`` and never a blank.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cascade import thresholds
from spike import endpointing, first_audio, first_token

#: The five M00 terms, in the order the report prints them. The names are the
#: producers' own names, so a rename upstream is a compile-time break here.
TERM_NAMES = (
    endpointing.ENDPOINTING_TERM,
    endpointing.POST_PROCESSING_TERM,
    first_token.TERM,
    first_audio.TERM_NAME,
    first_audio.CUSHION_NAME,
)

PASS = "PASS"
AT_RISK = "AT RISK"
FAIL = "FAIL"

PASS_BOUND = "reply_gap.p50_ms"
FAIL_BOUND = "reply_gap.p95_ms"


class ReportError(RuntimeError):
    """The report cannot be built or read as an honest five-term report."""


class MissingTermError(ReportError):
    """A term was deleted from the report; a four-term report is not the spike."""

    def __init__(self, missing: tuple[str, ...], unexpected: tuple[str, ...] = ()) -> None:
        self.missing = missing
        self.unexpected = unexpected
        detail = f"missing {', '.join(missing)}" if missing else ""
        if unexpected:
            extra = f"unexpected {', '.join(unexpected)}"
            detail = f"{detail}; {extra}" if detail else extra
        super().__init__(
            f"the M00 report must name exactly these five terms: "
            f"{', '.join(TERM_NAMES)}; {detail}"
        )


class DuplicateTermError(ReportError):
    """The same term is reported twice; one of them would silently win."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(
            f"term {name!r} appears twice in the report; one entry per term"
        )


class MissingProducerError(ReportError):
    """A term without its producer line is a test failure (M00 test rule)."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(
            f"term {name!r} has no producer line; an unproduced measurement is "
            "not reportable"
        )


class InvalidMeasurementError(ReportError):
    """A term value is not a finite, non-negative millisecond gap."""

    def __init__(self, name: str, ms: float) -> None:
        self.name = name
        self.ms = ms
        super().__init__(
            f"term {name!r} has an invalid measurement {ms!r}; a gap is a "
            "finite, non-negative number of milliseconds"
        )


@dataclass(frozen=True)
class Term:
    """One line of the report: a name, a value or ``None``, and a producer."""

    name: str
    ms: float | None
    producer: str
    detail: str = ""

    def __post_init__(self) -> None:
        if not self.producer.strip():
            raise MissingProducerError(self.name)
        if self.ms is not None:
            if not math.isfinite(self.ms) or self.ms < 0:
                raise InvalidMeasurementError(self.name, self.ms)

    @property
    def measured(self) -> bool:
        return self.ms is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "term": self.name,
            "ms": self.ms,
            "measured": self.measured,
            "producer": self.producer,
            "detail": self.detail,
        }


def _budget(registry: thresholds.Registry, name: str) -> tuple[float, str]:
    entry = registry.bound(name)
    value = registry.require(name)
    if entry.unit != "ms":
        raise ReportError(
            f"budget {name!r} is declared in {entry.unit!r}; the report compares "
            "milliseconds and will not convert a budget behind the reader's back"
        )
    if isinstance(value, str):
        raise ReportError(f"budget {name!r} is a string, not a millisecond value")
    return float(value), f"{name} ({entry.source} {entry.date})"


def build_report(
    terms: tuple[Term, ...],
    *,
    registry: thresholds.Registry | None = None,
    effort_label: str | None = None,
    unavailable: tuple[first_token.EffortUnavailable, ...] = (),
) -> "Report":
    """Build the five-term report, reading both budgets from the registry."""
    registry = thresholds.REGISTRY if registry is None else registry
    pass_budget, pass_source = _budget(registry, PASS_BOUND)
    fail_budget, fail_source = _budget(registry, FAIL_BOUND)
    return Report(
        terms=terms,
        pass_budget_ms=pass_budget,
        fail_budget_ms=fail_budget,
        budget_source=f"{pass_source}; {fail_source}",
        effort_label=effort_label,
        unavailable=unavailable,
    )


@dataclass(frozen=True)
class Report:
    """The five-term report; validation makes a deleted term unconstructible."""

    terms: tuple[Term, ...]
    pass_budget_ms: float
    fail_budget_ms: float
    budget_source: str
    effort_label: str | None = None
    unavailable: tuple[first_token.EffortUnavailable, ...] = ()

    def __post_init__(self) -> None:
        names = [term.name for term in self.terms]
        duplicates = tuple(
            name for name in dict.fromkeys(names) if names.count(name) > 1
        )
        if duplicates:
            raise DuplicateTermError(duplicates[0])
        missing = tuple(name for name in TERM_NAMES if name not in names)
        unexpected = tuple(name for name in names if name not in TERM_NAMES)
        if missing or unexpected:
            raise MissingTermError(missing, unexpected)
        # Canonical order, whatever order the caller supplied.
        by_name = {term.name: term for term in self.terms}
        object.__setattr__(
            self, "terms", tuple(by_name[name] for name in TERM_NAMES)
        )
        if self.fail_budget_ms < self.pass_budget_ms:
            raise ReportError(
                f"the fail budget {self.fail_budget_ms} is below the pass budget "
                f"{self.pass_budget_ms}; the verdict rule would be inverted"
            )

    @property
    def measured_sum_ms(self) -> float:
        """The sum of everything measured; zero when nothing is."""
        return round(
            float(sum(term.ms for term in self.terms if term.ms is not None)), 3
        )

    @property
    def unmeasured_names(self) -> tuple[str, ...]:
        return tuple(term.name for term in self.terms if not term.measured)

    @property
    def sum_ms(self) -> float | None:
        """The five-term sum, or ``None``: an unmeasured term is never zero."""
        if self.unmeasured_names:
            return None
        return self.measured_sum_ms

    @property
    def verdict(self) -> str:
        """``PASS`` / ``AT RISK`` / ``FAIL`` by the stated rule.

        ``PASS`` requires every term measured and the sum at or below the pass
        budget. A hole in the report is at best ``AT RISK``, and ``FAIL`` when
        the measured terms alone already exceed the fail budget.
        """
        measured = self.measured_sum_ms
        if measured > self.fail_budget_ms:
            return FAIL
        if self.unmeasured_names:
            return AT_RISK
        if measured > self.pass_budget_ms:
            return AT_RISK
        return PASS

    @property
    def over_budget(self) -> tuple[Term, ...]:
        """Terms that alone exceed the pass budget, even inside a passing sum."""
        return tuple(
            term
            for term in self.terms
            if term.ms is not None and term.ms > self.pass_budget_ms
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "terms": [term.as_dict() for term in self.terms],
            "term_count": len(self.terms),
            "measured_all": not self.unmeasured_names,
            "unmeasured": list(self.unmeasured_names),
            "sum_ms": self.sum_ms,
            "measured_sum_ms": self.measured_sum_ms,
            "budgets": {
                "pass_ms": self.pass_budget_ms,
                "fail_ms": self.fail_budget_ms,
                "source": self.budget_source,
            },
            "over_budget": [term.name for term in self.over_budget],
            "verdict": self.verdict,
            "effort": self.effort_label,
            "unavailable": [row.as_dict() for row in self.unavailable],
        }

    def render(self) -> str:
        """The reviewer-facing report: one line per term, then the sum and rule."""
        lines = [f"M00 latency spike — verdict: {self.verdict}", ""]
        for term in self.terms:
            if term.measured:
                value = f"{term.ms:.3f} ms"
            else:
                value = "UNMEASURED"
            lines.append(f"  {term.name:<28} {value}")
            lines.append(f"      producer: {term.producer}")
            if term.detail:
                lines.append(f"      detail:   {term.detail}")
        lines.append("")
        if self.sum_ms is None:
            lines.append(
                f"  {'sum (five terms)':<28} unmeasured — "
                f"{len(self.unmeasured_names)} of {len(self.terms)} terms "
                f"unmeasured: {', '.join(self.unmeasured_names)}"
            )
        else:
            lines.append(f"  {'sum (five terms)':<28} {self.sum_ms:.3f} ms")
        lines.append(
            f"  {'measured subtotal':<28} {self.measured_sum_ms:.3f} ms"
        )
        lines.append(
            f"  {'budgets':<28} PASS <= {self.pass_budget_ms:.3f} ms; "
            f"FAIL > {self.fail_budget_ms:.3f} ms"
        )
        lines.append(f"  {'budget source':<28} {self.budget_source}")
        if self.over_budget:
            named = ", ".join(
                f"{term.name} ({term.ms:.3f} ms)" for term in self.over_budget
            )
            lines.append(
                f"  {'over the pass budget':<28} {named} — each alone exceeds "
                f"{self.pass_budget_ms:.3f} ms"
            )
        else:
            lines.append(f"  {'over the pass budget':<28} (none)")
        for row in self.unavailable:
            lines.append(
                f"  {'unavailable effort':<28} reasoning_effort="
                f"{row.effort!r} HTTP {row.status} ({row.source})"
            )
        return "\n".join(lines)



def _term_from_stt(term: endpointing.Term) -> Term:
    return Term(
        name=term.name,
        ms=term.value_ms,
        producer=term.producer,
        detail=term.detail,
    )


def _first_content_row(
    measured: first_token.FirstContentReport | first_token.FirstContentTerm,
    effort_label: str,
) -> first_token.FirstContentTerm:
    if isinstance(measured, first_token.FirstContentTerm):
        row = measured
    else:
        row = measured.term(effort_label)
    if row.effort.label != effort_label:
        raise ReportError(
            f"the first-content row is effort {row.effort.label!r} but the "
            f"report is for {effort_label!r}; a row is not silently relabelled"
        )
    return row


def _term_from_first_content(
    row: first_token.FirstContentTerm,
) -> Term:
    source = f"; value from {row.effort.source}" if row.effort.source else ""
    detail = row.unmeasured_reason or (
        f"reasoning_effort={row.effort.label}"
        f" ({row.effort.reasoning_effort or 'vendor default'}){source}, "
        f"{row.reasoning_deltas} reasoning delta(s) excluded"
    )
    return Term(
        name=first_token.TERM,
        ms=row.first_content_ms,
        producer=row.producer,
        detail=detail,
    )


def _term_from_report_term(term: first_audio.ReportTerm) -> Term:
    return Term(
        name=term.name,
        ms=term.ms,
        producer=term.producer,
        detail=term.detail,
    )


def from_measurements(
    *,
    stt: endpointing.TurnTerms | None = None,
    first_content: first_token.FirstContentReport
    | first_token.FirstContentTerm
    | None = None,
    synthesis: first_audio.FirstAudio | None = None,
    effort_label: str = first_token.DEFAULT_LABEL,
    registry: thresholds.Registry | None = None,
    cushion_registry: thresholds.Registry | None = None,
) -> Report:
    """Compose the five terms from the ticket 10-12 measurements.

    A missing measurement is not skipped: its producer still runs to name the
    term and the reason, so the report always has five lines. No term is ever
    invented as zero.
    """
    if stt is None:
        stt = endpointing.unmeasured_terms(
            "unmeasured: the endpointing measurement did not run"
        )
    if first_content is None:
        first_content = first_token.measure_efforts(
            None, speech_complete_at_s=None
        )
    if synthesis is None:
        synthesis = first_audio.measure_first_audio(
            opening=first_audio.Opening(opened_at_s=0.0, begin_at_s=0.25),
            turn_at_s=1.0,
            frames=(),
            registry=cushion_registry,
        )

    row = _first_content_row(first_content, effort_label)
    terms = (
        _term_from_stt(stt.endpointing),
        _term_from_stt(stt.post_processing),
        _term_from_first_content(row),
        _term_from_report_term(synthesis.term),
        _term_from_report_term(synthesis.cushion_entry()),
    )
    unavailable = (
        first_content.unavailable
        if isinstance(first_content, first_token.FirstContentReport)
        else ()
    )
    return build_report(
        terms,
        registry=registry,
        effort_label=effort_label,
        unavailable=unavailable,
    )
