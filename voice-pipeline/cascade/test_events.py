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
import re
import unittest
from pathlib import Path

from cascade.events import (
    CALL_SCOPED_FIELDS,
    CASCADE_ONLY_EVENT_TYPES,
    EVENT_SCHEMA_VERSION,
    FALLBACK_EVENT_TYPE,
    FALLBACK_TRIGGERS,
    OPERATIONAL_FIELDS,
    PHASES,
    PIPELINES,
    EventEnvelopeError,
    EventStream,
    EventWriter,
    Fallback,
    ForbiddenEventKey,
    connect_fallback,
    emit_fallback,
    turn_fallback,
)
from cascade.routing import CallSubject, decide
from cascade.sanitizer import REDACTED

SUBJECT = "demo anna (en, browser)"

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

#: The one TS reader. Its cascade-only list is the list this writer must mirror.
EVENT_ENVELOPE_TS = (
    Path(__file__).resolve().parents[2]
    / "voni"
    / "src"
    / "lib"
    / "demo"
    / "event-envelope.ts"
)


class CascadeOnlyEventTypeDriftTests(unittest.TestCase):
    """``CASCADE_ONLY_EVENT_TYPES`` is a mirror, so a drift fails by name.

    The Python tuple is a second copy of the TS reader's list by necessity (the
    service does not import TypeScript), so this test is what keeps it honest:
    a type added on either side is named here before it can be believed.
    """

    def ts_types(self) -> tuple[str, ...]:
        source = EVENT_ENVELOPE_TS.read_text(encoding="utf8")
        match = re.search(
            r"export const CASCADE_ONLY_EVENT_TYPES\s*=\s*\[(.*?)\]\s*as const;",
            source,
            re.S,
        )
        if match is None:
            self.fail(
                f"cannot read CASCADE_ONLY_EVENT_TYPES from {EVENT_ENVELOPE_TS}; "
                "the reader's declaration changed shape"
            )
        return tuple(re.findall(r'"([^"]+)"', match.group(1)))

    def test_the_python_tuple_is_the_ts_readers_list(self):
        python_types = CASCADE_ONLY_EVENT_TYPES
        ts_types = self.ts_types()

        missing = [name for name in ts_types if name not in python_types]
        extra = [name for name in python_types if name not in ts_types]
        self.assertEqual(
            [],
            missing,
            "cascade-only event types the TS reader has and cascade.events does "
            f"not: {missing}",
        )
        self.assertEqual(
            [],
            extra,
            "cascade-only event types cascade.events has and the TS reader does "
            f"not: {extra}",
        )
        self.assertEqual(
            ts_types,
            python_types,
            "the two cascade-only lists carry the same names in a different order",
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


def cascade_writer(call_id: str = "call-109") -> EventWriter:
    return EventWriter(pipeline="cascade", call_id=call_id)


def emitted(
    stream: list, writer: EventWriter, fallback, *, at_ms: float | int = 900
) -> dict:
    return emit_fallback(
        writer, fallback, subject=SUBJECT, at_ms=at_ms, sink=stream.append
    )


def clean(stream: list) -> bool:
    """Ticket 116 owns the gate; this is the one fact the gate reads.

    A run is clean when no ``provider_fallback`` line was emitted. A refusal is
    an eligibility fact and never produces this event.
    """
    return not any(event["type"] == FALLBACK_EVENT_TYPE for event in stream)


class FallbackEmissionTests(unittest.TestCase):
    def test_a_mid_turn_fallback_names_leg_rungs_trigger_turn_and_phase(self):
        stream: list = []
        event = emitted(
            stream,
            cascade_writer(),
            turn_fallback(
                "stt",
                from_provider="meta",
                to_provider="assemblyai",
                trigger="mid_turn_failure",
                turn="turn-3",
                reason="stt closed with 1013",
            ),
        )

        self.assertEqual(event, FIXTURES["cascadeFallback"])
        self.assertEqual(stream, [event])
        self.assertEqual(event["leg"], "stt")
        self.assertEqual(event["from"], "meta")
        self.assertEqual(event["to"], "assemblyai")
        self.assertEqual(event["trigger"], "mid_turn_failure")
        self.assertEqual(event["turn"], "turn-3")
        self.assertEqual(event["phase"], "turn")

    def test_a_connect_time_fallback_is_emitted_and_names_the_connect_phase(self):
        stream: list = []
        event = emitted(
            stream,
            cascade_writer(),
            connect_fallback(
                "llm", primary="spark", selected="gateway", trigger="breaker_open"
            ),
            at_ms=0,
        )

        self.assertEqual(event["type"], FALLBACK_EVENT_TYPE)
        self.assertEqual(event["phase"], "connect")
        self.assertIsNone(event["turn"])
        self.assertEqual(event["leg"], "llm")
        self.assertEqual(event["from"], "spark")
        self.assertEqual(event["to"], "gateway")
        self.assertEqual(stream, [event], "a connect-time fallback still reaches the stream")

    def test_a_connect_and_a_mid_turn_fallback_are_two_events_with_the_right_phase(self):
        stream: list = []
        writer = cascade_writer()
        emitted(
            stream,
            writer,
            connect_fallback(
                "stt", primary="meta", selected="assemblyai", trigger="breaker_open"
            ),
            at_ms=0,
        )
        emitted(
            stream,
            writer,
            turn_fallback(
                "llm",
                from_provider="spark",
                to_provider="gateway",
                trigger="mid_turn_failure",
                turn="turn-4",
            ),
            at_ms=1500,
        )

        self.assertEqual([event["type"] for event in stream], [FALLBACK_EVENT_TYPE] * 2)
        self.assertEqual([event["phase"] for event in stream], ["connect", "turn"])
        self.assertEqual([event["turn"] for event in stream], [None, "turn-4"])
        self.assertEqual([event["leg"] for event in stream], ["stt", "llm"])

    def test_every_fallback_is_built_by_the_one_envelope_writer(self):
        stream: list = []
        event = emitted(
            stream,
            EventWriter(pipeline="cascade", call_id="call-109"),
            connect_fallback(
                "tts", primary="assemblyai", selected="meta", trigger="manual_pin"
            ),
        )

        self.assertEqual(
            tuple(event), (*CALL_SCOPED_FIELDS, "leg", "from", "to", "trigger")
        )
        self.assertEqual(event["schemaVersion"], EVENT_SCHEMA_VERSION)
        self.assertEqual(event["pipeline"], "cascade")
        self.assertEqual(event["callId"], "call-109")
        self.assertEqual(event["subject"], SUBJECT)

        source = (Path(__file__).with_name("events.py")).read_text(encoding="utf8")
        # The cascade-only mirror names this type too; it is not an emitter, so
        # count the identifier outside that tuple.
        mirror_start = source.index("CASCADE_ONLY_EVENT_TYPES = (")
        mirror_end = source.index(")", mirror_start) + 1
        without_mirror = source[:mirror_start] + source[mirror_end:]
        self.assertEqual(
            without_mirror.count("FALLBACK_EVENT_TYPE"),
            2,
            "one definition and one emission site; a second emitter is a review failure",
        )

    def test_a_managed_writer_cannot_emit_a_provider_fallback(self):
        stream: list = []
        with self.assertRaises(EventEnvelopeError) as caught:
            emitted(
                stream,
                EventWriter(pipeline="managed", call_id="call-109"),
                connect_fallback(
                    "stt", primary="meta", selected="assemblyai", trigger="breaker_open"
                ),
            )

        self.assertEqual(caught.exception.field, "pipeline")
        self.assertIn("cascade", str(caught.exception))
        self.assertEqual(stream, [], "a refused managed fallback writes nothing")

    def test_a_routing_refusal_is_a_routing_decision_not_a_fallback(self):
        decision = decide("off", CallSubject("demo-anna", kind="demo"))
        self.assertEqual(decision.disposition, "managed")
        self.assertFalse(decision.permitted)

        stream: list = []
        with self.assertRaises(EventEnvelopeError) as caught:
            connect_fallback(
                "stt",
                primary="meta",
                selected="assemblyai",
                trigger="routing_refusal",
            )

        self.assertEqual(caught.exception.field, "trigger")
        self.assertIn("routing", str(caught.exception))
        self.assertIn("not a provider fault", str(caught.exception))
        self.assertEqual(stream, [])
        self.assertNotIn("provider_fallback", json.dumps(decision.to_document()))

    def test_a_run_with_a_fallback_event_is_not_clean(self):
        stream: list = []
        writer = cascade_writer()
        # A connect on the primary rung emits nothing, so the run reads clean.
        self.assertTrue(clean(stream))

        emitted(
            stream,
            writer,
            connect_fallback(
                "llm", primary="spark", selected="gateway", trigger="breaker_open"
            ),
            at_ms=10,
        )

        self.assertFalse(clean(stream), "a connect-time fallback contaminates the run")
        self.assertEqual(
            [event["trigger"] for event in stream], ["breaker_open"]
        )


class FallbackRefusalTests(unittest.TestCase):
    def refused(self, fn) -> EventEnvelopeError:
        with self.assertRaises(EventEnvelopeError) as caught:
            fn()
        return caught.exception

    def test_an_unknown_leg_is_refused_by_name(self):
        error = self.refused(
            lambda: connect_fallback(
                "voice", primary="meta", selected="assemblyai", trigger="breaker_open"
            )
        )

        self.assertEqual(error.field, "leg")
        self.assertIn("voice", str(error))

    def test_from_and_to_must_be_different_providers(self):
        error = self.refused(
            lambda: turn_fallback(
                "stt",
                from_provider="meta",
                to_provider="meta",
                trigger="mid_turn_failure",
                turn="turn-1",
            )
        )

        self.assertEqual(error.field, "to")
        self.assertIn("different", str(error))

    def test_a_connect_fallback_cannot_name_a_turn(self):
        error = self.refused(
            lambda: Fallback(
                leg="stt",
                from_provider="meta",
                to_provider="assemblyai",
                trigger="mid_turn_failure",
                phase="connect",
                turn="turn-1",
            )
        )

        self.assertEqual(error.field, "turn")
        self.assertIn("connect", str(error))

    def test_a_mid_turn_fallback_must_name_its_turn(self):
        error = self.refused(
            lambda: turn_fallback(
                "stt",
                from_provider="meta",
                to_provider="assemblyai",
                trigger="mid_turn_failure",
                turn=None,
            )
        )

        self.assertEqual(error.field, "turn")
        self.assertIn("turn", str(error))

    def test_an_unknown_trigger_is_refused_by_name(self):
        error = self.refused(
            lambda: connect_fallback(
                "stt", primary="meta", selected="assemblyai", trigger="vibes"
            )
        )

        self.assertEqual(error.field, "trigger")
        self.assertIn("vibes", str(error))
        self.assertIn(", ".join(FALLBACK_TRIGGERS), str(error))

    def test_a_budget_stop_is_not_a_fallback(self):
        for trigger in ("budget_stop", "eligibility_refusal"):
            error = self.refused(
                lambda trigger=trigger: connect_fallback(
                    "stt", primary="meta", selected="assemblyai", trigger=trigger
                )
            )
            self.assertEqual(error.field, "trigger")
            self.assertIn("not a provider fault", str(error))


def cascade_stream(call_id: str = "call-111") -> tuple[list[str], EventStream]:
    lines: list[str] = []
    writer = EventWriter(pipeline="cascade", call_id=call_id)
    return lines, EventStream(writer, sink=lines.append)


class CascadeStreamSanitizerTests(unittest.TestCase):
    def test_every_cascade_line_runs_the_shared_sanitizer_before_write(self):
        lines, stream = cascade_stream()

        event = stream.call_scoped(
            "turn.reply_start",
            subject=SUBJECT,
            turn="turn-1",
            at_ms=1200,
            phase="turn",
            fields={
                "sessionId": "sess_abc",
                "reason": "fallback to wss://edge:supersecret@cascade.example/ws",
                "note": "key sk_live_abcdefgh1234 leaked",
            },
        )

        self.assertEqual(len(lines), 1)
        line = json.loads(lines[0])
        self.assertEqual(line, event)
        self.assertEqual(
            line["reason"], "fallback to wss://[redacted]@cascade.example/ws"
        )
        self.assertEqual(line["note"], "key [redacted] leaked")
        self.assertEqual(line["sessionId"], "sess_abc")
        self.assertNotIn("supersecret", lines[0])
        self.assertNotIn("sk_live_abcdefgh1234", lines[0])

    def test_a_forbidden_key_rejects_the_line_by_name_before_write(self):
        lines, stream = cascade_stream()

        with self.assertRaises(ForbiddenEventKey) as caught:
            stream.call_scoped(
                "turn.user_final",
                subject=SUBJECT,
                turn="turn-1",
                at_ms=1200,
                phase="turn",
                fields={"text": "caller words", "token": "tok_secret"},
            )

        self.assertEqual(caught.exception.keys, ("text", "token"))
        self.assertEqual(caught.exception.field, "text")
        self.assertIn('"text"', str(caught.exception))
        self.assertIn('"token"', str(caught.exception))
        self.assertEqual(lines, [], "a refused line is not written")
        self.assertNotIn("caller words", str(caught.exception))
        self.assertNotIn("tok_secret", str(caught.exception))

    def test_a_raw_vendor_handshake_is_never_logged(self):
        # The frame ``MetaStreamingSTT.open`` sends: the credential is inside it.
        handshake = {
            "authorization": {"accessToken": "Bearer supersecret"},
            "audioEncoding": "pcm_s16le",
            "model": "u-3-rt",
            "mode": "agent",
            "languageBias": ["English"],
        }
        lines, stream = cascade_stream()

        with self.assertRaises(ForbiddenEventKey) as caught:
            stream.call_scoped(
                "stt.handshake",
                subject=SUBJECT,
                turn=None,
                at_ms=0,
                phase="connect",
                fields={"handshake": handshake},
            )

        self.assertEqual(caught.exception.keys, ("handshake.authorization",))
        self.assertIn("authorization", str(caught.exception))
        self.assertNotIn("supersecret", str(caught.exception))
        self.assertNotIn("Bearer", str(caught.exception))
        self.assertEqual(lines, [])

    def test_a_fallback_reason_is_redacted_on_the_written_line(self):
        lines, stream = cascade_stream()

        emit_fallback(
            stream.writer,
            turn_fallback(
                "stt",
                from_provider="meta",
                to_provider="assemblyai",
                trigger="mid_turn_failure",
                turn="turn-3",
                reason="retry wss://user:pw@vendor.example/ws with Bearer abc.def",
            ),
            subject=SUBJECT,
            at_ms=900,
            sink=stream,
        )

        line = json.loads(lines[0])
        self.assertEqual(line["type"], FALLBACK_EVENT_TYPE)
        self.assertEqual(line["leg"], "stt")
        self.assertEqual(line["from"], "meta")
        self.assertEqual(line["to"], "assemblyai")
        self.assertEqual(line["trigger"], "mid_turn_failure")
        self.assertEqual(line["turn"], "turn-3")
        self.assertEqual(line["phase"], "turn")
        self.assertEqual(
            line["reason"], f"retry wss://{REDACTED}@vendor.example/ws with {REDACTED}"
        )
        self.assertNotIn("user:pw", lines[0])
        self.assertNotIn("abc.def", lines[0])

    def test_existing_consumers_see_the_same_allowed_fields(self):
        lines, stream = cascade_stream()

        stream.operational(
            "breaker.transition",
            leg="llm",
            at_ms=4200,
            phase="turn",
            fields={"from": "spark", "to": "gateway", "reason": "1013 rate limited"},
        )

        self.assertEqual(
            json.loads(lines[0]),
            {
                "schemaVersion": EVENT_SCHEMA_VERSION,
                "pipeline": "cascade",
                "callId": "call-111",
                "type": "breaker.transition",
                "leg": "llm",
                "atMs": 4200,
                "phase": "turn",
                "from": "spark",
                "to": "gateway",
                "reason": "1013 rate limited",
            },
        )


if __name__ == "__main__":
    unittest.main()
