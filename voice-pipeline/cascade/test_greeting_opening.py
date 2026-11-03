"""The opening hears the caller's first sentence (ticket: opening-hears-first).

Seam: :class:`cascade.call.CallLifecycle` over a scripted transport and speech
session. The transport releases caller frames only after ``listening``, so the
tests script frames that arrive *while* the speech handshake is still opening;
the speech session refuses audio before its acknowledgement exactly as
:class:`cascade.meta_stt.MetaStreamingSTT` does.

Two facts are observed rather than assumed:

* the caller's opening audio is buffered before the ack and flushed in arrival
  order once the session accepts it, never dropped;
* that audio (a loud PCM frame, a partial, or a final) is caller evidence, so
  the greeting is skipped and the caller's first final reaches the turn layer.

Independent expected values: the two caller frame bodies are the script's own,
the final text is the speech session's scripted transcript, and ``listening`` is
the transport's own recorded flag rather than a timestamp.
"""

from __future__ import annotations

import asyncio
import json
import struct
import unittest

from cascade.body_map import CascadeBody
from cascade.call import AudioFrame, BrowserStop, CallLifecycle, OpenedLeg
from cascade.meta_stt import (
    SAMPLE_RATE,
    MetaStreamingSTT,
    SpeechComplete,
    SpeechPartial,
    SpeechStart,
)
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    FakeStream,
    signed_message,
)
from cascade.testing import FakeClock
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from metrics import TimingLedger

from cascade.test_greeting_barge_in import (
    GREETING,
    GatedVoice,
    OpenVoice,
    StoppingStream,
    body_dict,
)

#: The take the service never heard on the delivered call (285138f6).
INTRO = "This is ridiculous. Your service is useless."
LOUD = b"\x00\x40" * 480


def _ack() -> str:
    """The vendor's acknowledgement: a JSON object with no ``type``."""
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def _event(type_name: str, **fields) -> str:
    """One vendor endpointing event, in the shape the live wire uses."""
    return json.dumps({"type": type_name, **fields})


class OpeningTransport:
    """The browser seam: pre-scripted opening frames, then a stop.

    ``delivered`` counts the audio frames the lifecycle has pulled, which is
    how the slow speech open knows the caller's first sentence arrived while it
    was still handshaking.
    """

    def __init__(self, opening=()) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        for item in opening:
            self.queue.put_nowait(item)
        self.delivered = 0
        self.sent: list[dict] = []
        self.listening_sent = False
        self.finish = asyncio.Event()

    async def receive(self):
        if not self.queue.empty():
            item = await self.queue.get()
            if isinstance(item, AudioFrame):
                self.delivered += 1
            return item
        await self.finish.wait()
        return BrowserStop()

    async def send(self, message) -> None:
        self.sent.append(dict(message))

    async def listening(self) -> None:
        self.listening_sent = True

    async def close(self) -> None:
        return None


class PreAckSpeech:
    """A speech session that refuses audio until its handshake acknowledges.

    This is the adapter's contract (``MetaSpeechSession.send_audio`` raises
    before the ack), so a call that flushes too early fails here rather than
    silently dropping the opening.
    """

    def __init__(self, transcript: str) -> None:
        self.transcript = transcript
        self.acknowledged = False
        self.audio: list[bytes] = []
        self.before_ack = 0
        self._fed = asyncio.Event()

    async def send_audio(self, pcm: bytes) -> None:
        if not self.acknowledged:
            self.before_ack += 1
            raise RuntimeError("meta speech session has no acknowledgement yet")
        self.audio.append(pcm)
        self._fed.set()

    async def events(self):
        await self._fed.wait()
        yield SpeechStart("intro")
        yield SpeechComplete(self.transcript, turn_id="intro")

    async def close(self) -> None:
        return None


class PartialSpeech:
    """A speech session whose opening evidence is a partial, not loud PCM."""

    def __init__(self, transcript: str, *, stream_started: asyncio.Event) -> None:
        self.transcript = transcript
        self.stream_started = stream_started
        self.audio: list[bytes] = []
        self.partial_processed = asyncio.Event()

    async def send_audio(self, pcm: bytes) -> None:
        self.audio.append(pcm)

    async def events(self):
        yield SpeechPartial("This is ridiculous")
        # Resumes only after the pump has processed the partial, so the slow
        # voice open can wait for the evidence itself.
        self.partial_processed.set()
        await self.stream_started.wait()
        yield SpeechComplete(self.transcript, turn_id="intro")

    async def close(self) -> None:
        return None


