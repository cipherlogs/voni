"""Call lifecycle: verify, open, stream, drain and the end message (ticket 75).

Seam: :class:`cascade.call.CallLifecycle` is driven by an injected transport,
so this test never opens a socket. The transport's ``receive()`` yields the
already-decoded browser inputs (an audio frame, a stop, a context update) or
``None`` when the socket dropped. Speech, voice and the optional model are
opened through injected factories, which is how "no vendor socket before the
body verifies" is observed rather than assumed.

Independent expected values:

- the signed body and its vectors come from ``envelope_vectors.json`` (minted
  with Node's crypto), so a body the adapter refuses is a real served body;
- the measured cost is a hand-written fake meter value, and the unmeasured case
  is asserted as ``None`` — an unmeasured unit is never turned into zero.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

from cascade import thresholds
from cascade.assemblyai_tts import Billing
from cascade.call import (
    BOUNDED_WAITS,
    AudioFrame,
    BrowserStop,
    CallLifecycle,
    CallStream,
    ContextUpdate,
    CostSummary,
    LegCost,
    OpenedLeg,
    OutboundAudio,
)
from cascade.eligibility import evaluate_body
from cascade.envelope import sign_body
from cascade.body_map import body_fingerprint
from cascade.meta_llm import TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.testing import FakeClock, ScriptedSTT
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio

VECTORS = json.loads(
    Path(__file__).with_name("envelope_vectors.json").read_text(encoding="utf-8")
)
BODY = VECTORS["body"]
ACCOUNT = VECTORS["account_salt"]
MINTED = VECTORS["minted_fingerprint"]
SECRET = VECTORS["secret"]
CALL_ID = VECTORS["call_id"]
AGENT_ID = VECTORS["agent_id"]
TTL_MS = VECTORS["expires_at_ms"] - VECTORS["issued_at_ms"]
ISSUED_S = VECTORS["issued_at_ms"] / 1000.0

#: "No argument given": distinct from an explicit ``send_audio=None``.
_UNSET = object()


def signed_message(body=None) -> dict:
    """One real signed wire message, minting the body's own fingerprint."""
    payload = BODY if body is None else body
    signed = sign_body(
        body=payload,
        minted_fingerprint=body_fingerprint(payload, account_salt=ACCOUNT),
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=CALL_ID,
        agent_id=AGENT_ID,
        ttl_ms=TTL_MS,
        clock=FakeClock(ISSUED_S),
    )
    return json.loads(json.dumps(signed.message()))


class FakeTransport:
    """The browser seam: scripted inputs, a recorded outbox and a close."""

    def __init__(self, inputs=()) -> None:
        self.inputs = list(inputs)
        self.sent: list[dict] = []
        self.closed = False

    async def receive(self):
        # One loop turn so a concurrently running event pump can deliver.
        await asyncio.sleep(0)
        if not self.inputs:
            return None
        return self.inputs.pop(0)

    async def send(self, message) -> None:
        self.sent.append(dict(message))

    async def close(self) -> None:
        self.closed = True


class FakeStream(CallStream):
    """Records everything the lifecycle streams into the turn layer."""

    def __init__(self, log: list[str] | None = None) -> None:
        self.log = log if log is not None else []
        self.started = False
        self.events: list[object] = []
        self.contexts: list[str] = []
        self.drained = False
        self.turns = 0

    async def start(self) -> None:
        self.started = True
        self.log.append("stream")

    async def event(self, event) -> None:
        self.events.append(event)
        if isinstance(event, SpeechStart):
            self.turns += 1

    async def context(self, text: str) -> None:
        self.contexts.append(text)

    async def drain(self) -> None:
        self.drained = True

    def turn_count(self) -> int:
        return self.turns


class HangingDrainStream(FakeStream):
    async def drain(self) -> None:
        await asyncio.Event().wait()


class MeteringStream(FakeStream):
    """A turn layer that reports the model usage chunks it received."""

    def __init__(self, usage, log: list[str] | None = None) -> None:
        super().__init__(log)
        self.usage = usage

    def turn_usage(self):
        return self.usage


