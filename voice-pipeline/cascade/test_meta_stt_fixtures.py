"""Recorded speech frames replay against pinned expectations (ticket 34).

Spec: `.scratch/meta-cascade/spec.md`, "Fixtures, chaos and live smoke" — a
fixture is a contract, not a snapshot of a mood. Each JSON document under
``cascade/fixtures/stt/`` is a recorded Meta realtime session: the handshake
acknowledgement (or the frame that broke it), the endpointing events, the raw
audio path with its pacing, one close code per file, a session limit/idle/
deliberate end, and two overlapping-turn sessions. Replaying a document pins
what the caller and the call record observe, so a changed known frame fails
*by fixture name* and an additive unknown event is ignored.

A fixture that can no longer be produced is a failure, never a skip: a missing
file, a document the loader cannot replay, or a session that no longer opens
raises with the fixture's name in the message.

The clock is the ticket-01 ``FakeClock`` and the socket is the ticket-01
scripted factory, so the session-limit delays are virtual and no test sleeps.
The vendor key is supplied explicitly, never read from the environment, so the
suite runs in the Python CI job untouched.
"""

import json
import os
import unittest
from unittest import mock

from cascade.stt_replay import (
    FIXTURE_DIR,
    FixtureError,
    assert_parity,
    load,
    replay,
)

#: Every fixture file must be replayed by a named test below; the guard compares
#: this list with the directory so a new recording cannot be dropped silently.
EXERCISED = (
    "handshake-ack",
    "handshake-protocol-error",
    "events-turn",
    "events-live-wire-two-turns",
    "events-unknown-ignored",
    "audio-malformed",
    "audio-pacing-lead",
    "close-1000",
    "close-1008",
    "close-1011",
    "close-1013",
    "close-no-code",
    "lifetime-planned-reconnect",
    "lifetime-idle-close",
    "lifetime-deliberate-end",
    "overlap-turns",
    "overlap-epoch-reuse",
)


class HandshakeFixtureTests(unittest.TestCase):
    def test_the_acknowledged_handshake_replays_in_full(self):
        actual = assert_parity(load("handshake-ack"))

        self.assertTrue(actual["acked"])
        self.assertEqual(actual["epoch"], 0)
        self.assertIsNone(actual["error"])
        handshake = actual["sent"][0][0]
        self.assertEqual(handshake["audioEncoding"], "PCM_24KHZ")
        self.assertEqual(handshake["languageBias"], ["English"])
        self.assertEqual(handshake["keywords"], ["pricing", "Voni"])
        self.assertNotIn("test-key", actual["session_ids"][0])

    def test_a_frame_before_the_ack_replays_as_a_named_protocol_error(self):
        actual = assert_parity(load("handshake-protocol-error"))

        self.assertEqual(actual["error"], "MetaHandshakeProtocolError")
        self.assertFalse(actual["acked"])
        self.assertIn("transcript", actual["failure_reason"])
        self.assertIn("call-123:0", actual["failure_reason"])

    def test_a_changed_handshake_field_fails_by_the_fixture_name(self):
        document = load("handshake-ack")
        document["expect"]["sent"][0][0]["model"] = "some-other-model"

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("handshake-ack", message)
        self.assertIn("sent", message)


