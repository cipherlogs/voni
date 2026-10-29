"""Ticket 13: the five-term M00 report, its sum and the three-way verdict.

Seam: ``spike.report.from_measurements`` over the ticket 10-12 measurement
objects, and ``spike.report.build_report`` over five already-built terms. No
socket, no key, no wall clock: the synthetic timeline injects one known delay
per term, and the expected sum is the script's, not the module's arithmetic.

The budgets are read from the threshold registry, never restated here: the
boundary tests move the registry's numbers and expect the verdict to move.
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from cascade import thresholds
from spike import endpointing, first_audio, first_token, report, run

P50_BOUND = "reply_gap.p50_ms"
P95_BOUND = "reply_gap.p95_ms"


def stt_terms(
    *,
    endpointing_ms: float | None = 120.0,
    post_processing_ms: float | None = 180.0,
) -> endpointing.TurnTerms:
    """The two STT terms for one caller turn, as ticket 10 returns them."""
    return endpointing.TurnTerms(
        turn_id="turn-1",
        endpointing=endpointing.Term(
            name=endpointing.ENDPOINTING_TERM,
            value_ms=endpointing_ms,
            producer=endpointing.ENDPOINTING_PRODUCER,
            detail="synthetic timeline",
        ),
        post_processing=endpointing.Term(
            name=endpointing.POST_PROCESSING_TERM,
            value_ms=post_processing_ms,
            producer=endpointing.POST_PROCESSING_PRODUCER,
            detail="synthetic timeline",
        ),
    )


def first_content(ms: float | None = 640.0) -> first_token.FirstContentReport:
    """The default effort row, as ticket 11 returns it."""
    row = first_token.FirstContentTerm(
        effort=first_token.DEFAULT_EFFORT,
        producer=(
            "spike.first_token[default] trace synthetic: speechComplete receipt "
            "-> first content delta (reasoning_content excluded)"
        ),
        first_content_ms=ms,
        unmeasured_reason="" if ms is not None else "unmeasured: no content delta",
    )
    return first_token.FirstContentReport(speech_complete_at_s=1.0, terms=(row,))


def synthesis(
    first_audio_ms: float | None = 60.0,
    *,
    cushion_ms: float | None = 500.0,
) -> first_audio.FirstAudio:
    """The first-audio term and the configured cushion, as ticket 12 returns them."""
    term = first_audio.ReportTerm(
        name=first_audio.TERM_NAME,
        ms=first_audio_ms,
        producer=first_audio.PRODUCER if first_audio_ms is not None else (
            f"{first_audio.PRODUCER} — synthetic: no frames"
        ),
        detail="synthetic timeline",
    )
    cushion = first_audio.Cushion(
        name=first_audio.CUSHION_NAME,
        ms=cushion_ms,
        source="test fixture",
        date="2026-10-29",
        detail="configured value; not measured from a live buffer",
    )
    return first_audio.FirstAudio(
        first_audio_ms=first_audio_ms,
        handshake_ms=250.0,
        term=term,
        handshake=first_audio.ReportTerm(
            name=first_audio.HANDSHAKE_NAME,
            ms=250.0,
            producer=first_audio.HANDSHAKE_PRODUCER,
        ),
        cushion=cushion,
    )


def full_report(**overrides):
    """The five-term report from a known synthetic timeline."""
    parts = {
        "stt": stt_terms(),
        "first_content": first_content(),
        "synthesis": synthesis(),
    }
    parts.update(overrides)
    return report.from_measurements(**parts)


class CompositionTests(unittest.TestCase):
    def test_the_report_names_all_five_terms_in_order_with_a_producer_line(self):
        result = full_report()

        self.assertEqual(
            [term.name for term in result.terms],
            [
                endpointing.ENDPOINTING_TERM,
                endpointing.POST_PROCESSING_TERM,
                first_token.TERM,
                first_audio.TERM_NAME,
                first_audio.CUSHION_NAME,
            ],
        )
        for term in result.terms:
            self.assertTrue(
                term.producer.strip(),
                f"term {term.name} has no producer line",
            )

    def test_the_synthetic_timeline_reproduces_its_injected_sum(self):
        # 120 + 180 + 640 + 60 + 500 = 1500ms, injected one per term.
        result = full_report()

        self.assertEqual(result.measured_sum_ms, 1500.0)
        self.assertEqual(result.sum_ms, 1500.0)
        self.assertEqual(result.unmeasured_names, ())

    def test_the_budgets_come_from_the_registry_not_from_literals(self):
        result = full_report()

        self.assertEqual(
            result.pass_budget_ms, thresholds.require_bound(P50_BOUND)
        )
        self.assertEqual(
            result.fail_budget_ms, thresholds.require_bound(P95_BOUND)
        )
        self.assertIn(P50_BOUND, result.budget_source)
        self.assertIn(P95_BOUND, result.budget_source)

    def test_a_first_content_row_for_another_effort_is_not_relabelled(self):
        lowest = first_token.FirstContentTerm(
            effort=first_token.lowest_effort("low", source="test fixture"),
            producer="spike.first_token[lowest] synthetic",
            first_content_ms=1.0,
        )
        with self.assertRaises(report.ReportError):
            full_report(first_content=lowest)


def terms_with(values: tuple[float | None, ...]) -> tuple[report.Term, ...]:
    """Five terms at the given values, one per canonical name."""
    return tuple(
        report.Term(name=name, ms=value, producer=f"synthetic producer for {name}")
        for name, value in zip(report.TERM_NAMES, values)
    )


def report_for(values: tuple[float | None, ...]) -> report.Report:
    return report.build_report(terms_with(values))


def split_total(total: float) -> tuple[float, ...]:
    """Five positive terms that sum to ``total``."""
    return (total - 4.0, 1.0, 1.0, 1.0, 1.0) if total > 4.0 else (total, 0.0, 0.0, 0.0, 0.0)


class VerdictBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.p50 = float(thresholds.require_bound(P50_BOUND))
        self.p95 = float(thresholds.require_bound(P95_BOUND))

    def test_every_term_measured_and_sum_at_the_pass_budget_is_pass(self):
        result = report_for(split_total(self.p50))

        self.assertEqual(result.sum_ms, self.p50)
        self.assertEqual(result.unmeasured_names, ())
        self.assertEqual(result.verdict, report.PASS)

    def test_one_millisecond_over_the_pass_budget_is_at_risk(self):
        result = report_for(split_total(self.p50 + 1.0))

        self.assertEqual(result.sum_ms, self.p50 + 1.0)
        self.assertEqual(result.verdict, report.AT_RISK)

    def test_exactly_the_fail_budget_is_at_risk(self):
        result = report_for(split_total(self.p95))

        self.assertEqual(result.sum_ms, self.p95)
        self.assertEqual(result.verdict, report.AT_RISK)

    def test_one_millisecond_over_the_fail_budget_is_fail(self):
        result = report_for(split_total(self.p95 + 1.0))

        self.assertEqual(result.sum_ms, self.p95 + 1.0)
        self.assertEqual(result.verdict, report.FAIL)

    def test_the_verdict_follows_the_registry_budget_not_a_literal(self):
        lowered = thresholds.Registry(
            {
                P50_BOUND: thresholds.Bound(
                    name=P50_BOUND,
                    unit="ms",
                    gate="reply-gap",
                    ticket="fixture",
                    value=1000.0,
                    source="fixture",
                    date="2026-10-29",
                ),
                P95_BOUND: thresholds.Bound(
                    name=P95_BOUND,
                    unit="ms",
                    gate="reply-gap",
                    ticket="fixture",
                    value=self.p95,
                    source="fixture",
                    date="2026-10-29",
                ),
            }
        )
        values = split_total(1200.0)

        self.assertEqual(
            report.build_report(terms_with(values)).verdict, report.PASS
        )
        self.assertEqual(
            report.build_report(terms_with(values), registry=lowered).verdict,
            report.AT_RISK,
        )


class UnmeasuredVerdictTests(unittest.TestCase):
    def setUp(self):
        self.p95 = float(thresholds.require_bound(P95_BOUND))

    def test_an_unmeasured_term_is_at_risk_and_is_named(self):
        result = report_for((120.0, 180.0, None, 60.0, 500.0))

        self.assertIsNone(result.sum_ms, "an unmeasured term makes the sum None")
        self.assertEqual(result.measured_sum_ms, 860.0)
        self.assertEqual(result.verdict, report.AT_RISK)
        self.assertEqual(result.unmeasured_names, (first_token.TERM,))

    def test_an_unmeasured_term_is_never_pass_even_with_a_zero_subtotal(self):
        for index, name in enumerate(report.TERM_NAMES):
            values: list[float | None] = [0.0] * 5
            values[index] = None
            result = report_for(tuple(values))

            with self.subTest(missing=name):
                self.assertNotEqual(result.verdict, report.PASS)
                self.assertEqual(result.verdict, report.AT_RISK)
                self.assertEqual(result.unmeasured_names, (name,))

    def test_measured_terms_over_the_fail_budget_fail_even_with_a_hole(self):
        result = report_for((None, self.p95, 1.0, 1.0, 1.0))

        self.assertIsNone(result.sum_ms)
        self.assertEqual(result.verdict, report.FAIL)
        self.assertEqual(result.unmeasured_names, (endpointing.ENDPOINTING_TERM,))

    def test_an_all_unmeasured_report_is_at_risk_with_all_five_named(self):
        result = report_for((None, None, None, None, None))

        self.assertIsNone(result.sum_ms)
        self.assertEqual(result.measured_sum_ms, 0.0)
        self.assertEqual(result.verdict, report.AT_RISK)
        self.assertEqual(result.unmeasured_names, report.TERM_NAMES)


class PerTermBudgetTests(unittest.TestCase):
    def setUp(self):
        self.p50 = float(thresholds.require_bound(P50_BOUND))

    def test_a_term_that_alone_exceeds_the_budget_is_named_inside_the_sum(self):
        result = report_for((self.p50 + 1.0, 1.0, 1.0, 1.0, 1.0))

        self.assertEqual(result.verdict, report.AT_RISK)
        self.assertLessEqual(result.sum_ms, result.fail_budget_ms)
        self.assertEqual(
            [term.name for term in result.over_budget],
            [endpointing.ENDPOINTING_TERM],
        )
        self.assertIn(
            endpointing.ENDPOINTING_TERM, result.as_dict()["over_budget"]
        )
        self.assertIn(endpointing.ENDPOINTING_TERM, result.render())

    def test_no_term_is_named_when_every_term_is_inside_the_budget(self):
        result = report_for((1.0, 1.0, 1.0, 1.0, 1.0))

        self.assertEqual(result.over_budget, ())


class RenderTests(unittest.TestCase):
    def test_every_term_is_printed_with_its_producer_and_its_ms(self):
        text = full_report().render()

        for term in full_report().terms:
            self.assertIn(term.name, text)
            self.assertIn(term.producer, text)
            self.assertIn(f"{term.ms:.3f} ms", text)
        self.assertIn(report.PASS, text)

    def test_an_unmeasured_term_is_printed_as_unmeasured_with_its_name(self):
        result = full_report(
            stt=stt_terms(endpointing_ms=None, post_processing_ms=180.0)
        )
        text = result.render()

        self.assertIn(endpointing.ENDPOINTING_TERM, text)
        self.assertIn("UNMEASURED", text)
        self.assertIn(f"verdict: {report.AT_RISK}", text)
        self.assertNotIn(f"verdict: {report.PASS}", text)

    def test_the_offline_report_is_at_risk_and_never_blank(self):
        result = report.from_measurements()

        self.assertEqual(result.verdict, report.AT_RISK)
        self.assertEqual(len(result.terms), 5)
        self.assertEqual(result.unmeasured_names, report.TERM_NAMES)
        text = result.render()
        for name in report.TERM_NAMES:
            self.assertIn(name, text)
        self.assertIn("unmeasured", text.lower())

    def test_the_dict_is_serialisable_and_names_every_missing_term(self):
        payload = report.from_measurements().as_dict()
        encoded = json.dumps(payload, sort_keys=True)

        self.assertEqual(payload["verdict"], report.AT_RISK)
        self.assertEqual(payload["term_count"], 5)
        self.assertIsNone(payload["sum_ms"])
        self.assertEqual(payload["unmeasured"], list(report.TERM_NAMES))
        self.assertEqual(len(payload["terms"]), 5)
        self.assertIn("first_content_token_ms", encoded)


class DeletionTests(unittest.TestCase):
    def test_deleting_any_one_term_makes_the_report_unbuildable(self):
        for index, name in enumerate(report.TERM_NAMES):
            values: list[float | None] = [1.0] * 5
            terms = list(terms_with(tuple(values)))
            del terms[index]
            with self.subTest(deleted=name):
                with self.assertRaises(report.MissingTermError) as caught:
                    report.build_report(tuple(terms))
                self.assertIn(name, str(caught.exception))

    def test_a_report_with_only_four_terms_cannot_be_constructed(self):
        with self.assertRaises(report.MissingTermError):
            report.Report(
                terms=terms_with((1.0, 1.0, 1.0, 1.0, 1.0))[:-1],
                pass_budget_ms=float(thresholds.require_bound(P50_BOUND)),
                fail_budget_ms=float(thresholds.require_bound(P95_BOUND)),
                budget_source="fixture",
            )

    def test_an_unknown_extra_term_is_refused_by_name(self):
        terms = terms_with((1.0, 1.0, 1.0, 1.0, 1.0)) + (
            report.Term(name="invented_term_ms", ms=1.0, producer="fixture"),
        )
        with self.assertRaises(report.MissingTermError) as caught:
            report.build_report(terms)
        self.assertIn("invented_term_ms", str(caught.exception))

    def test_a_duplicate_term_is_refused(self):
        terms = terms_with((1.0, 1.0, 1.0, 1.0, 1.0)) + (
            report.Term(
                name=report.TERM_NAMES[0], ms=1.0, producer="fixture"
            ),
        )
        with self.assertRaises(report.DuplicateTermError):
            report.build_report(terms)

    def test_composition_refuses_a_measurement_without_a_producer_line(self):
        broken = endpointing.TurnTerms(
            turn_id="turn-1",
            endpointing=endpointing.Term(
                name=endpointing.ENDPOINTING_TERM,
                value_ms=120.0,
                producer="",
            ),
            post_processing=stt_terms().post_processing,
        )
        with self.assertRaises(report.MissingProducerError):
            full_report(stt=broken)


class ProducerLineTests(unittest.TestCase):
    def test_any_term_without_a_producer_line_is_a_test_failure(self):
        for name in report.TERM_NAMES:
            with self.subTest(term=name):
                with self.assertRaises(report.MissingProducerError):
                    report.Term(name=name, ms=1.0, producer="")

    def test_a_blank_producer_line_is_not_a_producer_line(self):
        with self.assertRaises(report.MissingProducerError):
            report.Term(name=report.TERM_NAMES[0], ms=1.0, producer="   ")

    def test_a_negative_gap_is_refused(self):
        with self.assertRaises(report.InvalidMeasurementError):
            report.Term(
                name=report.TERM_NAMES[0], ms=-1.0, producer="fixture"
            )


class OfflineRunTests(unittest.TestCase):
    def test_the_offline_run_is_at_risk_with_the_unmeasured_terms_named(self):
        result = run.offline_report()

        self.assertNotEqual(result.verdict, report.PASS)
        self.assertEqual(result.verdict, report.AT_RISK)
        self.assertEqual(len(result.terms), 5)
        self.assertIn(endpointing.ENDPOINTING_TERM, result.unmeasured_names)
        self.assertIn(endpointing.POST_PROCESSING_TERM, result.unmeasured_names)
        self.assertIn(first_token.TERM, result.unmeasured_names)
        self.assertIn(first_audio.TERM_NAME, result.unmeasured_names)
        self.assertTrue(all(term.producer.strip() for term in result.terms))

    def test_the_offline_cli_prints_the_report_and_exits_zero(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(["--offline"])

        text = out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn(f"verdict: {report.AT_RISK}", text)
        for name in report.TERM_NAMES:
            self.assertIn(name, text)

    def test_the_offline_cli_writes_a_json_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "report-offline.json"
            with contextlib.redirect_stdout(io.StringIO()):
                code = run.main(["--offline", "--out", str(target)])
            payload = json.loads(target.read_text(encoding="utf-8"))

        self.assertEqual(code, 0)
        self.assertEqual(payload["verdict"], report.AT_RISK)
        self.assertEqual(payload["term_count"], 5)

    def test_the_cli_refuses_live_without_a_key_guard_and_names_why(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(["--live"])

        self.assertEqual(code, 2)
        self.assertIn("live", out.getvalue().lower())
        self.assertIn("owner-gated", out.getvalue())


if __name__ == "__main__":
    unittest.main()
