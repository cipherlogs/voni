"""A second failure on a leg ends the call cleanly, with or without a goodbye.

Spec: `.scratch/meta-cascade/spec.md` M10 "One reconnect per leg per call" and
"Second failure" — a second speech or model failure ends the call with a drain
and a localized goodbye through the still-healthy voice; a second voice failure
ends without one, because there is no voice left. The end message names the
failure leg and the reason, and it is sent exactly once with the ledger, the
provider table, the reconnect budget, the cost and the eligibility facts.

Two independent authorities are used here, never the code's own arithmetic:

* the localized goodbye line comes from :data:`cascade.call.GOODBYE_LINES`,
  keyed by the body's bound Locale — the same shape as the localized hold line
  (ticket 85), so an unknown Locale refuses by name;
* the "second failure" fact comes from the ticket-94
  :class:`cascade.reconnect.ReconnectBudget`, which the fake adapter drives the
  way the real one does. The lifecycle must report that budget, never count a
  second time.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

from cascade.assemblyai_tts import SynthesisCallFailure
from cascade.call import (
    BrowserStop,
    CallLifecycle,
    OpenedLeg,
    UnknownGoodbyeLineError,
    goodbye_line,
)
from cascade.failures import classify_llm, classify_stt, classify_tts
from cascade.meta_llm import FailureDecision, MetaLLMLegExhausted
from cascade.meta_stt import SpeechCallFailure, SpeechComplete, SpeechStart
from cascade.reconnect import (
    SESSION_LIMIT,
    ReconnectAction,
    ReconnectBudget,
)
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
from cascade.testing import FakeClock, ScriptedSTT
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio


class LiveTransport:
    """A browser socket that stays open and never sends another input."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    async def receive(self):
        await asyncio.Event().wait()

    async def send(self, message) -> None:
        self.sent.append(dict(message))

    async def close(self) -> None:
        self.closed = True


class GoodbyeVoice(FakeVoice):
    """A synthesis session with a reply/goodbye path as well as a greeting."""

    def __init__(self) -> None:
        super().__init__()
        self.spoken: list[str] = []
        self.goodbye_chunks = (b"\x20\x00", b"\x21\x00")

    async def speak(self, text: str):
        self.spoken.append(text)
        for chunk in self.goodbye_chunks:
            yield SentenceAudio(pcm=chunk, sample_rate=24000, text=text)


class GatedSpeech:
    """A speech session whose second event arrives only after streaming starts."""

    def __init__(self, gate: asyncio.Event) -> None:
        self.gate = gate
        self.closed = False

    async def events(self):
        yield SpeechStart("t1")
        await self.gate.wait()
        yield SpeechComplete("book a demo", turn_id="t1")

    async def close(self) -> None:
        self.closed = True


class SecondSpeechFailureStream(FakeStream):
    """A turn layer whose speech leg spends its one reconnect, then fails.

    The first trigger failure is reconnected exactly as the speech adapter does
    (the adapter reopens the session and keeps streaming); the second failure is
    the one the ticket-94 budget answers with ``END``, and the turn layer
    surfaces it. A lifecycle that counted failures itself would report three.
    """

    def __init__(
        self, budget: ReconnectBudget, gate: asyncio.Event, verdict=None
    ) -> None:
        super().__init__()
        self.budget = budget
        self.gate = gate
        self.verdict = verdict if verdict is not None else classify_stt(1011)
        self.decisions: list[ReconnectAction] = []

    async def start(self) -> None:
        await super().start()
        self.gate.set()

    async def event(self, event) -> None:
        await super().event(event)
        if isinstance(event, SpeechStart):
            self.decisions.append(self.budget.failed(self.verdict).action)
        elif isinstance(event, SpeechComplete):
            decision = self.budget.failed(self.verdict)
            self.decisions.append(decision.action)
            raise SpeechCallFailure(
                verdict=self.verdict,
                stage="events",
                reason=(
                    "the speech socket dropped again after its one reconnect; "
                    f"{decision.reason}"
                ),
            )


class SecondModelFailureStream(FakeStream):
    """A turn layer whose model leg spends its one retry, then fails.

    The adapter records both failures on the ticket-94 budget and raises the
    exhausted-leg failure; the lifecycle must read that verdict out of the
    recorded decision, speak the goodbye, and name the model leg.
    """

    def __init__(self, budget: ReconnectBudget, gate: asyncio.Event) -> None:
        super().__init__()
        self.budget = budget
        self.gate = gate
        self.verdict = classify_llm(503)

    async def start(self) -> None:
        await super().start()
        self.gate.set()

    async def event(self, event) -> None:
        await super().event(event)
        if not isinstance(event, SpeechComplete):
            return
        first = self.budget.failed(self.verdict)
        second = self.budget.failed(self.verdict)
        raise MetaLLMLegExhausted(
            FailureDecision(
                attempt=2,
                phase="turn",
                verdict=self.verdict,
                retry=False,
                opened_leg=True,
                reason=f"{first.reason}; {second.reason}",
            )
        )


