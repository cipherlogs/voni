"""The barge-in cut path: ``Cancel``, stop the producer, flush, drop (ticket 88).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Cut. An interruption is a caller winning the floor, and the cascade cuts
with the synthesis socket's ``Cancel``; it never closes the socket and it never
soft-yields (finishing the sentence first is the managed path, rejected for the
cascade because a long sentence blows ``realCutMs``).

These tests drive the public :class:`cascade.barge_in.BargeInCutPath` seam: the
producer that plays a reply's synthesis audio, and the one cut that stops it.
The synthesis session is the real ``AssemblyAIStreamingTTS`` over a pushable
scripted socket in the end-to-end test, and a recording fake elsewhere, so a
"close instead of cancel" implementation fails on both.

Ticket 89 owns mapping the client's ``played_ms`` to reply text; ticket 90 owns
the resume. Here the cut only *records* that seam, verbatim.
"""

import asyncio
import json
import unittest

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.barge_in import CUT_BUDGET_MS, BargeInCutPath
from cascade.test_tts_support import (
    audio_ms,
    begin,
    cancelled,
    flush_done,
)
from cascade.testing.clock import FakeClock
from metrics import TimingLedger
from providers import SentenceAudio

SAMPLE_RATE = 24000


class FakeTTS:
    """A synthesis session that records ``Cancel``/``close`` and feeds chunks.

    ``speak`` pulls ``(flush_id, pcm)`` pairs from the queue, so a test decides
    exactly when the next frame exists. ``cancel`` is the only way in-flight
    audio may be stopped: ``close`` is recorded so a socket-close cut fails.
    """

    def __init__(self) -> None:
        self.flush_id = None
        self.cancels = 0
        self.closes = 0
        self.events: list[str] = []
        self.frames: asyncio.Queue = asyncio.Queue()
        self.cancellation_audio_seconds = 0.0

    def feed(self, flush_id: int | None, pcm: bytes) -> None:
        """Make one frame available to the next ``speak`` read."""
        self.frames.put_nowait((flush_id, pcm))

    async def speak(self, text):
        self.events.append(f"speak:{text}")
        while True:
            flush_id, pcm = await self.frames.get()
            if flush_id is None:
                return
            self.flush_id = flush_id
            yield SentenceAudio(pcm=pcm, sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        from cascade.assemblyai_tts import Cancellation

        self.cancels += 1
        self.events.append("cancel")
        return Cancellation(audio_duration_seconds=self.cancellation_audio_seconds)

    async def close(self) -> None:
        self.closes += 1


class PushSocket:
    """A websocket the test feeds frame by frame; ``close`` is recorded."""

    def __init__(self) -> None:
        self.frames: asyncio.Queue = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False

    def push(self, frame: str | bytes | None) -> None:
        self.frames.put_nowait(frame)

    def __aiter__(self) -> "PushSocket":
        return self

    async def __anext__(self) -> str | bytes:
        frame = await self.frames.get()
        if frame is None:
            raise StopAsyncIteration
        return frame

    async def send(self, message: str | bytes) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


def sent_types(socket: PushSocket) -> list[str]:
    return [json.loads(message)["type"] for message in socket.sent]


class Harness:
    """One cut path over a recording sink and a recording playout flush."""

    def __init__(self, *, tts=None, clock=None, ledger=None) -> None:
        self.tts = tts if tts is not None else FakeTTS()
        self.clock = clock if clock is not None else FakeClock()
        self.ledger = ledger
        self.played: list[bytes] = []
        self.played_flush_ids: list[int | None] = []
        self.flushes: list = []
        self.events: list[str] = []
        self.played_event = asyncio.Event()
        if tts is None:
            # One event log, so the cross-component order is assertable.
            self.tts.events = self.events
        self.path = BargeInCutPath(
            tts=self.tts,
            on_audio=self._on_audio,
            flush_playout=self._flush_playout,
            clock=self.clock,
            ledger=ledger,
        )

    async def _on_audio(self, chunk: SentenceAudio) -> None:
        self.played.append(chunk.pcm)
        self.played_flush_ids.append(getattr(self.tts, "flush_id", None))
        self.events.append("audio")
        self.played_event.set()

    async def _flush_playout(self, flush) -> None:
        self.flushes.append(flush)
        self.events.append("flush")


def run(scenario, timeout_s: float = 5.0):
    """Drive one scenario; the timeout only turns a hang into a failure."""

    async def guarded():
        return await asyncio.wait_for(scenario(), timeout_s)

    return asyncio.run(guarded())


class CancelNotCloseTest(unittest.TestCase):
    def test_a_take_the_floor_cut_sends_cancel_and_never_closes_the_socket(self):
        async def scenario():
            harness = Harness()
            harness.tts.feed(0, b"first")
            harness.path.start(harness.tts.speak("One."))
            await harness.played_event.wait()

            cut = await harness.path.cut(
                "partial", speech_started_at=0.0, played_ms=120.0
            )
            await harness.path.join()

            # The session is still usable: a close would have ended the call.
            harness.tts.feed(1, b"later")
            harness.tts.feed(None, b"")
            harness.path.start(harness.tts.speak("Later."))
            await harness.path.join()
            return harness, cut

        harness, cut = run(scenario)

        self.assertEqual(harness.tts.cancels, 1)
        self.assertEqual(harness.tts.closes, 0)
        self.assertEqual(harness.played, [b"first", b"later"])
        self.assertEqual(cut.seam.flush_id, 0)

    def test_the_frames_between_cancel_and_cancelled_are_never_played(self):
        async def scenario():
            harness = Harness()

            async def cancel_and_feed_stale_audio():
                # The vendor's old-request frame, already on its way when the
                # Cancel lands: never heard, because the producer is stopped.
                harness.tts.feed(0, b"stale-between-cancel-and-cancelled")
                cancellation = await FakeTTS.cancel(harness.tts)
                # Let the producer run: it must drop the stale frame itself,
                # not merely be killed before it can pull one.
                await asyncio.sleep(0)
                return cancellation

            harness.tts.cancel = cancel_and_feed_stale_audio
            harness.tts.feed(0, b"heard")
            harness.path.start(harness.tts.speak("One."))
            await harness.played_event.wait()

            await harness.path.cut("partial", speech_started_at=0.0)
            # Give the stopped producer every chance to misbehave.
            await asyncio.sleep(0)
            return harness

        harness = run(scenario)

        self.assertEqual(harness.played, [b"heard"])
        self.assertEqual(harness.tts.closes, 0)

    def test_the_cut_does_not_wait_for_the_sentence_to_finish(self):
        async def scenario():
            harness = Harness()
            # The next frame never arrives: a soft yield would wait here.
            harness.tts.feed(0, b"first")
            harness.path.start(harness.tts.speak("A long sentence that continues."))
            await harness.played_event.wait()

            cut = await harness.path.cut("speech_start", speech_started_at=0.0)
            return harness, cut

        harness, cut = run(scenario)

        self.assertTrue(cut.real_cut)
        self.assertEqual(harness.played, [b"first"])
        self.assertEqual(harness.path.reply_in_flight, False)


class NewFlushIdTest(unittest.TestCase):
    def test_the_next_request_takes_the_new_flush_id(self):
        async def scenario():
            harness = Harness()
            harness.tts.feed(0, b"cut-me")
            harness.path.start(harness.tts.speak("One."), turn="turn-1")
            await harness.played_event.wait()

            await harness.path.cut("partial", speech_started_at=0.0)

            # The vendor skips ids after a cancel; the next request carries 5.
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            harness.path.start(harness.tts.speak("tail"), turn="turn-1")
            await harness.path.join()
            return harness

        harness = run(scenario)

        self.assertEqual(harness.played_flush_ids, [0, 5])
        self.assertEqual(harness.played, [b"cut-me", b"tail"])
        self.assertEqual(harness.tts.closes, 0)

    def test_a_cut_with_nothing_in_flight_still_cancels_and_flushes_the_client(self):
        async def scenario():
            harness = Harness()
            cut = await harness.path.cut("speech_start", speech_started_at=0.0)
            return harness, cut

        harness, cut = run(scenario)

        self.assertEqual(harness.tts.cancels, 1)
        self.assertEqual(len(harness.flushes), 1)
        self.assertIsNone(cut.seam.flush_id)
        self.assertEqual(cut.dropped_frames, 0)


class LedgerMarkTest(unittest.TestCase):
    def test_the_cancelled_mark_is_written_once_per_call_not_once_per_cut(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)

        async def scenario():
            harness = Harness(clock=clock, ledger=ledger)
            clock.advance(1.0)
            first = await harness.path.cut("partial", speech_started_at=0.0)
            clock.advance(2.0)
            second = await harness.path.cut("partial", speech_started_at=1.5)
            return first, second

        first, second = run(scenario)

        summary = ledger.summary()
        self.assertEqual(summary["marks"]["cancelled"], 1.0)
        self.assertEqual(summary["counts"]["interruption"], 2)
        self.assertEqual(first.decided_at, 1.0)
        self.assertEqual(second.decided_at, 3.0)


class CutBudgetTest(unittest.TestCase):
    def test_the_cut_is_measured_against_the_real_cut_budget(self):
        async def scenario():
            clock = FakeClock()
            harness = Harness(clock=clock)
            clock.advance(0.25)
            return await harness.path.cut("partial", speech_started_at=0.0)

        cut = run(scenario)

        self.assertEqual(cut.budget_ms, CUT_BUDGET_MS)
        self.assertEqual(cut.stop_latency_ms, 250.0)
        self.assertTrue(cut.within_budget)

    def test_a_slow_cut_is_recorded_as_over_budget_not_hidden(self):
        async def scenario():
            clock = FakeClock()
            harness = Harness(clock=clock)
            clock.advance(2.0)
            return await harness.path.cut("partial", speech_started_at=0.0)

        cut = run(scenario)

        self.assertEqual(cut.stop_latency_ms, 2000.0)
        self.assertFalse(cut.within_budget)
        # Over budget is still a real cut: the caller wins, not the sentence.
        self.assertTrue(cut.real_cut)

    def test_an_unreported_speech_start_leaves_the_latency_unmeasured(self):
        async def scenario():
            harness = Harness()
            return await harness.path.cut("greeting", speech_started_at=None)

        cut = run(scenario)

        self.assertIsNone(cut.stop_latency_ms)
        self.assertIsNone(cut.within_budget)


class PlayedPositionSeamTest(unittest.TestCase):
    def test_the_cut_records_the_played_position_for_the_resume_ticket(self):
        async def scenario():
            harness = Harness()
            harness.tts.feed(0, b"a")
            harness.path.start(harness.tts.speak("One."), turn="turn-7", reply="p1")
            await harness.played_event.wait()
            return await harness.path.cut(
                "partial",
                speech_started_at=0.0,
                played_ms=137.5,
            )

        cut = run(scenario)

        self.assertEqual(cut.seam.played_ms, 137.5)
        self.assertEqual(cut.seam.flush_id, 0)
        self.assertEqual(cut.seam.turn, "turn-7")
        self.assertEqual(cut.seam.reply, "p1")

    def test_an_unreported_played_position_stays_none_not_zero(self):
        async def scenario():
            harness = Harness()
            return await harness.path.cut("speech_start", speech_started_at=0.0)

        cut = run(scenario)

        self.assertIsNone(cut.seam.played_ms)

    def test_a_negative_played_position_is_refused(self):
        async def scenario():
            harness = Harness()
            await harness.path.cut(
                "partial", speech_started_at=0.0, played_ms=-1.0
            )

        with self.assertRaises(ValueError):
            run(scenario)


class PlayoutFlushTest(unittest.TestCase):
    def test_the_client_is_flushed_after_cancel_and_after_the_producer_stops(self):
        async def scenario():
            harness = Harness()
            harness.tts.feed(0, b"first")
            harness.path.start(harness.tts.speak("One."), turn="turn-1")
            await harness.played_event.wait()
            cut = await harness.path.cut(
                "partial", speech_started_at=0.0, played_ms=80.0
            )
            return harness, cut

        harness, cut = run(scenario)

        # Cancel and flush are what the client and vendor see, in this order.
        seen = [
            event
            for event in harness.events
            if event in ("audio", "cancel", "flush")
        ]
        self.assertEqual(seen, ["audio", "cancel", "flush"])
        flush = harness.flushes[0]
        self.assertEqual(flush.generation, cut.generation)
        self.assertEqual(flush.flush_id, 0)
        self.assertEqual(flush.cause, "partial")
        self.assertTrue(cut.client_flushed)


class RealSessionTest(unittest.TestCase):
    """End to end over the real adapter: the socket survives and ids advance."""

    def test_the_synthesis_socket_survives_and_the_next_request_uses_the_new_id(self):
        async def scenario():
            socket = PushSocket()

            async def factory(url, headers):
                return socket

            clock = FakeClock()
            ledger = TimingLedger(now=clock)
            tts = AssemblyAIStreamingTTS(
                voice_id="anna",
                transport="browser",
                api_key="test-key",
                socket_factory=factory,
                clock=clock,
            )
            socket.push(begin())
            await tts.open()

            harness = Harness(tts=tts, clock=clock, ledger=ledger)
            socket.push(audio_ms(300, flush_id=0))
            harness.path.start(tts.speak("One."), turn="turn-1")
            await harness.played_event.wait()

            cut = await harness.path.cut(
                "partial", speech_started_at=0.0, played_ms=150.0
            )

            # These arrive after Cancel: the first belongs to the old request
            # and is dropped; the next request takes the id the vendor assigns.
            socket.push(audio_ms(200, flush_id=1))
            socket.push(cancelled(audio_duration_seconds=0.2))
            socket.push(audio_ms(250, flush_id=5))
            socket.push(flush_done(flush_id=5, audio_duration_ms=250))
            harness.path.start(tts.speak("tail"), turn="turn-1")
            await harness.path.join()
            return tts, socket, harness, cut

        tts, socket, harness, cut = run(scenario)

        self.assertEqual(
            sent_types(socket),
            ["Generate", "Flush", "Cancel", "Generate", "Flush"],
        )
        self.assertFalse(socket.closed)
        self.assertEqual(harness.played_flush_ids, [0, 5])
        self.assertEqual(tts.flush_id, 5)
        self.assertTrue(tts.cancellations[0].acknowledged)
        self.assertEqual(
            tts.cancellations[0].dropped_audio_bytes, 24000 * 2 * 200 // 1000
        )
        self.assertEqual(cut.seam.played_ms, 150.0)
        self.assertIsNotNone(cut.cancellation)
        self.assertEqual(harness.path.cuts, (cut,))


if __name__ == "__main__":
    unittest.main()
