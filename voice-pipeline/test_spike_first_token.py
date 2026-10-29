"""Ticket 11: the spike's first-content-token term (M00, term 3).

The term is the gap from the ``speechComplete`` receipt to the first **content**
delta from Spark. Spark always reasons, so a reasoning-only stream must never
look fast: only a non-empty ``content`` delta marks the term. ``reasoning_effort:
"none"`` is reported as unavailable from the recorded HTTP 400 and is never
sent. Every unmeasured term carries a producer line and no number.

The transport is injected; synthetic SSE traces drive every case here, so the
suite is offline, key-free and never sleeps.
"""

import json
import time
import unittest

from spike.first_token import (
    DEFAULT_EFFORT,
    DEFAULT_EFFORTS,
    ENDPOINT,
    MODEL,
    TERM,
    Effort,
    EffortSourceRequiredError,
    EffortValueError,
    FirstContentTerm,
    HttpError,
    MissingEffortError,
    MissingProducerError,
    SseFormatError,
    Trace,
    TraceEvent,
    TraceTransport,
    UnavailableEffortError,
    UnknownEffortLabelError,
    build_payload,
    lowest_effort,
    measure_efforts,
    measure_first_content,
    recorded_none_refusal,
)

SPEECH_COMPLETE_AT = 500.0


class FakeClock:
    """A monotonic clock whose ``advance`` moves time instead of sleeping."""

    def __init__(self, start=SPEECH_COMPLETE_AT):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def sse(data):
    return "data: " + json.dumps(data)


def content(text):
    return sse({"choices": [{"delta": {"content": text}, "index": 0}]})


def reasoning(text):
    return sse({"choices": [{"delta": {"reasoning_content": text}, "index": 0}]})


def tool_call():
    return sse(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [{"index": 0, "id": "call_1", "type": "function"}]
                    },
                    "index": 0,
                }
            ]
        }
    )


DONE = "data: [DONE]"


def trace(name, *events, error=None):
    return Trace(name=name, events=tuple(events), error=error)


def replay(trace_value, clock=None):
    clock = clock or FakeClock()
    return TraceTransport(trace_value, clock=clock)


class FirstContentMeasurementTests(unittest.TestCase):
    def test_reasoning_first_trace_measures_the_first_content_delta(self):
        transport = replay(
            trace(
                "reasoning-first",
                TraceEvent(110.0, reasoning("The caller is asking about pricing.")),
                TraceEvent(240.0, reasoning("I should be brief.")),
                TraceEvent(810.0, content("Sure,")),
                TraceEvent(900.0, content(" I can help.")),
                TraceEvent(950.0, DONE),
            )
        )

        term = measure_first_content(
            transport,
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="Can you help?",
        )

        self.assertEqual(term.first_content_ms, 810.0)
        # The red case: a reasoning delta arrives at 110 ms and must not be
        # reported as the first token the caller can hear.
        self.assertNotEqual(term.first_content_ms, 110.0)
        self.assertEqual(term.first_reasoning_ms, 110.0)
        self.assertEqual(term.reasoning_deltas, 2)
        self.assertTrue(term.measured)
        self.assertIn("first content", term.producer)
        self.assertIn("reasoning-first", term.producer)


class EffortChoiceTests(unittest.TestCase):
    def test_reasoning_effort_none_is_an_unavailable_row_and_never_requested(self):
        with self.assertRaises(UnavailableEffortError) as caught:
            Effort("lowest", "none", source="test: trying the forbidden value")
        refusal = caught.exception.refusal
        self.assertEqual(refusal.effort, "none")
        self.assertEqual(refusal.status, 400)
        self.assertFalse(refusal.body_captured)
        self.assertIn("400", str(caught.exception))
        self.assertIn("never sends it", str(caught.exception))

        # The same value cannot be smuggled in by a payload builder either.
        with self.assertRaises(UnavailableEffortError):
            build_payload(Effort("lowest", "none", source="x"), "hi")

    def test_a_captured_400_body_is_carried_verbatim(self):
        body = '{"error": {"message": "none is not supported"}}'
        refusal = recorded_none_refusal(body=body)
        self.assertTrue(refusal.body_captured)
        self.assertEqual(refusal.body, body)
        self.assertEqual(refusal.status, 400)
        self.assertEqual(refusal.as_dict()["status"], 400)

    def test_default_effort_omits_the_reasoning_effort_field(self):
        payload = build_payload(DEFAULT_EFFORT, "Can you help?")
        self.assertEqual(payload["model"], MODEL)
        self.assertEqual(
            payload["messages"], [{"role": "user", "content": "Can you help?"}]
        )
        self.assertIs(payload["stream"], True)
        self.assertEqual(payload["stream_options"], {"include_usage": True})
        self.assertNotIn("reasoning_effort", payload)
        for forbidden in (
            "store",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "n",
            "logprobs",
        ):
            self.assertNotIn(forbidden, payload)

    def test_lowest_effort_must_name_where_its_value_came_from(self):
        with self.assertRaises(EffortSourceRequiredError):
            Effort("lowest", "low")
        with self.assertRaises(EffortSourceRequiredError):
            lowest_effort("low", source="  ")

    def test_lowest_effort_carries_the_named_vendor_value(self):
        effort = lowest_effort("low", source="test: vendor enum, 2026-10-29")
        self.assertEqual(effort.reasoning_effort, "low")
        self.assertTrue(effort.is_resolved)
        self.assertEqual(build_payload(effort, "hi")["reasoning_effort"], "low")

    def test_an_unknown_effort_label_is_refused(self):
        with self.assertRaises(UnknownEffortLabelError):
            Effort("medium")

    def test_the_default_row_cannot_carry_a_value(self):
        with self.assertRaises(EffortValueError):
            Effort("default", "low", source="test: wrong row")

    def test_the_unresolved_lowest_row_has_no_value(self):
        lowest = DEFAULT_EFFORTS[1]
        self.assertFalse(lowest.is_resolved)
        self.assertIsNone(lowest.reasoning_effort)


