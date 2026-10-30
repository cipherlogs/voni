"""Begin echo is an assertion (ticket 48).

The session's opening frame is the vendor's own record of what it got. Five
fields are compared with the request — voice, language, sample rate, encoding
and model — and a mismatch fails the call visibly before a single frame is
sent or played. The session's expiry and limits are kept as call facts, and an
unknown query parameter is a configuration bug, not a warning to ignore.
"""

import asyncio
import json
import unittest

from cascade.assemblyai_tts import (
    EchoMismatch,
    SynthesisConfigurationError,
    SynthesisEchoError,
)
from cascade.tts_support import (
    BEGIN_EXPIRES_AT,
    BEGIN_ID,
    VENDOR_LIMITS,
    begin,
    make_session,
    sent,
)


def open_session(**begin_fields):
    tts, factory = make_session([begin(**begin_fields)])
    asyncio.run(tts.open())
    return tts, factory


class EchoMatchTests(unittest.TestCase):
    def test_a_session_that_echoes_the_request_opens(self):
        tts, _ = open_session()

        self.assertEqual(tts.begin_mismatches, ())
        self.assertIsNotNone(tts.begin)
        self.assertEqual(tts.begin["type"], "Begin")

    def test_the_language_echo_is_compared_without_case(self):
        # The vendor normalizes `language` to lowercase; that is not a mismatch.
        tts, _ = open_session(language="english")

        self.assertEqual(tts.begin_mismatches, ())
        self.assertEqual(tts.configuration["language"], "english")


class EchoMismatchTests(unittest.TestCase):
    def assert_mismatch(self, field, expected_echoed, **begin_fields):
        tts, factory = make_session([begin(**begin_fields)])

        with self.assertRaises(SynthesisEchoError) as raised:
            asyncio.run(tts.open())

        self.assertIn(field, str(raised.exception))
        self.assertEqual(
            tts.begin_mismatches,
            (
                EchoMismatch(
                    field=field,
                    requested=self.requested(field),
                    echoed=expected_echoed,
                ),
            ),
        )
        # Fails visibly, plays no audio, and sends nothing on the open socket.
        self.assertEqual(sent(factory), [])
        self.assertTrue(factory.socket.closed)
        return tts

    def requested(self, field):
        return {
            "voice_id": "aai-anna",
            "language": "English",
            "sample_rate": 24000,
            "encoding": "pcm_s16le",
            "model": "assemblyai-tts-1",
        }[field]

    def test_a_mismatched_voice_is_named_and_plays_no_audio(self):
        self.assert_mismatch("voice_id", "aai-lola", voice_id="lola")

    def test_a_mismatched_language_is_named(self):
        self.assert_mismatch("language", "spanish", language="spanish")

    def test_a_mismatched_sample_rate_is_named(self):
        self.assert_mismatch("sample_rate", 8000, sample_rate=8000)

    def test_a_mismatched_encoding_is_named(self):
        self.assert_mismatch("encoding", "pcm_mulaw", encoding="pcm_mulaw")

    def test_a_mismatched_model_is_named(self):
        self.assert_mismatch("model", "another-model", model="another-model")

    def test_every_mismatch_is_recorded_not_just_the_first(self):
        tts, _ = make_session(
            [begin(voice_id="lola", sample_rate=8000)],
        )

        with self.assertRaises(SynthesisEchoError):
            asyncio.run(tts.open())

        self.assertEqual(
            [mismatch.field for mismatch in tts.begin_mismatches],
            ["voice_id", "sample_rate"],
        )


class UnknownParameterTests(unittest.TestCase):
    def test_unknown_query_parameters_refuse_the_call_as_a_configuration_bug(self):
        tts, factory = make_session([begin(unknown_params=["seed", "gain"])])

        with self.assertRaises(SynthesisConfigurationError) as raised:
            asyncio.run(tts.open())

        self.assertIn("seed", str(raised.exception))
        self.assertIn("configuration bug", str(raised.exception))
        self.assertEqual(tts.unknown_params, ("seed", "gain"))
        self.assertEqual(sent(factory), [])
        self.assertTrue(factory.socket.closed)


class SessionFactsTests(unittest.TestCase):
    def test_expiry_and_limits_are_recorded_on_the_call(self):
        tts, _ = open_session()

        self.assertEqual(tts.expires_at, BEGIN_EXPIRES_AT)
        self.assertEqual(tts.begin_id, BEGIN_ID)
        self.assertEqual(tts.limits["max_generate_text_length"], 2000)
        self.assertEqual(
            tts.limits["max_control_frames_per_sec"],
            VENDOR_LIMITS["max_control_frames_per_sec"],
        )

    def test_a_begin_without_expiry_or_limits_is_recorded_as_unknown(self):
        frame = json.loads(begin())
        del frame["expires_at"]
        del frame["configuration"]["limits"]
        tts, _ = make_session([json.dumps(frame)])

        asyncio.run(tts.open())

        self.assertIsNone(tts.expires_at)
        self.assertEqual(dict(tts.limits), {})


if __name__ == "__main__":
    unittest.main()
