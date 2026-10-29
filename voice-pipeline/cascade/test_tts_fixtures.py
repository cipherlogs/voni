"""Recorded voice frames replay against pinned expectations (ticket 56).

Spec: `.scratch/meta-cascade/spec.md`, M1 "AssemblyAI speech synthesis backend"
and "Fixtures, chaos and live smoke" — a fixture is a contract, not a snapshot
of a mood. Each JSON document under ``cascade/fixtures/tts/`` is a recorded
session: the ``Begin`` echo, the ``Generate``/``Flush`` schedule, audio frames
and their ``FlushDone`` maths, a barge-in ``Cancel``, a ``Termination`` summary
and one close code per file. Replaying a document pins what the caller and the
call record observe, so a changed known frame fails *by fixture name* and an
additive unknown frame is ignored.

A fixture that can no longer be produced is a failure, never a skip: a missing
file, a document the loader cannot replay, or a session that no longer opens
raises with the fixture's name in the message.

Audio payloads are short repeated-sample tokens rather than recorded speech:
the contract under test is the frame maths (bytes at the echoed rate and
sample width), not the timbre, and a new voice is auditioned in W2, not here.
Keepalive frames are deliberately not recorded: ticket 53 owns the keepalive
and the adapter has no keepalive to replay until it lands. Session expiry is
pinned through ``close-3008`` (a planned reconnect), not left unpinned.

No vendor key is read. Every replay uses the ticket-01 scripted socket factory
and an explicitly supplied test key, so this suite runs in the Python CI job
untouched.
"""

import json
import os
import unittest
from unittest import mock

from cascade.tts_replay import (
    FIXTURE_DIR,
    FixtureError,
    assert_parity,
    load,
    replay,
)

#: Every fixture file must be replayed by a named test below; the guard compares
#: this list with the directory so a new recording cannot be dropped silently.
EXERCISED = (
    "begin-echo",
    "begin-echo-mismatch",
    "sentence-scheduling",
    "audio-loss",
    "audio-partial-sample",
    "cancel-ordering",
    "termination-billing",
    "close-1000",
    "close-1006",
    "close-1011",
    "close-3005",
    "close-3006",
    "close-3008",
    "close-3010",
    "close-3011",
    "close-1009",
)


class BeginEchoFixtureTests(unittest.TestCase):
    def test_the_opening_echo_replays_against_the_request(self):
        actual = assert_parity(load("begin-echo"))

        self.assertEqual(actual["url_params"]["sample_rate"], "24000")
        self.assertEqual(actual["echo"]["encoding"], "pcm_s16le")
        self.assertEqual(actual["mismatches"], [])

    def test_a_mismatched_echo_replays_as_a_refused_call(self):
        actual = assert_parity(load("begin-echo-mismatch"))

        self.assertEqual(actual["error"], "SynthesisEchoError")
        self.assertEqual([m["field"] for m in actual["mismatches"]], ["sample_rate"])
        self.assertEqual(actual["sent"], [])

    def test_a_wrong_echoed_sample_rate_fails_by_the_fixture_name(self):
        document = load("begin-echo")
        document["begin"]["configuration"]["sample_rate"] = 8000

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("begin-echo", message)
        self.assertIn("sample_rate", message)


class SentenceSchedulingFixtureTests(unittest.TestCase):
    def test_the_first_sentence_is_generated_and_flushed_before_any_audio(self):
        actual = assert_parity(load("sentence-scheduling"))

        self.assertEqual(actual["sent_at_first_audio"], 2)
        self.assertEqual(
            [frame["type"] for frame in actual["sent"]],
            ["Generate", "Flush", "Generate", "Flush", "Generate", "Flush"],
        )
        self.assertEqual(
            [frame.get("text") for frame in actual["sent"] if "text" in frame],
            ["Hello there. ", "Your rate is 6.2 percent. ", "Goodbye."],
        )

    def test_the_flush_math_agrees_with_the_bytes_of_every_sentence(self):
        actual = assert_parity(load("sentence-scheduling"))

        self.assertEqual(
            actual["flush_math"],
            [
                {"flush_id": 0, "reported_ms": 8, "derived_ms": 8.0, "delta_ms": 0.0},
                {"flush_id": 1, "reported_ms": 12, "derived_ms": 12.0, "delta_ms": 0.0},
                {"flush_id": 2, "reported_ms": 4, "derived_ms": 4.0, "delta_ms": 0.0},
            ],
        )

    def test_an_additive_unknown_frame_is_ignored(self):
        document = load("sentence-scheduling")
        document["frames"].insert(
            1, {"type": "VendorTrace", "trace_id": "not part of the contract"}
        )

        assert_parity(document)  # same pinned projection