class ReasoningOnlyTests(unittest.TestCase):
    def test_a_reasoning_only_stream_is_unmeasured_and_named(self):
        transport = replay(
            trace(
                "reasoning-only",
                TraceEvent(110.0, reasoning("Thinking about the question.")),
                TraceEvent(400.0, reasoning("Still thinking.")),
                TraceEvent(700.0, DONE),
            )
        )

        term = measure_first_content(
            transport,
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="Can you help?",
        )

        self.assertIsNone(term.first_content_ms)
        self.assertFalse(term.measured)
        self.assertTrue(term.reasoning_only)
        self.assertIn("reasoning-only", term.unmeasured_reason)
        self.assertEqual(term.reasoning_deltas, 2)
        self.assertEqual(term.first_reasoning_ms, 110.0)
        self.assertTrue(term.producer)

    def test_an_empty_content_delta_does_not_mark_the_term(self):
        transport = replay(
            trace(
                "empty-first-delta",
                TraceEvent(90.0, content("")),
                TraceEvent(200.0, reasoning("Now I know what to say.")),
                TraceEvent(640.0, content("Hi there.")),
                TraceEvent(700.0, DONE),
            )
        )

        term = measure_first_content(
            transport,
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )

        self.assertEqual(term.first_content_ms, 640.0)

    def test_a_tool_call_stream_without_content_is_unmeasured(self):
        transport = replay(
            trace(
                "tools-only",
                TraceEvent(120.0, reasoning("I should call a tool.")),
                TraceEvent(300.0, tool_call()),
                TraceEvent(320.0, DONE),
            )
        )

        term = measure_first_content(
            transport,
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="book it",
        )

        self.assertIsNone(term.first_content_ms)
        self.assertIn("tool calls", term.unmeasured_reason)
        self.assertFalse(term.reasoning_only)

    def test_an_empty_stream_is_unmeasured_not_zero(self):
        term = measure_first_content(
            replay(trace("empty", TraceEvent(0.0, DONE))),
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )

        self.assertIsNone(term.first_content_ms)
        self.assertIn("no delta", term.unmeasured_reason)

    def test_a_vendor_http_error_is_recorded_not_timed(self):
        body = '{"error": {"message": "bad conversation structure"}}'
        term = measure_first_content(
            replay(trace("http-400", error=HttpError(400, body))),
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )

        self.assertIsNone(term.first_content_ms)
        self.assertFalse(term.measured)
        self.assertEqual(term.http_status, 400)
        self.assertEqual(term.http_body, body)
        self.assertIn("HTTP 400", term.unmeasured_reason)

    def test_a_missing_speech_complete_receipt_is_unmeasured(self):
        term = measure_first_content(
            replay(trace("no-mark", TraceEvent(80.0, content("Hi")))),
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=None,
            transcript="hello",
        )

        self.assertIsNone(term.first_content_ms)
        self.assertIn("speechComplete", term.unmeasured_reason)
        self.assertTrue(term.producer)

    def test_a_malformed_sse_line_is_refused_by_name(self):
        with self.assertRaises(SseFormatError):
            measure_first_content(
                replay(trace("broken", TraceEvent(10.0, "data: not-json"))),
                effort=DEFAULT_EFFORT,
                speech_complete_at_s=SPEECH_COMPLETE_AT,
                transcript="hello",
            )

    def test_measurement_uses_the_injected_clock_and_never_sleeps(self):
        clock = FakeClock()
        transport = replay(
            trace(
                "clocked",
                TraceEvent(120.0, reasoning("hmm")),
                TraceEvent(700.0, content("Hi")),
                TraceEvent(720.0, DONE),
            ),
            clock=clock,
        )

        started = time.monotonic()
        term = measure_first_content(
            transport,
            effort=DEFAULT_EFFORT,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )
        elapsed = time.monotonic() - started

        self.assertEqual(term.first_content_ms, 700.0)
        self.assertLess(elapsed, 0.5)
        self.assertAlmostEqual(clock.now, SPEECH_COMPLETE_AT + 0.7)


