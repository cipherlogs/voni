"""Event mapping for the Meta realtime speech backend (ticket 28).

The vendor's endpointing events map onto the cascade's internal vocabulary:
a ``speechStart`` opens a turn and carries the vendor ``turnId``; a
``transcript`` carries cumulative text and **no** id, so it belongs to the most
recent start; ``speechEnd`` and ``speechComplete`` both carry the same
``turnId`` but are distinct events, because only the completion may produce a
reply. Unknown event types and server binary frames are ignored. An ``error``
event fails the call and names the session.

The adapter never invents word timestamps or confidence: those fields are not
on any event it yields, even when a fixture frame carries them.
"""

import asyncio
import json
import unittest

from cascade.meta_stt import (
    MetaStreamError,
    MetaStreamingSTT,
    SpeechComplete,
    SpeechEnd,
    SpeechPartial,
    SpeechStart,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from providers import FinalTranscript, PartialTranscript


def untyped_ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def collect(plan, **kwargs):
    """Open over a scripted plan and drain the mapped event stream."""
    factory = ScriptedSocketFactory(list(plan))
    options = {"api_key": "test-key", "call_id": "call-123"}
    options.update(kwargs)
    backend = MetaStreamingSTT(socket_factory=factory, **options)

    async def run():
        await backend.open(language_codes=[], sample_rate=24000)
        return [mapped async for mapped in backend.events()]

    return asyncio.run(run()), backend, factory


class TurnBoundaryMappingTest(unittest.TestCase):
    def test_speech_start_opens_a_turn_and_carries_the_vendor_turn_id(self):
        events, _, _ = collect(
            [untyped_ack(), event("speechStart", turnId="turn-1")]
        )

        self.assertEqual(events, [SpeechStart(turn_id="turn-1")])

    def test_a_partial_carries_no_turn_id_and_belongs_to_the_latest_start(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId="turn-1"),
                event("transcript", text="hel"),
                event("transcript", text="hello"),
                event("speechStart", turnId="turn-2"),
                event("transcript", text="next"),
            ]
        )

        self.assertEqual(
            events,
            [
                SpeechStart(turn_id="turn-1"),
                SpeechPartial(text="hel"),
                SpeechPartial(text="hello"),
                SpeechStart(turn_id="turn-2"),
                SpeechPartial(text="next"),
            ],
        )
        for mapped in events:
            if isinstance(mapped, PartialTranscript) and not isinstance(
                mapped, FinalTranscript
            ):
                self.assertFalse(hasattr(mapped, "turn_id"))
                self.assertFalse(hasattr(mapped, "turnId"))

    def test_a_partial_with_no_preceding_start_is_ignored_and_logged(self):
        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events, _, _ = collect(
                [untyped_ack(), event("transcript", text="orphan")]
            )

        self.assertEqual(events, [])

    def test_speech_end_and_speech_complete_share_the_turn_id_but_are_distinct(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId="turn-1"),
                event("transcript", text="how are"),
                event("speechEnd", turnId="turn-1"),
                event("speechComplete", turnId="turn-1", text="How are you?"),
            ]
        )

        start, partial, end, complete = events
        self.assertIsInstance(end, SpeechEnd)
        self.assertIsInstance(complete, SpeechComplete)
        self.assertIsNot(type(end), type(complete))
        self.assertEqual(end.turn_id, "turn-1")
        self.assertEqual(complete.turn_id, "turn-1")
        self.assertEqual(partial.text, "how are")
        self.assertEqual(complete.text, "How are you?")

    def test_the_completion_is_a_final_transcript_the_end_is_not(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId="turn-1"),
                event("speechEnd", turnId="turn-1"),
                event("speechComplete", turnId="turn-1", text="done"),
            ]
        )

        end = events[1]
        complete = events[2]
        self.assertIsInstance(complete, FinalTranscript)
        self.assertNotIsInstance(end, FinalTranscript)

    def test_a_completion_without_a_turn_id_is_not_attributed_to_a_guess(self):
        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events, _, _ = collect(
                [
                    untyped_ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", text="no id"),
                ]
            )

        self.assertEqual(events, [SpeechStart(turn_id="turn-1")])


class RecordedWireTurnIdTest(unittest.TestCase):
    """The live M00 run recorded ``turnId`` as a JSON integer (``0``, ``1``)."""

    def test_a_json_integer_turn_id_opens_the_turn_as_its_decimal_string(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId=0),
                event("speechEnd", turnId=0),
                event("speechComplete", turnId=0, text="Hi"),
            ]
        )

        self.assertEqual(
            events,
            [
                SpeechStart(turn_id="0"),
                SpeechEnd(turn_id="0"),
                SpeechComplete(turn_id="0", text="Hi"),
            ],
        )

    def test_a_turn_id_that_names_no_turn_is_still_refused_by_name(self):
        for bad in (None, "", "   ", 1.0, {}, True):
            with self.subTest(turn_id=bad):
                with self.assertLogs("cascade.meta_stt", level="WARNING") as logs:
                    events, _, _ = collect(
                        [untyped_ack(), event("speechStart", turnId=bad)]
                    )

                self.assertEqual(events, [])
                self.assertIn("speechStart without a turnId", logs.output[0])


