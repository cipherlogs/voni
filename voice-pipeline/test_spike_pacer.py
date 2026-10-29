"""Ticket 09: the real-time pacer.

Two laws, proved with an injected clock and an injected wait so the suite never
sleeps: audio is never sent before its media time, and the stream never runs
more than the lead cap ahead of the vendor's ``audioProcessedMs``.
"""

import time
import unittest

from spike import fixture
from spike.pacer import MAX_LEAD_S, Blocked, Pacer, Send


class FakeClock:
    """A monotonic clock whose ``wait`` jumps time forward instead of sleeping."""

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start
        self.waits: list[float] = []

    def __call__(self) -> float:
        return self.now

    def wait(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.now += seconds


def one_second_audio() -> bytes:
    return fixture.render_pcm(seconds=1.0, speech_end_s=snap(0.9))


class RealTimeTests(unittest.TestCase):
    def test_chunks_are_sent_at_their_media_time(self):
        clock = FakeClock()
        pacer = Pacer(
            one_second_audio(),
            vendor_processed_s=lambda: 0.0,
            clock=clock,
            wait=clock.wait,
        )
        sends = []
        while (item := pacer.next_send()) is not None:
            self.assertIsInstance(item, Send)
            sends.append(item)

        self.assertEqual(len(sends), 10)
        for send in sends:
            self.assertAlmostEqual(send.sent_at_s, 1_000.0 + send.media_start_s)
        self.assertAlmostEqual(sends[0].media_start_s, 0.0)
        self.assertAlmostEqual(sends[-1].media_start_s, 0.9)
        self.assertAlmostEqual(sends[-1].media_end_s, 1.0)

    def test_pacer_waits_before_the_first_chunk_only_when_the_clock_is_early(self):
        clock = FakeClock()
        pacer = Pacer(
            one_second_audio(),
            vendor_processed_s=lambda: 0.0,
            clock=clock,
            wait=clock.wait,
        )
        first = pacer.next_send()
        second = pacer.next_send()
        self.assertAlmostEqual(first.sent_at_s, 1_000.0)
        self.assertAlmostEqual(second.sent_at_s - first.sent_at_s, 0.1)
        self.assertEqual(len(clock.waits), 1)
        self.assertAlmostEqual(clock.waits[0], 0.1)

    def test_twenty_second_stream_never_touches_the_wall_clock(self):
        started = time.monotonic()
        clock = FakeClock()
        pacer = Pacer(
            fixture.render_pcm(seconds=20.0, speech_end_s=snap(12.4)),
            vendor_processed_s=lambda: 20.0,
            clock=clock,
            wait=clock.wait,
        )
        count = 0
        while (item := pacer.next_send()) is not None:
            self.assertIsInstance(item, Send)
            count += 1
        elapsed = time.monotonic() - started
        self.assertEqual(count, 200)
        self.assertLess(elapsed, 1.0)
        self.assertAlmostEqual(clock.now - 1_000.0, 19.9)


class ChunkingTests(unittest.TestCase):
    def test_chunks_cover_the_input_exactly_with_a_short_last_chunk(self):
        audio = b"\x01\x00" * (24_000 + 1_234)
        clock = FakeClock()
        pacer = Pacer(
            audio,
            vendor_processed_s=lambda: 0.0,
            clock=clock,
            wait=clock.wait,
        )
        chunks = []
        while (item := pacer.next_send()) is not None:
            chunks.append(item.chunk)
        self.assertEqual(b"".join(chunks), audio)
        self.assertEqual(len(chunks), 11)
        self.assertEqual(len(chunks[0]), 4_800)
        self.assertEqual(len(chunks[-1]), 2_468)

    def test_a_chunk_longer_than_the_lead_cap_is_rejected(self):
        with self.assertRaises(ValueError):
            Pacer(
                b"\x00\x00" * 100,
                vendor_processed_s=lambda: 0.0,
                chunk_ms=int(MAX_LEAD_S * 1_000) + 1,
            )

    def test_empty_audio_is_done_immediately(self):
        pacer = Pacer(b"", vendor_processed_s=lambda: 0.0)
        self.assertIsNone(pacer.next_send())


class LeadCapTests(unittest.TestCase):
    def test_refuses_to_run_more_than_the_cap_ahead_of_the_vendor(self):
        clock = FakeClock()
        pacer = Pacer(
            fixture.render_pcm(seconds=20.0, speech_end_s=snap(12.4)),
            vendor_processed_s=lambda: 0.0,
            clock=clock,
            wait=clock.wait,
        )
        sends = []
        blocked = None
        for _ in range(1_000):
            item = pacer.next_send()
            if isinstance(item, Blocked):
                blocked = item
                break
            self.assertIsInstance(item, Send)
            sends.append(item)
        self.assertIsNotNone(blocked, "pacer never refused a stream past the lead cap")

        self.assertEqual(len(sends), int(MAX_LEAD_S * 1_000 / 100))
        self.assertAlmostEqual(sends[-1].media_end_s, MAX_LEAD_S)
        self.assertAlmostEqual(blocked.media_end_s, MAX_LEAD_S + 0.1)
        self.assertAlmostEqual(blocked.lead_s, MAX_LEAD_S + 0.1)
        self.assertAlmostEqual(blocked.vendor_processed_s, 0.0)
        self.assertAlmostEqual(clock.now - 1_000.0, MAX_LEAD_S - 0.1)

    def test_exactly_the_cap_ahead_is_allowed(self):
        clock = FakeClock()
        audio = fixture.render_pcm(seconds=6.0, speech_end_s=snap(5.0))
        pacer = Pacer(
            audio,
            vendor_processed_s=lambda: 1.0,
            clock=clock,
            wait=clock.wait,
        )
        sends = []
        while (item := pacer.next_send()) is not None:
            self.assertIsInstance(item, Send)
            sends.append(item)
        self.assertEqual(len(sends), 60)
        self.assertAlmostEqual(sends[-1].media_end_s, 6.0)
        self.assertAlmostEqual(sends[-1].media_end_s - 1.0, MAX_LEAD_S)

    def test_one_hundredth_of_a_second_past_the_cap_is_blocked(self):
        clock = FakeClock()
        audio = fixture.render_pcm(seconds=6.0, speech_end_s=snap(5.0))
        pacer = Pacer(
            audio,
            vendor_processed_s=lambda: 0.99,
            clock=clock,
            wait=clock.wait,
        )
        item = None
        for _ in range(60):
            item = pacer.next_send()
            if isinstance(item, Blocked):
                break
        self.assertIsInstance(item, Blocked)
        self.assertAlmostEqual(item.lead_s, 5.01)

    def test_blocked_does_not_advance_the_stream_and_resumes_when_the_vendor_does(self):
        clock = FakeClock()
        vendor = [0.0]
        pacer = Pacer(
            fixture.render_pcm(seconds=20.0, speech_end_s=snap(12.4)),
            vendor_processed_s=lambda: vendor[0],
            clock=clock,
            wait=clock.wait,
        )
        last = None
        for _ in range(1_000):
            last = pacer.next_send()
            if isinstance(last, Blocked):
                break
        self.assertIsInstance(last, Blocked, "pacer never refused a stream past the lead cap")

        still_blocked = pacer.next_send()
        self.assertIsInstance(still_blocked, Blocked)
        self.assertAlmostEqual(still_blocked.media_start_s, last.media_start_s)

        vendor[0] = 1.0
        resumed = pacer.next_send()
        self.assertIsInstance(resumed, Send)
        self.assertAlmostEqual(resumed.media_start_s, MAX_LEAD_S)
        self.assertAlmostEqual(resumed.media_end_s - vendor[0], 4.1)
        self.assertEqual(resumed.index, 50)


def snap(seconds: float) -> float:
    """Land the speech end on a whole sample so fixtures are exact."""
    return round(seconds * fixture.SAMPLE_RATE) / fixture.SAMPLE_RATE


if __name__ == "__main__":
    unittest.main()
