"""Cancel semantics and the next flush id (ticket 52).

``Cancel`` is the barge-in primitive: it stops in-flight synthesis and
discards every pending flush and the text that was never sent. The audio that
arrives between the ``Cancel`` and its ``Cancelled`` belongs to the old
request and is dropped. The request after it takes a new ``flush_id`` that may
skip numbers, read from the first frame after ``Cancelled`` and never
computed, and a ``Generate`` sent right after a cancel is not caught by it.
"""

import asyncio
import unittest

from cascade.test_tts_support import (
    audio,
    begin,
    cancelled,
    flush_done,
    make_session,
    open_session,
    pcm,
    sent_texts,
    sent_types,
)


async def first_audio(tts, text):
    """Start a reply and return its generator suspended after the first chunk."""
    generator = tts.speak(text)
    chunk = await generator.__anext__()
    return generator, chunk


async def drain(generator):
    return [chunk async for chunk in generator]


class DiscardTests(unittest.TestCase):
    def test_cancel_discards_unflushed_text_and_pending_flushes(self):
        tts, factory = open_session(
            [
                begin(),
                audio(pcm(1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=1000),
                audio(pcm(2), flush_id=1),
                flush_done(flush_id=1, audio_duration_ms=500),
                audio(pcm(3), flush_id=2),
                flush_done(flush_id=2, audio_duration_ms=500),
            ]
        )

        async def scenario():
            generator, _ = await first_audio(tts, "One. Two. Three.")
            await tts.cancel()
            sent_at_cancel = len(sent_types(factory))
            with self.assertRaises(StopAsyncIteration):
                await generator.__anext__()
            return sent_at_cancel

        sent_at_cancel = asyncio.run(scenario())

        self.assertEqual(sent_types(factory), ["Generate", "Flush", "Cancel"])
        self.assertEqual(len(sent_types(factory)), sent_at_cancel)
        cancellation = tts.cancellations[0]
        self.assertEqual(cancellation.discarded_characters, len("Two. ") + len("Three."))
        self.assertFalse(cancellation.acknowledged)

    def test_cancel_sends_the_cancel_frame_before_dropping_the_queue(self):
        tts, factory = open_session([begin()])

        async def scenario():
            await tts.cancel()

        asyncio.run(scenario())

        self.assertEqual(sent_types(factory), ["Cancel"])


class AcknowledgementTests(unittest.TestCase):
    def test_audio_between_cancel_and_cancelled_is_dropped(self):
        old_tail = pcm(42, 43)
        new_audio = pcm(7)
        tts, factory = open_session(
            [
                begin(),
                audio(pcm(1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=1000),
                audio(old_tail, flush_id=0),
                cancelled(audio_duration_seconds=0.4),
                audio(new_audio, flush_id=7),
                flush_done(flush_id=7, audio_duration_ms=300),
            ]
        )

        async def scenario():
            abandoned, _ = await first_audio(tts, "First. Second.")
            await tts.cancel()
            with self.assertRaises(StopAsyncIteration):
                await abandoned.__anext__()
            return await drain(tts.speak("Tail."))

        chunks = asyncio.run(scenario())

        self.assertEqual([chunk.pcm for chunk in chunks], [new_audio])
        cancellation = tts.cancellations[0]
        self.assertTrue(cancellation.acknowledged)
        self.assertEqual(cancellation.audio_duration_seconds, 0.4)
        self.assertEqual(cancellation.dropped_audio_bytes, len(old_tail))
        self.assertEqual(cancellation.dropped_flushes, 1)

    def test_the_next_flush_id_is_read_from_the_first_frame_after_cancelled(self):
        tts, factory = open_session(
            [
                begin(),
                audio(pcm(1), flush_id=0),
                cancelled(audio_duration_seconds=0.4),
                audio(pcm(7), flush_id=7),
                flush_done(flush_id=7, audio_duration_ms=300),
            ]
        )

        async def scenario():
            generator, _ = await first_audio(tts, "First.")
            await tts.cancel()
            with self.assertRaises(StopAsyncIteration):
                await generator.__anext__()
            return await drain(tts.speak("Tail."))

        asyncio.run(scenario())

        cancellation = tts.cancellations[0]
        self.assertEqual(cancellation.next_flush_id, 7)
        self.assertEqual(tts.flush_id, 7)

    def test_a_generate_sent_after_cancel_is_not_caught_by_that_cancel(self):
        tts, factory = open_session(
            [
                begin(),
                audio(pcm(1), flush_id=0),
                cancelled(audio_duration_seconds=0.4),
                audio(pcm(9), flush_id=4),
                flush_done(flush_id=4, audio_duration_ms=200),
            ]
        )

        async def scenario():
            generator, _ = await first_audio(tts, "First.")
            await tts.cancel()
            with self.assertRaises(StopAsyncIteration):
                await generator.__anext__()
            return await drain(tts.speak("The tail."))

        chunks = asyncio.run(scenario())

        self.assertEqual([chunk.pcm for chunk in chunks], [pcm(9)])
        self.assertEqual(sent_texts(factory), ["First.", "The tail."])
        self.assertEqual(
            sent_types(factory),
            ["Generate", "Flush", "Cancel", "Generate", "Flush"],
        )

    def test_a_cancel_with_nothing_in_flight_acks_zero_and_the_client_flush_runs(self):
        new_audio = pcm(5)
        tts, factory = open_session(
            [
                begin(),
                cancelled(audio_duration_seconds=0.0),
                audio(new_audio, flush_id=3),
                flush_done(flush_id=3, audio_duration_ms=200),
            ]
        )

        async def scenario():
            await tts.cancel()
            return await drain(tts.speak("Tail."))

        chunks = asyncio.run(scenario())

        self.assertEqual([chunk.pcm for chunk in chunks], [new_audio])
        self.assertEqual(tts.cancellations[0].audio_duration_seconds, 0.0)
        self.assertTrue(tts.cancellations[0].acknowledged)
        self.assertEqual(tts.cancellations[0].next_flush_id, 3)
        self.assertEqual(sent_types(factory), ["Cancel", "Generate", "Flush"])

class NotOpenTests(unittest.TestCase):
    def test_a_cancel_before_the_session_is_open_refuses(self):
        tts, _ = make_session([begin()])

        with self.assertRaises(RuntimeError):
            asyncio.run(tts.cancel())


if __name__ == "__main__":
    unittest.main()
