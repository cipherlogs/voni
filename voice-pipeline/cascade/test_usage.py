"""Every billable unit comes from the wire (ticket 100).

Spec: `.scratch/meta-cascade/spec.md` M3 "Money and eyes" — "Money is metered
from the wire, not from an estimate of what a turn probably cost." The units are
LLM prompt/completion/cached/reasoning tokens, TTS billed characters (plus the
vendor's audio and session seconds as facts) and STT audio seconds when the
vendor reports them. A unit the vendor did not report is ``unmeasured``, never
zero, and a partial sum is never presented as a complete one.

The seam is the meter's public record: :meth:`UsageMeter.record_llm`,
:meth:`UsageMeter.record_tts`, :meth:`UsageMeter.record_stt`, and the
:class:`CallUsage` document read per call and per turn. Ticket 101 prices those
units; it must never re-parse a vendor frame or estimate a missing number.
"""

import unittest

from cascade.assemblyai_tts import Billing
from cascade.meta_llm import TurnUsage
from cascade.usage import UsageMeter


class RecordedTokenTests(unittest.TestCase):
    def test_a_vendor_usage_frame_records_every_billable_token_unit(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1",
            {
                "prompt_tokens": 128,
                "completion_tokens": 16,
                "total_tokens": 144,
                "prompt_tokens_details": {"cached_tokens": 64},
                "completion_tokens_details": {"reasoning_tokens": 9},
            },
        )

        usage = meter.usage()
        turn = usage.turn("turn-1")

        self.assertIsNotNone(turn)
        self.assertEqual(turn.unit("prompt_tokens").quantity, 128)
        self.assertEqual(turn.unit("completion_tokens").quantity, 16)
        self.assertEqual(turn.unit("cached_tokens").quantity, 64)
        self.assertEqual(turn.unit("reasoning_tokens").quantity, 9)
        self.assertTrue(turn.unit("prompt_tokens").measured)
        self.assertTrue(turn.measured)
        # ``total_tokens`` is the vendor's derived sum, not a priced unit.
        self.assertIsNone(turn.unit("total_tokens"))

    def test_an_omitted_detail_is_unmeasured_not_zero(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1", {"prompt_tokens": 128, "completion_tokens": 16}
        )

        turn = meter.usage().turn("turn-1")

        self.assertEqual(turn.unit("prompt_tokens").quantity, 128)
        self.assertIsNone(turn.unit("cached_tokens").quantity)
        self.assertFalse(turn.unit("cached_tokens").measured)
        self.assertIsNone(turn.unit("reasoning_tokens").quantity)
        self.assertFalse(turn.unit("reasoning_tokens").measured)
        self.assertIn("omitted", turn.unit("cached_tokens").source)
        # The turn is not fully measured while a priced unit is absent.
        self.assertFalse(turn.measured)

    def test_a_measured_zero_is_a_measurement_not_an_absence(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1",
            {
                "prompt_tokens": 64,
                "completion_tokens": 8,
                "prompt_tokens_details": {"cached_tokens": 0},
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        )

        turn = meter.usage().turn("turn-1")

        self.assertEqual(turn.unit("cached_tokens").quantity, 0)
        self.assertTrue(turn.unit("cached_tokens").measured)
        self.assertTrue(turn.measured)

    def test_a_turn_with_no_usage_chunk_is_unmeasured_never_zero(self):
        meter = UsageMeter()
        meter.record_llm("turn-1", None)

        usage = meter.usage()
        turn = usage.turn("turn-1")

        for name in (
            "prompt_tokens",
            "completion_tokens",
            "cached_tokens",
            "reasoning_tokens",
        ):
            self.assertIsNone(turn.unit(name).quantity)
            self.assertFalse(turn.unit(name).measured)
        self.assertIn("no usage chunk", turn.unit("prompt_tokens").source)
        self.assertFalse(usage.leg("llm").measured)

    def test_the_streams_own_turn_usage_is_recorded_as_it_stands(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1",
            TurnUsage(
                prompt_tokens=128,
                completion_tokens=16,
                total_tokens=144,
                cached_tokens=0,
                reasoning_tokens=None,
            ),
        )
        meter.record_llm("turn-2", TurnUsage.unmeasured())

        usage = meter.usage()

        turn = usage.turn("turn-1")
        self.assertEqual(turn.unit("prompt_tokens").quantity, 128)
        self.assertEqual(turn.unit("cached_tokens").quantity, 0)
        self.assertIsNone(turn.unit("reasoning_tokens").quantity)
        self.assertFalse(turn.measured)
        # The interrupted turn keeps the call total unmeasured: no partial sum.
        self.assertFalse(usage.leg("llm").measured)
        self.assertIsNone(usage.leg("llm").unit("prompt_tokens").quantity)

    def test_a_retried_turn_is_metered_twice_because_the_vendor_bills_both(self):
        meter = UsageMeter()
        for _ in range(2):
            meter.record_llm(
                "turn-1",
                {
                    "prompt_tokens": 10,
                    "completion_tokens": 2,
                    "prompt_tokens_details": {"cached_tokens": 0},
                    "completion_tokens_details": {"reasoning_tokens": 0},
                },
            )

        self.assertEqual(
            meter.usage().turn("turn-1").unit("prompt_tokens").quantity, 20
        )
        self.assertEqual(
            meter.usage().leg("llm").unit("prompt_tokens").quantity, 20
        )

    def test_the_call_totals_sum_every_turn(self):
        meter = UsageMeter()
        for turn, prompt, completion in (
            ("turn-1", 128, 16),
            ("turn-2", 64, 8),
        ):
            meter.record_llm(
                turn,
                {
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                    "prompt_tokens_details": {"cached_tokens": 0},
                    "completion_tokens_details": {"reasoning_tokens": 0},
                },
            )

        llm = meter.usage().leg("llm")

        self.assertEqual(llm.unit("prompt_tokens").quantity, 192)
        self.assertEqual(llm.unit("completion_tokens").quantity, 24)
        self.assertEqual(llm.unit("cached_tokens").quantity, 0)
        self.assertTrue(llm.measured)
        self.assertEqual(
            meter.usage().turn("turn-2").unit("prompt_tokens").quantity, 64
        )

    def test_one_unmeasured_turn_makes_the_call_total_unmeasured(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1",
            {
                "prompt_tokens": 128,
                "completion_tokens": 16,
                "prompt_tokens_details": {"cached_tokens": 64},
                "completion_tokens_details": {"reasoning_tokens": 9},
            },
        )
        meter.record_llm("turn-2", None)

        llm = meter.usage().leg("llm")

        # No partial sum presented as complete: the measured turn is not added
        # up and called the total.
        self.assertIsNone(llm.unit("prompt_tokens").quantity)
        self.assertFalse(llm.unit("prompt_tokens").measured)
        self.assertIn("no usage chunk", llm.unit("prompt_tokens").source)

    def test_a_leg_that_never_reported_is_unmeasured_not_zero(self):
        usage = UsageMeter().usage()

        for leg in ("stt", "llm", "tts"):
            self.assertFalse(usage.leg(leg).measured)
            for unit in usage.leg(leg).units:
                self.assertIsNone(unit.quantity)
                self.assertFalse(unit.measured)
        self.assertFalse(usage.measured)


class RecordedVoiceTests(unittest.TestCase):
    def billing(self, **overrides):
        values = {
            "characters": 91,
            "measured": True,
            "source": "billed_characters",
            "total_input_char_length": 96,
            "audio_duration_seconds": 5.304,
            "session_duration_seconds": 8,
            "audio_bytes": 254_592,
        }
        values.update(overrides)
        return Billing(**values)

    def test_termination_characters_are_the_billed_voice_unit(self):
        meter = UsageMeter()
        meter.record_tts(self.billing())

        tts = meter.usage().leg("tts")

        self.assertEqual(tts.unit("characters").quantity, 91)
        self.assertTrue(tts.unit("characters").measured)
        self.assertEqual(tts.unit("characters").source, "billed_characters")
        self.assertEqual(tts.unit("audio_seconds").quantity, 5.304)
        self.assertEqual(
            tts.unit("audio_seconds").source,
            "Termination.audio_duration_seconds",
        )
        self.assertEqual(tts.unit("session_seconds").quantity, 8)
        self.assertTrue(tts.measured)

    def test_a_session_without_termination_is_unmeasured_never_zero(self):
        meter = UsageMeter()
        meter.record_tts(
            self.billing(
                characters=None,
                measured=False,
                source="unterminated: the session has not ended",
                audio_duration_seconds=None,
                session_duration_seconds=None,
            )
        )

        tts = meter.usage().leg("tts")

        self.assertIsNone(tts.unit("characters").quantity)
        self.assertFalse(tts.unit("characters").measured)
        self.assertIn("unterminated", tts.unit("characters").source)
        self.assertFalse(tts.measured)

    def test_a_reconnect_replay_is_metered_because_the_vendor_bills_it(self):
        meter = UsageMeter()
        meter.record_tts(self.billing())
        meter.record_tts(
            self.billing(
                characters=40,
                audio_duration_seconds=2.5,
                session_duration_seconds=3,
            )
        )

        tts = meter.usage().leg("tts")

        self.assertEqual(tts.unit("characters").quantity, 131)
        self.assertEqual(tts.unit("audio_seconds").quantity, 7.804)
        self.assertEqual(tts.unit("session_seconds").quantity, 11)
        self.assertTrue(tts.measured)


class RecordedSpeechTests(unittest.TestCase):
    def test_the_vendor_usage_frame_meters_whole_audio_seconds(self):
        meter = UsageMeter()
        meter.record_stt({"audio_duration_seconds": 12.9})

        stt = meter.usage().leg("stt")

        self.assertEqual(stt.unit("audio_seconds").quantity, 12)
        self.assertTrue(stt.unit("audio_seconds").measured)
        self.assertIn("whole seconds", stt.unit("audio_seconds").source)
        self.assertTrue(stt.measured)

    def test_a_whole_second_is_not_rounded_up(self):
        meter = UsageMeter()
        meter.record_stt({"audio_duration_seconds": 0.4})

        unit = meter.usage().leg("stt").unit("audio_seconds")

        self.assertEqual(unit.quantity, 0)
        self.assertTrue(unit.measured)

    def test_no_speech_usage_frame_is_unmeasured_never_zero(self):
        meter = UsageMeter()
        meter.record_stt(None)

        stt = meter.usage().leg("stt")

        self.assertIsNone(stt.unit("audio_seconds").quantity)
        self.assertFalse(stt.unit("audio_seconds").measured)
        self.assertIn("no speech usage frame", stt.unit("audio_seconds").source)

    def test_a_frame_without_the_duration_is_unmeasured(self):
        meter = UsageMeter()
        meter.record_stt({"something_else": 1})

        unit = meter.usage().leg("stt").unit("audio_seconds")

        self.assertIsNone(unit.quantity)
        self.assertIn("did not report audio_duration_seconds", unit.source)

    def test_a_reconnected_speech_session_is_metered_too(self):
        meter = UsageMeter()
        meter.record_stt({"audio_duration_seconds": 12.9})
        meter.record_stt({"audio_duration_seconds": 3.4})

        stt = meter.usage().leg("stt")

        self.assertEqual(stt.unit("audio_seconds").quantity, 15)


class CallDocumentTests(unittest.TestCase):
    def measured_meter(self) -> UsageMeter:
        meter = UsageMeter()
        meter.record_stt({"audio_duration_seconds": 12.9})
        meter.record_llm(
            "turn-1",
            {
                "prompt_tokens": 128,
                "completion_tokens": 16,
                "prompt_tokens_details": {"cached_tokens": 64},
                "completion_tokens_details": {"reasoning_tokens": 9},
            },
        )
        meter.record_tts(
            Billing(
                characters=91,
                measured=True,
                source="billed_characters",
                audio_duration_seconds=5.304,
                session_duration_seconds=8,
            )
        )
        return meter

    def test_the_document_is_per_call_and_per_turn(self):
        document = self.measured_meter().to_document()

        self.assertEqual(list(document["legs"]), ["stt", "llm", "tts"])
        self.assertTrue(document["measured"])
        self.assertEqual(
            document["legs"]["llm"]["units"]["prompt_tokens"],
            {
                "quantity": 128,
                "measured": True,
                "source": "vendor usage chunk (stream_options.include_usage)",
            },
        )
        self.assertEqual(
            document["legs"]["tts"]["units"]["characters"]["quantity"], 91
        )
        self.assertEqual(
            document["turns"]["turn-1"]["prompt_tokens"]["quantity"], 128
        )
        # Every unit is a record, never a bare number, and never a zero
        # standing in for silence.
        for leg in document["legs"].values():
            for unit in leg["units"].values():
                self.assertEqual(set(unit), {"quantity", "measured", "source"})
                if not unit["measured"]:
                    self.assertIsNone(unit["quantity"])

    def test_one_unterminated_session_makes_the_call_total_unmeasured(self):
        meter = self.measured_meter()
        meter.record_tts(
            Billing(
                characters=None,
                measured=False,
                source="unterminated: no Termination summary was received",
            )
        )

        document = meter.to_document()

        self.assertIsNone(
            document["legs"]["tts"]["units"]["characters"]["quantity"]
        )
        self.assertFalse(document["legs"]["tts"]["measured"])
        self.assertFalse(document["measured"])

    def test_unknown_turns_and_negative_units_are_refused(self):
        meter = self.measured_meter()

        self.assertIsNone(meter.usage().turn("turn-404"))
        with self.assertRaises(ValueError):
            meter.record_llm("", {"prompt_tokens": 1})
        with self.assertRaises(ValueError):
            meter.record_stt({"audio_duration_seconds": -1})


if __name__ == "__main__":
    unittest.main()