class FakeVoice:
    """The opened synthesis session: a bound voice and its greeting path."""

    def __init__(self, *, fail=None, greeting_failure=None) -> None:
        self.binding = bind_voice("lola")
        self.closed = False
        self.greeted: list[str] = []
        self.greeting_chunks = (b"\x10\x00", b"\x11\x00")
        self.greeting_failure = fail if fail is not None else greeting_failure

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        if self.greeting_failure is not None:
            raise self.greeting_failure
        for chunk in self.greeting_chunks:
            yield SentenceAudio(pcm=chunk, sample_rate=24000, text=text)

    async def close(self) -> None:
        self.closed = True


class RecordingAudioSink:
    """The lifecycle's audio seam: records frames and what had been heard."""

    def __init__(self, probe=None) -> None:
        self.frames: list[OutboundAudio] = []
        self.probe = probe
        self.heard_at_frame: list[list[bytes]] = []

    async def __call__(self, audio: OutboundAudio) -> None:
        self.frames.append(audio)
        if self.probe is not None:
            self.heard_at_frame.append(self.probe())


class HangingCloseVoice(FakeVoice):
    async def close(self) -> None:
        await asyncio.Event().wait()


class MeteringVoice(FakeVoice):
    """A synthesis session that closed with the vendor's ``Termination`` facts."""

    def __init__(self, billing: Billing) -> None:
        super().__init__()
        self.billing = billing


class HangingGreetingVoice(FakeVoice):
    """A voice whose greeting synthesis never produces its first frame."""

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        await asyncio.Event().wait()
        yield  # pragma: no cover - the bound cancels this wait


class CallLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.envelope_clock = FakeClock(ISSUED_S)

    def make(
        self,
        *,
        transport,
        body=None,
        message=None,
        speech=None,
        voice=None,
        stream=None,
        open_model=None,
        eligibility=None,
        cost_meter=None,
        drain_bound_ms=1000,
        opens=None,
        log=None,
        fail_voice=None,
        model_session=None,
        send_audio=_UNSET,
        bounds=None,
    ):
        self.opens = [] if opens is None else opens
        self.log = [] if log is None else log
        self.speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            clock=self.clock,
        ) if speech is None else speech
        self.voice = FakeVoice() if voice is None else voice
        self.stream = FakeStream(self.log) if stream is None else stream
        if send_audio is _UNSET:
            send_audio = RecordingAudioSink(
                lambda: (list(self.speech.audio), self.stream.started)
            )
        self.sink = send_audio

        async def open_speech(_body):
            self.opens.append("speech")
            self.log.append("speech")
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", self.speech)

        async def open_voice(_body):
            self.opens.append("voice")
            self.log.append("voice")
            if fail_voice is not None:
                raise fail_voice
            return OpenedLeg("tts", "assemblyai", "primary", "one synthesis rung", self.voice)

        async def open_the_model(_body):
            self.opens.append("model")
            self.log.append("model")
            return OpenedLeg(
                "llm", "spark", "primary", "model leg is closed", model_session
            )

        return CallLifecycle(
            message=signed_message(body) if message is None else message,
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            open_model=open_the_model if open_model else None,
            stream=self.stream,
            send_audio=send_audio,
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            envelope_clock=self.envelope_clock,
            drain_bound_ms=drain_bound_ms,
            bounds=bounds,
            cost_meter=cost_meter,
            eligibility=eligibility,
        )

    def run_call(self, lifecycle):
        return asyncio.run(lifecycle.run())

    # -- a call that verifies opens, then streams -------------------------

    def test_a_verified_call_opens_speech_and_voice_before_it_streams(self):
        self.clock.advance(1.25)
        transport = FakeTransport([AudioFrame(b"\x01\x02"), BrowserStop()])
        lifecycle = self.make(transport=transport, open_model=True)

        end = self.run_call(lifecycle)

        self.assertEqual(
            1.25, end.metrics["marks"]["audio_in"]
        )

        self.assertEqual(["speech", "voice", "model", "stream"], self.log)
        self.assertEqual([b"\x01\x02"], self.speech.audio)
        self.assertEqual(
            [SpeechStart, SpeechComplete],
            [type(event) for event in self.stream.events],
        )
        self.assertTrue(self.speech.closed)
        self.assertTrue(self.voice.closed)
        self.assertTrue(self.stream.drained)
        self.assertEqual("stop", end.ended_by)
        self.assertTrue(end.drain.ok)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)

    # -- the greeting is spoken before any caller audio (ticket 77) -------

    def test_the_greeting_is_spoken_before_any_user_audio_or_stream_start(self):
        transport = FakeTransport([AudioFrame(b"\xaa\xbb"), BrowserStop()])

        self.run_call(self.make(transport=transport))

        self.assertEqual(["Hi, this is Voni."], self.voice.greeted)
        self.assertEqual(
            [b"\x10\x00", b"\x11\x00"], [frame.pcm for frame in self.sink.frames]
        )
        # At the first greeting frame no caller audio had been forwarded and
        # the turn layer had not started.
        self.assertEqual([([], False)], self.sink.heard_at_frame[:1])
        self.assertEqual([b"\xaa\xbb"], self.speech.audio)

    def test_the_greeting_marks_are_recorded_and_it_is_not_a_turn(self):
        transport = FakeTransport([])

        end = self.run_call(
            self.make(
                transport=transport, speech=ScriptedSTT([], clock=self.clock)
            )
        )

        marks = end.metrics["marks"]
        for name in ("greeting_start", "greeting_first_audio", "greeting_done"):
            self.assertIn(name, marks)
        self.assertNotIn("first_playout", marks)
        self.assertIsNone(end.metrics["gaps_ms"]["floor_take_to_first_playout"])
        self.assertEqual(0, end.turns)
        self.assertTrue(self.stream.drained)

    def test_a_call_with_no_user_audio_speaks_the_greeting_and_ends_with_a_drain(self):
        transport = FakeTransport([])

        end = self.run_call(self.make(transport=transport))

        self.assertTrue(self.voice.greeted)
        self.assertEqual("dropped", end.ended_by)
        self.assertTrue(end.drain.ok)
        self.assertIn("greeting_done", end.metrics["marks"])
        self.assertTrue(self.stream.drained)

    def test_a_body_without_a_greeting_opens_silently_and_records_the_absence(self):
        body = json.loads(json.dumps(BODY))
        body["greeting"] = ""
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport, body=body))

        self.assertEqual([], self.voice.greeted)
        self.assertEqual([], self.sink.frames)
        self.assertNotIn("greeting_start", end.metrics["marks"])
        self.assertTrue(self.stream.started)
        self.assertIsNotNone(end.greeting)
        self.assertFalse(end.greeting.spoken)
        document = transport.sent[-1]
        self.assertFalse(document["greeting"]["spoken"])
        self.assertIn("no greeting", document["greeting"]["reason"])

    def test_a_greeting_failure_ends_the_call_visibly_before_the_stream_starts(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(
                transport=transport,
                voice=FakeVoice(fail=RuntimeError("synthesis refused")),
            )
        )

        self.assertFalse(self.stream.started)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("RuntimeError", end.error.name)
        self.assertEqual("greeting", end.error.stage)
        self.assertTrue(self.speech.closed)
        self.assertTrue(self.voice.closed)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)

    def test_a_greeting_without_an_audio_sink_never_opens_silently(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(transport=transport, send_audio=None)
        )

        self.assertFalse(self.stream.started)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("NoAudioSink", end.error.name)
        self.assertEqual("greeting", end.error.stage)
        self.assertEqual([], self.voice.greeted)

    def test_a_hanging_greeting_is_bounded_and_ends_the_call_visibly(self):
        transport = FakeTransport([BrowserStop()])
        lifecycle = self.make(
            transport=transport,
            voice=HangingGreetingVoice(),
            # No caller event: this test is the greeting's bound, not barge-in
            # (a speechStart now cuts the greeting before it can hang).
            speech=ScriptedSTT([], clock=self.clock),
            bounds={"tts.idle_timeout_ms": 10},
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertFalse(self.stream.started)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("GreetingTimedOut", end.error.name)
        self.assertEqual("greeting", end.error.stage)
        self.assertIn("tts.idle_timeout_ms", str(end.error))
        self.assertTrue(self.speech.closed)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)

    def test_a_browser_stop_drains_and_ends_without_waiting_for_more_audio(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport))

        self.assertEqual("stop", end.ended_by)
        self.assertTrue(end.drain.ok)
        self.assertTrue(self.stream.drained)
        self.assertTrue(self.speech.closed)
        self.assertEqual("end", transport.sent[-1]["type"])

    def test_a_dropped_socket_drains_and_ends_instead_of_hanging(self):
        transport = FakeTransport([AudioFrame(b"\x00\x01")])

        end = self.run_call(self.make(transport=transport))

        self.assertEqual("dropped", end.ended_by)
        self.assertTrue(self.stream.drained)
        self.assertTrue(self.speech.closed)
        self.assertTrue(self.voice.closed)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)

    def test_a_failed_voice_open_closes_speech_and_ends_with_a_named_error(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(
                transport=transport,
                fail_voice=RuntimeError("synthesis connect refused"),
            )
        )

        self.assertEqual(["speech", "voice"], self.opens)
        self.assertFalse(self.stream.started)
        self.assertFalse(self.stream.drained)
        self.assertTrue(self.speech.closed)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("RuntimeError", end.error.name)
        self.assertEqual("open", end.error.stage)
        document = transport.sent[-1]
        self.assertEqual("meta", document["providers"]["stt"]["provider"])
        self.assertIsNone(document["providers"]["tts"]["provider"])

    def test_a_model_stream_without_close_does_not_fail_the_drain(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(
                transport=transport,
                open_model=True,
                model_session=object(),
            )
        )

        self.assertEqual("stop", end.ended_by)
        self.assertTrue(end.drain.ok)

    def test_a_context_update_reaches_the_turn_layer(self):
        transport = FakeTransport([ContextUpdate("keep it short"), BrowserStop()])

        self.run_call(self.make(transport=transport))

        self.assertEqual(["keep it short"], self.stream.contexts)

    # -- the end message --------------------------------------------------

    def test_the_end_message_carries_the_ledger_provider_table_cost_and_eligibility(self):
        measured = CostSummary(
            rate_table_version="rate-table-1",
            legs=(
                LegCost("stt", "audio_seconds", 1.25, True, "wire seconds"),
                LegCost("llm", "tokens", 120, True, "wire usage"),
                LegCost("tts", "characters", 42, True, "billed_characters"),
            ),
            total_usd=0.031,
        )
        eligibility = evaluate_body(BODY, keyterm_limit=10)
        transport = FakeTransport([AudioFrame(b"\x00\x01"), BrowserStop()])

        end = self.run_call(
            self.make(
                transport=transport,
                eligibility=eligibility,
                cost_meter=lambda: measured,
            )
        )

        document = transport.sent[-1]
        self.assertEqual(CALL_ID, document["callId"])
        self.assertEqual("stop", document["endedBy"])
        self.assertEqual(1, document["turns"])
        self.assertEqual("rate-table-1", document["cost"]["rateTableVersion"])
        self.assertTrue(document["cost"]["measured"])
        self.assertEqual(0.031, document["cost"]["totalUsd"])
        self.assertEqual(
            42, document["cost"]["legs"]["tts"]["quantity"]
        )
        self.assertEqual("cascade", document["eligibility"]["disposition"])
        self.assertIn("audio_in", document["metrics"]["marks"])
        self.assertEqual("meta", document["providers"]["stt"]["provider"])
        self.assertEqual("primary", document["providers"]["stt"]["rung"])
        self.assertEqual("assemblyai", document["providers"]["tts"]["provider"])
        self.assertIsNone(document["providers"]["llm"]["provider"])

    def test_an_unmeasured_cost_is_unmeasured_never_zero(self):
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport))

        document = transport.sent[-1]
        self.assertFalse(document["cost"]["measured"])
        self.assertIsNone(document["cost"]["totalUsd"])
        # The table version is cited because it is the table the call would
        # have priced with; the units were never reported, so no amount exists.
        self.assertEqual("cascade-vendor-rates v1", document["cost"]["rateTableVersion"])
        for leg in ("stt", "llm", "tts"):
            self.assertFalse(document["cost"]["legs"][leg]["measured"])
            self.assertIsNone(document["cost"]["legs"][leg]["quantity"])
            self.assertIsNone(document["cost"]["legs"][leg]["amountUsd"])
            self.assertEqual({}, document["cost"]["legs"][leg]["units"])
        self.assertEqual(
            {"stt", "llm", "tts"}, set(document["providers"])
        )

    def test_a_call_meters_the_vendor_units_and_carries_their_priced_cost(self):
        # Rates come from cascade/rates/v1.json (never invented here):
        #   stt.audio_seconds 0.00005, llm.prompt 0.00000125, llm.cached
        #   0.00000015, llm.completion/reasoning 0.00000425, tts.characters
        #   0.000015, tts audio/session seconds a sourced 0.
        speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            clock=self.clock,
        )
        # The vendor bills speech in whole seconds: 3.7 s is 3 billed seconds.
        speech.usage = {"audio_duration_seconds": 3.7}
        voice = MeteringVoice(
            Billing(
                characters=40,
                measured=True,
                source="billed_characters",
                audio_duration_seconds=2.5,
                session_duration_seconds=4,
            )
        )
        stream = MeteringStream(
            {
                "t1": TurnUsage(
                    prompt_tokens=1000,
                    completion_tokens=100,
                    cached_tokens=200,
                    reasoning_tokens=0,
                    measured=True,
                )
            }
        )
        transport = FakeTransport([AudioFrame(b"\x00\x01"), BrowserStop()])

        end = self.run_call(
            self.make(transport=transport, speech=speech, voice=voice, stream=stream)
        )

        document = transport.sent[-1]["cost"]
        self.assertTrue(document["measured"])
        self.assertEqual("cascade-vendor-rates v1", document["rateTableVersion"])
        self.assertAlmostEqual(0.002205, document["totalUsd"], places=12)
        self.assertEqual(3, document["legs"]["stt"]["units"]["audio_seconds"])
        self.assertEqual(
            {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "cached_tokens": 200,
                "reasoning_tokens": 0,
            },
            document["legs"]["llm"]["units"],
        )
        self.assertEqual(
            {"characters": 40, "audio_seconds": 2.5, "session_seconds": 4},
            document["legs"]["tts"]["units"],
        )
        self.assertAlmostEqual(0.00015, document["legs"]["stt"]["amountUsd"], places=12)
        self.assertAlmostEqual(0.001455, document["legs"]["llm"]["amountUsd"], places=12)
        self.assertAlmostEqual(0.0006, document["legs"]["tts"]["amountUsd"], places=12)
        # The call's own meter is what priced the end message.
        self.assertTrue(end.cost.measured)

    def test_a_leg_that_did_not_report_keeps_the_total_unmeasured(self):
        speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            clock=self.clock,
        )
        speech.usage = {"audio_duration_seconds": 3.0}
        # The voice reported its billed characters but no audio or session
        # seconds: the leg stays unmeasured, so the total cannot be a number.
        voice = MeteringVoice(
            Billing(characters=40, measured=True, source="billed_characters")
        )
        stream = MeteringStream(
            {
                "t1": TurnUsage(
                    prompt_tokens=1000,
                    completion_tokens=100,
                    cached_tokens=0,
                    reasoning_tokens=0,
                    measured=True,
                )
            }
        )
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(transport=transport, speech=speech, voice=voice, stream=stream)
        )

        document = transport.sent[-1]["cost"]
        self.assertFalse(document["measured"])
        self.assertIsNone(document["totalUsd"])
        self.assertTrue(document["legs"]["stt"]["measured"])
        self.assertTrue(document["legs"]["llm"]["measured"])
        self.assertFalse(document["legs"]["tts"]["measured"])
        self.assertIsNone(document["legs"]["tts"]["amountUsd"])
        self.assertIn("session_seconds", document["unmeasuredReason"])

    def test_a_hanging_drain_is_bounded_and_the_call_still_ends(self):
        transport = FakeTransport([BrowserStop()])
        lifecycle = self.make(
            transport=transport,
            stream=HangingDrainStream(),
            drain_bound_ms=10,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual("stop", end.ended_by)
        self.assertFalse(end.drain.ok)
        self.assertEqual("DrainTimedOut", end.drain.error.name)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)
        recorded = transport.sent[-1]["bounds"]
        drain = next(item for item in recorded if item["stage"] == "drain")
        self.assertEqual("deploy.drain_max_wait_ms", drain["bound"])
        self.assertFalse(drain["ok"])
        self.assertEqual("DrainTimedOut", drain["error"]["name"])

    def test_an_unset_drain_bound_is_named_and_never_invented(self):
        bound = thresholds.bound("deploy.drain_max_wait_ms")
        if not bound.is_open:
            self.skipTest("ticket 140 has supplied the deploy drain bound")
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport, drain_bound_ms=None))

        self.assertFalse(end.drain.ok)
        self.assertEqual("UnsetBoundError", end.drain.error.name)
        self.assertIn("deploy.drain_max_wait_ms", str(end.drain.error))
        self.assertEqual("end", transport.sent[-1]["type"])

    def test_a_hanging_vendor_close_is_bounded_and_the_call_still_ends(self):
        transport = FakeTransport([BrowserStop()])
        voice = HangingCloseVoice()

        end = asyncio.run(
            asyncio.wait_for(
                self.make(
                    transport=transport, voice=voice, drain_bound_ms=10
                ).run(),
                timeout=2.0,
            )
        )

        self.assertFalse(end.drain.ok)
        self.assertEqual("DrainTimedOut", end.drain.error.name)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)

    # -- verification happens before any vendor socket --------------------

    def test_an_unbound_voice_ends_with_a_named_error_before_any_vendor_socket(self):
        body = json.loads(json.dumps(BODY))
        body["voice"]["voice_id"] = "juergen"
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport, body=body))

        self.assertEqual([], self.opens)
        self.assertFalse(self.stream.started)
        self.assertEqual("refused", end.ended_by)
        self.assertEqual("UnboundVoiceError", end.error.name)
        self.assertEqual("binding", end.error.stage)
        document = transport.sent[-1]
        self.assertEqual("UnboundVoiceError", document["error"]["name"])
        self.assertEqual("refused", document["eligibility"]["disposition"])
        self.assertEqual(["binding"], document["eligibility"]["predicates"])
        self.assertIsNone(document["providers"]["stt"]["provider"])
        self.assertFalse(document["cost"]["measured"])

    def test_a_smuggled_body_key_ends_with_a_named_error_before_any_vendor_socket(self):
        body = json.loads(json.dumps(BODY))
        body["smuggled"] = True
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport, body=body))

        self.assertEqual([], self.opens)
        self.assertEqual("UnknownBodyKeyError", end.error.name)
        self.assertEqual("body", end.error.stage)

    def test_a_tampered_envelope_ends_with_a_named_error_before_any_vendor_socket(self):
        message = signed_message()
        signature = message["envelope"]["signature"]
        message["envelope"]["signature"] = ("0" if signature[0] != "0" else "1") + signature[1:]
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(transport=transport, message=message)
        )

        self.assertEqual([], self.opens)
        self.assertEqual("EnvelopeSignatureMismatch", end.error.name)
        self.assertEqual("envelope", end.error.stage)
        self.assertEqual("refused", end.ended_by)

    def test_an_eligibility_refusal_names_its_predicates_and_opens_nothing(self):
        body = json.loads(json.dumps(BODY))
        # The body carries one keyterm; a zero limit refuses it by name.
        decision = evaluate_body(body, keyterm_limit=0)
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(
            self.make(transport=transport, body=body, eligibility=decision)
        )

        self.assertEqual([], self.opens)
        self.assertEqual("EligibilityRefused", end.error.name)
        self.assertEqual("eligibility", end.error.stage)
        document = transport.sent[-1]
        self.assertEqual("refused", document["eligibility"]["disposition"])
        self.assertEqual(["accepted"], document["eligibility"]["predicates"])
        self.assertIn("keyterm", document["eligibility"]["reasons"][0])

    def test_the_end_message_records_auto_detect_from_the_served_body(self):
        auto = json.loads(json.dumps(BODY))
        auto["input"]["language_codes"] = []
        fixed = json.loads(json.dumps(BODY))

        for body, expected in ((auto, True), (fixed, False)):
            with self.subTest(auto_detect=expected):
                transport = FakeTransport([BrowserStop()])
                self.run_call(self.make(transport=transport, body=body))

                document = transport.sent[-1]
                self.assertEqual("cascade", document["eligibility"]["disposition"])
                self.assertIs(document["eligibility"]["autoDetect"], expected)

    def test_a_refused_call_never_starts_the_stream(self):
        body = json.loads(json.dumps(BODY))
        # The entry is missing base_url and api_key, so no client can be built:
        # the call fails by name before a socket, and it does not route managed.
        body["llm"] = [{"model": "tenant-model"}]
        transport = FakeTransport([BrowserStop()])

        end = self.run_call(self.make(transport=transport, body=body))

        self.assertEqual([], self.opens)
        self.assertEqual("MissingLlmOverrideFieldError", end.error.name)
        self.assertEqual("body", end.error.stage)
        self.assertFalse(self.stream.started)