class AudioIntegrityFixtureTests(unittest.TestCase):
    def test_a_flush_duration_disagreement_replays_as_audio_loss(self):
        actual = assert_parity(load("audio-loss"))

        self.assertEqual(actual["error"], "AudioLossError")
        self.assertEqual(
            actual["audio_losses"],
            [
                {
                    "flush_id": 0,
                    "reported_ms": 8,
                    "derived_ms": 2.0,
                    "delta_ms": -6.0,
                    "audio_bytes": 96,
                }
            ],
        )

    def test_a_partial_sample_is_refused_before_it_can_be_played(self):
        actual = assert_parity(load("audio-partial-sample"))

        self.assertEqual(actual["error"], "PartialSampleError")
        self.assertEqual(actual["chunks"], [])

    def test_a_changed_flush_duration_fails_by_the_fixture_name(self):
        document = load("sentence-scheduling")
        flush_done = next(
            frame for frame in document["frames"] if frame["type"] == "FlushDone"
        )
        flush_done["audio_duration_ms"] = 9

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("sentence-scheduling", message)
        self.assertIn("flush_math", message)

    def test_a_dropped_audio_frame_fails_by_the_fixture_name(self):
        document = load("sentence-scheduling")
        del document["frames"][0]

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        self.assertIn("sentence-scheduling", str(caught.exception))


class CancelOrderingFixtureTests(unittest.TestCase):
    def test_cancel_drops_the_old_tail_and_reads_the_next_flush_id(self):
        actual = assert_parity(load("cancel-ordering"))

        self.assertEqual(
            [frame["type"] for frame in actual["sent"]],
            ["Generate", "Flush", "Cancel", "Generate", "Flush"],
        )
        self.assertEqual(
            actual["cancellations"],
            [
                {
                    "audio_duration_seconds": 0.4,
                    "dropped_audio_bytes": 192,
                    "dropped_flushes": 1,
                    "discarded_characters": 7,
                    "next_flush_id": 7,
                    "acknowledged": True,
                }
            ],
        )
        self.assertEqual(actual["tail_chunks"][0]["text"], "Tail.")


class TerminationFixtureTests(unittest.TestCase):
    def test_terminate_records_the_billed_characters_after_its_implicit_flush(self):
        actual = assert_parity(load("termination-billing"))

        self.assertEqual(actual["final_flush"]["flush_id"], 1)
        self.assertEqual(actual["billing"]["characters"], 96)
        self.assertEqual(actual["billing"]["source"], "billed_characters")
        self.assertEqual(actual["billing"]["measured"], True)
        self.assertEqual(actual["word_boundaries_status"], "complete")

    def test_terminate_sends_no_extra_flush_for_its_implicit_flush(self):
        actual = assert_parity(load("termination-billing"))

        self.assertEqual(actual["sent"][-1], {"type": "Terminate"})
        self.assertEqual(
            [frame["type"] for frame in actual["sent"]],
            ["Generate", "Flush", "Terminate"],
        )

    def test_a_changed_billed_character_count_fails_by_the_fixture_name(self):
        document = load("termination-billing")
        termination = next(
            frame for frame in document["frames"] if frame["type"] == "Termination"
        )
        termination["billed_characters"] = 97

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("termination-billing", message)
        self.assertIn("billing", message)