class ReportTests(unittest.TestCase):
    def test_default_and_lowest_effort_are_measured_and_reported(self):
        transport = replay(
            trace(
                "two-efforts",
                TraceEvent(120.0, reasoning("thinking")),
                TraceEvent(700.0, content("Hi")),
                TraceEvent(720.0, DONE),
            )
        )
        lowest = lowest_effort("low", source="test: vendor enum, 2026-10-29")

        report = measure_efforts(
            transport,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
            efforts=(DEFAULT_EFFORT, lowest),
        )

        self.assertEqual(
            [term.effort.label for term in report.terms], ["default", "lowest"]
        )
        self.assertEqual(report.terms[0].first_content_ms, 700.0)
        self.assertEqual(report.terms[1].first_content_ms, 700.0)
        self.assertEqual(transport.requests[0].get("reasoning_effort"), None)
        self.assertNotIn("reasoning_effort", transport.requests[0])
        self.assertEqual(transport.requests[1]["reasoning_effort"], "low")

        as_dict = report.as_dict()
        self.assertEqual(as_dict["term"], TERM)
        self.assertEqual(
            [row["effort"] for row in as_dict["efforts"]], ["default", "lowest"]
        )
        self.assertEqual(as_dict["efforts"][0]["first_content_ms"], 700.0)
        self.assertTrue(as_dict["efforts"][1]["measured"])
        for row in as_dict["efforts"]:
            self.assertTrue(row["producer"].strip())

    def test_the_report_always_carries_the_none_refusal_and_never_sends_it(self):
        transport = replay(trace("single", TraceEvent(300.0, content("Hi"))))

        report = measure_efforts(
            transport,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )

        unavailable = report.as_dict()["unavailable"]
        self.assertEqual(len(unavailable), 1)
        self.assertEqual(unavailable[0]["effort"], "none")
        self.assertEqual(unavailable[0]["status"], 400)
        self.assertFalse(unavailable[0]["available"])
        self.assertFalse(unavailable[0]["body_captured"])
        self.assertIn(ENDPOINT, unavailable[0]["producer"])
        for request in transport.requests:
            self.assertNotEqual(request.get("reasoning_effort"), "none")
        self.assertEqual(
            [term.effort.label for term in report.terms], ["default", "lowest"]
        )

    def test_missing_lowest_effort_is_refused_by_name(self):
        with self.assertRaises(MissingEffortError) as caught:
            measure_efforts(
                replay(trace("only-default", TraceEvent(300.0, content("Hi")))),
                speech_complete_at_s=SPEECH_COMPLETE_AT,
                transcript="hello",
                efforts=(DEFAULT_EFFORT,),
            )
        self.assertIn("lowest", str(caught.exception))
        self.assertEqual(caught.exception.missing, ("lowest",))

    def test_an_unresolved_lowest_row_is_unmeasured_and_not_requested(self):
        transport = replay(trace("default-only", TraceEvent(300.0, content("Hi"))))

        report = measure_efforts(
            transport,
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
        )

        self.assertEqual(len(transport.requests), 1)
        lowest = report.terms[1]
        self.assertEqual(lowest.effort.label, "lowest")
        self.assertIsNone(lowest.first_content_ms)
        self.assertIn("not named", lowest.unmeasured_reason)
        self.assertTrue(lowest.producer)

    def test_a_captured_400_body_reaches_the_report(self):
        body = '{"error": {"message": "none is not supported"}}'
        report = measure_efforts(
            replay(trace("captured", TraceEvent(300.0, content("Hi")))),
            speech_complete_at_s=SPEECH_COMPLETE_AT,
            transcript="hello",
            none_refusal=recorded_none_refusal(body=body),
        )

        row = report.as_dict()["unavailable"][0]
        self.assertEqual(row["effort"], "none")
        self.assertTrue(row["body_captured"])
        self.assertEqual(row["body"], body)

    def test_no_live_transport_reports_both_terms_unmeasured_with_producers(self):
        report = measure_efforts(None, speech_complete_at_s=None)

        self.assertEqual(
            [term.effort.label for term in report.terms], ["default", "lowest"]
        )
        for term in report.terms:
            self.assertIsNone(term.first_content_ms)
            self.assertFalse(term.measured)
            self.assertIn("no live", term.unmeasured_reason)
            self.assertTrue(term.producer.strip())
        self.assertIsNone(report.as_dict()["speech_complete_at_s"])

    def test_a_term_without_a_producer_line_is_refused(self):
        with self.assertRaises(MissingProducerError):
            FirstContentTerm(effort=DEFAULT_EFFORT, producer="  ")


if __name__ == "__main__":
    unittest.main()
