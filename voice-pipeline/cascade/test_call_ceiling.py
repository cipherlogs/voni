"""The per-call ceiling drains the call; it never truncates speech (ticket 105).

Seam: :class:`cascade.call.CallLifecycle`. The ceiling is priced from ticket
101's rate table over ticket 100's recorded units, and the breach is detected
as the turn layer reports each unit — never from an estimate in this module.

Expected amounts come from the committed rate record, not from the code under
test: 200,001 prompt tokens at USD 1.25 per million is USD 0.25000125, which is
over the supplied USD 0.25 ceiling by a hair. The localized goodbye comes from
:data:`cascade.call.GOODBYE_LINES` keyed by the body's bound Locale.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from decimal import Decimal

from cascade.assemblyai_tts import Billing
from cascade.call import BrowserStop, CallLifecycle, OpenedLeg, goodbye_line
from cascade.meta_llm import TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    FakeStream,
    FakeTransport,
    FakeVoice,
    RecordingAudioSink,
    signed_message,
)
from cascade.test_second_failure import GoodbyeVoice, LiveTransport
from cascade.testing import FakeClock, ScriptedSTT
from metrics import TimingLedger

OVER_CEILING = TurnUsage(
    prompt_tokens=200_001,
    completion_tokens=0,
    cached_tokens=0,
    reasoning_tokens=0,
    measured=True,
)


class CeilingStream(FakeStream):
    """A turn layer that reports a model turn's usage as the turn closes."""

    def __init__(self, usage: dict | None = None) -> None:
        super().__init__()
        self.usage = {} if usage is None else usage

    def turn_usage(self):
        return self.usage


class DeliverThenReport(CeilingStream):
    """Reports ``usage`` after the first event, like a completed model turn."""

    def __init__(self, usage: dict) -> None:
        super().__init__({})
        self.reported = usage

    async def event(self, event) -> None:
        await super().event(event)
        self.usage = self.reported


class PerTurnStream(CeilingStream):
    """Adds one turn's usage as each turn closes, like the model stream."""

    def __init__(self, usage_by_turn: dict[str, TurnUsage]) -> None:
        super().__init__({})
        self.usage_by_turn = usage_by_turn
        self.delivered: list[str] = []

    async def event(self, event) -> None:
        await super().event(event)
        self.delivered.append(type(event).__name__)
        turn = getattr(event, "turn_id", None)
        if isinstance(event, SpeechComplete) and turn in self.usage_by_turn:
            self.usage = {**self.usage, turn: self.usage_by_turn[turn]}

    def turn_usage(self):
        return dict(self.usage)


class BillingGoodbyeVoice(GoodbyeVoice):
    """A voice whose ``Termination`` characters include the spoken goodbye."""

    def __init__(self) -> None:
        super().__init__()
        self.characters = 10  # the greeting

    @property
    def billing(self) -> Billing:
        return Billing(
            characters=self.characters,
            measured=True,
            source="billed_characters",
            audio_duration_seconds=3.0,
            session_duration_seconds=5,
        )

    async def speak(self, text: str):
        self.characters += 50  # the goodbye's own billed characters
        async for audio in super().speak(text):
            yield audio


class OrderedSink:
    """The audio seam: records how many end messages had gone out per frame."""

    def __init__(self, transport, log: list[tuple[str, int]]) -> None:
        self.transport = transport
        self.log = log

    async def __call__(self, frame) -> None:
        self.log.append((frame.kind, len(self.transport.sent)))


class CeilingTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.envelope_clock = FakeClock(ISSUED_S)

    def make(
        self,
        *,
        transport,
        stream,
        voice=None,
        ceiling_usd=None,
        usage_meter=None,
        events=None,
        send_audio=None,
        on_budget_stopped=None,
    ):
        self.speech = ScriptedSTT(
            events
            if events is not None
            else [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            clock=self.clock,
        )
        self.voice = GoodbyeVoice() if voice is None else voice

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", self.speech)

        async def open_voice(_body):
            return OpenedLeg(
                "tts", "assemblyai", "primary", "one synthesis rung", self.voice
            )

        return CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=send_audio if send_audio is not None else RecordingAudioSink(),
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            envelope_clock=self.envelope_clock,
            drain_bound_ms=1000,
            ceiling_usd=ceiling_usd,
            usage_meter=usage_meter,
            on_budget_stopped=on_budget_stopped,
        )

    def run_call(self, lifecycle):
        return asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

    def test_a_single_model_turn_that_crosses_the_ceiling_drains_and_says_goodbye(self):
        stream = DeliverThenReport({"t1": OVER_CEILING})
        lifecycle = self.make(transport=LiveTransport(), stream=stream)

        end = self.run_call(lifecycle)
        document = end.to_document()

        self.assertEqual("budget", end.ended_by)
        self.assertTrue(end.drain.ok)
        self.assertTrue(stream.drained)
        self.assertIsNotNone(end.goodbye)
        self.assertTrue(end.goodbye.spoken)
        self.assertEqual(goodbye_line("es"), end.goodbye.text)
        self.assertEqual(2, end.goodbye.frames)
        self.assertIn("budget_stopped", end.metrics["marks"])
        # The breach latched before the next provider event: no new turn work.
        self.assertEqual(1, len(stream.events))
        self.assertFalse(lifecycle.may_request("llm"))
        self.assertFalse(lifecycle.may_request("tts"))
        self.assertTrue(lifecycle.may_request("goodbye"))
        self.assertEqual(0.25, document["budget"]["ceilingUsd"])
        self.assertAlmostEqual(0.25000125, document["budget"]["spendUsd"], places=12)
        # Money is a Decimal on the record; the document carries JSON numbers.
        self.assertIsInstance(end.budget.spend_usd, Decimal)
        self.assertIsInstance(end.budget.ceiling_usd, Decimal)
        self.assertIsInstance(document["budget"]["spendUsd"], float)
        self.assertIn("ceiling", document["budget"]["reason"])
        self.assertEqual(
            "budget_stopped",
            json.loads(json.dumps(document))["budget"]["mark"],
        )

    def test_an_unmeasured_cost_takes_no_false_stop_and_is_never_zero(self):
        stream = DeliverThenReport({"t1": TurnUsage.unmeasured()})
        lifecycle = self.make(
            transport=FakeTransport([BrowserStop()]), stream=stream
        )

        end = self.run_call(lifecycle)
        cost = end.to_document()["cost"]

        self.assertEqual("stop", end.ended_by)
        self.assertIsNone(end.budget)
        self.assertNotIn("budget_stopped", end.metrics["marks"])
        self.assertIsNone(end.goodbye)
        self.assertFalse(cost["measured"])
        self.assertIsNone(cost["totalUsd"])
        self.assertIn("no usage chunk", cost["unmeasuredReason"])

    def test_a_measured_floor_below_the_ceiling_does_not_stop_the_call(self):
        # 1,000 prompt tokens is USD 0.00125 at the committed v1 rate: under the
        # ceiling, even though speech and voice have not reported yet.
        under = TurnUsage(
            prompt_tokens=1_000,
            completion_tokens=0,
            cached_tokens=0,
            reasoning_tokens=0,
            measured=True,
        )
        stream = DeliverThenReport({"t1": under})
        lifecycle = self.make(
            transport=FakeTransport([BrowserStop()]), stream=stream
        )

        end = self.run_call(lifecycle)

        self.assertEqual("stop", end.ended_by)
        self.assertIsNone(end.budget)
        self.assertIsNone(end.goodbye)

    def test_spend_exactly_at_the_ceiling_is_a_breach(self):
        # 200,000 prompt tokens at USD 1.25 per million is exactly USD 0.25.
        exact = TurnUsage(
            prompt_tokens=200_000,
            completion_tokens=0,
            cached_tokens=0,
            reasoning_tokens=0,
            measured=True,
        )
        lifecycle = self.make(
            transport=LiveTransport(),
            stream=DeliverThenReport({"t1": exact}),
        )

        end = self.run_call(lifecycle)

        self.assertEqual("budget", end.ended_by)
        self.assertEqual(0.25, end.budget.ceiling_usd)
        self.assertEqual(Decimal("0.25"), end.budget.spend_usd)

    def test_the_ceiling_is_checked_after_each_billable_unit(self):
        # Two model turns: 100,000 tokens is USD 0.125, then 200,000 more
        # brings the priced spend to USD 0.375 — over the ceiling only after
        # the second turn. A check only at the end could not end it as "budget".
        turns = {
            "t1": TurnUsage(
                prompt_tokens=100_000,
                completion_tokens=0,
                cached_tokens=0,
                reasoning_tokens=0,
                measured=True,
            ),
            "t2": TurnUsage(
                prompt_tokens=200_000,
                completion_tokens=0,
                cached_tokens=0,
                reasoning_tokens=0,
                measured=True,
            ),
        }
        stream = PerTurnStream(turns)
        lifecycle = self.make(
            transport=LiveTransport(),
            stream=stream,
            events=[
                SpeechStart("t1"),
                SpeechComplete("book a demo", turn_id="t1"),
                SpeechStart("t2"),
                SpeechComplete("tell me more", turn_id="t2"),
            ],
        )

        end = self.run_call(lifecycle)

        self.assertEqual("budget", end.ended_by)
        self.assertEqual(Decimal("0.375"), end.budget.spend_usd)
        # Both turns up to the breach reached the turn layer; nothing after it.
        self.assertEqual(
            ["SpeechStart", "SpeechComplete", "SpeechStart", "SpeechComplete"],
            stream.delivered,
        )
        self.assertFalse(lifecycle.may_request("llm"))
        self.assertFalse(lifecycle.may_request("tts"))
        self.assertTrue(lifecycle.may_request("goodbye"))

    def test_the_goodbye_is_spoken_before_the_end_signal_and_its_cost_is_recorded(self):
        transport = LiveTransport()
        log: list[tuple[str, int]] = []
        stops = []
        voice = BillingGoodbyeVoice()
        lifecycle = self.make(
            transport=transport,
            stream=DeliverThenReport({"t1": OVER_CEILING}),
            voice=voice,
            send_audio=OrderedSink(transport, log),
            on_budget_stopped=stops.append,
        )

        end = self.run_call(lifecycle)

        goodbye = [row for row in log if row[0] == "goodbye"]
        self.assertTrue(goodbye)
        # The closing line is spoken while no end message has been sent yet.
        self.assertEqual([0] * len(goodbye), [row[1] for row in goodbye])
        self.assertEqual("end", transport.sent[-1]["type"])
        # One stop: the goodbye's recorded cost cannot re-trigger the ceiling.
        self.assertEqual(1, len(stops))
        self.assertIs(stops[0], end.budget)
        self.assertEqual(Decimal("0.25000125"), end.budget.spend_usd)
        tts = end.to_document()["cost"]["legs"]["tts"]
        self.assertEqual(60, tts["units"]["characters"])
        self.assertAlmostEqual(0.0009, tts["amountUsd"], places=12)


