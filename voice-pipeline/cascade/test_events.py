"""One call-event envelope for both engines (ticket 107).

Seam: ``cascade.events.EventWriter`` — the voice service's envelope writer. A
managed event and a cascade event differ only by the ``pipeline`` value, and an
operational event carries ``leg`` in place of ``subject``/``turn``.

Expected values are the canonical fixture that the one TS reader
(``voni/src/lib/demo/event-envelope.ts``) parses, so a writer/reader drift fails
on one side of the A/B. This module is a builder, not a second sanitizer: the
persisted stream is written by the one TS writer, which calls the one sanitizer
(ticket 07).
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from cascade.events import (
    CALL_SCOPED_FIELDS,
    EVENT_SCHEMA_VERSION,
    OPERATIONAL_FIELDS,
    PHASES,
    PIPELINES,
    EventEnvelopeError,
    EventWriter,
)

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "voni"
        / "src"
        / "lib"
        / "demo"
        / "event-envelope.fixtures.json"
    ).read_text(encoding="utf8")
)


def call_scoped(writer: EventWriter, **overrides: object) -> dict:
    fields = {
        "subject": "demo anna (en, browser)",
        "turn": "turn-1",
        "at_ms": 1200,
        "phase": "turn",
    }
    fields.update(overrides)
    return writer.call_scoped("turn.reply_start", **fields)  # type: ignore[arg-type]


class EnvelopeParityTests(unittest.TestCase):
    def test_both_engines_write_the_same_envelope(self):
        managed = call_scoped(EventWriter(pipeline="managed", call_id="call-107"))
        cascade = call_scoped(EventWriter(pipeline="cascade", call_id="call-107"))

        self.assertEqual(managed, FIXTURES["managedCallScoped"])
        self.assertEqual(cascade, FIXTURES["cascadeCallScoped"])
        self.assertEqual(sorted(managed), sorted(cascade))
        self.assertEqual(
            {key: value for key, value in managed.items() if key != "pipeline"},
            {key: value for key, value in cascade.items() if key != "pipeline"},
            "the engine is the only difference between the two envelopes",
        )

    def test_a_call_scoped_event_carries_every_required_field(self):
        event = call_scoped(EventWriter(pipeline="cascade", call_id="call-107"))

        self.assertEqual(tuple(event), CALL_SCOPED_FIELDS)
        self.assertEqual(event["schemaVersion"], EVENT_SCHEMA_VERSION)
        self.assertEqual(event["phase"], "turn")

    def test_an_operational_event_carries_the_leg_in_place_of_subject_and_turn(self):
        event = EventWriter(pipeline="cascade", call_id="call-107").operational(
            "breaker.transition", leg="llm", at_ms=4200, phase="turn"
        )

        self.assertEqual(event, FIXTURES["cascadeOperational"])
        self.assertEqual(tuple(event), OPERATIONAL_FIELDS)
        self.assertNotIn("subject", event)
        self.assertNotIn("turn", event)


class RefusalTests(unittest.TestCase):
    def refused(self, fn) -> EventEnvelopeError:
        with self.assertRaises(EventEnvelopeError) as caught:
            fn()
        return caught.exception

    def test_an_unknown_pipeline_is_refused_by_name(self):
        error = self.refused(lambda: EventWriter(pipeline="phone", call_id="call-107"))

        self.assertEqual(error.field, "pipeline")
        self.assertIn("phone", str(error))
        self.assertIn(", ".join(PIPELINES), str(error))

    def test_a_blank_call_id_is_refused_not_defaulted(self):
        error = self.refused(lambda: EventWriter(pipeline="cascade", call_id="  "))

        self.assertEqual(error.field, "callId")

    def test_a_blank_subject_is_refused_by_name(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(lambda: call_scoped(writer, subject=""))

        self.assertEqual(error.field, "subject")

    def test_a_turn_is_an_id_or_null_never_a_number(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(lambda: call_scoped(writer, turn=7))

        self.assertEqual(error.field, "turn")

    def test_an_unknown_phase_is_refused_by_name(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(lambda: call_scoped(writer, phase="thinking"))

        self.assertEqual(error.field, "phase")
        self.assertIn("thinking", str(error))
        self.assertIn(", ".join(PHASES), str(error))

    def test_a_non_finite_time_is_refused(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(lambda: call_scoped(writer, at_ms=float("inf")))

        self.assertEqual(error.field, "atMs")

    def test_an_operational_type_cannot_be_written_call_scoped(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(
            lambda: writer.call_scoped(
                "breaker.transition",
                subject="demo anna (en, browser)",
                turn=None,
                at_ms=0,
                phase="connect",
            )
        )

        self.assertEqual(error.field, "type")
        self.assertIn("breaker.transition", str(error))
        self.assertIn("operational", str(error))

    def test_a_call_scoped_type_cannot_be_written_operational(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(
            lambda: writer.operational("turn.reply_start", leg="llm", at_ms=0, phase="turn")
        )

        self.assertEqual(error.field, "type")
        self.assertIn("turn.reply_start", str(error))

    def test_a_payload_field_cannot_overwrite_the_envelope(self):
        writer = EventWriter(pipeline="cascade", call_id="call-107")

        error = self.refused(lambda: call_scoped(writer, fields={"callId": "call-other"}))

        self.assertEqual(error.field, "callId")
        self.assertIn("collides with the envelope", str(error))

    def test_the_python_builder_keeps_no_second_sanitizer(self):
        source = (Path(__file__).with_name("events.py")).read_text(encoding="utf8")

        self.assertNotIn("FORBIDDEN", source)
        self.assertNotIn("def redact", source)


if __name__ == "__main__":
    unittest.main()
