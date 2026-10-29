"""Anti-lie: the fallback emission is load-bearing for eligibility (ticket 146).

The run's rungs are read before the first frame, so a leg the records put on
the fallback rung is a *connect-time* fallback. These tests drive the one
emission path from the frozen choices and then audit the stream a run carries
against the choices it made: a run that used a fallback but carries no
``provider_fallback`` event is refused by name.

Deleting the emission (``sink(event)`` in ``events.emit_fallback``) leaves the
stream empty and makes the connect-fallback test fail; deleting the audit's
missing-event refusal makes the no-event test fail. Neither proof is described
here instead of executed — the red logs are attached to the ticket.
"""

import unittest
from pathlib import Path

from cascade import fallback_audit
from cascade.eligibility import REFUSAL_EVENT_TYPE
from cascade.events import (
    FALLBACK_EVENT_TYPE,
    EventEnvelopeError,
    EventWriter,
    connect_fallback,
    emit_fallback,
    turn_fallback,
)
from cascade.ladders import Ladder, RungChoice
from cascade.routing import CallSubject, decide

SUBJECT = "demo-anna"

LLM = Ladder("llm", "spark", "gateway")
STT = Ladder("stt", "meta", "assemblyai")
TTS = Ladder("tts", "assemblyai", None)

LADDERS = {ladder.leg: ladder for ladder in (STT, LLM, TTS)}


def choice(
    leg: str,
    rung: str,
    provider: str | None,
    *,
    pinned: bool = False,
) -> RungChoice:
    """One frozen rung, built the way ``read_choices`` builds it."""
    return RungChoice(
        leg=leg,  # type: ignore[arg-type]
        rung=rung,  # type: ignore[arg-type]
        provider=provider,
        reason=f"{leg} reads {'open' if rung == 'fallback' else 'closed'}: {rung} rung",
        state="open" if rung == "fallback" else "closed",
        effective_state="open" if rung == "fallback" else "closed",
        last_probe_at=10.0,
        pinned=pinned,
        recorded_provider=provider or "",
    )


def cascade_writer(call_id: str = "call-146") -> EventWriter:
    return EventWriter(pipeline="cascade", call_id=call_id)


def emit_connect(choices, stream: list, *, at_ms: float | int = 0):
    return fallback_audit.emit_connect_fallbacks(
        cascade_writer(),
        choices,
        LADDERS,
        subject=SUBJECT,
        at_ms=at_ms,
        sink=stream.append,
    )


class ConnectEmissionTests(unittest.TestCase):
    def test_a_connect_time_fallback_is_emitted_and_the_run_is_contaminated(self):
        choices = {"llm": choice("llm", "fallback", "gateway")}
        stream: list = []

        emitted = emit_connect(choices, stream)

        self.assertEqual(len(emitted), 1)
        self.assertEqual(list(emitted), stream)
        event = stream[0]
        self.assertEqual(event["type"], FALLBACK_EVENT_TYPE)
        self.assertEqual(event["phase"], "connect")
        self.assertIsNone(event["turn"])
        self.assertEqual(event["leg"], "llm")
        self.assertEqual(event["from"], "spark")
        self.assertEqual(event["to"], "gateway")
        self.assertEqual(event["trigger"], "breaker_open")
        # The one fact the eligibility gate reads: a fallback line exists.
        self.assertTrue(any(row["type"] == FALLBACK_EVENT_TYPE for row in stream))

        fallback_audit.assert_fallbacks_emitted(choices, stream)

    def test_a_pinned_leg_emits_the_manual_pin_trigger(self):
        choices = {"stt": choice("stt", "fallback", "assemblyai", pinned=True)}
        stream: list = []

        emit_connect(choices, stream)

        self.assertEqual(stream[0]["trigger"], "manual_pin")
        self.assertEqual((stream[0]["from"], stream[0]["to"]), ("meta", "assemblyai"))

    def test_every_fallback_chosen_at_connect_is_emitted(self):
        choices = {
            "stt": choice("stt", "fallback", "assemblyai"),
            "llm": choice("llm", "fallback", "gateway"),
            "tts": choice("tts", "primary", "assemblyai"),
        }
        stream: list = []

        emit_connect(choices, stream)

        self.assertEqual([row["leg"] for row in stream], ["stt", "llm"])
        self.assertEqual([row["phase"] for row in stream], ["connect", "connect"])
        fallback_audit.assert_fallbacks_emitted(choices, stream)


