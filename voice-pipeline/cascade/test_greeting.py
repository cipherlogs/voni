"""The body's greeting, spoken before any caller audio (ticket 77).

Seam: :class:`cascade.greeting.CallGreeting` is handed an opened voice session
and a ledger. The voice is a fake that records the one call it receives, so
"the greeting goes through the bound voice's ``speak_greeting`` path" is
observed rather than assumed. The last test opens a real
:class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS` over the recorded-frame
fixtures, because "one ``Generate`` + ``Flush`` immediately" belongs to that
adapter and is not re-implemented here.

Independent expected values:

- the ledger mark names and their order are the spec's three greeting marks;
- the greeting text is the body's own text, copied before the call;
- the reply-gap rows come from :func:`metrics.cascade_gaps`, not from a
  restatement of the formula in the test.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.body_map import CascadeBody, adapt_body
from cascade.greeting import CallGreeting, GreetingFailure
from cascade.testing import FakeClock, ScriptedSocketFactory
from cascade.voice_binding import bind_voice
from metrics import TimingLedger, cascade_gaps
from providers import SentenceAudio

GREETING = "Hola, soy Voni. ¿En qué puedo ayudarte?"
SAMPLE_RATE = 24000


def body_with(greeting: str = GREETING) -> CascadeBody:
    """One real adapted body; only the greeting line varies per test."""
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


class GreetingVoice:
    """The opened voice session: one bound voice and its greeting path."""

    def __init__(self, chunks=(b"\x01\x00", b"\x02\x00"), *, fail=None, with_binding=True):
        self.binding = bind_voice("lola") if with_binding else None
        self.chunks = tuple(chunks)
        self.fail = fail
        self.greeted: list[str] = []
        self.spoken: list[str] = []

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        if self.fail is not None:
            raise self.fail
        for chunk in self.chunks:
            yield SentenceAudio(pcm=chunk, sample_rate=SAMPLE_RATE, text=text)

    async def speak(self, text: str):
        """A reply path the greeting must never use."""
        self.spoken.append(text)
        if False:  # pragma: no cover - an async generator that yields nothing
            yield SentenceAudio(pcm=b"", sample_rate=SAMPLE_RATE, text=text)


class GreetingSink:
    """Records every frame the call would put on the wire."""

    def __init__(self) -> None:
        self.frames: list[SentenceAudio] = []

    async def __call__(self, audio: SentenceAudio) -> None:
        self.frames.append(audio)


class GreetingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(10.0)
        self.ledger = TimingLedger(now=self.clock)
        self.sink = GreetingSink()

    def greet(self, body=None, *, voice=None):
        greeting = CallGreeting(
            voice=voice if voice is not None else GreetingVoice(),
            ledger=self.ledger,
            sink=self.sink,
        )
        return asyncio.run(greeting.speak(body if body is not None else body_with()))

    def marks(self):
        return self.ledger.summary()["marks"]

    # -- spoken, through the bound voice ----------------------------------

    def test_the_body_greeting_is_spoken_through_the_bound_voice(self):
        voice = GreetingVoice()

        outcome = self.greet(voice=voice)

        self.assertEqual([GREETING], voice.greeted)
        self.assertEqual([], voice.spoken)
        self.assertTrue(outcome.spoken)
        self.assertEqual(GREETING, outcome.text)
        self.assertEqual(2, outcome.frames)
        self.assertEqual(4, outcome.audio_bytes)
        self.assertEqual(SAMPLE_RATE, outcome.sample_rate)
        self.assertEqual(2, len(self.sink.frames))
        self.assertEqual([b"\x01\x00", b"\x02\x00"], [f.pcm for f in self.sink.frames])

    def test_the_greeting_records_start_first_audio_and_done_in_order(self):
        self.greet()

        marks = self.marks()
        self.assertEqual(
            ["greeting_start", "greeting_first_audio", "greeting_done"],
            [mark for mark in marks if mark.startswith("greeting_")],
        )
        self.assertLessEqual(marks["greeting_start"], marks["greeting_done"])
        self.assertEqual(marks["greeting_start"], marks["greeting_first_audio"])

    def test_the_first_audio_mark_is_stamped_at_the_first_frame(self):
        clock = FakeClock(0.0)
        ledger = TimingLedger(now=clock)

        class SlowVoice(GreetingVoice):
            async def speak_greeting(self, text):
                clock.advance(1.0)
                yield SentenceAudio(pcm=b"\x01\x00", sample_rate=SAMPLE_RATE, text=text)
                clock.advance(2.0)
                yield SentenceAudio(pcm=b"\x02\x00", sample_rate=SAMPLE_RATE, text=text)

        greeting = CallGreeting(voice=SlowVoice(), ledger=ledger, sink=GreetingSink())
        asyncio.run(greeting.speak(body_with()))

        marks = ledger.summary()["marks"]
        self.assertEqual(1.0, marks["greeting_first_audio"])
        self.assertEqual(3.0, marks["greeting_done"])

    def test_the_greeting_is_not_a_turn_and_never_enters_a_reply_gap(self):
        self.greet()

        marks = self.marks()
        self.assertNotIn("first_playout", marks)
        self.assertNotIn("speech_complete", marks)
        self.assertEqual(
            {"screen_latency_ms": None, "think_ms": None, "reply_gap_ms": None},
            cascade_gaps({"audio_in": 0.0, **marks}),
        )

    # -- no greeting is intentional, not a defect -------------------------

    def test_a_body_without_a_greeting_opens_silently_and_records_the_absence(self):
        voice = GreetingVoice()

        outcome = self.greet(body_with(""), voice=voice)

        self.assertFalse(outcome.spoken)
        self.assertIn("no greeting", outcome.reason)
        self.assertEqual("", outcome.text)
        self.assertEqual([], voice.greeted)
        self.assertEqual([], self.sink.frames)
        self.assertEqual({}, self.marks())

    # -- failures are visible, never a silent opening ---------------------

    def test_a_voice_without_a_greeting_path_fails_by_name(self):
        voice = GreetingVoice()
        voice.speak_greeting = None

        with self.assertRaises(GreetingFailure) as raised:
            self.greet(voice=voice)

        self.assertEqual("greeting", raised.exception.stage)
        self.assertTrue(raised.exception.visible)
        self.assertIn("speak_greeting", str(raised.exception))
        self.assertNotIn("greeting_done", self.marks())

    def test_a_voice_bound_to_another_voice_refuses_to_speak(self):
        voice = GreetingVoice()
        voice.binding = bind_voice("anna")

        with self.assertRaises(GreetingFailure) as raised:
            self.greet(voice=voice)

        self.assertEqual("GreetingVoiceMismatch", type(raised.exception).__name__)
        self.assertEqual([], voice.greeted)
        self.assertEqual([], self.sink.frames)
        self.assertEqual({}, self.marks())

    def test_a_synthesis_failure_propagates_with_the_greeting_stage(self):
        failure = RuntimeError("synthesis refused")
        failure.stage = "greeting"
        failure.visible = True

        with self.assertRaises(RuntimeError) as raised:
            self.greet(voice=GreetingVoice(fail=failure))

        self.assertIs(failure, raised.exception)
        self.assertEqual("greeting", raised.exception.stage)
        self.assertTrue(raised.exception.visible)
        self.assertNotIn("greeting_done", self.marks())

    # -- the adapter's own greeting path is Generate + Flush --------------

    def test_the_greeting_goes_out_as_one_generate_and_flush_immediately(self):
        partial = "Hola, soy Voni. "
        plan = [
            _begin(),
            _audio(flush_id=0),
            _flush_done(0),
            _audio(flush_id=1),
            _flush_done(1),
        ]
        factory = ScriptedSocketFactory(plan)
        tts = AssemblyAIStreamingTTS(
            voice_id="lola",
            transport="browser",
            api_key="test-key",
            socket_factory=factory,
        )
        asyncio.run(tts.open())
        greeting = CallGreeting(
            voice=tts, ledger=self.ledger, sink=GreetingSink()
        )

        outcome = asyncio.run(greeting.speak(body_with("Hola, soy Voni. ¿Qué tal?")))

        sent = [__import__("json").loads(raw) for raw in factory.socket.sent]
        self.assertEqual(["Generate", "Flush"], [frame["type"] for frame in sent[:2]])
        self.assertEqual("Hola, soy Voni. ", sent[0]["text"])
        self.assertEqual("¿Qué tal?", sent[2]["text"])
        self.assertTrue(outcome.spoken)
        self.assertIn("greeting_done", self.marks())


def _begin() -> str:
    from cascade.tts_support import begin

    return begin(voice_id="lola", language="Spanish")


def _audio(*, flush_id: int) -> str:
    from cascade.tts_support import audio_ms

    return audio_ms(1200, flush_id=flush_id)


def _flush_done(flush_id: int) -> str:
    from cascade.tts_support import flush_done

    return flush_done(flush_id=flush_id)


if __name__ == "__main__":
    unittest.main()
