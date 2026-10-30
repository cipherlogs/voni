"""Operational decisions are first-class events, never console lines (110).

Seam: :class:`cascade.events.OperationalEvents`, which builds every line through
the one :class:`~cascade.events.EventWriter` and writes it through the one
:class:`~cascade.events.EventStream` (so the shared sanitizer always runs).

The shapes pinned here are the spec's: a breaker transition is operational (the
leg in place of subject/turn) and names its rungs; a budget crossing names the
line, day, spend and cap; a ceiling stop names the call, spend and ceiling; a
reconnect names the leg, reason and whether it was planned or a failure. Every
call-scoped event names its subject and a turn id or ``null``, and no event
carries caller text or audio.

The last test is end-to-end on :class:`cascade.call.CallLifecycle`: the live
ceiling breach calls the emission, so deleting that call site fails a test.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from decimal import Decimal

from cascade.breaker import BreakerTransition, BreakerTrigger
from cascade.call import BudgetStop, CallLifecycle, OpenedLeg
from cascade.counter import MANAGED_LINE, REFUSED_LINE, Crossing, DailyCounter
from cascade.events import (
    BREAKER_EVENT_TYPE,
    BUDGET_CROSSING_EVENT_TYPE,
    BUDGET_STOPPED_EVENT_TYPE,
    DEPLOY_DRAIN_EVENT_TYPE,
    GREETING_EVENT_TYPES,
    PROTOCOL_ERROR_EVENT_TYPE,
    RECONNECT_EVENT_TYPE,
    TURN_FAILED_EVENT_TYPE,
    EventEnvelopeError,
    EventStream,
    EventWriter,
    OperationalEvents,
)
from cascade.failures import classify
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.reconnect import ReconnectBudget
from cascade.sanitizer import REDACTED
from cascade.store import MemoryStore
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    BrowserStop,
    FakeStream,
    FakeTransport,
    FakeVoice,
    RecordingAudioSink,
    signed_message,
)
from cascade.test_call_ceiling import OVER_CEILING, DeliverThenReport
from cascade.test_daily_cap_refusal import NOON, measured
from cascade.test_second_failure import GoodbyeVoice, LiveTransport
from cascade.testing import FakeClock, ScriptedSTT

SUBJECT = "demo anna (en, browser)"
CALL = "call-110"


def recording(call_id: str = CALL):
    lines: list[str] = []
    writer = EventWriter(pipeline="cascade", call_id=call_id)
    stream = EventStream(writer, sink=lines.append)
    ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 12.5)
    return lines, ops


def only(lines: list[str]) -> dict:
    return json.loads(lines[0])


class BudgetEventTests(unittest.TestCase):
    def test_a_crossing_names_the_line_day_spend_and_cap(self):
        lines, ops = recording()
        event = ops.budget_crossing(
            Crossing(MANAGED_LINE, "2026-10-30", Decimal("20"), Decimal("25"))
        )

        self.assertEqual(
            {
                "schemaVersion": 1,
                "pipeline": "cascade",
                "callId": CALL,
                "type": BUDGET_CROSSING_EVENT_TYPE,
                "subject": SUBJECT,
                "turn": None,
                "atMs": 12500.0,
                "phase": "end",
                "line": "route_managed",
                "day": "2026-10-30",
                "spend": "20",
                "cap": "25",
            },
            only(lines),
        )
        self.assertEqual(event, only(lines))

    def test_the_100_percent_line_is_its_own_crossing_event(self):
        lines, ops = recording()
        ops.budget_crossing(
            Crossing(REFUSED_LINE, "2026-10-30", Decimal("25"), Decimal("25"))
        )

        line = only(lines)
        self.assertEqual("refuse_cascade", line["line"])
        self.assertEqual("25", line["spend"])
        self.assertEqual("25", line["cap"])
        self.assertIn("subject", line)
        self.assertIsNone(line["turn"])

    def test_both_the_80_and_100_crossings_are_emitted_by_one_charge(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: NOON)

        async def scenario():
            counter = DailyCounter(
                MemoryStore(), now=lambda: NOON, on_crossing=ops.budget_crossing
            )
            await counter.charge(measured("25"), at=NOON)

        asyncio.run(scenario())

        self.assertEqual(
            [BUDGET_CROSSING_EVENT_TYPE, BUDGET_CROSSING_EVENT_TYPE],
            [json.loads(line)["type"] for line in lines],
        )
        self.assertEqual(
            ["route_managed", "refuse_cascade"],
            [json.loads(line)["line"] for line in lines],
        )

    def test_a_ceiling_stop_names_the_call_spend_and_ceiling_once(self):
        lines, ops = recording()
        stop = BudgetStop(
            spend_usd=0.25000125,
            ceiling_usd=0.25,
            measured=True,
            turn="t1",
        )
        event = ops.budget_stopped(stop)

        line = only(lines)
        self.assertEqual(BUDGET_STOPPED_EVENT_TYPE, line["type"])
        self.assertEqual(CALL, line["callId"])
        self.assertEqual("t1", line["turn"])
        self.assertEqual("drain", line["phase"])
        self.assertEqual(0.25000125, line["spendUsd"])
        self.assertEqual(0.25, line["ceilingUsd"])
        self.assertTrue(line["measured"])
        self.assertEqual(stop.reason, line["reason"])
        self.assertNotIn("ceiling", line)
        self.assertEqual(event, line)

    def test_an_unmeasured_ceiling_stop_names_why_it_cannot_be_complete(self):
        lines, ops = recording()
        stop = BudgetStop(
            spend_usd=0.25,
            ceiling_usd=0.25,
            measured=False,
            reasons=("the model leg reported no usage",),
        )
        ops.budget_stopped(stop)

        line = only(lines)
        self.assertFalse(line["measured"])
        self.assertIn("the model leg reported no usage", line["unmeasuredReason"])

    def test_a_managed_run_cannot_claim_a_budget_event(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="managed", call_id=CALL), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 12.5)

        with self.assertRaises(EventEnvelopeError) as caught:
            ops.budget_crossing(
                Crossing(MANAGED_LINE, "2026-10-30", Decimal("20"), Decimal("25"))
            )

        self.assertEqual("type", caught.exception.field)
        self.assertIn("cascade", str(caught.exception))
        self.assertEqual([], lines, "a refused line writes nothing")


class DeployDrainTests(unittest.TestCase):
    def test_a_deploy_drain_is_planned_and_names_its_reason(self):
        lines, ops = recording()

        ops.deploy_drain(
            reason="deploy 2026.10.30: readiness failed, live calls finish",
            planned=True,
        )

        line = only(lines)
        self.assertEqual(DEPLOY_DRAIN_EVENT_TYPE, line["type"])
        self.assertEqual("drain", line["phase"])
        self.assertIsNone(line["turn"])
        self.assertTrue(line["planned"])
        self.assertIn("readiness failed", line["reason"])

    def test_a_deploy_drain_cannot_be_a_failure(self):
        _, ops = recording()

        with self.assertRaises(EventEnvelopeError) as caught:
            ops.deploy_drain(reason="draining", planned=False)

        self.assertEqual("planned", caught.exception.field)
        self.assertIn("deploy drain is planned", str(caught.exception))


class ReconnectEventTests(unittest.TestCase):
    def test_a_planned_reconnect_names_leg_reason_and_planned(self):
        budget = ReconnectBudget(now=lambda: 1.0)
        budget.planned("stt")
        lines, ops = recording()

        ops.reconnect(budget.events[-1])

        line = only(lines)
        self.assertEqual(RECONNECT_EVENT_TYPE, line["type"])
        self.assertEqual("stt", line["leg"])
        self.assertEqual("planned_reconnect", line["action"])
        self.assertTrue(line["planned"])
        self.assertIn("planned reconnect", line["reason"])
        self.assertIsNone(line["turn"])

    def test_a_failure_reconnect_names_the_failure_class(self):
        budget = ReconnectBudget(now=lambda: 1.0)
        budget.failed(classify("stt", 1011))
        lines, ops = recording()

        ops.reconnect(budget.events[-1])

        line = only(lines)
        self.assertEqual("stt", line["leg"])
        self.assertFalse(line["planned"])
        self.assertEqual("trigger", line["failureClass"])
        self.assertIn("reconnecting", line["reason"])


class GreetingEventTests(unittest.TestCase):
    def test_the_three_greeting_marks_are_three_first_class_events(self):
        lines, ops = recording()

        ops.greeting("greeting.start", voice_id="anna")
        ops.greeting(
            "greeting.first_audio", voice_id="anna", frames=1, sample_rate=24000
        )
        ops.greeting(
            "greeting.done",
            voice_id="anna",
            frames=2,
            sample_rate=24000,
            cancelled=True,
            cause="speech_start",
        )

        events = [json.loads(line) for line in lines]
        self.assertEqual(list(GREETING_EVENT_TYPES), [event["type"] for event in events])
        self.assertEqual([None, None, None], [event["turn"] for event in events])
        self.assertEqual(["connect"] * 3, [event["phase"] for event in events])
        self.assertEqual(["anna"] * 3, [event["voiceId"] for event in events])
        self.assertEqual(
            [0, 1, 2],
            [event["frames"] for event in events],
        )
        self.assertTrue(events[2]["cancelled"])
        self.assertEqual("speech_start", events[2]["cause"])
        for event in events:
            self.assertNotIn("text", event)

    def test_an_unknown_greeting_mark_is_refused_by_name(self):
        _, ops = recording()

        with self.assertRaises(EventEnvelopeError) as caught:
            ops.greeting("greeting.middle", voice_id="anna")

        self.assertEqual("type", caught.exception.field)
        self.assertIn("greeting.middle", str(caught.exception))


class BreakerEventTests(unittest.TestCase):
    def transition(self) -> BreakerTransition:
        return BreakerTransition(
            leg="llm",
            from_state="closed",
            to_state="open",
            trigger=BreakerTrigger(
                kind="failure", code=1013, phase="stream", turn=3
            ),
            reason="closed -> open: abnormal socket close",
            at=4.0,
            record_version=2,
        )

    def test_a_breaker_transition_is_operational_and_names_its_rungs(self):
        lines, ops = recording()

        ops.breaker_transition(self.transition(), manual_pin=False)

        line = only(lines)
        self.assertEqual(BREAKER_EVENT_TYPE, line["type"])
        self.assertEqual("llm", line["leg"])
        self.assertNotIn("subject", line)
        self.assertNotIn("turn", line)
        self.assertEqual("closed", line["from"])
        self.assertEqual("open", line["to"])
        self.assertEqual("failure", line["trigger"])
        self.assertEqual(1013, line["triggerCode"])
        self.assertEqual(3, line["triggerTurn"])
        self.assertFalse(line["manualPin"])
        self.assertEqual("turn", line["phase"], "the stream phase maps to the turn phase")
        self.assertIn("abnormal socket close", line["reason"])

    def test_a_manual_pin_is_reported_as_set(self):
        lines, ops = recording()
        transition = BreakerTransition(
            leg="tts",
            from_state="closed",
            to_state="closed",
            trigger=BreakerTrigger(kind="manual_pin", phase="manual"),
            reason="pinned to fallback by operator",
            at=5.0,
            record_version=3,
        )

        ops.breaker_transition(transition)

        line = only(lines)
        self.assertTrue(line["manualPin"])
        self.assertEqual("connect", line["phase"], "a manual write is pre-call")

    def test_a_managed_run_cannot_claim_a_breaker_transition(self):
        stream = EventStream(
            EventWriter(pipeline="managed", call_id=CALL), sink=lambda _line: None
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 12.5)

        with self.assertRaises(EventEnvelopeError) as caught:
            ops.breaker_transition(self.transition())

        self.assertEqual("type", caught.exception.field)


class ProtocolAndTurnFailureTests(unittest.TestCase):
    def test_a_protocol_error_names_the_leg_code_and_reason(self):
        lines, ops = recording()

        ops.protocol_error(
            leg="stt", code="not_json", reason="a frame arrived before the ack"
        )

        line = only(lines)
        self.assertEqual(PROTOCOL_ERROR_EVENT_TYPE, line["type"])
        self.assertEqual("stt", line["leg"])
        self.assertEqual("not_json", line["code"])
        self.assertEqual("connect", line["phase"])
        self.assertIsNone(line["turn"])

    def test_a_failed_turn_names_its_turn_leg_and_error(self):
        lines, ops = recording()

        ops.turn_failed(
            turn="t1", leg="llm", reason="the model stream ended early",
            name="TimeoutError",
        )

        line = only(lines)
        self.assertEqual(TURN_FAILED_EVENT_TYPE, line["type"])
        self.assertEqual("t1", line["turn"])
        self.assertEqual("llm", line["leg"])
        self.assertEqual("TimeoutError", line["name"])
        self.assertEqual("turn", line["phase"])

    def test_a_failed_turn_must_name_its_turn(self):
        _, ops = recording()

        with self.assertRaises(EventEnvelopeError) as caught:
            ops.turn_failed(turn=None, leg="llm", reason="ended early")

        self.assertEqual("turn", caught.exception.field)


class SanitizerTests(unittest.TestCase):
    def test_no_operational_event_carries_text_audio_or_a_raw_credential(self):
        lines, ops = recording()

        ops.protocol_error(
            leg="stt",
            code=1006,
            reason="retry wss://user:pw@vendor.example/ws with Bearer abc.def",
        )
        ops.turn_failed(
            turn="t1",
            leg="llm",
            reason="key sk_live_abcdefgh1234 rejected",
            name="AuthError",
        )

        for raw in lines:
            line = json.loads(raw)
            for forbidden in ("text", "transcript", "audio", "pcm", "data", "token"):
                self.assertNotIn(forbidden, line)
        first, second = (json.loads(raw) for raw in lines)
        self.assertEqual(
            f"retry wss://{REDACTED}@vendor.example/ws with {REDACTED}",
            first["reason"],
        )
        self.assertEqual(f"key {REDACTED} rejected", second["reason"])
        self.assertNotIn("user:pw", lines[0])
        self.assertNotIn("abc.def", lines[0])
        self.assertNotIn("sk_live_abcdefgh1234", lines[1])

    def test_every_operational_event_is_written_through_the_one_stream(self):
        lines, ops = recording()
        ops.deploy_drain(reason="drain", planned=True)

        self.assertEqual(1, len(lines), "a console line is not the only trace")
        self.assertTrue(lines[0].endswith("\n"))


class LiveCallEmissionTests(unittest.TestCase):
    def lifecycle(self, *, transport, stream, speech, voice, ops, ceiling_usd=None):
        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", speech)

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "one rung", voice)

        clock = FakeClock()
        return CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=RecordingAudioSink(),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            ceiling_usd=ceiling_usd,
            operational_events=ops,
        )

    def test_the_call_emits_exactly_one_budget_stopped_event_on_breach(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0)
        clock = FakeClock()
        lifecycle = self.lifecycle(
            transport=LiveTransport(),
            stream=DeliverThenReport({"t1": OVER_CEILING}),
            speech=ScriptedSTT(
                [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
                clock=clock,
            ),
            voice=GoodbyeVoice(),
            ops=ops,
            ceiling_usd=0.25,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

        self.assertEqual("budget", end.ended_by)
        stops = [json.loads(line) for line in lines if "budget.stopped" in line]
        self.assertEqual(1, len(stops), "one breach, one budget.stopped event")
        line = stops[0]
        self.assertEqual(BUDGET_STOPPED_EVENT_TYPE, line["type"])
        self.assertEqual(CALL_ID, line["callId"])
        self.assertEqual(0.25, line["ceilingUsd"])
        self.assertAlmostEqual(0.25000125, line["spendUsd"], places=12)

    def test_the_greeting_emits_start_first_audio_and_done(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0)
        lifecycle = self.lifecycle(
            transport=FakeTransport([BrowserStop()]),
            stream=FakeStream(),
            speech=ScriptedSTT([], clock=FakeClock()),
            voice=FakeVoice(),
            ops=ops,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

        self.assertTrue(end.greeting.spoken)
        events = [json.loads(line) for line in lines]
        self.assertEqual(
            ["greeting.start", "greeting.first_audio", "greeting.done"],
            [event["type"] for event in events],
        )
        self.assertEqual(["connect"] * 3, [event["phase"] for event in events])
        self.assertEqual([None] * 3, [event["turn"] for event in events])
        self.assertEqual(2, events[-1]["frames"])

    def test_a_reconnect_recorded_on_the_budget_is_emitted_on_the_stream(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0)
        lifecycle = self.lifecycle(
            transport=FakeTransport([BrowserStop()]),
            stream=FakeStream(),
            speech=ScriptedSTT([], clock=FakeClock()),
            voice=FakeVoice(),
            ops=ops,
        )
        lifecycle.reconnect_budget.planned("stt")

        asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

        reconnects = [
            json.loads(line) for line in lines if '"reconnect"' in line
        ]
        self.assertEqual(1, len(reconnects))
        self.assertEqual("stt", reconnects[0]["leg"])
        self.assertTrue(reconnects[0]["planned"])

    def test_a_deploy_drain_is_announced_once_for_a_live_call(self):
        lines: list[str] = []
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID), sink=lines.append
        )
        ops = OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0)
        lifecycle = self.lifecycle(
            transport=FakeTransport(),
            stream=FakeStream(),
            speech=ScriptedSTT([], clock=FakeClock()),
            voice=FakeVoice(),
            ops=ops,
        )

        first = lifecycle.deploy_draining("deploy 2026.10.30: readiness failed")
        second = lifecycle.deploy_draining("deploy 2026.10.30: readiness failed")

        self.assertIs(first, second)
        self.assertEqual(1, len(lines))
        line = json.loads(lines[0])
        self.assertEqual(DEPLOY_DRAIN_EVENT_TYPE, line["type"])
        self.assertTrue(line["planned"])

    def test_a_failing_operational_sink_never_ends_the_call(self):
        class BrokenSink:
            def __call__(self, event: dict) -> None:
                raise RuntimeError("the event sink is down")

        ops = OperationalEvents(
            EventStream(EventWriter(pipeline="cascade", call_id=CALL_ID), sink=BrokenSink()),
            subject=SUBJECT,
            now=lambda: 0.0,
        )
        lifecycle = self.lifecycle(
            transport=FakeTransport([BrowserStop()]),
            stream=FakeStream(),
            speech=ScriptedSTT([], clock=FakeClock()),
            voice=FakeVoice(),
            ops=ops,
        )

        with self.assertLogs("cascade.call", level="ERROR"):
            end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
            self.assertIsNone(lifecycle.deploy_draining("sink is down"))

        self.assertEqual("stop", end.ended_by)


if __name__ == "__main__":
    unittest.main()
