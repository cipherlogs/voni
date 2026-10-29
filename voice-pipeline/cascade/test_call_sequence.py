"""Call-level audio sequence numbers survive a reconnect (ticket 98).

Every server-to-browser audio frame carries one monotonic ``seq`` that belongs
to the call, not to a TTS ``flush_id`` and not to a session epoch. The tests
drive the two seams this module owns:

* :class:`cascade.call.CallSequence` is the emitter — the counter only ever
  moves forward, and a reconnect advances the epoch without touching it;
* :class:`cascade.call.CallPlayout` is the receiving contract — a frame whose
  ``seq`` is not greater than the highest played is dropped, a gap is logged
  and playback continues, and a duplicate is never played twice.

Expected values are written by hand: the first frame is ``seq`` 1, a reconnect
is the *next* number rather than ``1`` again, and a duplicate carries the same
payload the first frame carried.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.call import (
    CallLifecycle,
    CallPlayout,
    CallSequence,
    OutboundAudio,
)
from providers import SentenceAudio


def frame(seq: int, pcm: bytes = b"\x01\x00", *, epoch: int = 0) -> OutboundAudio:
    """One already-built outbound frame, for the playout tests."""
    return OutboundAudio(
        seq=seq,
        epoch=epoch,
        pcm=pcm,
        sample_rate=24000,
        kind="reply",
    )


class CallSequenceTest(unittest.TestCase):
    def test_the_first_frame_is_one_and_every_frame_moves_forward(self):
        sequence = CallSequence()

        self.assertEqual([1, 2, 3], [sequence.next() for _ in range(3)])
        self.assertEqual(3, sequence.current)

    def test_the_seq_is_the_call_seq_and_not_a_tts_flush_id(self):
        sequence = CallSequence()

        first = sequence.frame(
            pcm=b"\x01\x00", sample_rate=24000, kind="greeting", flush_id=7
        )
        second = sequence.frame(
            pcm=b"\x02\x00", sample_rate=24000, kind="greeting", flush_id=7
        )

        self.assertEqual([1, 2], [first.seq, second.seq])
        self.assertEqual([7, 7], [first.flush_id, second.flush_id])

    def test_a_reconnect_continues_the_sequence_and_never_resets_it(self):
        sequence = CallSequence()
        sequence.next()
        sequence.next()

        epoch = sequence.reconnect()

        self.assertEqual(1, epoch)
        self.assertEqual(2, sequence.current)
        self.assertEqual(3, sequence.next())

    def test_a_reconnect_must_advance_the_session_epoch(self):
        sequence = CallSequence()

        sequence.reconnect(epoch=1)

        with self.assertRaises(ValueError):
            sequence.reconnect(epoch=1)

    def test_frames_after_a_reconnect_carry_the_new_epoch_and_the_next_seq(self):
        sequence = CallSequence()
        sequence.next()
        sequence.reconnect()

        outbound = sequence.frame(pcm=b"\x09\x00", sample_rate=24000)

        self.assertEqual(2, outbound.seq)
        self.assertEqual(1, outbound.epoch)


class CallPlayoutTest(unittest.TestCase):
    def test_a_frame_greater_than_the_highest_played_is_played(self):
        playout = CallPlayout()

        self.assertTrue(playout.accept(frame(1)))
        self.assertTrue(playout.accept(frame(2, b"\x02\x00")))

        self.assertEqual([1, 2], [played.seq for played in playout.played])
        self.assertEqual(2, playout.highest_played)

    def test_a_duplicate_frame_is_dropped_and_never_played_twice(self):
        playout = CallPlayout()
        original = frame(1)
        playout.accept(original)

        with self.assertLogs("cascade.call", level="WARNING") as logs:
            accepted = playout.accept(original)

        self.assertFalse(accepted)
        self.assertEqual([1], [played.seq for played in playout.played])
        self.assertEqual(1, len(playout.duplicates))
        self.assertFalse(playout.duplicates[0].different_bytes)
        self.assertIn("duplicate", logs.output[0])
        self.assertIn("seq=1", logs.output[0])

    def test_a_duplicate_with_different_bytes_is_dropped_and_logged(self):
        playout = CallPlayout()
        playout.accept(frame(1, b"\x01\x00"))

        with self.assertLogs("cascade.call", level="WARNING") as logs:
            accepted = playout.accept(frame(1, b"\xff\xff"))

        self.assertFalse(accepted)
        self.assertEqual(1, len(playout.duplicates))
        self.assertTrue(playout.duplicates[0].different_bytes)
        self.assertEqual(1, playout.duplicates[0].seq)
        self.assertIn("different bytes", logs.output[0])
        self.assertEqual([b"\x01\x00"], [played.pcm for played in playout.played])

    def test_a_gap_is_logged_and_the_call_continues(self):
        playout = CallPlayout()
        playout.accept(frame(1))

        with self.assertLogs("cascade.call", level="WARNING") as logs:
            accepted = playout.accept(frame(3, b"\x03\x00"))

        self.assertTrue(accepted)
        self.assertEqual([1, 3], [played.seq for played in playout.played])
        self.assertEqual(1, len(playout.gaps))
        self.assertEqual(2, playout.gaps[0].expected)
        self.assertEqual(3, playout.gaps[0].received)
        self.assertIn("gap", logs.output[0])

    def test_a_stale_frame_from_the_old_epoch_is_dropped_after_reconnect(self):
        playout = CallPlayout()
        playout.accept(frame(1, epoch=0))
        playout.accept(frame(2, epoch=1))

        self.assertFalse(playout.accept(frame(2, b"\x02\x00", epoch=0)))

        self.assertEqual([1, 2], [played.seq for played in playout.played])
        self.assertEqual(1, len(playout.duplicates))

    def test_a_new_epoch_with_the_next_seq_is_played(self):
        playout = CallPlayout()
        playout.accept(frame(1, epoch=0))

        self.assertTrue(playout.accept(frame(2, b"\x02\x00", epoch=1)))

        self.assertEqual(1, playout.played[-1].epoch)


class LifecycleSequenceTest(unittest.TestCase):
    """The real call path: greeting audio carries the call-level seq."""

    def lifecycle(self):
        sent = []

        async def unused(_body):
            raise AssertionError("not opened here")

        async def send_audio(outbound):
            sent.append(outbound)

        lifecycle = CallLifecycle(
            message={},
            secret="secret",
            call_id="sequence-test",
            transport=None,
            open_speech=unused,
            open_voice=unused,
            send_audio=send_audio,
        )
        return lifecycle, sent

    def test_emitted_audio_frames_carry_a_monotonic_call_seq(self):
        lifecycle, sent = self.lifecycle()

        first = asyncio.run(
            lifecycle.emit_audio(SentenceAudio(pcm=b"\x01\x00", sample_rate=24000))
        )
        second = asyncio.run(
            lifecycle.emit_audio(SentenceAudio(pcm=b"\x02\x00", sample_rate=24000))
        )

        self.assertEqual([1, 2], [first.seq, second.seq])
        self.assertEqual([1, 2], [outbound.seq for outbound in sent])

    def test_a_reconnect_does_not_reset_the_next_emitted_seq(self):
        lifecycle, sent = self.lifecycle()

        asyncio.run(
            lifecycle.emit_audio(SentenceAudio(pcm=b"\x01\x00", sample_rate=24000))
        )
        epoch = lifecycle.session_reconnected()
        third = asyncio.run(
            lifecycle.emit_audio(SentenceAudio(pcm=b"\x03\x00", sample_rate=24000))
        )

        self.assertEqual(1, epoch)
        self.assertEqual(2, third.seq)
        self.assertEqual(1, third.epoch)
        self.assertEqual([1, 2], [outbound.seq for outbound in sent])

    def test_the_same_emitted_frame_is_never_played_twice(self):
        lifecycle, sent = self.lifecycle()
        playout = CallPlayout()

        outbound = asyncio.run(
            lifecycle.emit_audio(SentenceAudio(pcm=b"\x01\x00", sample_rate=24000))
        )

        self.assertTrue(playout.accept(outbound))
        self.assertFalse(playout.accept(outbound))
        self.assertEqual([outbound], playout.played)


if __name__ == "__main__":
    unittest.main()
