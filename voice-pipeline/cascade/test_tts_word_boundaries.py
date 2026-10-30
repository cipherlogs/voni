"""Word boundaries and resume granularity (ticket 51).

Each sentence is its own request, so its ``WordBoundaries`` frame arrives per
sentence and is matched by ``flush_id``, never by arrival order. When the
vendor reports ``word_boundaries_status`` as ``complete`` the barge-in cut
resumes from the first unheard word; any other status is recorded and the cut
falls back to the first sentence not fully played, with no gap guessed from
the sentence text.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    ResumeGranularity,
    WordBoundary,
    schedule,
)
from cascade.tts_support import (
    audio_ms,
    begin,
    flush_done,
    open_session,
    termination,
    word_boundaries,
    words,
)


def spoken(tts, text):
    async def drain():
        return [chunk async for chunk in tts.speak(text)]

    return asyncio.run(drain())


def two_sentences(*, status):
    """A recorded reply where each sentence has its own boundaries and audio."""
    return [
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
        termination(word_boundaries_status=status),
    ]


class CaptureTests(unittest.TestCase):
    def test_word_boundaries_are_captured_per_sentence(self):
        tts, _ = open_session(two_sentences(status="complete"))

        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        self.assertEqual(
            tts.requests[0].words,
            (
                WordBoundary(word="hello", start_ms=0, end_ms=300, confidence=0.99),
                WordBoundary(word="there.", start_ms=300, end_ms=700, confidence=0.99),
            ),
        )
        self.assertEqual(tts.requests[1].words[0].word, "friend.")
        self.assertEqual(tts.requests[0].text, "Hello there. ")
        self.assertEqual(tts.requests[1].text, "Friend.")

    def test_boundaries_are_matched_by_flush_id_even_when_they_arrive_late(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(700, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=700),
                # The next request's audio arrives before the first request's
                # boundaries, as the vendor documents it can.
                audio_ms(400, flush_id=1),
                word_boundaries(
                    flush_id=0,
                    audio_start_ms=0,
                    entries=words(("hello", 0, 300), ("there.", 300, 700)),
                ),
                flush_done(flush_id=1, audio_duration_ms=400),
            ]
        )

        spoken(tts, "Hello there. Friend.")

        self.assertEqual([word.word for word in tts.requests[0].words], ["hello", "there."])
        self.assertEqual(tts.requests[1].words, ())

    def test_boundaries_are_not_invented_from_the_sentence_text(self):
        tts, _ = open_session(two_sentences(status="complete"))

        spoken(tts, "Hello there. Friend.")

        self.assertEqual(
            [word.start_ms for word in tts.requests[0].words], [0, 300]
        )


class CompleteBoundaryResumeTests(unittest.TestCase):
    def test_a_complete_status_resumes_from_the_first_unheard_word(self):
        tts, _ = open_session(two_sentences(status="complete"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(400)

        self.assertIs(resume.granularity, ResumeGranularity.WORD)
        self.assertEqual(resume.text, "there. Friend.")
        self.assertEqual(resume.flush_id, 0)
        self.assertEqual(resume.word_index, 1)

    def test_a_cut_inside_the_second_sentence_resumes_in_that_sentence(self):
        tts, _ = open_session(two_sentences(status="complete"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(800)

        self.assertIs(resume.granularity, ResumeGranularity.WORD)
        self.assertEqual(resume.text, "Friend.")
        self.assertEqual(resume.flush_id, 1)
        self.assertEqual(resume.word_index, 0)

    def test_a_cut_where_every_word_was_heard_moves_past_that_sentence(self):
        tts, _ = open_session(two_sentences(status="complete"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(700)

        self.assertEqual(resume.text, "Friend.")
        self.assertEqual(resume.flush_id, 1)


class IncompleteBoundaryResumeTests(unittest.TestCase):
    def test_an_incomplete_status_falls_back_to_the_sentence_boundary(self):
        tts, _ = open_session(two_sentences(status="none"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(400)

        self.assertIs(resume.granularity, ResumeGranularity.SENTENCE)
        self.assertEqual(resume.text, "Hello there. ")
        self.assertEqual(resume.flush_id, 0)
        self.assertIsNone(resume.word_index)
        self.assertIn("none", resume.reason)

    def test_the_two_statuses_yield_two_different_resume_points_by_name(self):
        complete, _ = open_session(two_sentences(status="complete"))
        spoken(complete, "Hello there. Friend.")
        asyncio.run(complete.terminate())

        incomplete, _ = open_session(two_sentences(status="none"))
        spoken(incomplete, "Hello there. Friend.")
        asyncio.run(incomplete.terminate())

        word = complete.resume_point(400)
        sentence = incomplete.resume_point(400)

        self.assertEqual(word.granularity.value, "word")
        self.assertEqual(sentence.granularity.value, "sentence")
        self.assertNotEqual(word.text, sentence.text)

    def test_the_sentence_fallback_is_the_first_sentence_not_fully_played(self):
        tts, _ = open_session(two_sentences(status="disabled"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(800)

        self.assertIs(resume.granularity, ResumeGranularity.SENTENCE)
        self.assertEqual(resume.text, "Friend.")
        self.assertEqual(resume.flush_id, 1)

    def test_a_status_is_recorded_on_the_call(self):
        tts, _ = open_session(two_sentences(status="none"))
        spoken(tts, "Hello there. Friend.")
        asyncio.run(tts.terminate())

        self.assertEqual(tts.word_boundaries_status, "none")

    def test_a_missing_boundaries_frame_falls_back_even_when_complete(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(700, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=700),
                termination(word_boundaries_status="complete"),
            ]
        )
        spoken(tts, "Hello there.")
        asyncio.run(tts.terminate())

        resume = tts.resume_point(200)

        self.assertIs(resume.granularity, ResumeGranularity.SENTENCE)
        self.assertEqual(resume.text, "Hello there.")
        self.assertIn("WordBoundaries", resume.reason)


class LiveResumeTests(unittest.TestCase):
    def test_a_live_call_uses_words_it_has_before_any_termination(self):
        tts, _ = open_session(two_sentences(status="complete"))
        spoken(tts, "Hello there. Friend.")
        # No Terminate: a barge-in happens mid-call, so the status is not known.

        resume = tts.resume_point(400)

        self.assertIs(resume.granularity, ResumeGranularity.WORD)
        self.assertEqual(resume.text, "there. Friend.")


if __name__ == "__main__":
    unittest.main()
