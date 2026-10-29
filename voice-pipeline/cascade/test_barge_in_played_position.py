"""The unheard tail is located from the client's played position (ticket 89).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Tail identity. The client reports the last played position with the
interruption; the server maps it to the reply text using the per-sentence
``FlushDone.audio_duration_ms`` and the session's ``WordBoundaries``. The
resume point is the first unheard word when the boundaries are complete, and
the start of the first sentence that had not fully played otherwise. A short
repeat is acceptable; a lost word is not.

The cut point itself is sample-exact: the reported millisecond position is
converted to a whole sample at the session's own rate before it is used to
locate a word, so a fractional report can never round *up* past a word. The
located point is stored on the cut seam for ticket 90's resume; this ticket
does not re-synthesize anything.

The synthesis session is the real ``AssemblyAIStreamingTTS`` over recorded
frames, so word boundaries, flush durations and the status fallback are the
adapter's own, not a fake's.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    ResumeGranularity,
    ResumePoint,
)
from cascade.barge_in import BargeInCutPath
from cascade.test_tts_support import (
    audio_ms,
    begin,
    flush_done,
    open_session,
    termination,
    word_boundaries,
    words,
)
from cascade.testing.clock import FakeClock
from providers import SentenceAudio

SAMPLE_RATE = 24000


def reply_frames(*, status=None):
    """One two-sentence reply, each sentence timed and (first) word-timed.

    ``status`` is the ``Termination`` summary's ``word_boundaries_status``;
    ``None`` keeps the call live, where the adapter treats the boundaries it
    has as usable.
    """
    frames = [
        begin(),
        audio_ms(700, flush_id=0),
        flush_done(flush_id=0, audio_duration_ms=700),
        word_boundaries(
            flush_id=0,
            audio_start_ms=0,
            entries=words(("hello", 0, 300), ("there.", 300, 700)),
        ),
        audio_ms(400, flush_id=1),
        flush_done(flush_id=1, audio_duration_ms=400),
        word_boundaries(
            flush_id=1,
            audio_start_ms=700,
            entries=words(("friend.", 700, 1100)),
        ),
    ]
    if status is not None:
        frames.append(termination(word_boundaries_status=status))
    return frames


def spoken(tts, text="Hello there. Friend."):
    async def drain():
        return [chunk async for chunk in tts.speak(text)]

    return asyncio.run(drain())


def live_session():
    """A live call with the first sentence's word boundaries recorded."""
    tts, _ = open_session(reply_frames())
    spoken(tts)
    return tts


def finished_session(status):
    """A call that has ended, so the summary's boundary status is known."""
    tts, _ = open_session(reply_frames(status=status))
    spoken(tts)
    asyncio.run(tts.terminate())
    return tts


class RecordingPath:
    """One cut path over a recording sink, for the location-only seam."""

    def __init__(self, tts) -> None:
        self.tts = tts
        self.played: list[bytes] = []
        self.flushes: list[object] = []
        self.played_event = asyncio.Event()
        self.path = BargeInCutPath(
            tts=tts,
            on_audio=self._on_audio,
            flush_playout=self._flush_playout,
            clock=FakeClock(),
        )

    async def _on_audio(self, chunk: SentenceAudio) -> None:
        self.played.append(chunk.pcm)
        self.played_event.set()

    async def _flush_playout(self, flush) -> None:
        self.flushes.append(flush)


async def endless_audio():
    """A reply producer that yields one chunk and then never finishes."""
    yield SentenceAudio(pcm=b"heard", sample_rate=SAMPLE_RATE, text="Hello there. ")
    await asyncio.Event().wait()


def run(scenario, timeout_s: float = 5.0):
    async def guarded():
        return await asyncio.wait_for(scenario(), timeout_s)

    return asyncio.run(guarded())


