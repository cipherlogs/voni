"""Termination and the billed character count (ticket 54).

``Terminate`` performs the implicit flush: the adapter sends no extra
``Flush``, the vendor answers with the final ``FlushDone`` and then a
``Termination`` summary, and the summary's billed character count, audio
duration and session duration are recorded as call facts. A call that ends
without a ``Termination`` records its characters as unmeasured, never zero.
"""

import asyncio
import unittest

from cascade.tts_support import (
    audio,
    audio_ms,
    begin,
    flush_done,
    open_session,
    pcm_ms,
    sent_types,
    termination,
)


def spoken(tts, text):
    async def drain():
        return [chunk async for chunk in tts.speak(text)]

    return asyncio.run(drain())


class FinalFlushTests(unittest.TestCase):
    def test_terminate_returns_the_final_flush_then_the_termination(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                audio_ms(120, flush_id=1),
                flush_done(flush_id=1, audio_duration_ms=120),
                termination(total_input_char_length=96, billed_characters=96),
            ]
        )
        spoken(tts, "Hello there.")

        record = asyncio.run(tts.terminate())

        self.assertIsNotNone(record.flush_done)
        self.assertEqual(record.flush_done["flush_id"], 1)
        self.assertEqual(record.flush_done["audio_duration_ms"], 120)
        self.assertEqual(record.termination["type"], "Termination")
        self.assertEqual(record.final_flush.flush_id, 1)

    def test_terminate_sends_no_extra_flush_for_its_implicit_flush(self):
        tts, factory = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                audio_ms(120, flush_id=1),
                flush_done(flush_id=1, audio_duration_ms=120),
                termination(),
            ]
        )
        spoken(tts, "Hello there.")

        asyncio.run(tts.terminate())

        self.assertEqual(
            sent_types(factory), ["Generate", "Flush", "Terminate"]
        )

    def test_audio_delivered_after_terminate_is_kept_not_dropped(self):
        residual = pcm_ms(120)
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                audio(residual, flush_id=1),
                flush_done(flush_id=1, audio_duration_ms=120),
                termination(),
            ]
        )
        spoken(tts, "Hello there.")

        record = asyncio.run(tts.terminate())

        self.assertEqual(record.residual_audio, residual)
        self.assertEqual(record.billing.audio_bytes, len(pcm_ms(800)) + len(residual))


class BillingTests(unittest.TestCase):
    def terminate_with(self, **summary):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                termination(**summary),
            ]
        )
        spoken(tts, "Hello there.")
        return tts, asyncio.run(tts.terminate())

    def test_the_billed_character_count_is_recorded_per_call(self):
        tts, record = self.terminate_with(
            total_input_char_length=96, billed_characters=91
        )

        self.assertEqual(record.billing.characters, 91)
        self.assertTrue(record.billing.measured)
        self.assertEqual(record.billing.source, "billed_characters")
        self.assertEqual(tts.billing.characters, 91)

    def test_the_total_input_length_is_kept_as_a_separate_fact(self):
        _, record = self.terminate_with(
            total_input_char_length=96, billed_characters=91
        )

        self.assertEqual(record.billing.total_input_char_length, 96)

    def test_billed_characters_fall_back_to_the_total_input_length(self):
        _, record = self.terminate_with(
            total_input_char_length=96, billed_characters=None
        )

        self.assertEqual(record.billing.characters, 96)
        self.assertTrue(record.billing.measured)
        self.assertEqual(record.billing.source, "total_input_char_length")

    def test_audio_and_session_durations_are_recorded_as_facts(self):
        _, record = self.terminate_with(
            audio_duration_seconds=5.304, session_duration_seconds=8
        )

        self.assertEqual(record.billing.audio_duration_seconds, 5.304)
        self.assertEqual(record.billing.session_duration_seconds, 8)

    def test_a_summary_with_no_character_count_is_unmeasured_not_zero(self):
        _, record = self.terminate_with(
            total_input_char_length=None, billed_characters=None
        )

        self.assertIsNone(record.billing.characters)
        self.assertFalse(record.billing.measured)


class UnterminatedTests(unittest.TestCase):
    def test_a_call_that_ends_without_a_termination_records_unmeasured(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
            ]
        )
        spoken(tts, "Hello there.")

        asyncio.run(tts.close())

        self.assertIsNone(tts.billing.characters)
        self.assertFalse(tts.billing.measured)
        self.assertNotEqual(tts.billing.characters, 0)
        self.assertIn("unterminated", tts.billing.source)
        self.assertEqual(tts.billing.audio_bytes, len(pcm_ms(800)))

    def test_close_after_terminate_keeps_the_measured_billing(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                termination(billed_characters=12),
            ]
        )
        spoken(tts, "Hello there.")
        asyncio.run(tts.terminate())

        asyncio.run(tts.close())

        self.assertEqual(tts.billing.characters, 12)
        self.assertTrue(tts.billing.measured)


if __name__ == "__main__":
    unittest.main()
