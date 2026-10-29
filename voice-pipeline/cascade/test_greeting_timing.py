"""Greeting timing and the connected chime (ticket 78).

Seam: :class:`cascade.greeting.CallGreeting` is handed an opened voice, a
ledger and the call's audio sink. Two facts are observed rather than assumed:

* the greeting never starts before the synthesis session acknowledged ``Begin``
  — a voice whose session has not confirmed its handshake refuses by name and
  sends no ``Generate``;
* the connected chime is fired by the first *audible* frame, once per call,
  before that frame is handed to the call's sink. The chime is a fire-and-forget
  trigger: an awaitable is never awaited, so it cannot delay the first audio
  beyond the greeting's named bound.

The integration half drives :class:`cascade.call.CallLifecycle` with zero
microphone frames, which is the spec's "a call with no user audio still emits
the greeting" case, and asserts exactly one chime for the whole call.

Independent expected values: the mark names and their order are the spec's
three greeting marks; the chime count is one per call by definition, not
derived from the implementation.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.body_map import CascadeBody, adapt_body
from cascade.call import CallLifecycle, OpenedLeg
from cascade.greeting import CallGreeting, GreetingFailure
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    FakeTransport,
    signed_message,
)
from cascade.testing import FakeClock
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio

GREETING = "Hola, soy Voni. ¿En qué puedo ayudarte?"
SAMPLE_RATE = 24000


def body_with(greeting: str = GREETING) -> CascadeBody:
    return adapt_body(
        {
            "system_prompt": "You are Voni, a careful voice agent.",
            "greeting": greeting,
            "voice": {"voice_id": "lola"},
            "input": {"language_codes": ["es"]},
            "output": {"voice": "lola"},
            "tools": [],
            "llm": [],
        }
    )


class AcknowledgedVoice:
    """An opened synthesis session with its ``Begin`` echo already read."""

    def __init__(
        self,
        chunks=(b"\x01\x00", b"\x02\x00"),
        *,
        begin=True,
        log: list[str] | None = None,
    ) -> None:
        self.binding = bind_voice("lola")
        self.begin = {} if begin else None
        self.chunks = tuple(chunks)
        self.log = log if log is not None else []
        self.greeted: list[str] = []
        self.cancelled = 0

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        self.log.append("greeting-sent")
        for chunk in self.chunks:
            yield SentenceAudio(pcm=chunk, sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancelled += 1


class RecordingSink:
    def __init__(self, log: list[str] | None = None) -> None:
        self.frames: list[SentenceAudio] = []
        self.log = log if log is not None else []

    async def __call__(self, audio: SentenceAudio) -> None:
        self.frames.append(audio)
        self.log.append("audio")


class NeverAwaited:
    """An awaitable the caller must not await; awaiting it never resumes."""

    def __await__(self):
        yield  # pragma: no cover - reached only by a wrong implementation
        raise AssertionError("the connected chime must not be awaited")


class GreetingTimingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(10.0)
        self.ledger = TimingLedger(now=self.clock)

    def greet(self, *, voice=None, chime=None, sink=None, body=None):
        greeting = CallGreeting(
            voice=voice if voice is not None else AcknowledgedVoice(),
            ledger=self.ledger,
            sink=sink if sink is not None else RecordingSink(),
            chime=chime,
        )
        return asyncio.run(greeting.speak(body if body is not None else body_with()))

    # -- only after the session acknowledgement ---------------------------

    def test_a_greeting_is_not_sent_before_the_session_acknowledges_begin(self):
        voice = AcknowledgedVoice(begin=False)

        with self.assertRaises(GreetingFailure) as raised:
            self.greet(voice=voice)

        self.assertEqual("GreetingNotConnected", type(raised.exception).__name__)
        self.assertEqual("greeting", raised.exception.stage)
        self.assertEqual([], voice.greeted)
        self.assertEqual({}, self.ledger.summary()["marks"])

    def test_an_acknowledged_session_may_speak_the_greeting(self):
        voice = AcknowledgedVoice(begin=True)

        outcome = self.greet(voice=voice)

        self.assertTrue(outcome.spoken)
        self.assertEqual([GREETING], voice.greeted)

    # -- the chime is the first audible frame -----------------------------

    def test_the_chime_fires_once_before_the_first_audible_frame_is_heard(self):
        log: list[str] = []
        voice = AcknowledgedVoice(chunks=(b"", b"\x01\x00", b"\x02\x00"), log=log)
        sink = RecordingSink(log)

        outcome = self.greet(
            voice=voice, sink=sink, chime=lambda: log.append("chime")
        )

        self.assertEqual(
            ["greeting-sent", "audio", "chime", "audio", "audio"], log
        )
        self.assertTrue(outcome.chime_fired)
        self.assertEqual(3, outcome.frames)

    def test_the_chime_is_fired_exactly_once_for_many_frames(self):
        chimes: list[int] = []

        outcome = self.greet(
            voice=AcknowledgedVoice(chunks=(b"\x01", b"\x02", b"\x03")),
            chime=lambda: chimes.append(1),
        )

        self.assertEqual([1], chimes)
        self.assertTrue(outcome.chime_fired)

    def test_a_greeting_with_no_audible_frame_fires_no_chime(self):
        chimes: list[int] = []

        with self.assertRaises(GreetingFailure):
            self.greet(
                voice=AcknowledgedVoice(chunks=(b"", b"")),
                chime=lambda: chimes.append(1),
            )

        self.assertEqual([], chimes)

    def test_the_chime_cannot_delay_the_first_audio_by_being_awaited(self):
        outcome = asyncio.run(
            asyncio.wait_for(
                CallGreeting(
                    voice=AcknowledgedVoice(),
                    ledger=self.ledger,
                    sink=RecordingSink(),
                    chime=lambda: NeverAwaited(),
                ).speak(body_with()),
                timeout=1.0,
            )
        )

        self.assertTrue(outcome.spoken)

    # -- the lifecycle: zero microphone frames still chime ---------------

    def test_zero_microphone_frames_produce_greeting_audio_and_one_chime(self):
        log: list[str] = []
        chimes: list[int] = []
        voice = AcknowledgedVoice(log=log)
        transport = FakeTransport([])
        sink_log: list[str] = []

        def chime():
            chimes.append(1)
            log.append("chime")

        lifecycle = lifecycle_with(
            transport=transport,
            voice=voice,
            chime=chime,
            sink_log=sink_log,
            clock=self.clock,
        )

        end = asyncio.run(lifecycle.run())

        self.assertTrue(end.greeting.spoken)
        self.assertTrue(end.greeting.chime_fired)
        self.assertEqual([1], chimes)
        self.assertEqual([b"\x01\x00", b"\x02\x00"], [f.pcm for f in end_greeting_frames(lifecycle)])
        self.assertEqual(1, log.count("chime"))
        self.assertNotIn("audio_in", end.metrics["marks"])

    def test_the_greeting_is_sent_after_voice_open_and_before_the_stream(self):
        log: list[str] = []
        voice = AcknowledgedVoice(log=log)
        transport = FakeTransport([])
        lifecycle = lifecycle_with(
            transport=transport,
            voice=voice,
            chime=lambda: log.append("chime"),
            log=log,
            clock=self.clock,
        )

        asyncio.run(lifecycle.run())

        self.assertEqual(
            ["speech-open", "voice-open", "greeting-sent", "chime", "stream"],
            log,
        )


def end_greeting_frames(lifecycle):
    return [frame for frame in lifecycle.audio_frames if frame.kind == "greeting"]


def lifecycle_with(
    *,
    transport,
    voice,
    chime=None,
    sink_log=None,
    log=None,
    clock=None,
):
    """One lifecycle over a signed body, a recording sink and a real clock mark."""
    log = log if log is not None else []
    sink_log = sink_log if sink_log is not None else []
    frames = []

    class Sink:
        async def __call__(self, outbound) -> None:
            frames.append(outbound)
            sink_log.append("audio")

    async def open_speech(_body):
        log.append("speech-open")
        return OpenedLeg("stt", "meta", "primary", "speech leg is closed", object())

    async def open_voice(_body):
        log.append("voice-open")
        voice.begin = {}
        return OpenedLeg("tts", "assemblyai", "primary", "one synthesis rung", voice)

    class Stream:
        async def start(self) -> None:
            log.append("stream")

        async def event(self, event) -> None:
            return None

        async def context(self, text: str) -> None:
            return None

        async def drain(self) -> None:
            return None

        def turn_count(self) -> int:
            return 0

    lifecycle = CallLifecycle(
        message=signed_message(),
        secret=SECRET,
        call_id=CALL_ID,
        transport=transport,
        open_speech=open_speech,
        open_voice=open_voice,
        stream=Stream(),
        send_audio=Sink(),
        ledger=TimingLedger(now=clock if clock is not None else FakeClock()),
        clock=clock if clock is not None else FakeClock(),
        envelope_clock=FakeClock(ISSUED_S),
        chime=chime,
        drain_bound_ms=1000,
    )
    return lifecycle


if __name__ == "__main__":
    unittest.main()
