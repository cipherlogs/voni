"""Every turn names the providers that actually served it (ticket 108).

Seam: ``cascade.events.TurnAttribution`` and ``emit_attribution`` (built by the
one envelope writer), plus the attribution slot on
``cascade.turn_state.TurnState`` / ``TurnStateStore.attribute``.

The facts pinned here are the ones an operator reads when asking "which model
answered this turn?":

* a turn names the speech, model and voice actually used, each with its rung;
* a leg that did not run is ``null`` (a backchannel has no model);
* a fallback turn names both rungs — the provider that served and the one that
  lost;
* a managed turn records the provider table as ``N/A — vendor-owned`` and never
  a fabricated vendor name;
* attribution is keyed by the logical turn, so a reconnect cannot move it and
  one leg's fallback cannot rewrite another leg's provider;
* a turn whose attribution was never recorded says ``unmeasured`` with a named
  reason, never a guess;
* the end message's call-level provider table is derived from the turns, so a
  turn's attribution and the table cannot disagree.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from cascade.call import (
    CallEligibility,
    CallEnd,
    CostSummary,
    DrainOutcome,
    OpenedLeg,
    ProviderTable,
)
from cascade.events import (
    ATTRIBUTION_EVENT_TYPE,
    ATTRIBUTION_STATES,
    CALL_SCOPED_FIELDS,
    EVENT_SCHEMA_VERSION,
    VENDOR_OWNED,
    AttributionError,
    EventEnvelopeError,
    EventStream,
    EventWriter,
    LegAttribution,
    TurnAttribution,
    emit_attribution,
)
from cascade.sanitizer import REDACTED
from cascade.testing.clock import FakeClock
from cascade.turn_state import LogicalTurnId, TurnStateStore

SUBJECT = "demo anna (en, browser)"
MISSING = "not opened at connect"


def leg(
    name: str,
    provider: str,
    rung: str = "primary",
    *,
    reason: str = "the leg reads closed",
    from_provider: str | None = None,
) -> LegAttribution:
    return LegAttribution(
        leg=name,
        provider=provider,
        rung=rung,
        reason=reason,
        from_provider=from_provider,
    )


def cascade_writer(call_id: str = "call-108") -> EventWriter:
    return EventWriter(pipeline="cascade", call_id=call_id)


def emitted(
    stream: list,
    attribution: TurnAttribution,
    *,
    writer: EventWriter | None = None,
    at_ms: float | int = 1500,
) -> dict:
    return emit_attribution(
        writer if writer is not None else cascade_writer(),
        attribution,
        subject=SUBJECT,
        at_ms=at_ms,
        sink=stream.append,
    )


class TurnNamesTheProvidersTest(unittest.TestCase):
    def test_a_turn_names_the_speech_model_and_voice_that_served_it(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution(
                turn="0:t1",
                stt=leg("stt", "meta"),
                llm=leg("llm", "spark"),
                tts=leg("tts", "assemblyai"),
            ),
        )

        self.assertEqual(stream, [event], "the attribution reaches the call's sink")
        self.assertEqual(event["type"], ATTRIBUTION_EVENT_TYPE)
        self.assertEqual(event["turn"], "0:t1")
        self.assertEqual(event["phase"], "turn")
        self.assertEqual(event["schemaVersion"], EVENT_SCHEMA_VERSION)
        self.assertEqual(event["pipeline"], "cascade")
        self.assertEqual(tuple(event), (*CALL_SCOPED_FIELDS, "state", "providers"))
        self.assertEqual(event["state"], "measured")
        self.assertEqual(
            event["providers"],
            {
                "stt": {
                    "leg": "stt",
                    "provider": "meta",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
                "llm": {
                    "leg": "llm",
                    "provider": "spark",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
                "tts": {
                    "leg": "tts",
                    "provider": "assemblyai",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
            },
        )

    def test_the_three_states_are_the_closed_set_the_schema_names(self):
        self.assertEqual(
            {"measured", "vendor-owned", "unmeasured"}, set(ATTRIBUTION_STATES)
        )
        self.assertEqual(
            "measured", TurnAttribution(turn="0:t30", stt=leg("stt", "meta")).state
        )
        self.assertEqual("vendor-owned", TurnAttribution.managed("0:t30").state)
        self.assertEqual(
            "unmeasured", TurnAttribution.unmeasured("0:t30", "no record").state
        )


class LegThatDidNotRunTest(unittest.TestCase):
    def test_a_backchannel_turn_has_no_model_and_says_so_with_null(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution(
                turn="0:t2",
                stt=leg("stt", "meta"),
                llm=None,
                tts=leg("tts", "assemblyai"),
            ),
        )

        self.assertEqual(event["state"], "measured")
        self.assertIn(
            "llm",
            event["providers"],
            "a leg that did not run is explicit, not absent",
        )
        self.assertIsNone(event["providers"]["llm"])
        self.assertEqual(event["providers"]["stt"]["provider"], "meta")
        self.assertEqual(event["providers"]["tts"]["provider"], "assemblyai")

    def test_an_attribution_that_names_no_leg_is_refused_by_name(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution(turn="0:t3")

        self.assertEqual(caught.exception.field, "providers")
        self.assertIn("unmeasured", str(caught.exception))

    def test_a_leg_slot_cannot_carry_another_leg(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution(turn="0:t4", llm=leg("stt", "meta"))

        self.assertEqual(caught.exception.field, "leg")
        self.assertIn("llm", str(caught.exception))
        self.assertIn("stt", str(caught.exception))

    def test_an_attribution_needs_a_logical_turn(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution(turn="  ", stt=leg("stt", "meta"))

        self.assertEqual(caught.exception.field, "turn")


class FallbackTurnNamesBothRungsTest(unittest.TestCase):
    def test_a_fallback_turn_names_the_serving_and_the_losing_rung(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution(
                turn="0:t5",
                stt=leg("stt", "assemblyai", "fallback", from_provider="meta"),
                llm=leg("llm", "spark"),
                tts=leg("tts", "assemblyai"),
            ),
        )

        self.assertEqual(
            event["providers"]["stt"],
            {
                "leg": "stt",
                "provider": "assemblyai",
                "rung": "fallback",
                "from": "meta",
                "reason": "the leg reads closed",
            },
        )
        self.assertEqual(event["providers"]["llm"]["rung"], "primary")
        self.assertNotIn("from", event["providers"]["llm"])

    def test_an_unrelated_leg_never_moves_the_model_that_answered_the_turn(self):
        event = emitted(
            [],
            TurnAttribution(
                turn="0:t6",
                stt=leg("stt", "assemblyai", "fallback", from_provider="meta"),
                llm=leg("llm", "gateway", "fallback", from_provider="spark"),
                tts=leg("tts", "assemblyai"),
            ),
        )

        self.assertEqual(event["providers"]["llm"]["provider"], "gateway")
        self.assertEqual(event["providers"]["llm"]["from"], "spark")
        self.assertEqual(event["providers"]["stt"]["provider"], "assemblyai")
        self.assertEqual(event["providers"]["stt"]["from"], "meta")
        self.assertEqual(event["providers"]["tts"]["provider"], "assemblyai")
        self.assertNotIn("from", event["providers"]["tts"])

    def test_a_fallback_without_the_losing_rung_is_refused_by_name(self):
        with self.assertRaises(AttributionError) as caught:
            leg("stt", "assemblyai", "fallback")

        self.assertEqual(caught.exception.field, "from")
        self.assertIn("both rungs", str(caught.exception))

    def test_a_primary_rung_cannot_name_a_losing_rung(self):
        with self.assertRaises(AttributionError) as caught:
            leg("stt", "meta", "primary", from_provider="assemblyai")

        self.assertEqual(caught.exception.field, "from")
        self.assertIn("primary", str(caught.exception))

    def test_a_fallback_cannot_name_the_same_provider_twice(self):
        with self.assertRaises(AttributionError) as caught:
            leg("stt", "meta", "fallback", from_provider="meta")

        self.assertEqual(caught.exception.field, "from")
        self.assertIn("different", str(caught.exception))


class ManagedTurnIsVendorOwnedTest(unittest.TestCase):
    def test_a_managed_turn_records_the_table_as_vendor_owned(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution.managed("0:t7"),
            writer=EventWriter(pipeline="managed", call_id="call-108"),
        )

        self.assertEqual(event["pipeline"], "managed")
        self.assertEqual(event["state"], "vendor-owned")
        self.assertIs(event["vendorOwned"], True)
        self.assertEqual(
            {name: row["provider"] for name, row in event["providers"].items()},
            {"stt": VENDOR_OWNED, "llm": VENDOR_OWNED, "tts": VENDOR_OWNED},
        )
        self.assertEqual(VENDOR_OWNED, "N/A — vendor-owned")
        for name in ("meta", "spark", "assemblyai", "gateway"):
            self.assertNotIn(
                name, str(event["providers"]), "a vendor name is never fabricated"
            )

    def test_a_cascade_turn_cannot_claim_a_vendor_owned_table(self):
        stream: list = []
        with self.assertRaises(EventEnvelopeError) as caught:
            emitted(stream, TurnAttribution.managed("0:t8"))

        self.assertEqual(caught.exception.field, "vendorOwned")
        self.assertIn("managed", str(caught.exception))
        self.assertEqual(stream, [], "a refused attribution writes nothing")

    def test_a_managed_turn_cannot_name_a_vendor(self):
        stream: list = []
        with self.assertRaises(EventEnvelopeError) as caught:
            emitted(
                stream,
                TurnAttribution(turn="0:t9", llm=leg("llm", "spark")),
                writer=EventWriter(pipeline="managed", call_id="call-108"),
            )

        self.assertEqual(caught.exception.field, "providers")
        self.assertIn("vendor-owned", str(caught.exception))
        self.assertEqual(stream, [])

    def test_a_vendor_owned_turn_cannot_also_name_a_leg(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution(turn="0:t10", llm=leg("llm", "spark"), vendor_owned=True)

        self.assertEqual(caught.exception.field, "providers")
        self.assertIn("vendor-owned", str(caught.exception))

    def test_vendor_owned_is_a_marker_never_a_provider_name(self):
        with self.assertRaises(AttributionError) as caught:
            leg("stt", VENDOR_OWNED)

        self.assertEqual(caught.exception.field, "provider")
        self.assertIn("vendor-owned", str(caught.exception))


class UnmeasuredAttributionTest(unittest.TestCase):
    def test_a_turn_without_a_recorded_attribution_says_unmeasured_by_name(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution.unmeasured(
                "0:t11", "the reply contract never recorded which provider served it"
            ),
        )

        self.assertEqual(event["state"], "unmeasured")
        self.assertEqual(
            event["unmeasuredReason"],
            "the reply contract never recorded which provider served it",
        )
        self.assertEqual(event["providers"], {"stt": None, "llm": None, "tts": None})
        self.assertNotIn("vendorOwned", event)
        for name in ("meta", "spark", "assemblyai", "gateway"):
            self.assertNotIn(name, str(event["providers"]))
        measured = TurnAttribution(turn="0:t12", stt=leg("stt", "meta"))
        self.assertNotIn("unmeasuredReason", measured.to_payload())

    def test_an_unmeasured_attribution_must_name_its_reason(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution.unmeasured("0:t13", "  ")

        self.assertEqual(caught.exception.field, "unmeasuredReason")
        self.assertIn("named", str(caught.exception))

    def test_an_unmeasured_attribution_cannot_also_name_a_leg(self):
        with self.assertRaises(AttributionError) as caught:
            TurnAttribution(
                turn="0:t14",
                llm=leg("llm", "spark"),
                unmeasured_reason="no record",
            )

        self.assertEqual(caught.exception.field, "providers")
        self.assertIn("unmeasured", str(caught.exception))


class AttributionKeyedByLogicalTurnTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.attribution = TurnAttribution(
            turn="0:t1", stt=leg("stt", "meta"), tts=leg("tts", "assemblyai")
        )

    def test_the_attribution_slot_hangs_off_the_logical_turn(self):
        turn = self.turns.open("t1")

        recorded = self.turns.attribute(self.attribution, turn="t1")

        self.assertIs(turn, recorded)
        self.assertIs(self.attribution, turn.providers)
        self.assertIs(self.attribution, turn.provider_attribution())

    def test_a_turn_with_no_recorded_attribution_is_unmeasured_by_name(self):
        turn = self.turns.open("t1")

        record = turn.provider_attribution()

        self.assertEqual("unmeasured", record.state)
        self.assertEqual("0:t1", record.turn)
        self.assertEqual({"stt": None, "llm": None, "tts": None}, record.to_payload()["providers"])
        self.assertIn("0:t1", record.to_payload()["unmeasuredReason"])
        self.assertIsNone(turn.providers, "an unmeasured turn invents no provider")

    def test_the_attribution_survives_a_reconnect_that_rebinds_the_provider_id(self):
        turn = self.turns.open("t1")
        self.turns.attribute(self.attribution, turn=turn)

        self.clock.advance(30)
        self.turns.new_epoch(source="meta")
        rebound = self.turns.bind("t9", turn)

        self.assertEqual(LogicalTurnId(0, "t1"), rebound)
        self.assertEqual("0:t1", turn.id.event_id)
        self.assertIs(self.attribution, turn.provider_attribution())
        self.assertEqual("meta", turn.attribution_history[0].source)
        self.assertEqual("t9", turn.attribution.provider_turn_id)

    def test_a_replayed_speech_start_after_a_reconnect_keeps_the_attribution(self):
        turn = self.turns.open("t1")
        self.turns.attribute(self.attribution, turn=turn)

        self.turns.new_epoch()
        self.turns.bind("t9", turn)
        replayed = self.turns.open("t9", epoch=1)

        self.assertIs(turn, replayed)
        self.assertEqual(2, turn.speech_starts)
        self.assertIs(self.attribution, turn.provider_attribution())

    def test_an_attribution_cannot_be_recorded_on_another_turn(self):
        one = self.turns.open("t1")
        two = self.turns.open("t2")

        with self.assertRaises(AttributionError) as caught:
            self.turns.attribute(self.attribution, turn=two)

        self.assertEqual(caught.exception.field, "turn")
        self.assertIn("0:t1", str(caught.exception))
        self.assertIn("0:t2", str(caught.exception))
        self.assertIsNone(two.providers)
        self.assertIsNone(one.providers)

    def test_an_attribution_from_a_replaced_session_is_ignored(self):
        turn = self.turns.open("t1")
        self.turns.new_epoch()

        recorded = self.turns.attribute(self.attribution, turn=turn, epoch=0)

        self.assertIsNone(recorded)
        self.assertIsNone(turn.providers)

    def test_the_reply_leg_can_be_attributed_after_the_turn_closed(self):
        turn = self.turns.open("t1")
        self.turns.close(turn, reason="replied")

        recorded = self.turns.attribute(
            TurnAttribution(turn=turn.id, stt=leg("stt", "meta"), llm=leg("llm", "spark")),
            turn=turn.id,
        )

        self.assertIs(turn, recorded)
        self.assertEqual("spark", recorded.provider_attribution().llm.provider)

    def test_a_logical_turn_id_is_its_own_stable_key(self):
        turn = self.turns.open("t1")

        self.assertEqual("0:t1", turn.id.event_id)
        self.assertEqual("0:t1", TurnAttribution(turn=turn.id, stt=leg("stt", "meta")).turn)


class CallProviderTableDerivesFromTurnsTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")

    def attributed_turn(self, provider_id: str, *, llm: str = "spark") -> object:
        turn = self.turns.open(provider_id)
        self.turns.finalise(f"caller words for {provider_id}", turn=turn)
        self.turns.attribute(
            TurnAttribution(
                turn=turn.id,
                stt=leg("stt", "meta"),
                llm=leg("llm", llm) if llm else None,
                tts=leg("tts", "assemblyai"),
            ),
            turn=turn,
        )
        return turn

    def test_a_clean_call_derives_the_same_table_it_opened(self):
        self.attributed_turn("t1")
        self.attributed_turn("t2")

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual(
            table,
            ProviderTable.from_opened(
                [
                    OpenedLeg("stt", "meta", "primary", "the leg reads closed"),
                    OpenedLeg("llm", "spark", "primary", "the leg reads closed"),
                    OpenedLeg("tts", "assemblyai", "primary", "the leg reads closed"),
                ],
                missing_reason=MISSING,
            ),
        )
        self.assertEqual(
            table.to_document(),
            {
                "stt": {
                    "provider": "meta",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
                "llm": {
                    "provider": "spark",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
                "tts": {
                    "provider": "assemblyai",
                    "rung": "primary",
                    "reason": "the leg reads closed",
                },
            },
        )

    def test_the_end_message_table_is_the_derived_table(self):
        last = self.attributed_turn("t1")
        table = self.turns.provider_table(missing_reason=MISSING)
        end = CallEnd(
            call_id="call-108",
            metrics={},
            providers=table,
            cost=CostSummary.unmeasured("no cost meter is wired"),
            eligibility=CallEligibility("cascade"),
            turns=1,
            ended_by="stop",
            drain=DrainOutcome(True),
        )

        document = end.to_document()
        self.assertEqual(document["providers"], table.to_document())
        for name in ("stt", "llm", "tts"):
            recorded = last.provider_attribution().leg(name)
            self.assertEqual(document["providers"][name]["provider"], recorded.provider)
            self.assertEqual(document["providers"][name]["rung"], recorded.rung)

    def test_a_backchannel_turn_does_not_erase_the_model_from_the_table(self):
        self.attributed_turn("t1")
        self.attributed_turn("t2", llm="")

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual("spark", table.to_document()["llm"]["provider"])
        self.assertIsNone(self.turns.get("t2").provider_attribution().llm)

    def test_a_leg_that_never_ran_is_null_with_the_missing_reason(self):
        self.attributed_turn("t1", llm="")

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual(
            {"provider": None, "rung": None, "reason": MISSING},
            table.to_document()["llm"],
        )

    def test_a_mid_call_fallback_moves_the_row_and_the_last_turn_matches(self):
        self.attributed_turn("t1")
        fallback = self.turns.open("t2")
        self.turns.attribute(
            TurnAttribution(
                turn=fallback.id,
                stt=leg("stt", "meta"),
                llm=leg("llm", "gateway", "fallback", from_provider="spark"),
                tts=leg("tts", "assemblyai"),
            ),
            turn=fallback,
        )

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual(
            {"provider": "gateway", "rung": "fallback", "reason": "the leg reads closed"},
            table.to_document()["llm"],
        )
        self.assertEqual(
            "spark", fallback.provider_attribution().leg("llm").from_provider
        )

    def test_an_unmeasured_turn_contributes_no_provider(self):
        self.attributed_turn("t1")
        unattributed = self.turns.open("t2")

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual("unmeasured", unattributed.provider_attribution().state)
        self.assertEqual("meta", table.to_document()["stt"]["provider"])

    def test_a_managed_call_derives_a_vendor_owned_table(self):
        turn = self.turns.open("t1")
        self.turns.attribute(TurnAttribution.managed(turn.id), turn=turn)

        table = self.turns.provider_table(missing_reason=MISSING)

        self.assertEqual(
            {name: VENDOR_OWNED for name in ("stt", "llm", "tts")},
            {name: row["provider"] for name, row in table.to_document().items()},
        )
        self.assertEqual({name: None for name in ("stt", "llm", "tts")},
                         {name: row["rung"] for name, row in table.to_document().items()})

    def test_a_missing_reason_is_required_not_defaulted(self):
        with self.assertRaises(TypeError):
            self.turns.provider_table()  # type: ignore[call-arg]

        with self.assertRaises(ValueError):
            self.turns.provider_table(missing_reason="  ")


class OneWriterTest(unittest.TestCase):
    def test_every_attribution_is_built_by_the_one_envelope_writer(self):
        stream: list = []
        event = emitted(
            stream,
            TurnAttribution(turn="0:t20", stt=leg("stt", "meta")),
        )

        self.assertEqual(tuple(event), (*CALL_SCOPED_FIELDS, "state", "providers"))
        self.assertEqual(event["schemaVersion"], EVENT_SCHEMA_VERSION)
        self.assertEqual(event["callId"], "call-108")
        self.assertEqual(event["subject"], SUBJECT)
        source = (Path(__file__).with_name("events.py")).read_text(encoding="utf8")
        self.assertEqual(
            source.count("ATTRIBUTION_EVENT_TYPE"),
            2,
            "one definition and one emission site; a second emitter is a review failure",
        )

    def test_an_attribution_line_runs_the_shared_sanitizer_before_write(self):
        lines: list[str] = []
        writer = cascade_writer("call-108")
        stream = EventStream(writer, sink=lines.append)

        emit_attribution(
            writer,
            TurnAttribution(
                turn="0:t21",
                stt=leg("stt", "meta", reason="retry wss://user:pw@vendor.example/ws"),
            ),
            subject=SUBJECT,
            at_ms=900,
            sink=stream,
        )

        line = json.loads(lines[0])
        self.assertEqual(line["type"], ATTRIBUTION_EVENT_TYPE)
        self.assertEqual(line["turn"], "0:t21")
        self.assertEqual(
            line["providers"]["stt"]["reason"],
            f"retry wss://{REDACTED}@vendor.example/ws",
        )
        self.assertNotIn("user:pw", lines[0])


class AttributionNeverBorrowsAnotherLegOrTurnTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")

    def test_one_legs_fallback_does_not_rewrite_another_turns_model(self):
        one = self.turns.open("t1")
        self.turns.attribute(
            TurnAttribution(turn=one.id, stt=leg("stt", "meta"), llm=leg("llm", "spark")),
            turn=one,
        )

        two = self.turns.open("t2")
        self.turns.attribute(
            TurnAttribution(
                turn=two.id,
                stt=leg("stt", "assemblyai", "fallback", from_provider="meta"),
                llm=leg("llm", "spark"),
            ),
            turn=two,
        )

        self.assertEqual("spark", one.provider_attribution().llm.provider)
        self.assertEqual("primary", one.provider_attribution().llm.rung)
        self.assertEqual("meta", one.provider_attribution().stt.provider)
        self.assertEqual("assemblyai", two.provider_attribution().stt.provider)

    def test_a_fallback_inside_one_turn_replaces_that_turns_snapshot(self):
        turn = self.turns.open("t1")
        self.turns.attribute(
            TurnAttribution(turn=turn.id, stt=leg("stt", "meta"), llm=leg("llm", "spark")),
            turn=turn,
        )

        latest = TurnAttribution(
            turn=turn.id,
            stt=leg("stt", "meta"),
            llm=leg("llm", "gateway", "fallback", from_provider="spark"),
        )
        self.turns.attribute(latest, turn=turn)

        self.assertIs(latest, turn.providers, "one record per turn; the newest snapshot wins")
        table = self.turns.provider_table(missing_reason=MISSING)
        self.assertEqual("gateway", table.to_document()["llm"]["provider"])
        self.assertEqual("fallback", table.to_document()["llm"]["rung"])


if __name__ == "__main__":
    unittest.main()
