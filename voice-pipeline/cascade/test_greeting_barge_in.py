"""Barge-in cancels the greeting (ticket 79).

Seam: :class:`cascade.greeting.CallGreeting` can expose a running greeting
(:meth:`~cascade.greeting.CallGreeting.start`) and cut it
(:meth:`~cascade.greeting.GreetingPlayback.cancel`); :class:`cascade.call.CallLifecycle`
listens to the caller while the greeting sounds. Two facts are observed:

* the cut is the synthesis session's ``Cancel`` (ticket 52), not a socket
  close, and the greeting's pending text is discarded;
* the greeting never resumes (``speak_greeting`` is called once) and the
  caller's turn is still delivered to the turn layer.

The integration half drives the real lifecycle with a gated fake voice: it
emits one frame, then blocks, so "the greeting would have finished over the
caller" is a reachable state rather than a scheduling accident. The last unit
test uses a real :class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS` over
recorded frames to prove the ``Cancel`` frame goes out and the second
sentence's characters are discarded.

Independent expected values: one greeting line (the body's), one ``Cancel``,
one caller turn; the marks come from the spec's greeting/cancelled vocabulary.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.body_map import CascadeBody, adapt_body
from cascade.call import CallLifecycle, OpenedLeg
from cascade.greeting import CallGreeting, GreetingFailure
from cascade.meta_stt import SpeechComplete, SpeechPartial, SpeechStart
from cascade.test_call import CALL_ID, ISSUED_S, SECRET, FakeStream, signed_message
from cascade.testing import FakeClock, ScriptedSTT
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio

GREETING = "Hola, soy Voni. ¿En qué puedo ayudarte?"
SAMPLE_RATE = 24000


def body_dict(greeting: str = GREETING) -> dict:
    return {
        "system_prompt": "You are Voni, a careful voice agent.",
        "greeting": greeting,
        "voice": {"voice_id": "lola"},
        "input": {"language_codes": ["es"]},
        "output": {"voice": "lola"},
        "tools": [],
        "llm": [],
    }


def body_with(greeting: str = GREETING) -> CascadeBody:
    return adapt_body(body_dict(greeting))


class RecordingSink:
    def __init__(self) -> None:
        self.frames: list[SentenceAudio] = []

    async def __call__(self, audio: SentenceAudio) -> None:
        self.frames.append(audio)


class GatedVoice:
    """The opened session: one frame, then it waits until a cut releases it."""

    def __init__(self) -> None:
        self.binding = bind_voice("lola")
        self.begin = {}
        self.greeted: list[str] = []
        self.cancelled = 0
        self.first_frame_out = asyncio.Event()
        self.gate = asyncio.Event()

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        yield SentenceAudio(pcm=b"\x01\x00", sample_rate=SAMPLE_RATE, text=text)
        self.first_frame_out.set()
        await self.gate.wait()
        yield SentenceAudio(pcm=b"\x02\x00", sample_rate=SAMPLE_RATE, text=text)
        yield SentenceAudio(pcm=b"\x03\x00", sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancelled += 1
        self.gate.set()


class OpenVoice:
    """The opened session: every frame available, no cut expected."""

    def __init__(self) -> None:
        self.binding = bind_voice("lola")
        self.begin = {}
        self.greeted: list[str] = []
        self.cancelled = 0

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        for chunk in (b"\x01\x00", b"\x02\x00"):
            yield SentenceAudio(pcm=chunk, sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancelled += 1


class GreetingBargeInUnitTest(unittest.TestCase):
    def setUp(self):
        self.ledger = TimingLedger(now=FakeClock(10.0))

    def start(self, voice, sink):
        return CallGreeting(
            voice=voice,
            ledger=self.ledger,
            sink=sink,
            chime=lambda: None,
        ).start(body_with())

    def test_a_cut_sends_cancel_stops_the_frames_and_marks_the_greeting_done(self):
        async def scenario():
            voice = GatedVoice()
            sink = RecordingSink()
            playback = self.start(voice, sink)
            await asyncio.wait_for(voice.first_frame_out.wait(), timeout=1.0)

            outcome = await playback.cancel("speech_start")

            return voice, sink, outcome

        voice, sink, outcome = asyncio.run(scenario())

        self.assertEqual([GREETING], voice.greeted)
        self.assertEqual(1, voice.cancelled)
        self.assertEqual(1, len(sink.frames))
        self.assertTrue(outcome.cancelled)
        self.assertEqual("speech_start", outcome.cause)
        self.assertEqual(1, outcome.frames)
        marks = self.ledger.summary()["marks"]
        self.assertIn("greeting_start", marks)
        self.assertIn("greeting_first_audio", marks)
        self.assertIn("greeting_done", marks)

    def test_a_second_cut_is_idempotent_and_never_restarts_the_greeting(self):
        async def scenario():
            voice = GatedVoice()
            playback = self.start(voice, RecordingSink())
            await asyncio.wait_for(voice.first_frame_out.wait(), timeout=1.0)
            first = await playback.cancel("speech_start")
            second = await playback.cancel("partial")
            return voice, first, second

        voice, first, second = asyncio.run(scenario())

        self.assertIs(first, second)
        self.assertEqual(1, voice.cancelled)
        self.assertEqual([GREETING], voice.greeted)


class GreetingCutOnTheWireTest(unittest.TestCase):
    """The cut is `Cancel` on the real adapter, and pending text is discarded."""

    def test_the_cut_sends_cancel_and_discards_the_pending_sentence(self):
        from cascade.test_tts_support import audio_ms, begin

        first = "Hola, soy Voni. "
        second = "¿En qué puedo ayudarte?"

        async def scenario():
            factory = HoldingSocketFactory(
                [begin(voice_id="lola", language="Spanish"), audio_ms(400, flush_id=0)]
            )
            tts = AssemblyAIStreamingTTS(
                voice_id="lola",
                transport="browser",
                api_key="test-key",
                socket_factory=factory,
            )
            await tts.open()
            greeting = CallGreeting(
                voice=tts,
                ledger=TimingLedger(now=FakeClock()),
                sink=RecordingSink(),
                chime=lambda: None,
            ).start(body_with(first + second))
            while tts.audio_bytes == 0:
                await asyncio.sleep(0)
            outcome = await greeting.cancel("speech_start")
            return factory, tts, outcome

        factory, tts, outcome = asyncio.run(scenario())

        self.assertEqual(
            ["Generate", "Flush", "Cancel"],
            [json.loads(message)["type"] for message in factory.socket.sent],
        )
        self.assertTrue(outcome.cancelled)
        self.assertEqual(len(second), tts.cancellations[-1].discarded_characters)


class HoldingSocket:
    """Replays its frames, then holds the socket open with no further frame."""

    def __init__(self, frames) -> None:
        self.frames = list(frames)
        self.sent: list[str] = []
        self.closed = False
        self.hold = asyncio.Event()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.frames:
            return self.frames.pop(0)
        await self.hold.wait()
        raise StopAsyncIteration

    async def send(self, message) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True
        self.hold.set()


class HoldingSocketFactory:
    def __init__(self, frames) -> None:
        self.socket = HoldingSocket(frames)

    async def __call__(self, url, headers):
        return self.socket


class TurnTransport:
    """Feeds caller input, then waits for the turn layer to finish the turn."""

    def __init__(self, inputs=()) -> None:
        self.inputs = list(inputs)
        self.sent: list[dict] = []
        self.closed = False
        self.finish = asyncio.Event()

    async def receive(self):
        await asyncio.sleep(0)
        if self.inputs:
            return self.inputs.pop(0)
        await self.finish.wait()
        from cascade.call import BrowserStop

        return BrowserStop()

    async def send(self, message) -> None:
        self.sent.append(dict(message))

    async def close(self) -> None:
        self.closed = True


class StoppingStream(FakeStream):
    """Stops the transport once the caller's turn has been delivered."""

    def __init__(self, transport, log=None) -> None:
        super().__init__(log)
        self._transport = transport

    async def event(self, event) -> None:
        await super().event(event)
        if isinstance(event, SpeechComplete):
            self._transport.finish.set()


