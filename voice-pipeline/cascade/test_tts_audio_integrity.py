"""Audio decode and loss detection (ticket 50).

``FlushDone.audio_duration_ms`` is the vendor's own report of how much audio it
produced for that request, so it is the one fact the received bytes can be
checked against: ``bytes / (sample_rate x bytes_per_sample) x 1000``. A
difference beyond the named tolerance fails the call as audio loss and records
the delta, because dropped audio is then a fact rather than a guess. The
comparison runs at the ``Begin`` rate and the transport's sample width, so the
8 kHz mu-law phone leg is measured as 8,000 bytes per second, never as the
browser's 24 kHz 16-bit. Every ``Audio`` frame must hold whole samples.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import (
    AUDIO_LOSS_TOLERANCE_MS,
    AudioLossError,
    PartialSampleError,
    transport_format,
)
from cascade.failures import FailureClass
from cascade.tts_support import (
    audio,
    audio_ms,
    begin,
    flush_done,
    open_session,
    pcm,
    pcm_ms,
    termination,
)
from cascade.thresholds import bound, require_bound

TOLERANCE_MS = require_bound("tts.audio_loss_tolerance_ms")


def spoken(tts, text):
    async def drain():
        return [chunk async for chunk in tts.speak(text)]

    return asyncio.run(drain())


class MatchingAudioTests(unittest.TestCase):
    def test_a_flush_whose_bytes_match_its_reported_duration_passes(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(1000, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=1000),
            ]
        )

        chunks = spoken(tts, "Hello there.")

        self.assertEqual(tts.audio_losses, [])
        self.assertEqual(tts.requests[0].audio_bytes, len(pcm_ms(1000)))
        self.assertEqual(tts.requests[0].derived_audio_duration_ms, 1000.0)
        self.assertEqual(chunks[0].sample_rate, 24000)

    def test_a_flush_with_no_reported_duration_is_not_compared(self):
        # Unknown is not zero: a FlushDone without a duration has nothing to
        # check the bytes against, so the call must not invent a mismatch.
        tts, _ = open_session(
            [
                begin(),
                audio_ms(250, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=None),
            ]
        )

        spoken(tts, "Hello there.")

        self.assertEqual(tts.audio_losses, [])
        self.assertIsNone(tts.requests[0].audio_duration_ms)
        self.assertEqual(tts.requests[0].derived_audio_duration_ms, 250.0)

    def test_the_tolerance_is_the_named_registry_bound(self):
        self.assertEqual(AUDIO_LOSS_TOLERANCE_MS, TOLERANCE_MS)
        entry = bound("tts.audio_loss_tolerance_ms")
        self.assertEqual(entry.ticket, "50")
        self.assertEqual(entry.unit, "ms")
        self.assertGreater(entry.value, 0)


class LossTests(unittest.TestCase):
    def test_a_flush_that_lost_audio_fails_the_call_and_records_the_delta(self):
        tts, _ = open_session(
            [
                begin(),
                # 2 bytes of 24 kHz s16 is 0.0417 ms, not the reported second.
                audio(pcm(1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=1000),
            ]
        )

        with self.assertRaises(AudioLossError) as raised:
            spoken(tts, "Hello there.")

        loss = raised.exception.loss
        self.assertEqual(loss.flush_id, 0)
        self.assertEqual(loss.reported_ms, 1000)
        self.assertAlmostEqual(loss.derived_ms, 2 / (24000 * 2) * 1000)
        self.assertAlmostEqual(loss.delta_ms, loss.derived_ms - 1000)
        self.assertGreater(abs(loss.delta_ms), TOLERANCE_MS)
        self.assertEqual(tts.audio_losses, [loss])
        self.assertIn("audio loss", str(raised.exception))
        self.assertIn("flush 0", str(raised.exception))

    def test_audio_loss_ends_the_call_visibly_and_opens_the_voice_leg(self):
        tts, _ = open_session(
            [
                begin(),
                audio(pcm(1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=1000),
            ]
        )

        with self.assertRaises(AudioLossError) as raised:
            spoken(tts, "Hello there.")

        failure = raised.exception
        self.assertTrue(failure.visible)
        self.assertTrue(failure.call_ended)
        self.assertIsNone(failure.fallback)
        self.assertEqual(failure.verdict.code, 3005)
        self.assertIs(failure.verdict.failure_class, FailureClass.TRIGGER)
        self.assertEqual(tts.failures, [failure.verdict])
        self.assertEqual(tts.breaker_opens, [failure.verdict])

    def test_more_audio_than_the_report_is_also_a_loss(self):
        # A delta in either direction means the vendor's account of the request
        # and the bytes we hold disagree; neither is silently trusted.
        tts, _ = open_session(
            [
                begin(),
                audio_ms(1000, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=500),
            ]
        )

        with self.assertRaises(AudioLossError) as raised:
            spoken(tts, "Hello there.")

        self.assertGreater(raised.exception.loss.delta_ms, TOLERANCE_MS)
        self.assertAlmostEqual(raised.exception.loss.delta_ms, 500.0)

    def test_loss_is_measured_per_request_not_across_the_whole_call(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(400, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=400),
                audio_ms(300, flush_id=1),
                # Second request reports more than it delivered; the first one
                # is intact, so the failure names the second request only.
                flush_done(flush_id=1, audio_duration_ms=500),
            ]
        )

        with self.assertRaises(AudioLossError) as raised:
            spoken(tts, "Hello there. Friend.")

        self.assertEqual(raised.exception.loss.flush_id, 1)
        self.assertEqual(tts.requests[0].audio_duration_ms, 400)


class ToleranceTests(unittest.TestCase):
    def test_a_difference_exactly_at_the_tolerance_passes(self):
        reported = 1000 - int(TOLERANCE_MS)

        tts, _ = open_session(
            [
                begin(),
                audio_ms(1000, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=reported),
            ]
        )

        spoken(tts, "Hello there.")

        self.assertEqual(tts.audio_losses, [])
        self.assertAlmostEqual(tts.requests[0].derived_audio_duration_ms, 1000.0)

    def test_a_difference_one_millisecond_beyond_the_tolerance_fails(self):
        reported = 1000 - int(TOLERANCE_MS) - 1

        tts, _ = open_session(
            [
                begin(),
                audio_ms(1000, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=reported),
            ]
        )

        with self.assertRaises(AudioLossError) as raised:
            spoken(tts, "Hello there.")

        self.assertGreater(raised.exception.loss.delta_ms, TOLERANCE_MS)


class WholeSampleTests(unittest.TestCase):
    def test_the_sample_width_comes_from_the_transport_encoding(self):
        # pcm_s16le is two bytes per sample, pcm_mulaw is one.
        self.assertEqual(transport_format("browser").bytes_per_sample, 2)
        self.assertEqual(transport_format("telnyx").bytes_per_sample, 1)

    def test_a_16_bit_frame_that_ends_mid_sample_is_refused(self):
        tts, _ = open_session(
            [
                begin(),
                audio(b"\x01\x02\x03", flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=0),
            ]
        )

        with self.assertRaises(PartialSampleError) as raised:
            spoken(tts, "Hello there.")

        self.assertIn("whole samples", str(raised.exception))

    def test_a_mu_law_frame_needs_no_even_byte_count(self):
        # mu-law is one byte per sample: 1,600 bytes are 1,600 whole samples.
        tts, _ = open_session(
            [
                begin(
                    voice_id="lola",
                    language="Spanish",
                    sample_rate=8000,
                    encoding="pcm_mulaw",
                ),
                audio(pcm_ms(200, sample_rate=8000, bytes_per_sample=1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=200),
            ],
            transport="telnyx",
            voice_id="lola",
        )

        spoken(tts, "Hola.")

        self.assertEqual(tts.audio_losses, [])
        self.assertEqual(tts.requests[0].audio_bytes, 1600)


class PhoneRateTests(unittest.TestCase):
    def test_the_phone_leg_is_measured_at_the_begin_rate_and_width(self):
        # 1,600 bytes at 8 kHz mu-law is 200 ms. Measured at the browser's
        # 24 kHz x 2 bytes it would be 33.3 ms, which the loss check would
        # (wrongly) refuse: the rate and the width come from this session.
        tts, _ = open_session(
            [
                begin(
                    voice_id="lola",
                    language="Spanish",
                    sample_rate=8000,
                    encoding="pcm_mulaw",
                ),
                audio(pcm_ms(200, sample_rate=8000, bytes_per_sample=1), flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=200),
            ],
            transport="telnyx",
            voice_id="lola",
        )

        chunks = spoken(tts, "Hola.")

        self.assertEqual(tts.audio_sample_rate, 8000)
        self.assertEqual(chunks[0].sample_rate, 8000)
        self.assertEqual(tts.requests[0].derived_audio_duration_ms, 200.0)
        self.assertEqual(tts.audio_losses, [])


class TerminationIntegrityTests(unittest.TestCase):
    def test_the_implicit_flush_is_measured_against_its_residual_audio(self):
        tts, _ = open_session(
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

        record = asyncio.run(tts.terminate())

        self.assertEqual(record.residual_audio, pcm_ms(120))
        self.assertEqual(record.final_flush.audio_bytes, len(pcm_ms(120)))
        self.assertEqual(tts.audio_losses, [])

    def test_a_final_flush_that_never_delivered_its_audio_is_a_loss(self):
        tts, _ = open_session(
            [
                begin(),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
                # Terminate owes a final FlushDone but no residual audio arrives.
                flush_done(flush_id=1, audio_duration_ms=120),
                termination(),
            ]
        )
        spoken(tts, "Hello there.")

        with self.assertRaises(AudioLossError) as raised:
            asyncio.run(tts.terminate())

        self.assertEqual(raised.exception.loss.flush_id, 1)
        self.assertEqual(raised.exception.loss.reported_ms, 120)


if __name__ == "__main__":
    unittest.main()