class MissingEventTests(unittest.TestCase):
    def test_a_run_that_used_a_fallback_without_its_event_is_refused(self):
        choices = {"llm": choice("llm", "fallback", "gateway")}

        with self.assertRaises(fallback_audit.MissingFallbackEvent) as caught:
            fallback_audit.assert_fallbacks_emitted(choices, [])

        self.assertEqual(caught.exception.leg, "llm")
        self.assertEqual(caught.exception.phase, "connect")
        self.assertIn("llm", str(caught.exception))
        self.assertIn("connect", str(caught.exception))
        self.assertIn(FALLBACK_EVENT_TYPE, str(caught.exception))

    def test_the_missing_event_is_named_per_leg_when_only_one_was_emitted(self):
        choices = {
            "stt": choice("stt", "fallback", "assemblyai"),
            "llm": choice("llm", "fallback", "gateway"),
        }
        stream: list = []
        emit_connect({"stt": choices["stt"]}, stream)

        with self.assertRaises(fallback_audit.MissingFallbackEvent) as caught:
            fallback_audit.assert_fallbacks_emitted(choices, stream)

        self.assertEqual(caught.exception.leg, "llm")

    def test_a_mid_turn_event_does_not_stand_in_for_the_connect_emission(self):
        choices = {"llm": choice("llm", "fallback", "gateway")}
        stream: list = []
        emit_fallback(
            cascade_writer(),
            turn_fallback(
                "llm",
                from_provider="spark",
                to_provider="gateway",
                trigger="mid_turn_failure",
                turn="turn-2",
            ),
            subject=SUBJECT,
            at_ms=1200,
            sink=stream.append,
        )

        with self.assertRaises(fallback_audit.MissingFallbackEvent):
            fallback_audit.assert_fallbacks_emitted(choices, stream)


class RefusalIsNotAFallbackTests(unittest.TestCase):
    def test_primary_rungs_emit_nothing_and_need_no_event(self):
        choices = {
            "stt": choice("stt", "primary", "meta"),
            "llm": choice("llm", "primary", "spark"),
        }
        stream: list = []

        self.assertEqual(emit_connect(choices, stream), ())
        self.assertEqual(stream, [])
        fallback_audit.assert_fallbacks_emitted(choices, stream)

    def test_a_routing_refusal_is_a_refusal_fact_not_a_fallback(self):
        decision = decide("off", CallSubject("demo-anna", kind="demo"))
        self.assertEqual(decision.disposition, "managed")

        refusal_events = [{"type": REFUSAL_EVENT_TYPE, "predicate": "routing", "reason": decision.reason}]
        fallback_audit.assert_fallbacks_emitted({}, refusal_events)
        self.assertFalse(
            any(row["type"] == FALLBACK_EVENT_TYPE for row in refusal_events)
        )

        with self.assertRaises(EventEnvelopeError) as caught:
            connect_fallback(
                "llm",
                primary="spark",
                selected="gateway",
                trigger="routing_refusal",
            )
        self.assertEqual(caught.exception.field, "trigger")
        self.assertIn("not a provider fault", str(caught.exception))

    def test_an_eligibility_refusal_is_not_contamination(self):
        refusal = {
            "type": REFUSAL_EVENT_TYPE,
            "predicate": "locale",
            "reason": "the body fixes no language",
        }

        fallback_audit.assert_fallbacks_emitted({}, [refusal])

        self.assertNotEqual(refusal["type"], FALLBACK_EVENT_TYPE)


class OneEmitterTests(unittest.TestCase):
    def test_the_audit_composes_the_one_emitter_and_builds_no_line(self):
        source = Path(fallback_audit.__file__).read_text(encoding="utf8")

        self.assertNotIn("call_scoped(", source)
        self.assertNotIn('"provider_fallback"', source)
        self.assertIn("emit_fallback(", source)

    def test_the_one_python_emission_site_is_still_one(self):
        source = Path(fallback_audit.__file__).with_name("events.py").read_text(
            encoding="utf8"
        )

        self.assertEqual(
            source.count("FALLBACK_EVENT_TYPE"),
            2,
            "one definition and one emission site; a second emitter is a review failure",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
