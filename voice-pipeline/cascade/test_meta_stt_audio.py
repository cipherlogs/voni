"""The speech audio path: raw PCM, pacing, silence and malformed frames (29).

Only raw signed 16-bit little-endian mono 24 kHz PCM may reach the vendor:
JSON audio, base64 (a text payload) and containers are refused locally, and a
malformed binary frame is dropped and logged. Audio is paced approximately real
time by never running more than 5 s ahead of the injected clock, and silence is
sent to fill a gap before the next frame so the vendor's idle-input close does
not fire.

The audio path awaits only the socket write, never a vendor reply.
"""

import asyncio
import json
import unittest

from cascade.meta_stt import (
    BYTES_PER_SECOND,
    MAX_LEAD_S,
    SILENCE_FRAME_BYTES,
    SILENCE_FRAME_MS,
    AudioFrameRejected,
    MetaStreamingSTT,
)
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import ScriptedSocketFactory


def untyped_ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def caller_pcm(seconds: float) -> bytes:
    """Non-zero PCM (sample value 1), so it is distinguishable from silence."""
    samples = int(seconds * 24000)
    return b"\x01\x00" * samples


def silence_bytes(seconds: float) -> bytes:
    samples = int(seconds * 24000)
    return b"\x00\x00" * samples


def open_audio(clock=None, **kwargs):
    factory = ScriptedSocketFactory([untyped_ack()])
    options = {"api_key": "test-key", "call_id": "call-123"}
    if clock is not None:
        options["clock"] = clock
    options.update(kwargs)
    backend = MetaStreamingSTT(socket_factory=factory, **options)
    asyncio.run(backend.open(language_codes=[], sample_rate=24000))
    return backend, factory


class RawPcmOnlyTest(unittest.TestCase):
    def test_raw_pcm_goes_up_as_one_binary_frame(self):
        backend, factory = open_audio()
        pcm = caller_pcm(0.01)

        asyncio.run(backend.send_audio(pcm))

        self.assertEqual(factory.socket.sent[-1], pcm)
        self.assertIsInstance(factory.socket.sent[-1], bytes)

    def test_json_audio_is_refused_locally_and_never_sent(self):
        backend, factory = open_audio()
        payload = json.dumps({"audio": "AAAA"})

        with self.assertRaises(AudioFrameRejected) as raised:
            asyncio.run(backend.send_audio(payload))

        self.assertIn("raw binary", str(raised.exception))
        self.assertEqual(len(factory.socket.sent), 1)

    def test_base64_audio_text_is_refused_locally_and_never_sent(self):
        backend, factory = open_audio()

        with self.assertRaises(AudioFrameRejected):
            asyncio.run(backend.send_audio("UklGRiQAAABXQVZFZm10IBAAAAAB"))

        self.assertEqual(len(factory.socket.sent), 1)

    def test_a_wav_container_is_refused_locally(self):
        backend, factory = open_audio()
        wav = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 32

        with self.assertRaises(AudioFrameRejected) as raised:
            asyncio.run(backend.send_audio(wav))

        self.assertIn("container", str(raised.exception))
        self.assertEqual(len(factory.socket.sent), 1)

    def test_an_ogg_container_is_refused_locally(self):
        backend, factory = open_audio()

        with self.assertRaises(AudioFrameRejected):
            asyncio.run(backend.send_audio(b"OggS" + b"\x00" * 40))

        self.assertEqual(len(factory.socket.sent), 1)

    def test_a_malformed_binary_frame_is_dropped_and_logged(self):
        backend, factory = open_audio()

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            asyncio.run(backend.send_audio(b"\x01\x00\x01"))

        self.assertEqual(len(factory.socket.sent), 1)
        self.assertEqual(backend.dropped_frames, 1)

    def test_an_empty_frame_is_dropped(self):
        backend, factory = open_audio()

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            asyncio.run(backend.send_audio(b""))

        self.assertEqual(len(factory.socket.sent), 1)
        self.assertEqual(backend.dropped_frames, 1)

    def test_audio_after_close_is_refused(self):
        backend, factory = open_audio()
        asyncio.run(backend.close())

        with self.assertRaises(RuntimeError):
            asyncio.run(backend.send_audio(caller_pcm(0.01)))