class EventFixtureTests(unittest.TestCase):
    def test_the_turn_lifecycle_replays_start_partial_end_complete(self):
        actual = assert_parity(load("events-turn"))

        self.assertEqual(
            [event["type"] for event in actual["events"]],
            [
                "SpeechStart",
                "SpeechPartial",
                "SpeechPartial",
                "SpeechEnd",
                "SpeechComplete",
            ],
        )
        self.assertEqual(actual["events"][-1]["text"], "How are you?")
        self.assertEqual(actual["turns"][0]["final_text"], "How are you?")
        self.assertEqual(actual["turns"][0]["partial_text"], "how are you")

    def test_the_live_wire_shape_maps_both_integer_turns(self):
        actual = assert_parity(load("events-live-wire-two-turns"))

        self.assertIsNone(actual["error"])
        self.assertEqual(
            [event["type"] for event in actual["events"]],
            [
                "SpeechStart",
                "SpeechPartial",
                "SpeechEnd",
                "SpeechComplete",
            ]
            * 2,
        )
        self.assertEqual(
            [event["turn_id"] for event in actual["events"] if "turn_id" in event],
            ["0", "0", "0", "1", "1", "1"],
            "speechStart, speechEnd and speechComplete each carry the turn id",
        )
        self.assertEqual(
            [
                (turn["turn_id"], turn["partial_text"], turn["final_text"])
                for turn in actual["turns"]
            ],
            [
                (
                    "0",
                    "Hi",
                    "Hi I'm Voni let's try something cool I'll show you what "
                    "I can do while we talk",
                ),
                ("1", "ready?", "ready?"),
            ],
            "each partial binds to its own turn, and the final text is "
            "`transcript`, not an empty `text`",
        )

    def test_unknown_and_additive_events_are_ignored(self):
        actual = assert_parity(load("events-unknown-ignored"))

        self.assertEqual(
            [event["type"] for event in actual["events"]],
            ["SpeechStart", "SpeechPartial", "SpeechComplete"],
        )
        self.assertEqual(actual["events"][-1]["text"], "hi")
        self.assertEqual(actual["stale_events"], 0)

    def test_a_changed_completion_text_fails_by_the_fixture_name(self):
        document = load("events-turn")
        complete = next(
            frame
            for frame in document["plans"][0]
            if isinstance(frame.get("json"), dict)
            and frame["json"].get("type") == "speechComplete"
        )
        complete["json"]["text"] = "How are you"

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("events-turn", message)
        self.assertIn("events", message)

    def test_an_additive_event_passes_and_is_ignored(self):
        document = load("events-turn")
        document["plans"][0].insert(
            1,
            {
                "json": {
                    "type": "vendorFutureEvent",
                    "turnId": "turn-9",
                    "confidence": 0.99,
                }
            },
        )

        assert_parity(document)  # same pinned event sequence


class AudioFixtureTests(unittest.TestCase):
    def test_a_malformed_binary_frame_is_dropped_and_a_valid_frame_still_goes(self):
        actual = assert_parity(load("audio-malformed"))

        self.assertEqual(actual["dropped_frames"], 2)
        audio = [frame for frame in actual["sent"][0][1:]]
        self.assertEqual(len(audio), 1)
        self.assertEqual(audio[0]["bytes"], 960)
        self.assertFalse(audio[0]["silence"])

    def test_pacing_never_runs_more_than_five_seconds_ahead(self):
        actual = assert_parity(load("audio-pacing-lead"))

        self.assertEqual(actual["dropped_frames"], 1)
        audio = actual["sent"][0][1:]
        self.assertEqual(len(audio), 11)
        self.assertEqual(
            sum(frame["bytes"] for frame in audio),
            5 * 24000 * 2 + 24000,
            "ten 0.5 s frames, then one more once the clock caught up",
        )
        self.assertIsNone(actual["error"])

    def test_a_changed_audio_sample_fails_by_the_fixture_name(self):
        document = load("audio-malformed")
        document["audio"][2]["value"] = 2

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        self.assertIn("audio-malformed", str(caught.exception))
        self.assertIn("sent", str(caught.exception))


class CloseCodeFixtureTests(unittest.TestCase):
    def test_1000_is_a_clean_close(self):
        actual = assert_parity(load("close-1000"))

        self.assertEqual(actual["action"], "clean")
        self.assertEqual(actual["failure_class"], "do_not_open")
        self.assertEqual(actual["failures"], [])
        self.assertEqual(actual["reconnects"], 0)

    def test_1008_fails_visibly_alerts_and_opens_no_leg(self):
        actual = assert_parity(load("close-1008"))

        self.assertEqual(actual["action"], "fail")
        self.assertEqual(actual["failure_class"], "bug")
        self.assertEqual(actual["alerts"], 1)
        self.assertEqual(actual["breaker_opens"], 0)

    def test_1011_retries_once_with_a_new_session(self):
        actual = assert_parity(load("close-1011"))

        self.assertEqual(actual["action"], "retry")
        self.assertTrue(actual["retried"])
        self.assertEqual(actual["reconnects"], 1)
        self.assertEqual(actual["failures"][0]["code"], 1011)

    def test_1013_backs_off_opens_the_leg_and_does_not_retry(self):
        actual = assert_parity(load("close-1013"))

        self.assertEqual(actual["action"], "fail")
        self.assertTrue(actual["backoff"])
        self.assertEqual(actual["reconnects"], 0)
        self.assertEqual(actual["breaker_opens"], 1)

    def test_a_close_with_no_code_is_treated_as_1011(self):
        actual = assert_parity(load("close-no-code"))

        self.assertEqual(actual["action"], "retry")
        self.assertIsNone(actual["failures"][0]["code"])
        self.assertEqual(actual["failures"][0]["class"], "trigger")

    def test_a_changed_close_code_fails_by_the_fixture_name(self):
        document = load("close-1013")
        document["close"]["code"] = 1011

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("close-1013", message)
        self.assertIn("action", message)


