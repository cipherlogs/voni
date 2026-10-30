"""A served call charges the day it consumed (tickets 102/103/104).

Seam: :class:`cascade.call.CallLifecycle` now hands each recorded vendor unit to
ticket 102's :class:`cascade.counter.DailyCounter`, priced by ticket 101's rate
table. The tests prove three things the money policy needs:

* each recorded turn is charged once, as its own unit set (so a reconnect or a
  fallback leg adds a record instead of being lost);
* two calls' spend crosses the 80% line, and the *next* admission routes managed
  while a live call is untouched;
* at the 100% line the next admission refuses cascade and still admits the call
  (managed), and each line's ``budget.crossing`` event is emitted once per day.

Amounts come from the committed rate record, never from the code under test:
8,000,000 prompt tokens at USD 1.25 per million is USD 10.00.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from decimal import Decimal
from types import SimpleNamespace

from cascade.admission import admit_new_call
from cascade.call import CallLifecycle, OpenedLeg
from cascade.counter import DailyCounter
from cascade.events import EventStream, EventWriter, OperationalEvents
from cascade.meta_llm import TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.routing import CallSubject, RoutingSwitch
from cascade.store import MemoryStore
from cascade.test_call import (
    BODY,
    CALL_ID,
    ISSUED_S,
    SECRET,
    BrowserStop,
    FakeTransport,
    RecordingAudioSink,
    signed_message,
)
from cascade.test_call_ceiling import DeliverThenReport, PerTurnStream
from cascade.test_daily_cap_refusal import NOON
from cascade.test_second_failure import GoodbyeVoice, LiveTransport
from cascade.testing import FakeClock, ScriptedSTT
from metrics import TimingLedger

SUBJECT = CallSubject("tenant-daily-charge", "tenant")


def usage(prompt_tokens: int) -> TurnUsage:
    return TurnUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=0,
        cached_tokens=0,
        reasoning_tokens=0,
        measured=True,
    )


def open_switch(store: MemoryStore) -> RoutingSwitch:
    async def seed() -> RoutingSwitch:
        switch = RoutingSwitch(store, now=lambda: NOON)
        await switch.set_mode("all", actor="test", reason="measure the day")
        return switch

    return asyncio.run(seed())


class LifecycleForCharge:
    """One served call with the daily counter wired in."""

    def __init__(
        self,
        *,
        stream,
        counter=None,
        on_crossing=None,
        operational_events=None,
        voice=None,
        call_id: str = CALL_ID,
        ceiling_usd: float | None = 0.25,
        events=None,
        transport=None,
        body=None,
    ) -> None:
        self.clock = FakeClock()
        self.speech = ScriptedSTT(
            events
            if events is not None
            else [SpeechStart("t1"), SpeechComplete("hello", turn_id="t1")],
            clock=self.clock,
        )
        self.voice = GoodbyeVoice() if voice is None else voice

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg", self.speech)

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "voice leg", self.voice)

        self.lifecycle = CallLifecycle(
            message=signed_message(body),
            secret=SECRET,
            call_id=call_id,
            transport=LiveTransport() if transport is None else transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=RecordingAudioSink(),
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            ceiling_usd=ceiling_usd,
            daily_counter=counter,
            on_crossing=on_crossing,
            operational_events=operational_events,
        )

    def run(self):
        return asyncio.run(asyncio.wait_for(self.lifecycle.run(), timeout=5.0))


def ops_for(call_id: str = CALL_ID):
    lines: list[str] = []
    stream = EventStream(
        EventWriter(pipeline="cascade", call_id=call_id), sink=lines.append
    )
    return OperationalEvents(stream, subject=SUBJECT.subject_id, now=lambda: 0.0), lines


class PerRecordChargeTests(unittest.TestCase):
    def test_each_recorded_turn_is_charged_once_as_its_own_unit_set(self):
        class RecordingCounter:
            def __init__(self) -> None:
                self.amounts: list[Decimal | None] = []

            async def charge(self, call_cost) -> SimpleNamespace:
                self.amounts.append(call_cost.amount)
                return SimpleNamespace(crossings=())

        counter = RecordingCounter()
        stream = PerTurnStream(
            {"t1": usage(80_000), "t2": usage(160_000)}
        )
        call = LifecycleForCharge(
            stream=stream,
            counter=counter,
            events=[
                SpeechStart("t1"),
                SpeechComplete("first", turn_id="t1"),
                SpeechStart("t2"),
                SpeechComplete("second", turn_id="t2"),
            ],
        )

        end = call.run()

        self.assertEqual("budget", end.ended_by)
        # Two vendor records, two charges: reconnects and fallback legs are
        # separate unit sets and are never collapsed into one charge. 80,000
        # and 160,000 prompt tokens are USD 0.10 and USD 0.20 at the v1 rate.
        self.assertEqual(
            [Decimal("0.10"), Decimal("0.20")], counter.amounts
        )


class CrossingAndAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = MemoryStore()
        self.switch = open_switch(self.store)
        self.counter = DailyCounter(self.store, now=lambda: NOON)
        self.crossings = []

    def charge_one_call(self, *, prompt_tokens: int, call_id: str):
        ops, lines = ops_for(call_id)
        call = LifecycleForCharge(
            stream=DeliverThenReport({"t1": usage(prompt_tokens)}),
            counter=self.counter,
            on_crossing=self.crossings.append,
            operational_events=ops,
            call_id=call_id,
        )
        end = call.run()
        return end, lines

    def admission(self):
        opened = []

        async def open_cascade():
            opened.append("cascade")
            return "socket"

        async def decide():
            return await admit_new_call(
                self.switch, SUBJECT, open_cascade=open_cascade, budget=self.counter
            )

        return asyncio.run(decide()), opened

    def test_two_calls_charge_the_day_and_the_next_admission_routes_managed(self):
        self.charge_one_call(prompt_tokens=8_000_000, call_id=CALL_ID)
        self.charge_one_call(prompt_tokens=8_000_000, call_id=CALL_ID)

        day = asyncio.run(self.counter.snapshot(at=NOON))
        admission, opened = self.admission()

        self.assertEqual(Decimal("20"), day.spent)
        self.assertEqual(["route_managed"], [c.line for c in self.crossings])
        self.assertEqual("managed", admission.decision.disposition)
        self.assertIn("80.0%", admission.decision.reason)
        self.assertEqual(0, admission.connections)
        self.assertEqual([], opened, "a managed decision opened a vendor socket")

    def test_at_the_cap_the_next_admission_refuses_cascade_and_never_the_call(self):
        for index in range(3):
            self.charge_one_call(
                prompt_tokens=8_000_000, call_id=CALL_ID
            )

        day = asyncio.run(self.counter.snapshot(at=NOON))
        admission, opened = self.admission()

        self.assertEqual(Decimal("30"), day.spent)
        # Both lines are durable and emitted once each: 80% by the second call,
        # 100% by the third.
        self.assertEqual(
            ["route_managed", "refuse_cascade"],
            [c.line for c in self.crossings],
        )
        self.assertEqual("managed", admission.decision.disposition)
        self.assertIn("cascade is refused for new calls", admission.decision.reason)
        self.assertIn("the call itself is never refused", admission.decision.reason)
        # Refusing cascade is a routing decision: the call is still admitted.
        self.assertEqual(0, admission.connections)
        self.assertEqual([], opened)

    def test_the_crossing_event_is_emitted_once_per_day_per_line(self):
        _, first = self.charge_one_call(
            prompt_tokens=8_000_000, call_id=CALL_ID
        )
        _, second = self.charge_one_call(
            prompt_tokens=8_000_000, call_id=CALL_ID
        )
        _, third = self.charge_one_call(
            prompt_tokens=8_000_000, call_id=CALL_ID
        )

        def crossing_lines(lines):
            return [
                line
                for line in (json.loads(row) for row in lines)
                if line["type"] == "budget.crossing"
            ]

        self.assertEqual([], crossing_lines(first))
        managed = crossing_lines(second)
        self.assertEqual(1, len(managed))
        self.assertEqual("route_managed", managed[0]["line"])
        self.assertEqual(CALL_ID, managed[0]["callId"])
        refused = crossing_lines(third)
        self.assertEqual(1, len(refused))
        self.assertEqual("refuse_cascade", refused[0]["line"])

    def test_an_unmeasured_record_is_not_charged_as_zero(self):
        # A call whose only recorded turn has no usage chunk records its
        # absence on the end message's cost, but the daily bucket never adds a
        # fabricated zero: the measured spend stays zero and no crossing fires.
        class UnmeasuredStream(DeliverThenReport):
            pass

        call = LifecycleForCharge(
            stream=UnmeasuredStream({"t1": TurnUsage.unmeasured()}),
            counter=self.counter,
            body={key: value for key, value in BODY.items() if key != "greeting"},
            transport=FakeTransport([BrowserStop()]),
        )
        call.run()

        day = asyncio.run(self.counter.snapshot(at=NOON))
        self.assertEqual(Decimal("0"), day.spent)
        self.assertFalse(day.would_route_managed)
        self.assertEqual([], [c.line for c in self.crossings])


if __name__ == "__main__":
    unittest.main()