class GreetingBargeInCallTest(unittest.TestCase):
    def make(self, *, trace, voice, inputs=()):
        transport = TurnTransport(inputs)
        stream = StoppingStream(transport)
        frames = []

        class Sink:
            async def __call__(self, outbound) -> None:
                frames.append(outbound)

        speech = ScriptedSTT(trace, clock=FakeClock())

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", speech)

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "one synthesis rung", voice)

        clock = FakeClock(10.0)
        lifecycle = CallLifecycle(
            message=signed_message(body_dict()),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=Sink(),
            ledger=TimingLedger(now=clock),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
        )
        return lifecycle, transport, stream, frames, speech

    def test_a_speech_start_cuts_the_greeting_and_the_caller_turn_proceeds(self):
        voice = GatedVoice()
        lifecycle, transport, stream, frames, speech = self.make(
            trace=[SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            voice=voice,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual([GREETING], voice.greeted)
        self.assertEqual(1, voice.cancelled)
        greeting_frames = [frame for frame in frames if frame.kind == "greeting"]
        self.assertEqual(1, len(greeting_frames))
        self.assertTrue(end.greeting.cancelled)
        self.assertEqual("speech_start", end.greeting.cause)
        self.assertTrue(stream.started)
        self.assertEqual(
            [SpeechStart, SpeechComplete], [type(event) for event in stream.events]
        )
        self.assertEqual(1, end.turns)
        self.assertEqual("stop", end.ended_by)
        marks = end.metrics["marks"]
        self.assertIn("cancelled", marks)
        self.assertIn("greeting_done", marks)
        self.assertEqual([], speech.audio)

    def test_a_taking_the_floor_partial_also_cuts_without_a_speech_start(self):
        voice = GatedVoice()
        lifecycle, transport, stream, frames, speech = self.make(
            trace=[
                SpeechPartial("book a demo"),
                SpeechComplete("book a demo", turn_id="t1"),
            ],
            voice=voice,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual(1, voice.cancelled)
        self.assertTrue(end.greeting.cancelled)
        self.assertEqual("partial", end.greeting.cause)
        self.assertEqual(
            [SpeechPartial, SpeechComplete], [type(event) for event in stream.events]
        )

    def test_a_backchannel_does_not_cut_the_greeting(self):
        voice = OpenVoice()
        lifecycle, transport, stream, frames, speech = self.make(
            trace=[SpeechPartial("mm-hmm"), SpeechComplete("mm-hmm", turn_id="t1")],
            voice=voice,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual(0, voice.cancelled)
        self.assertFalse(end.greeting.cancelled)
        self.assertEqual(
            [b"\x01\x00", b"\x02\x00"],
            [frame.pcm for frame in frames if frame.kind == "greeting"],
        )
        self.assertEqual(
            [SpeechPartial, SpeechComplete], [type(event) for event in stream.events]
        )


if __name__ == "__main__":
    unittest.main()