class LeadBudgetTest(unittest.TestCase):
    def test_audio_is_never_more_than_five_seconds_ahead_of_the_clock(self):
        clock = FakeClock()
        backend, factory = open_audio(clock)

        for _ in range(10):
            asyncio.run(backend.send_audio(caller_pcm(0.5)))
        asyncio.run(backend.send_audio(caller_pcm(0.1)))

        sent_audio = [frame for frame in factory.socket.sent[1:]]
        self.assertEqual(sum(len(frame) for frame in sent_audio), 5 * BYTES_PER_SECOND)
        self.assertEqual(backend.dropped_frames, 1)
        self.assertEqual(MAX_LEAD_S, 5.0)

    def test_a_frame_fits_again_once_the_clock_catches_up(self):
        clock = FakeClock()
        backend, factory = open_audio(clock)
        for _ in range(10):
            asyncio.run(backend.send_audio(caller_pcm(0.5)))
        asyncio.run(backend.send_audio(caller_pcm(0.5)))
        self.assertEqual(backend.dropped_frames, 1)

        clock.advance(1.0)
        asyncio.run(backend.send_audio(caller_pcm(0.5)))

        self.assertEqual(backend.dropped_frames, 1)
        sent_audio = factory.socket.sent[1:]
        self.assertEqual(
            sum(len(frame) for frame in sent_audio), 5 * BYTES_PER_SECOND + 24000
        )


class SilenceTest(unittest.TestCase):
    def test_silence_fills_the_gap_before_the_next_caller_frame(self):
        clock = FakeClock()
        backend, factory = open_audio(clock)
        asyncio.run(backend.send_audio(caller_pcm(0.01)))

        clock.advance(0.1)
        asyncio.run(backend.send_audio(caller_pcm(0.01)))

        audio = factory.socket.sent[1:]
        silent = [frame for frame in audio if frame == silence_bytes(0.02)]
        self.assertEqual(len(silent), 4)
        self.assertEqual(sum(len(frame) for frame in silent), 4 * SILENCE_FRAME_BYTES)
        self.assertEqual(audio[-1], caller_pcm(0.01))
        self.assertEqual(SILENCE_FRAME_MS, 20.0)

    def test_silence_can_be_sent_directly_for_a_quiet_tick(self):
        clock = FakeClock()
        backend, factory = open_audio(clock)

        asyncio.run(backend.send_silence(0.1))

        audio = factory.socket.sent[1:]
        self.assertEqual(len(audio), 5)
        self.assertTrue(all(frame == silence_bytes(0.02) for frame in audio))
        self.assertEqual(sum(len(frame) for frame in audio), 5 * SILENCE_FRAME_BYTES)

    def test_silence_does_not_exceed_the_lead_budget(self):
        clock = FakeClock()
        backend, factory = open_audio(clock)

        asyncio.run(backend.send_silence(30.0))

        audio = factory.socket.sent[1:]
        self.assertLessEqual(sum(len(frame) for frame in audio), 5 * BYTES_PER_SECOND)


class NoRoundTripTest(unittest.TestCase):
    def test_the_audio_path_never_reads_from_the_socket(self):
        class CountingSocket:
            def __init__(self) -> None:
                self.sent: list[str | bytes] = []
                self.reads = 0
                self.closed = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                self.reads += 1
                if self.reads == 1:
                    return untyped_ack()
                raise StopAsyncIteration

            async def send(self, message):
                self.sent.append(message)

            async def close(self):
                self.closed = True

        socket = CountingSocket()

        async def factory(url, headers):
            return socket

        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )
        asyncio.run(backend.open(language_codes=[], sample_rate=24000))
        reads_after_ack = socket.reads

        asyncio.run(backend.send_audio(caller_pcm(0.02)))
        asyncio.run(backend.send_silence(0.02))

        self.assertEqual(socket.reads, reads_after_ack)


if __name__ == "__main__":
    unittest.main()