class IgnoredFrameTest(unittest.TestCase):
    def test_unknown_event_types_are_ignored(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("audioProgress", progress=0.5),
                event("someFutureEvent", turnId="turn-9"),
                event("speechStart", turnId="turn-1"),
                event("speechComplete", turnId="turn-1", text="hi"),
                event("brandNewEvent", text="ignored"),
            ]
        )

        self.assertEqual(
            events,
            [SpeechStart(turn_id="turn-1"), SpeechComplete(turn_id="turn-1", text="hi")],
        )

    def test_a_server_binary_frame_is_ignored(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                Frame(b"\x00\x01\x02"),
                event("speechStart", turnId="turn-1"),
                Frame(b"\xff"),
                event("speechComplete", turnId="turn-1", text="hi"),
            ]
        )

        self.assertEqual(
            events,
            [SpeechStart(turn_id="turn-1"), SpeechComplete(turn_id="turn-1", text="hi")],
        )

    def test_a_non_json_text_frame_is_ignored(self):
        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events, _, _ = collect(
                [untyped_ack(), "not json", event("speechStart", turnId="turn-1")]
            )

        self.assertEqual(events, [SpeechStart(turn_id="turn-1")])

    def test_a_known_event_with_a_new_additive_field_is_accepted(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId="turn-1", serverTick=7),
                event("transcript", text="hi", isFinal=False),
            ]
        )

        self.assertEqual(
            events,
            [SpeechStart(turn_id="turn-1"), SpeechPartial(text="hi")],
        )


class SessionErrorTest(unittest.TestCase):
    def test_an_error_event_fails_the_call_and_names_the_session(self):
        backend = None
        with self.assertRaises(MetaStreamError) as raised:
            collect(
                [
                    untyped_ack(),
                    event("speechStart", turnId="turn-1"),
                    event("error", message="model overloaded", code="500"),
                ]
            )

        self.assertIn("call-123:0", str(raised.exception))
        self.assertIn("model overloaded", str(raised.exception))

    def test_the_error_reason_is_recorded_without_the_credential(self):
        factory = ScriptedSocketFactory(
            [untyped_ack(), event("error", message="boom")]
        )
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass

        with self.assertRaises(MetaStreamError):
            asyncio.run(run())

        self.assertIn("boom", backend.failure_reason or "")
        self.assertIn("call-123:0", backend.failure_reason or "")
        self.assertNotIn("test-key", backend.failure_reason or "")


class NoInventedMetadataTest(unittest.TestCase):
    def test_word_timestamps_and_confidence_are_never_emitted(self):
        events, _, _ = collect(
            [
                untyped_ack(),
                event("speechStart", turnId="turn-1"),
                event(
                    "transcript",
                    text="hello",
                    confidence=0.93,
                    words=[{"word": "hello", "start": 0.1, "end": 0.4}],
                    timestamps=[0.1, 0.4],
                ),
                event(
                    "speechComplete",
                    turnId="turn-1",
                    text="hello",
                    confidence=0.99,
                    words=[{"word": "hello", "start": 0.1, "end": 0.4}],
                ),
            ]
        )

        for mapped in events:
            for forbidden in ("words", "timestamps", "confidence", "start", "end"):
                self.assertFalse(
                    hasattr(mapped, forbidden),
                    f"{type(mapped).__name__} invented {forbidden}",
                )

    def test_the_mapped_event_fields_are_exactly_the_contract(self):
        self.assertEqual(
            SpeechStart.__dataclass_fields__.keys(), {"turn_id", "session_epoch"}
        )
        self.assertEqual(
            SpeechEnd.__dataclass_fields__.keys(), {"turn_id", "session_epoch"}
        )
        self.assertEqual(
            SpeechComplete.__dataclass_fields__.keys(),
            {"text", "turn_duration_ms", "turn_id", "session_epoch"},
        )
        self.assertEqual(PartialTranscript.__dataclass_fields__.keys(), {"text"})
        self.assertEqual(
            SpeechPartial.__dataclass_fields__.keys(), {"text", "session_epoch"}
        )


class EventsBeforeSessionTest(unittest.TestCase):
    def test_events_before_the_session_is_open_are_refused(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        async def run():
            async for _ in backend.events():
                pass

        with self.assertRaises(RuntimeError):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