class SecondVoiceFailureStream(FakeStream):
    """A turn layer whose voice leg spends its one reconnect, then fails."""

    def __init__(self, budget: ReconnectBudget, gate: asyncio.Event) -> None:
        super().__init__()
        self.budget = budget
        self.gate = gate
        self.verdict = classify_tts(1006)

    async def start(self) -> None:
        await super().start()
        self.gate.set()

    async def event(self, event) -> None:
        await super().event(event)
        if not isinstance(event, SpeechComplete):
            return
        self.budget.failed(self.verdict)
        decision = self.budget.failed(self.verdict)
        raise SynthesisCallFailure(
            verdict=self.verdict,
            stage="reply",
            reason=f"the voice socket dropped again; {decision.reason}",
        )


class PlannedReconnectStream(FakeStream):
    """A turn layer that rotates a session between turns, not mid-sentence.

    The adapter that owns the leg records the planned reconnect on the budget
    (as the speech and voice adapters do on a session limit), and the call only
    advances its own epoch. Nothing here is a failure.
    """

    def __init__(
        self,
        lifecycle_holder: list,
        gate: asyncio.Event,
        *,
        leg: str = "tts",
        code: Any = SESSION_LIMIT,
    ) -> None:
        super().__init__()
        self.lifecycle_holder = lifecycle_holder
        self.gate = gate
        self.leg = leg
        self.code = code
        self.decision = None

    async def start(self) -> None:
        await super().start()
        lifecycle = self.lifecycle_holder[0]
        self.decision = lifecycle.reconnect_budget.planned(
            self.leg, code=self.code
        )
        lifecycle.session_reconnected()
        self.gate.set()


class ClosedVoice(GoodbyeVoice):
    """A voice session that already reported itself closed."""

    def __init__(self) -> None:
        super().__init__()
        self.closed = True


class HangingGoodbyeVoice(GoodbyeVoice):
    async def speak(self, text: str):
        self.spoken.append(text)
        await asyncio.Event().wait()
        yield  # pragma: no cover - the named bound cancels this wait


class FailingGoodbyeVoice(GoodbyeVoice):
    async def speak(self, text: str):
        self.spoken.append(text)
        raise SynthesisCallFailure(
            verdict=classify_tts(1011),
            stage="goodbye",
            reason="the voice died while speaking the goodbye",
        )
        yield  # pragma: no cover


class ImmediatelyFailingSpeech:
    """A speech session that fails before the opening has finished."""

    def __init__(self, verdict) -> None:
        self.verdict = verdict
        self.closed = False

    async def events(self):
        raise SpeechCallFailure(
            verdict=self.verdict,
            stage="events",
            reason="the speech socket dropped while the greeting sounded",
        )
        yield  # pragma: no cover

    async def close(self) -> None:
        self.closed = True