class LifetimeFixtureTests(unittest.TestCase):
    def test_the_session_limit_reconnects_at_a_turn_boundary(self):
        actual = assert_parity(load("lifetime-planned-reconnect"))

        self.assertEqual(actual["reconnects"], 1)
        self.assertEqual(actual["failures"], [])
        self.assertEqual(
            [event["session_epoch"] for event in actual["events"]],
            [0, 0, 0, 1, 1],
        )
        self.assertEqual(
            [ending["kind"] for ending in actual["session_endings"]],
            ["lifetime", "normal"],
        )
        self.assertTrue(actual["session_endings"][0]["planned"])
        self.assertIn("reconnect", actual["ledger_marks"])

    def test_an_idle_close_is_a_planned_session_end_not_a_failure(self):
        actual = assert_parity(load("lifetime-idle-close"))

        self.assertEqual(actual["reconnects"], 1)
        self.assertEqual(actual["failures"], [])
        self.assertEqual(
            [ending["kind"] for ending in actual["session_endings"]],
            ["idle", "normal"],
        )
        self.assertTrue(actual["session_endings"][0]["planned"])

    def test_a_deliberate_end_sends_end_stream_and_records_it(self):
        actual = assert_parity(load("lifetime-deliberate-end"))

        self.assertEqual(actual["events"][-1]["type"], "SpeechComplete")
        self.assertEqual(
            actual["sent"][0][-1], {"type": "endStream"}
        )
        ending = actual["session_endings"][-1]
        self.assertEqual(ending["kind"], "deliberate")
        self.assertTrue(ending["end_stream_sent"])
        self.assertFalse(ending["planned"])


class OverlapFixtureTests(unittest.TestCase):
    def test_a_later_start_before_an_earlier_completion_keeps_both_turns(self):
        actual = assert_parity(load("overlap-turns"))

        self.assertEqual(
            [event["turn_id"] for event in actual["events"] if "turn_id" in event],
            ["turn-1", "turn-2", "turn-1", "turn-2"],
        )
        self.assertEqual(
            [(turn["session_epoch"], turn["turn_id"]) for turn in actual["turns"]],
            [(0, "turn-1"), (0, "turn-2")],
        )
        self.assertEqual(
            [turn["final_text"] for turn in actual["turns"]], ["one", "two"]
        )

    def test_a_reused_turn_id_after_a_reconnect_is_a_new_logical_turn(self):
        actual = assert_parity(load("overlap-epoch-reuse"))

        self.assertEqual(
            [event["session_epoch"] for event in actual["events"]], [0, 0, 1, 1]
        )
        self.assertEqual(
            [(turn["session_epoch"], turn["turn_id"]) for turn in actual["turns"]],
            [(0, "turn-1"), (1, "turn-1")],
        )
        self.assertEqual(
            [turn["final_text"] for turn in actual["turns"]], ["first", "second"]
        )


class FixtureDriftTests(unittest.TestCase):
    """A changed known field is a visible failure, never a silent pass."""

    def test_an_unknown_fixture_field_is_refused_by_name(self):
        document = load("events-turn")
        document["vendor_extra"] = "not part of the document contract"

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("events-turn", str(caught.exception))
        self.assertIn("vendor_extra", str(caught.exception))

    def test_an_unpinned_known_field_is_refused_by_name(self):
        document = load("events-turn")
        del document["expect"]["stale_events"]

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("events-turn", str(caught.exception))
        self.assertIn("stale_events", str(caught.exception))

    def test_a_fixture_that_can_no_longer_be_produced_fails_not_skips(self):
        document = load("events-turn")
        del document["plans"]

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("events-turn", str(caught.exception))
        self.assertIn("plans", str(caught.exception))

    def test_a_frame_with_two_payloads_is_refused(self):
        document = load("events-turn")
        frame = document["plans"][0][1]
        frame["close_code"] = 1000

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("events-turn", str(caught.exception))

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
            assert_parity(load("handshake-ack"))


if __name__ == "__main__":
    unittest.main()