class WordLevelLocationTest(unittest.TestCase):
    def test_the_played_position_maps_to_the_first_unheard_word(self):
        tts = live_session()

        point = RecordingPath(tts).path.cut_point(400)

        self.assertIs(point.resume.granularity, ResumeGranularity.WORD)
        self.assertEqual("there. Friend.", point.resume.text)
        self.assertEqual(0, point.resume.flush_id)
        self.assertEqual(1, point.resume.word_index)

    def test_a_word_already_being_spoken_is_repeated_never_lost(self):
        tts = live_session()

        # 300ms is where "there." starts; the caller heard part of it.
        point = RecordingPath(tts).path.cut_point(300.5)

        self.assertIn("there.", point.resume_text)
        self.assertEqual(1, point.resume.word_index)


class SampleExactCutPointTest(unittest.TestCase):
    def test_the_reported_position_is_stored_as_whole_samples(self):
        tts = live_session()

        point = RecordingPath(tts).path.cut_point(400.4)

        # 400.4ms at 24 kHz is 9609.6 samples; the cut is the whole sample
        # already played, never a fractional sample and never a later one.
        self.assertEqual(9609, point.played_samples)
        self.assertEqual(SAMPLE_RATE, point.sample_rate)
        self.assertEqual(400.375, point.played_ms)
        self.assertIn("there.", point.resume_text)

    def test_the_sample_exact_point_is_stored_on_the_cut_for_the_resume(self):
        tts = live_session()
        recorder = RecordingPath(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply="Hello there. Friend.")
            await recorder.played_event.wait()
            return await recorder.path.cut(
                "partial", speech_started_at=0.0, played_ms=400.4
            )

        cut = run(scenario)

        self.assertEqual(400.4, cut.seam.played_ms)
        self.assertIsNotNone(cut.seam.cut_point)
        self.assertEqual(9609, cut.seam.cut_point.played_samples)
        self.assertEqual("there. Friend.", cut.seam.resume_text)
        self.assertEqual(1, cut.seam.cut_point.resume.word_index)

    def test_a_voice_with_no_reported_position_has_no_cut_point(self):
        tts = live_session()
        recorder = RecordingPath(tts)

        async def scenario():
            return await recorder.path.cut("speech_start", speech_started_at=0.0)

        cut = run(scenario)

        self.assertIsNone(cut.seam.cut_point)
        self.assertEqual("", cut.seam.resume_text)


class SentenceFallbackTest(unittest.TestCase):
    def test_incomplete_boundaries_fall_back_to_the_sentence_not_fully_played(self):
        tts = finished_session("none")

        point = RecordingPath(tts).path.cut_point(400)

        self.assertIs(point.resume.granularity, ResumeGranularity.SENTENCE)
        self.assertEqual("Hello there. ", point.resume.text)
        self.assertIsNone(point.resume.word_index)
        self.assertIn("none", point.resume.reason)

    def test_the_fallback_skips_a_sentence_that_fully_played(self):
        tts = finished_session("disabled")

        point = RecordingPath(tts).path.cut_point(800)

        self.assertIs(point.resume.granularity, ResumeGranularity.SENTENCE)
        self.assertEqual("Friend.", point.resume.text)
        self.assertEqual(1, point.resume.flush_id)


class CutPointRecordTest(unittest.TestCase):
    def test_the_located_tail_is_reported_on_the_seam(self):
        tts = live_session()

        point = RecordingPath(tts).path.cut_point(400)

        self.assertIsInstance(point.resume, ResumePoint)
        self.assertEqual("there. Friend.", point.resume_text)
        self.assertTrue(point.word_level)

    def test_the_sample_rate_is_the_sessions_own(self):
        # 8 kHz mu-law: one millisecond is eight samples, not twenty-four.
        tts, _ = open_session(
            [begin(sample_rate=8000, encoding="pcm_mulaw")], transport="telnyx"
        )

        point = RecordingPath(tts).path.cut_point(125.5)

        self.assertEqual(8000, point.sample_rate)
        self.assertEqual(1004, point.played_samples)
        self.assertEqual(125.5, point.played_ms)


if __name__ == "__main__":
    unittest.main()