class CallHarness(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()

    def make(
        self,
        *,
        stream,
        voice,
        budget,
        transport=None,
        bounds=None,
        speech=None,
    ):
        self.transport = LiveTransport() if transport is None else transport
        self.speech = (
            ScriptedSTT(
                [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
                clock=self.clock,
            )
            if speech is None
            else speech
        )
        self.stream = stream
        self.voice = voice
        self.sink = RecordingAudioSink()

        async def open_speech(_body):
            return OpenedLeg(
                "stt", "meta", "primary", "speech leg is closed", self.speech
            )

        async def open_voice(_body):
            return OpenedLeg(
                "tts", "assemblyai", "primary", "one synthesis rung", self.voice
            )

        return CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=self.transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=self.stream,
            send_audio=self.sink,
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            bounds=bounds,
            reconnect_budget=budget,
        )


class SecondSpeechFailureTest(CallHarness):
    def test_a_second_speech_failure_ends_the_call_instead_of_hanging(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        stream = SecondSpeechFailureStream(budget, gate)
        lifecycle = self.make(
            stream=stream,
            voice=GoodbyeVoice(),
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual(
            [ReconnectAction.RECONNECT, ReconnectAction.END], stream.decisions
        )
        self.assertEqual("error", end.ended_by)
        self.assertIsNotNone(end.error)
        self.assertEqual("LegFailure", end.error.name)
        self.assertEqual("stt", end.error.trigger["leg"])
        self.assertTrue(self.stream.drained)
        self.assertTrue(end.drain.ok)
        self.assertEqual(1, len(self.transport.sent))
        self.assertTrue(self.transport.closed)

    def test_a_second_speech_failure_says_the_localized_goodbye_through_the_voice(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = GoodbyeVoice()
        lifecycle = self.make(
            stream=SecondSpeechFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        # The Locale is the bound voice's, and the line is the catalogue's.
        expected = goodbye_line(bind_voice("lola").locale.code)
        self.assertEqual([expected], voice.spoken)
        self.assertTrue(end.goodbye.spoken)
        self.assertEqual(expected, end.goodbye.text)
        goodbye_frames = [
            frame for frame in self.sink.frames if frame.kind == "goodbye"
        ]
        self.assertEqual(
            [b"\x20\x00", b"\x21\x00"], [frame.pcm for frame in goodbye_frames]
        )
        document = self.transport.sent[-1]
        self.assertEqual(expected, document["goodbye"]["text"])
        self.assertTrue(document["goodbye"]["spoken"])
        # The goodbye is not a reply: the call sequence still numbers it in one
        # unbroken order with the greeting (ticket 98), never restarting.
        self.assertEqual(
            list(range(1, len(self.sink.frames) + 1)),
            [frame.seq for frame in self.sink.frames],
        )

    def test_a_second_model_failure_says_the_goodbye_and_names_the_model_leg(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = GoodbyeVoice()
        lifecycle = self.make(
            stream=SecondModelFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual("error", end.ended_by)
        self.assertEqual("LegFailure", end.error.name)
        self.assertEqual("llm", end.error.trigger["leg"])
        self.assertEqual(503, end.error.trigger["code"])
        self.assertIn("llm leg", end.error.message)
        self.assertIn("open after the retry policy", end.error.message)
        self.assertEqual([goodbye_line("es")], voice.spoken)
        self.assertTrue(end.goodbye.spoken)
        self.assertEqual(1, len(self.transport.sent))

    def test_a_second_voice_failure_ends_without_a_spoken_goodbye(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = GoodbyeVoice()
        lifecycle = self.make(
            stream=SecondVoiceFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual("error", end.ended_by)
        self.assertEqual("tts", end.error.trigger["leg"])
        # There is no voice left, so nothing is ever sent into the dead socket,
        # even though this session carries a speak path.
        self.assertEqual([], voice.spoken)
        self.assertEqual([], [f for f in self.sink.frames if f.kind == "goodbye"])
        self.assertIsNotNone(end.goodbye)
        self.assertFalse(end.goodbye.spoken)
        self.assertIn("no voice left", end.goodbye.reason)
        # The call still ends cleanly: one end message, the socket released.
        self.assertEqual(1, len(self.transport.sent))
        self.assertEqual("end", self.transport.sent[0]["type"])
        self.assertTrue(self.transport.closed)

    def test_the_one_end_message_carries_every_fact_group_and_names_the_trigger(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        lifecycle = self.make(
            stream=SecondSpeechFailureStream(budget, gate),
            voice=GoodbyeVoice(),
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual(1, len(self.transport.sent), "the end message is sent once")
        document = self.transport.sent[0]
        self.assertEqual("end", document["type"])
        self.assertEqual(CALL_ID, document["callId"])

        # The ledger, as the managed path already writes it.
        self.assertIn("greeting_done", document["metrics"]["marks"])
        self.assertIn("marks", document["metrics"])

        # The call-level provider table: three cascade legs, the model null.
        self.assertEqual(("stt", "llm", "tts"), tuple(document["providers"]))
        self.assertEqual("meta", document["providers"]["stt"]["provider"])
        self.assertEqual("assemblyai", document["providers"]["tts"]["provider"])
        self.assertIsNone(document["providers"]["llm"]["provider"])

        # The reconnect budget is the ticket-94 budget's own document.
        self.assertIs(lifecycle.reconnect_budget, budget)
        self.assertEqual(budget.to_document(), document["reconnect"])
        self.assertEqual(1, document["reconnect"]["budgetPerLeg"])
        self.assertEqual(2, document["reconnect"]["legs"]["stt"]["failures"])
        self.assertEqual(
            1, document["reconnect"]["legs"]["stt"]["failureReconnects"]
        )
        self.assertEqual(0, document["reconnect"]["legs"]["stt"]["budgetLeft"])

        # The cost: no meter ran, so it is unmeasured and never zero-priced.
        self.assertFalse(document["cost"]["measured"])
        self.assertIsNone(document["cost"]["totalUsd"])

        # Eligibility: still a cascade call, never moved to the managed path.
        self.assertEqual("cascade", document["eligibility"]["disposition"])
        self.assertEqual([], document["eligibility"]["reasons"])

        # The failure is named: leg, class, code and reason.
        self.assertEqual("error", document["endedBy"])
        self.assertEqual("stt", document["error"]["trigger"]["leg"])
        self.assertEqual(1011, document["error"]["trigger"]["code"])
        self.assertEqual("trigger", document["error"]["trigger"]["class"])
        self.assertEqual(
            "internal/backend failure: retry once with a new session",
            document["error"]["trigger"]["reason"],
        )
        self.assertEqual("LegFailure", document["error"]["name"])
        # Nothing moved the product: no managed fact appears in the end message.
        self.assertNotIn("managed", json.dumps(document).lower())


class PlannedReconnectTest(CallHarness):
    def test_a_planned_reconnect_never_counts_as_a_failure_and_never_ends_the_call(self):
        # The speech session's 60-minute limit and the voice session's expiry
        # are operational facts: both rotate the session, neither is a failure.
        for leg, code in (("stt", SESSION_LIMIT), ("tts", 3008)):
            with self.subTest(leg=leg):
                self.setUp()
                budget = ReconnectBudget(now=self.clock)
                holder: list = []
                gate = asyncio.Event()
                gate.set()
                stream = PlannedReconnectStream(holder, gate, leg=leg, code=code)
                lifecycle = self.make(
                    stream=stream,
                    voice=GoodbyeVoice(),
                    budget=budget,
                    transport=FakeTransport([BrowserStop()]),
                )
                holder.append(lifecycle)

                end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

                self.assertIs(
                    ReconnectAction.PLANNED_RECONNECT, stream.decision.action
                )
                counters = budget.counters(leg)
                self.assertEqual(0, counters.failures)
                self.assertEqual(0, counters.failure_reconnects)
                self.assertEqual(1, counters.planned_reconnects)
                self.assertEqual(1, counters.budget_left)
                self.assertEqual(1, lifecycle.sequence.epoch)
                self.assertEqual("stop", end.ended_by)
                self.assertIsNone(end.goodbye)
                document = self.transport.sent[0]
                self.assertEqual(
                    1, document["reconnect"]["legs"][leg]["plannedReconnects"]
                )
                self.assertEqual(0, document["reconnect"]["legs"][leg]["failures"])


class GoodbyeSafetyTest(CallHarness):
    def test_a_failure_during_the_greeting_ends_without_starting_the_turn_layer(self):
        budget = ReconnectBudget(now=self.clock)
        voice = GoodbyeVoice()
        lifecycle = self.make(
            stream=FakeStream(),
            voice=voice,
            budget=budget,
            speech=ImmediatelyFailingSpeech(classify_stt(1011)),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertFalse(self.stream.started)
        self.assertFalse(self.stream.drained)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("stt", end.error.trigger["leg"])
        self.assertTrue(end.goodbye.spoken)
        self.assertEqual(1, len(self.transport.sent))

    def test_the_goodbye_is_never_written_into_an_already_closed_voice(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = ClosedVoice()
        lifecycle = self.make(
            stream=SecondSpeechFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual([], voice.spoken)
        self.assertFalse(end.goodbye.spoken)
        self.assertIn("already closed", end.goodbye.reason)
        self.assertEqual(1, len(self.transport.sent))

    def test_a_hanging_goodbye_is_bounded_and_the_call_still_ends(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = HangingGoodbyeVoice()
        lifecycle = self.make(
            stream=SecondSpeechFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
            bounds={"tts.idle_timeout_ms": 10},
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual([goodbye_line("es")], voice.spoken)
        self.assertFalse(end.goodbye.spoken)
        self.assertIn("GoodbyeTimedOut", end.goodbye.reason)
        self.assertIn("tts.idle_timeout_ms", end.goodbye.reason)
        self.assertEqual(1, len(self.transport.sent))
        self.assertTrue(self.transport.closed)

    def test_a_goodbye_that_fails_still_sends_the_one_end_message(self):
        budget = ReconnectBudget(now=self.clock)
        gate = asyncio.Event()
        voice = FailingGoodbyeVoice()
        lifecycle = self.make(
            stream=SecondSpeechFailureStream(budget, gate),
            voice=voice,
            budget=budget,
            speech=GatedSpeech(gate),
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual([goodbye_line("es")], voice.spoken)
        self.assertFalse(end.goodbye.spoken)
        self.assertIn("SynthesisCallFailure", end.goodbye.reason)
        self.assertEqual(1, len(self.transport.sent))
        # The failure the call ended on is still the speech leg's, not the
        # goodbye's: the goodbye is a courtesy, not a second ending.
        self.assertEqual("stt", end.error.trigger["leg"])


class GoodbyeCatalogueTest(unittest.TestCase):
    def test_every_bound_locale_has_a_goodbye_line(self):
        for code in ("en", "es", "fr", "de", "it", "pt"):
            with self.subTest(locale=code):
                self.assertTrue(goodbye_line(code).strip())

    def test_an_unknown_locale_is_refused_by_name(self):
        with self.assertRaises(UnknownGoodbyeLineError) as raised:
            goodbye_line("xx")
        self.assertIn('"xx"', str(raised.exception))
        self.assertEqual("xx", raised.exception.locale_code)