class BoundedWaitTest(unittest.TestCase):
    """Five named waits plus the audio path's synthesis wait (ticket 76)."""

    STAGES = ("reply_task", "stall_guard", "tool", "drain", "reconnect")

    def lifecycle(self, bounds=None):
        async def unused(_body):
            raise AssertionError("a bound-only test opens no leg")

        return CallLifecycle(
            message={},
            secret="secret",
            call_id="bound-test",
            transport=FakeTransport(),
            open_speech=unused,
            open_voice=unused,
            bounds=bounds,
        )

    def test_each_named_wait_reads_a_declared_registry_bound(self):
        expected = {
            "reply_task": "turn.reply_task_ms",
            "stall_guard": "turn.stall_guard_ms",
            "tool": "tool.timeout_ms",
            "drain": "deploy.drain_max_wait_ms",
            "reconnect": "reconnect.handshake_ms",
            "greeting": "tts.idle_timeout_ms",
        }
        for stage, name in expected.items():
            with self.subTest(stage=stage):
                self.assertEqual(name, BOUNDED_WAITS[stage][0])
                # ``thresholds.bound`` refuses an undeclared name by name.
                self.assertEqual(name, thresholds.bound(name).name)

    def test_each_never_completing_wait_times_out_by_name_and_is_recorded(self):
        for stage in self.STAGES:
            with self.subTest(stage=stage):
                lifecycle = self.lifecycle({BOUNDED_WAITS[stage][0]: 10})

                result, outcome = asyncio.run(
                    asyncio.wait_for(
                        lifecycle.run_bounded(stage, _never), timeout=2.0
                    )
                )

                self.assertIsNone(result)
                self.assertFalse(outcome.ok)
                self.assertEqual(BOUNDED_WAITS[stage][1], outcome.error.name)
                self.assertEqual(stage, outcome.error.stage)
                self.assertIn(BOUNDED_WAITS[stage][0], str(outcome.error))
                self.assertEqual([outcome], lifecycle.bound_outcomes)

    def test_an_unbounded_wait_hangs_which_is_why_the_bound_is_there(self):
        async def scenario():
            # The direct await never finishes; the test-level deadline is the
            # only thing that ends it. That is the bug the named bound removes.
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(_never(), timeout=0.01)
            return await self.lifecycle({"tool.timeout_ms": 10}).run_bounded(
                "tool", _never
            )

        result, outcome = asyncio.run(scenario())

        self.assertIsNone(result)
        self.assertEqual("ToolTimedOut", outcome.error.name)

    def test_an_unset_bound_raises_by_name_and_is_never_defaulted(self):
        name = "turn.reply_task_ms"
        entry = thresholds.bound(name)

        with mock.patch(
            "cascade.call.require_bound",
            side_effect=thresholds.UnsetBoundError(entry),
        ):
            result, outcome = asyncio.run(
                self.lifecycle().run_bounded("reply_task", _never)
            )

        self.assertIsNone(result)
        self.assertEqual("UnsetBoundError", outcome.error.name)
        self.assertIn(name, str(outcome.error))

    def test_a_zero_or_negative_bound_is_refused_not_used(self):
        result, outcome = asyncio.run(
            self.lifecycle({"tool.timeout_ms": 0}).run_bounded("tool", _never)
        )

        self.assertIsNone(result)
        self.assertEqual("InvalidBound", outcome.error.name)
        self.assertIn("tool.timeout_ms", str(outcome.error))


async def _never():
    """A stand-in for the dependency that never answers."""
    await asyncio.Event().wait()


if __name__ == "__main__":
    unittest.main()