class ServedStreamCeilingTest(unittest.TestCase):
    """The served turn stream reports a model turn as it finishes.

    The check that matters is at the *unit*, not at the next speech event: one
    expensive turn must trip the ceiling and drain with the closing line, never
    leave the call waiting for another provider event.
    """

    def test_one_expensive_model_turn_ends_the_call_with_the_closing_line(self):
        from cascade.turn_stream import CascadeTurnStream

        clock = FakeClock()
        envelope_clock = FakeClock(ISSUED_S)
        voice = GoodbyeVoice()

        class ExpensiveLLM:
            def __init__(self) -> None:
                self.requests: list[list[dict]] = []

            async def complete(self, *, messages, tools=None, turn=None):
                from cascade.meta_llm import MetaLLMTurn, TurnUsage
                from providers import TokenDelta

                self.requests.append(messages)
                record = turn if turn is not None else MetaLLMTurn()
                first, second = "Here is the first part. ", "And the second part."
                record.content_text = first + second
                yield TokenDelta(text=first)
                yield TokenDelta(text=second)
                record.finish_reason = "stop"
                record.usage = TurnUsage(
                    prompt_tokens=200_001,
                    completion_tokens=0,
                    cached_tokens=0,
                    reasoning_tokens=0,
                    measured=True,
                )
                record.finished = True

        llm = ExpensiveLLM()
        holder: dict[str, CallLifecycle] = {}

        async def on_turn_billed() -> None:
            await holder["lifecycle"].note_billed()

        stream = CascadeTurnStream(
            llm=llm,
            tts=voice,
            emit_audio=lambda audio, kind="reply", flush_id=None: _emit(audio),
            clock=clock,
            on_turn_billed=on_turn_billed,
        )

        async def _emit(audio):
            return await holder["lifecycle"].emit_audio(audio)

        self.speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("tell me everything", turn_id="t1")],
            clock=clock,
        )

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", self.speech)

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "one synthesis rung", voice)

        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=LiveTransport(),
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=RecordingAudioSink(),
            ledger=TimingLedger(now=clock),
            clock=clock,
            envelope_clock=envelope_clock,
            drain_bound_ms=1000,
            ceiling_usd=0.25,
        )
        holder["lifecycle"] = lifecycle

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

        self.assertEqual("budget", end.ended_by)
        # Everything the turn produced was spoken through, in whole sentences.
        self.assertEqual(
            ["Here is the first part.", "And the second part.", goodbye_line("es")],
            voice.spoken,
        )
        self.assertTrue(end.goodbye.spoken)
        self.assertTrue(end.drain.ok)
        self.assertEqual(1, len(llm.requests), "a turn after the breach was answered")