class ClosePolicyFixtureTests(unittest.TestCase):
    def test_1000_is_a_clean_close_with_no_failure(self):
        actual = assert_parity(load("close-1000"))

        self.assertEqual(actual["action"], "clean")
        self.assertEqual(actual["failure_class"], "do_not_open")
        self.assertEqual(actual["failures"], [])
        self.assertIsNone(actual["error"])

    def test_1006_retries_once_before_any_audio(self):
        actual = assert_parity(load("close-1006"))

        self.assertEqual(actual["action"], "retry")
        self.assertTrue(actual["retried"])
        self.assertEqual(actual["reconnects"], 1)

    def test_1011_retries_once_before_any_audio(self):
        actual = assert_parity(load("close-1011"))

        self.assertEqual(actual["action"], "retry")
        self.assertEqual(actual["failure_class"], "trigger")

    def test_3005_retries_the_owed_flush_once(self):
        actual = assert_parity(load("close-3005"))

        self.assertEqual(actual["action"], "retry")
        self.assertEqual(actual["breaker_opens"], 0)

    def test_3006_is_a_configuration_bug_that_alerts_and_does_not_open_the_leg(self):
        actual = assert_parity(load("close-3006"))

        self.assertEqual(actual["failure_class"], "bug")
        self.assertEqual(actual["alerts"], 1)
        self.assertEqual(actual["breaker_opens"], 0)
        self.assertTrue(actual["visible"])

    def test_3008_is_a_planned_reconnect_not_a_failure(self):
        actual = assert_parity(load("close-3008"))

        self.assertEqual(actual["action"], "planned_reconnect")
        self.assertTrue(actual["needs_reconnect"])
        self.assertEqual(actual["failures"], [])

    def test_3010_is_a_pacing_bug_that_alerts(self):
        actual = assert_parity(load("close-3010"))

        self.assertEqual(actual["failure_class"], "bug")
        self.assertEqual(actual["alerts"], 1)
        self.assertEqual(actual["breaker_opens"], 0)

    def test_3011_is_an_unread_audio_bug_that_alerts(self):
        actual = assert_parity(load("close-3011"))

        self.assertEqual(actual["failure_class"], "bug")
        self.assertEqual(actual["alerts"], 1)

    def test_1009_is_a_message_too_large_bug_that_does_not_retry(self):
        actual = assert_parity(load("close-1009"))

        self.assertEqual(actual["failure_class"], "bug")
        self.assertEqual(actual["reconnects"], 0)
        self.assertEqual(actual["breaker_opens"], 0)

    def test_a_changed_close_code_fails_by_the_fixture_name(self):
        document = load("close-3008")
        document["close_code"] = 1011

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("close-3008", message)
        self.assertIn("action", message)


class FixtureDriftTests(unittest.TestCase):
    """A changed known field is a visible failure, never a silent pass."""

    def test_an_unknown_fixture_field_is_refused_by_name(self):
        document = load("begin-echo")
        document["vendor_extra"] = "not part of the document contract"

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("begin-echo", str(caught.exception))
        self.assertIn("vendor_extra", str(caught.exception))

    def test_an_unpinned_known_field_is_refused_by_name(self):
        document = load("begin-echo")
        del document["expect"]["echo"]

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("begin-echo", str(caught.exception))
        self.assertIn("echo", str(caught.exception))

    def test_a_fixture_that_can_no_longer_be_produced_fails_not_skips(self):
        document = load("begin-echo")
        del document["begin"]

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("begin-echo", str(caught.exception))

    def test_a_missing_fixture_file_fails_by_name(self):
        with self.assertRaises(FixtureError) as caught:
            load("no-such-recording")

        self.assertIn("no-such-recording", str(caught.exception))


class EveryFixtureExercisedTests(unittest.TestCase):
    def test_every_recorded_fixture_is_exercised(self):
        on_disk = {path.stem for path in FIXTURE_DIR.glob("*.json")}

        self.assertEqual(on_disk, set(EXERCISED), sorted(on_disk ^ set(EXERCISED)))


class NoVendorKeyTests(unittest.TestCase):
    def test_the_replay_suite_runs_with_an_empty_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            assert_parity(load("begin-echo"))


if __name__ == "__main__":
    unittest.main()