class OpeningStream(StoppingStream):
    """A turn layer that stops the call on the final and admits stream start."""

    def __init__(self, transport, started: asyncio.Event) -> None:
        super().__init__(transport)
        self.started_event = started

    async def start(self) -> None:
        await super().start()
        self.started_event.set()


class QuietStream(FakeStream):
    """A turn layer that ends the call as soon as it starts (quiet caller)."""

    def __init__(self, transport) -> None:
        super().__init__()
        self.transport = transport

    async def start(self) -> None:
        await super().start()
        self.transport.finish.set()


class QuietSpeech:
    """A speech session that produces no events for a silent opening."""

    async def send_audio(self, pcm: bytes) -> None:
        return None

    async def events(self):
        if False:  # pragma: no cover - an async iterator that yields none
            yield None

    async def close(self) -> None:
        return None


def lifecycle_with(*, transport, open_speech, open_voice, stream, clock=None):
    class Sink:
        async def __call__(self, outbound) -> None:
            return None

    clock = clock if clock is not None else FakeClock(10.0)
    return CallLifecycle(
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


def opened(leg: str, session) -> OpenedLeg:
    return OpenedLeg(leg, "fake", "primary", "scripted session", session)


class OpeningHearsFirstTest(unittest.TestCase):
    def test_pre_ack_caller_audio_is_flushed_and_the_first_final_is_answered(self):
        """The intro spoken while the handshake opens is not lost.

        The browser holds every frame until ``listening``; the service sends it
        before the speech handshake now. The two scripted frames therefore
        arrive while ``open_speech`` is still waiting, and the ack lands after
        them. The greeting must be skipped (the caller already spoke) and the
        buffered frames must reach the speech session in order, producing the
        first final the turn layer answers.
        """
        transport = OpeningTransport([AudioFrame(LOUD), AudioFrame(LOUD)])
        speech = PreAckSpeech(INTRO)
        voice = GatedVoice()
        stream = StoppingStream(transport)

        async def open_speech(_body: CascadeBody) -> OpenedLeg:
            # The handshake is slow: wait until both opening frames have been
            # pulled from the transport, then acknowledge.
            while transport.delivered < 2:
                await asyncio.sleep(0)
            speech.acknowledged = True
            return opened("stt", speech)

        async def open_voice(_body: CascadeBody) -> OpenedLeg:
            return opened("tts", voice)

        lifecycle = lifecycle_with(
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertTrue(transport.listening_sent)
        self.assertEqual(0, speech.before_ack, "audio was sent before the ack")
        self.assertEqual([LOUD, LOUD], speech.audio)
        self.assertEqual([], voice.greeted)
        self.assertFalse(end.greeting.spoken)
        self.assertIn("caller spoke first", end.greeting.reason)
        self.assertEqual(1, end.turns)
        self.assertEqual(
            [SpeechStart, SpeechComplete], [type(event) for event in stream.events]
        )
        self.assertEqual(INTRO, stream.events[-1].text)

    def test_an_opening_partial_skips_the_greeting_and_is_answered(self):
        """A partial is caller evidence; only finals is not enough."""
        transport = OpeningTransport()
        started = asyncio.Event()
        speech = PartialSpeech(INTRO, stream_started=started)
        voice = GatedVoice()
        stream = OpeningStream(transport, started)

        async def open_speech(_body: CascadeBody) -> OpenedLeg:
            return opened("stt", speech)

        async def open_voice(_body: CascadeBody) -> OpenedLeg:
            await speech.partial_processed.wait()
            return opened("tts", voice)

        lifecycle = lifecycle_with(
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual([], voice.greeted)
        self.assertFalse(end.greeting.spoken)
        self.assertIn("caller spoke first", end.greeting.reason)
        self.assertEqual(
            [SpeechPartial, SpeechComplete], [type(event) for event in stream.events]
        )
        self.assertEqual(INTRO, stream.events[-1].text)

    def test_a_quiet_opening_still_hears_the_greeting(self):
        """The earlier ``listening`` must not turn every call silent."""
        transport = OpeningTransport()
        speech = QuietSpeech()
        voice = OpenVoice()
        stream = QuietStream(transport)

        async def open_speech(_body: CascadeBody) -> OpenedLeg:
            return opened("stt", speech)

        async def open_voice(_body: CascadeBody) -> OpenedLeg:
            return opened("tts", voice)

        lifecycle = lifecycle_with(
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertTrue(transport.listening_sent)
        self.assertEqual([GREETING], voice.greeted)
        self.assertTrue(end.greeting.spoken)
        self.assertFalse(end.greeting.cancelled)


class SlowAckOpeningTest(unittest.TestCase):
    """A six-second ack replays the opening, never in one fatal burst.

    The live failure (04d01703) buffered the caller's opening through a slow
    handshake, then sent the whole backlog in one go on top of a silence fill
    for the handshake itself: the vendor closed 1008 ("audio backlog too
    large") before any turn existed. The fix bounds the buffer and paces the
    replay on the speech session's own clock.
    """

    def test_a_slow_ack_replays_the_opening_at_real_time_and_still_replies(self):
        clock = FakeClock(10.0)
        frames = 150  # 3 s of 20 ms caller frames
        transport = OpeningTransport([AudioFrame(LOUD) for _ in range(frames)])
        voice = OpenVoice()
        stream = StoppingStream(transport)
        factory = ScriptedSocketFactory(
            [
                Frame(_ack(), delay_ms=6000),
                Frame(_event("speechStart", turnId=1)),
                Frame(_event("transcript", text=INTRO)),
                Frame(_event("speechComplete", turnId=1, transcript=INTRO)),
            ],
            clock=clock,
        )
        speech = MetaStreamingSTT(
            api_key="test-key",
            call_id=CALL_ID,
            socket_factory=factory,
            clock=clock,
        )
        ack_at: list[float] = []

        async def open_speech(_body: CascadeBody) -> OpenedLeg:
            # The caller's three seconds arrived while the handshake was in
            # flight; the acknowledgement lands six seconds after connecting.
            while transport.delivered < frames:
                await asyncio.sleep(0)
            await speech.open(language_codes=[], sample_rate=SAMPLE_RATE)
            ack_at.append(clock())
            return opened("stt", speech)

        async def open_voice(_body: CascadeBody) -> OpenedLeg:
            return opened("tts", voice)

        lifecycle = lifecycle_with(
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            clock=clock,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertEqual(0, speech.dropped_frames, "the replay dropped audio")
        self.assertEqual((), speech.failures, "the speech leg failed on backlog")
        # The three seconds of opening audio played over three seconds of the
        # session's clock, not as one burst.
        self.assertGreaterEqual(clock() - ack_at[0], 2.9)
        self.assertEqual([], voice.greeted)
        self.assertFalse(end.greeting.spoken)
        self.assertIn("caller spoke first", end.greeting.reason)
        self.assertEqual(1, end.turns)
        self.assertEqual(
            [SpeechStart, SpeechPartial, SpeechComplete],
            [type(event) for event in stream.events],
        )
        self.assertEqual(INTRO, stream.events[-1].text)

    def test_an_overflowing_buffer_drops_the_oldest_and_records_it(self):
        clock = FakeClock(10.0)
        frames = 300  # 6 s: a second past the five-second lead bound
        # Every frame is loud caller audio with its arrival order as a marker.
        pcm = [struct.pack("<H", index) + LOUD[2:] for index in range(frames)]
        transport = OpeningTransport([AudioFrame(frame) for frame in pcm])
        speech = PreAckSpeech(INTRO)
        voice = GatedVoice()
        stream = StoppingStream(transport)

        async def open_speech(_body: CascadeBody) -> OpenedLeg:
            while transport.delivered < frames:
                await asyncio.sleep(0)
            speech.acknowledged = True
            return opened("stt", speech)

        async def open_voice(_body: CascadeBody) -> OpenedLeg:
            return opened("tts", voice)

        lifecycle = lifecycle_with(
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            clock=clock,
        )

        with self.assertLogs("cascade.call", level="WARNING") as logs:
            end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        kept = [struct.unpack("<H", frame[:2])[0] for frame in speech.audio]
        self.assertEqual(list(range(frames - len(kept), frames)), kept)
        self.assertGreater(lifecycle.opening_audio_dropped, 0)
        self.assertEqual(
            lifecycle.opening_audio_dropped, (frames - len(kept)) * len(LOUD)
        )
        self.assertIn("dropped the oldest", "\n".join(logs.output))
        self.assertEqual([], voice.greeted)
        self.assertFalse(end.greeting.spoken)
        self.assertEqual(INTRO, stream.events[-1].text)


if __name__ == "__main__":
    unittest.main()
