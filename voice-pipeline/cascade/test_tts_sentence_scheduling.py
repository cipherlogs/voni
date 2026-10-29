"""Sentence scheduling: the first sentence flushes immediately (ticket 49).

Text is sent per sentence and concluded with ``Flush``; the first sentence of
a reply, and the greeting, is ``Generate`` + ``Flush`` before anything else so
audio starts without waiting for more context. A sentence longer than the
Generate cap is split at a clause boundary or under the cap, and an over-cap
``Generate`` is never sent. Because the scheduler flushes only at a sentence
boundary, a per-token flush cannot be expressed, and the control-frame rate
stays inside the budget the session announced in ``Begin``.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    GENERATE_CHAR_CAP,
    ControlFramePacingError,
    schedule,
)
from cascade.test_tts_support import (
    audio,
    begin,
    flush_done,
    make_session,
    open_session,
    pcm,
    sent_texts,
    sent_types,
)
from cascade.testing import FakeClock, Frame
from cascade.thresholds import require_bound

SENTENCE_MS = 250


def spoken(tts, text):
    """Every ``SentenceAudio`` the reply yields, in order."""
    return asyncio.run(drain(tts, text))


async def drain(tts, text):
    return [chunk async for chunk in tts.speak(text)]


def session_plan(sentence_count, *, delay_ms=SENTENCE_MS, clock=None, start=0):
    """A scripted session that answers each sentence with one Audio + FlushDone.

    ``delay_ms`` is applied to the Audio frame, so each sentence's two control
    frames land one sentence-time after the previous sentence's, as they do
    when delivery paces the client.
    """
    frames = [begin()]
    for index in range(start, start + sentence_count):
        frames.append(
            Frame(audio(pcm(index), flush_id=index), delay_ms=delay_ms or 0.0)
        )
        frames.append(flush_done(flush_id=index))
    return open_session(frames, clock=clock if clock is not None else FakeClock())


def frames_per_second(times):
    """The largest number of frames in any one-second window of the clock."""
    return max(
        (
            sum(1 for moment in times if start <= moment < start + 1.0)
            for start in times
        ),
        default=0,
    )


class FirstSentenceTests(unittest.TestCase):
    def test_the_first_sentence_is_generated_and_flushed_before_the_rest(self):
        tts, factory = session_plan(2)

        spoken(tts, "Hello there. How are you today?")

        self.assertEqual(sent_types(factory)[:2], ["Generate", "Flush"])
        self.assertEqual(sent_texts(factory), ["Hello there. ", "How are you today?"])

    def test_the_greeting_is_generated_and_flushed_immediately(self):
        tts, factory = session_plan(2)

        async def greet():
            return [chunk async for chunk in tts.speak_greeting("Hi there. One moment.")]

        asyncio.run(greet())

        self.assertEqual(sent_types(factory)[:2], ["Generate", "Flush"])
        self.assertEqual(sent_texts(factory)[0], "Hi there. ")

    def test_audio_is_yielded_per_sentence_with_its_request_text(self):
        block = pcm(7, -2)
        tts, _ = open_session(
            [
                begin(),
                audio(block, flush_id=0),
                flush_done(flush_id=0),
                audio(pcm(9), flush_id=1),
                flush_done(flush_id=1),
            ]
        )

        chunks = spoken(tts, "First. Second.")

        self.assertEqual(chunks[0].pcm, block)
        self.assertEqual([chunk.text for chunk in chunks], ["First. ", "Second."])
        self.assertEqual(chunks[0].sample_rate, 24000)


class ScheduleTests(unittest.TestCase):
    def test_each_sentence_is_its_own_request(self):
        self.assertEqual(schedule("One. Two! Three?"), ("One. ", "Two! ", "Three?"))

    def test_a_short_sentence_with_clauses_is_not_split(self):
        self.assertEqual(
            schedule("Hello, there. How are you?"),
            ("Hello, there. ", "How are you?"),
        )

    def test_a_long_sentence_splits_at_clause_boundaries_under_the_cap(self):
        text = "word, " * 700  # 4,200 characters, no sentence end

        chunks = schedule(text)

        self.assertTrue(all(len(chunk) <= GENERATE_CHAR_CAP for chunk in chunks))
        self.assertEqual("".join(chunks), text)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks[:-1]:
            self.assertTrue(chunk.endswith(", "), chunk[-12:])

    def test_a_sentence_with_no_clause_splits_at_whitespace_under_the_cap(self):
        text = "word " * 700  # 3,500 characters, no clause or sentence end

        chunks = schedule(text)

        self.assertTrue(all(len(chunk) <= GENERATE_CHAR_CAP for chunk in chunks))
        self.assertEqual("".join(chunks), text)
        for chunk in chunks[:-1]:
            self.assertTrue(chunk.endswith(" "), chunk[-12:])

    def test_an_unbroken_run_is_cut_under_the_cap_not_dropped(self):
        text = "x" * (GENERATE_CHAR_CAP + 500)

        chunks = schedule(text)

        self.assertTrue(all(len(chunk) <= GENERATE_CHAR_CAP for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_the_cap_is_the_one_threshold_registry_value(self):
        self.assertEqual(GENERATE_CHAR_CAP, require_bound("tts.generate_char_cap"))

    def test_empty_text_sends_nothing(self):
        self.assertEqual(schedule(""), ())
        self.assertEqual(schedule("   "), ())


class OverCapRequestTests(unittest.TestCase):
    def test_an_over_cap_generate_is_never_sent(self):
        text = "word, " * 700
        tts, factory = session_plan(len(schedule(text)))

        spoken(tts, text)

        generates = sent_texts(factory)
        self.assertTrue(generates)
        self.assertTrue(
            all(len(request) <= GENERATE_CHAR_CAP for request in generates),
            [len(request) for request in generates],
        )
        self.assertEqual("".join(generates), text)


class NoPerTokenFlushTests(unittest.TestCase):
    def test_one_sentence_is_one_flush_however_many_tokens(self):
        text = "one two three four five six seven eight nine ten."
        tts, factory = session_plan(1)

        spoken(tts, text)

        self.assertEqual(sent_types(factory), ["Generate", "Flush"])
        self.assertEqual(sent_texts(factory), [text])

    def test_three_sentences_make_exactly_three_flushes(self):
        tts, factory = session_plan(3)

        spoken(tts, "One. Two. Three.")

        self.assertEqual(sent_types(factory).count("Flush"), 3)
        self.assertEqual(sent_types(factory).count("Generate"), 3)


class ControlFrameBudgetTests(unittest.TestCase):
    def test_a_reply_paced_by_delivery_stays_within_the_frame_budget(self):
        clock = FakeClock()
        tts, _ = session_plan(5, clock=clock)

        spoken(tts, "One. Two. Three. Four. Five.")

        self.assertEqual(frames_per_second(tts.control_frame_times), 8)
        self.assertLessEqual(
            frames_per_second(tts.control_frame_times),
            tts.limits["max_control_frames_per_sec"],
        )

    def test_a_burst_faster_than_the_budget_is_refused_as_a_pacing_bug(self):
        clock = FakeClock()
        tts, factory = session_plan(15, delay_ms=None, clock=clock)

        with self.assertRaises(ControlFramePacingError) as raised:
            spoken(tts, " ".join("One." for _ in range(15)))

        self.assertIn("3010", str(raised.exception))
        self.assertIn("pacing", str(raised.exception))
        self.assertLessEqual(
            len(sent_types(factory)),
            int(tts.limits["max_control_frames_per_sec"]),
        )


if __name__ == "__main__":
    unittest.main()
