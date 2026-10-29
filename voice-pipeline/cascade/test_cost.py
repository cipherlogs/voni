"""Contract tests for the named rate table and reproducible cost (ticket 101).

Seam: ``cascade.cost`` — ``load_rate_table`` for the committed record and
``cost_call`` for a priced :class:`cascade.usage.CallUsage`. Nothing here
reaches into the loader's private helpers, so the record's storage can change
without rewriting a consumer.

Every expected amount is computed by hand from the vendor's published price
(an independent source), never by re-running the cost arithmetic in the test.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from cascade import cost, usage
from cascade.assemblyai_tts import Billing
from cascade.usage import UsageMeter

V1 = Path(cost.RATES_DIR) / "v1.json"


def table_with(tmp: str, mutate) -> cost.RateTable:
    """A copy of the shipped v1 record, changed by ``mutate`` and loaded."""
    record = json.loads(V1.read_text(encoding="utf-8"))
    mutate(record)
    path = Path(tmp) / f"v{record['version']}.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return cost.load_rate_table(path=path)


class RateTableRecordTests(unittest.TestCase):
    def test_every_metered_unit_is_named_with_its_source_and_date(self):
        table = cost.load_rate_table()

        self.assertEqual(table.name, "cascade-vendor-rates")
        self.assertEqual(table.version, 1)
        self.assertEqual(table.currency, "USD")
        self.assertRegex(table.date, r"^\d{4}-\d{2}-\d{2}$")

        expected = {
            *(f"stt.{name}" for name in usage.STT_UNITS),
            *(f"llm.{name}" for name in usage.TOKEN_UNITS),
            *(f"tts.{name}" for name in usage.TTS_UNITS),
        }
        self.assertEqual(set(table.keys()), expected)

        for rate in table.rates():
            with self.subTest(rate=rate.key):
                self.assertEqual(rate.key, f"{rate.leg}.{rate.unit}")
                self.assertTrue(rate.source.strip(), "a rate must state its source")
                self.assertTrue(
                    rate.url.startswith("https://"),
                    "a rate must cite the vendor price page",
                )
                self.assertRegex(rate.date, r"^\d{4}-\d{2}-\d{2}$")
                self.assertFalse(rate.open, "every shipped unit has a sourced rate")

    def test_the_shipped_v1_prices_are_pinned_to_their_source(self):
        table = cost.load_rate_table(version=1)

        self.assertEqual(table.version, 1)
        self.assertEqual(
            {rate.key: format(rate.usd_per_unit, "f") for rate in table.rates()},
            {
                # Meta: $0.18/audio-hour; $1.25/$4.25/$0.15 per 1M tokens.
                "stt.audio_seconds": "0.00005",
                "llm.prompt_tokens": "0.00000125",
                "llm.cached_tokens": "0.00000015",
                "llm.completion_tokens": "0.00000425",
                "llm.reasoning_tokens": "0.00000425",
                # AssemblyAI: $15 per 1M input characters; seconds not billed.
                "tts.characters": "0.000015",
                "tts.audio_seconds": "0",
                "tts.session_seconds": "0",
            },
        )


class RateProvenanceTests(unittest.TestCase):
    def test_a_priced_rate_without_a_source_or_a_date_is_refused(self):
        for field in ("source", "date", "url"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                record = json.loads(V1.read_text(encoding="utf-8"))
                del record["rates"]["stt.audio_seconds"][field]
                path = Path(tmp) / "v1.json"
                path.write_text(json.dumps(record), encoding="utf-8")

                with self.assertRaises(cost.RateTableError) as caught:
                    cost.load_rate_table(path=path)

                self.assertIn("stt.audio_seconds", str(caught.exception))
                self.assertIn(field, str(caught.exception))

    def test_an_open_rate_refuses_by_name_instead_of_defaulting(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = json.loads(V1.read_text(encoding="utf-8"))
            entry = record["rates"]["tts.characters"]
            entry["usd_per_unit"] = None
            entry["note"] = (
                "OPEN — no published assemblyai-tts-1 character price is recorded"
            )
            for field in ("source", "url", "date"):
                entry.pop(field, None)
            path = Path(tmp) / "v1.json"
            path.write_text(json.dumps(record), encoding="utf-8")
            table = cost.load_rate_table(path=path)

            self.assertTrue(table.get("tts.characters").open)
            with self.assertRaises(cost.OpenRateError) as caught:
                table.require("tts.characters")
            self.assertEqual(caught.exception.key, "tts.characters")
            self.assertIn("tts.characters", str(caught.exception))
            self.assertIn("OPEN", str(caught.exception))

    def test_an_unknown_rate_refuses_by_name_and_lists_the_declared_ones(self):
        table = cost.load_rate_table()

        with self.assertRaises(cost.UnknownRateError) as caught:
            table.require("llm.total_tokens")

        self.assertIn("llm.total_tokens", str(caught.exception))
        self.assertIn("llm.prompt_tokens", str(caught.exception))


def known_call_usage() -> usage.CallUsage:
    """One call's recorded vendor units, all measured.

    Hand-worked cost (USD), from the vendor prices in ``cascade/rates/v1.json``:
      stt   90 s            * 0.18/3600        = 0.0045
      llm   prompt 1,000,000, cached 250,000:
            750,000 * 1.25/1M                 = 0.9375
            250,000 * 0.15/1M                 = 0.0375
      llm   completion 200,000, reasoning 50,000:
            150,000 * 4.25/1M                 = 0.6375
             50,000 * 4.25/1M                 = 0.2125
      tts   1,000 chars * 15/1M               = 0.015
            audio and session seconds         = 0 (billed per character)
      total                                   = 1.8445
    """
    meter = UsageMeter()
    meter.record_llm(
        "turn-1",
        {
            "prompt_tokens": 1_000_000,
            "completion_tokens": 200_000,
            "total_tokens": 1_200_000,
            "prompt_tokens_details": {"cached_tokens": 250_000},
            "completion_tokens_details": {"reasoning_tokens": 50_000},
        },
    )
    meter.record_stt({"audio_duration_seconds": 90})
    meter.record_tts(
        Billing(
            characters=1_000,
            measured=True,
            source="Termination.billed_characters",
            total_input_char_length=1_040,
            audio_duration_seconds=3.2,
            session_duration_seconds=4,
        )
    )
    return meter.usage()


class KnownCallCostTests(unittest.TestCase):
    def test_a_known_calls_cost_is_computed_from_recorded_units(self):
        priced = cost.cost_call(known_call_usage())

        self.assertTrue(priced.measured)
        self.assertEqual(priced.leg("stt").amount, Decimal("0.0045"))
        self.assertEqual(priced.leg("llm").amount, Decimal("1.825"))
        self.assertEqual(priced.leg("tts").amount, Decimal("0.015"))
        self.assertEqual(priced.amount, Decimal("1.8445"))

    def test_cached_and_reasoning_tokens_are_priced_once_not_twice(self):
        priced = cost.cost_call(known_call_usage())
        lines = {line.rate: line for line in priced.leg("llm").lines}

        # The reported prompt is charged net of its cached detail, and the
        # cached tokens are charged on their own line.
        self.assertEqual(lines["llm.prompt_tokens"].reported, 1_000_000)
        self.assertEqual(lines["llm.prompt_tokens"].billed, 750_000)
        self.assertEqual(lines["llm.cached_tokens"].billed, 250_000)
        # Reasoning is a detail of completion, for the same reason.
        self.assertEqual(lines["llm.completion_tokens"].billed, 150_000)
        self.assertEqual(lines["llm.reasoning_tokens"].billed, 50_000)

    def test_every_cost_cites_the_rate_table_version_and_currency(self):
        priced = cost.cost_call(known_call_usage())
        document = priced.to_document()

        self.assertEqual(
            document["rateTable"],
            {"name": "cascade-vendor-rates", "version": 1, "currency": "USD"},
        )
        self.assertEqual(document["amount"], "1.8445")
        self.assertEqual(document["legs"]["llm"]["amount"], "1.825")
        self.assertEqual(
            document["legs"]["tts"]["lines"][0],
            {
                "rate": "tts.characters",
                "reported": 1_000,
                "billed": 1_000,
                "amount": "0.015",
            },
        )


class UnmeasuredCostTests(unittest.TestCase):
    def test_an_absent_vendor_unit_makes_the_whole_cost_unmeasured(self):
        meter = UsageMeter()
        # An interrupted stream: the turn is recorded with no usage chunk.
        meter.record_llm("turn-1", None)
        meter.record_stt({"audio_duration_seconds": 90})
        meter.record_tts(
            Billing(
                characters=1_000,
                measured=True,
                source="Termination.billed_characters",
                audio_duration_seconds=3.2,
                session_duration_seconds=4,
            )
        )

        priced = cost.cost_call(meter.usage())

        self.assertFalse(priced.measured)
        self.assertIsNone(priced.amount)
        self.assertIsNone(priced.leg("llm").amount)
        # The measured legs keep their own cost; only the total refuses.
        self.assertEqual(priced.leg("stt").amount, Decimal("0.0045"))
        self.assertEqual(priced.leg("tts").amount, Decimal("0.015"))
        self.assertIn("llm.prompt_tokens", " ".join(priced.reasons))
        with self.assertRaises(cost.UnmeasuredCostError) as caught:
            priced.require_amount()
        self.assertIn("llm.prompt_tokens", str(caught.exception))

        document = priced.to_document()
        self.assertFalse(document["measured"])
        self.assertIsNone(document["amount"])
        self.assertIsNone(document["legs"]["llm"]["amount"])

    def test_a_leg_the_meter_never_recorded_is_unmeasured_not_zero(self):
        empty = cost.cost_call(
            usage.CallUsage(
                legs=(
                    ("stt", usage.Units()),
                    ("llm", usage.Units()),
                    ("tts", usage.Units()),
                )
            )
        )

        self.assertFalse(empty.measured)
        self.assertIsNone(empty.amount)
        for leg in ("stt", "llm", "tts"):
            self.assertIsNone(empty.leg(leg).amount)
            self.assertIn("no units", " ".join(empty.leg(leg).reasons))


class IncompleteTableTests(unittest.TestCase):
    def test_a_unit_the_table_does_not_price_makes_the_total_unmeasured(self):
        with tempfile.TemporaryDirectory() as tmp:
            table = table_with(
                tmp, lambda record: record["rates"].pop("tts.characters")
            )
        priced = cost.cost_call(known_call_usage(), table=table)

        self.assertFalse(priced.measured)
        self.assertIsNone(priced.amount)
        self.assertIsNone(priced.leg("tts").amount)
        self.assertEqual(priced.leg("tts").lines, ())
        self.assertEqual(priced.leg("stt").amount, Decimal("0.0045"))
        reasons = " ".join(priced.reasons)
        self.assertIn("declares no rate for tts.characters", reasons)
        with self.assertRaises(cost.UnmeasuredCostError) as caught:
            priced.require_amount()
        self.assertIn("tts.characters", str(caught.exception))
        self.assertIsNone(priced.to_document()["amount"])

    def test_an_open_rate_makes_the_total_unmeasured_and_names_itself(self):
        def open_characters(record: dict) -> None:
            entry = record["rates"]["tts.characters"]
            entry["usd_per_unit"] = None
            entry["note"] = "OPEN — no published character price is recorded"
            for field in ("source", "url", "date"):
                entry.pop(field)

        with tempfile.TemporaryDirectory() as tmp:
            table = table_with(tmp, open_characters)
        priced = cost.cost_call(known_call_usage(), table=table)

        self.assertFalse(priced.measured)
        self.assertIsNone(priced.amount)
        self.assertIsNone(priced.leg("tts").amount)
        reasons = " ".join(priced.reasons)
        self.assertIn("OPEN", reasons)
        self.assertIn("tts.characters", reasons)


class ReproducibleCostTests(unittest.TestCase):
    def test_the_same_recorded_units_always_produce_the_same_cost(self):
        recorded = known_call_usage()

        first = cost.cost_call(recorded).to_document()
        second = cost.cost_call(recorded).to_document()

        self.assertEqual(first, second)
        self.assertEqual(first["amount"], "1.8445")

    def test_a_price_change_is_a_new_version_and_an_old_cost_keeps_its_own(self):
        old = cost.cost_call(known_call_usage())

        def double_stt(record: dict) -> None:
            record["version"] = 2
            record["date"] = "2026-11-01"
            record["rates"]["stt.audio_seconds"]["usd_per_unit"] = "0.0001"

        with tempfile.TemporaryDirectory() as tmp:
            new_table = table_with(tmp, double_stt)
            new = cost.cost_call(known_call_usage(), table=new_table)

        self.assertEqual(new.table.version, 2)
        self.assertEqual(new.leg("stt").amount, Decimal("0.009"))
        self.assertEqual(new.amount, Decimal("1.849"))
        self.assertEqual(new.to_document()["rateTable"]["version"], 2)
        # The v1 cost is unchanged: a price change never rewrites history.
        self.assertEqual(old.table.version, 1)
        self.assertEqual(old.amount, Decimal("1.8445"))
        self.assertEqual(old.to_document()["rateTable"]["version"], 1)

    def test_the_same_call_does_not_get_a_different_cost_from_a_second_read(self):
        table = cost.load_rate_table()

        self.assertEqual(table.version, cost.RATE_TABLE.version)
        self.assertEqual(
            cost.cost_call(known_call_usage(), table=table).to_document(),
            cost.cost_call(known_call_usage(), table=cost.RATE_TABLE).to_document(),
        )

    def test_a_detail_larger_than_its_parent_is_refused_by_name(self):
        meter = UsageMeter()
        meter.record_llm(
            "turn-1",
            {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
                "prompt_tokens_details": {"cached_tokens": 64},
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        )
        priced = cost.cost_call(meter.usage())

        # cached_tokens (64) cannot be a detail of a 10-token prompt: the
        # vendor's numbers contradict each other, so no cost is invented.
        self.assertFalse(priced.measured)
        self.assertIsNone(priced.leg("llm").amount)
        reasons = " ".join(priced.reasons)
        self.assertIn("cached_tokens", reasons)
        self.assertIn("prompt_tokens", reasons)


class RateArithmeticTests(unittest.TestCase):
    def test_a_rate_prices_one_wire_unit_exactly(self):
        table = cost.load_rate_table()

        self.assertEqual(table.price("stt.audio_seconds", 90), Decimal("0.0045"))
        self.assertEqual(table.price("llm.prompt_tokens", 1_000_000), Decimal("1.25"))
        self.assertEqual(table.price("tts.characters", 1_000), Decimal("0.015"))

    def test_seconds_the_vendor_does_not_bill_are_a_sourced_zero_not_an_absence(self):
        priced = cost.cost_call(known_call_usage())
        tts = priced.leg("tts")
        lines = {line.rate: line for line in tts.lines}

        self.assertEqual(lines["tts.audio_seconds"].billed, 3.2)
        self.assertEqual(lines["tts.audio_seconds"].amount, Decimal(0))
        self.assertEqual(lines["tts.session_seconds"].amount, Decimal(0))
        self.assertTrue(tts.measured)
        self.assertEqual(priced.to_document()["legs"]["tts"]["lines"][1]["amount"], "0")

    def test_the_artifact_records_every_quantity_the_cost_was_made_from(self):
        priced = cost.cost_call(known_call_usage())
        document = priced.to_document()
        table = cost.load_rate_table()

        total = Decimal(0)
        for leg_document in document["legs"].values():
            leg_total = Decimal(0)
            for line in leg_document["lines"]:
                self.assertEqual(
                    Decimal(line["amount"]),
                    table.price(line["rate"], line["billed"]),
                )
                self.assertIsNotNone(line["reported"])
                leg_total += Decimal(line["amount"])
            self.assertEqual(Decimal(leg_document["amount"]), leg_total)
            total += leg_total
        self.assertEqual(Decimal(document["amount"]), total)


class RecordIntegrityTests(unittest.TestCase):
    def test_a_duplicate_rate_is_refused_instead_of_one_silently_winning(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "v1.json"
            path.write_text(
                '{"schema": 1, "name": "x", "version": 1, "currency": "USD", '
                '"date": "2026-10-29", "rates": {'
                '"stt.audio_seconds": {}, "stt.audio_seconds": {}}}',
                encoding="utf-8",
            )

            with self.assertRaises(cost.RateTableError) as caught:
                cost.load_rate_table(path=path)
            self.assertIn("stt.audio_seconds", str(caught.exception))

    def test_asking_for_a_version_the_record_is_not_refuses_by_name(self):
        def bump(record: dict) -> None:
            record["version"] = 2

        with tempfile.TemporaryDirectory() as tmp:
            table_with(tmp, bump)
            path = Path(tmp) / "v2.json"

            with self.assertRaises(cost.RateTableError) as caught:
                cost.load_rate_table(version=1, path=path)
            self.assertIn("version", str(caught.exception))

    def test_an_open_rate_must_say_why_it_is_open(self):
        def silent_open(record: dict) -> None:
            entry = record["rates"]["tts.characters"]
            entry["usd_per_unit"] = None
            entry["note"] = ""
            for field in ("source", "url", "date"):
                entry.pop(field)

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(cost.RateTableError) as caught:
                table_with(tmp, silent_open)
            self.assertIn("OPEN", str(caught.exception))
            self.assertIn("why", str(caught.exception))

    def test_a_negative_rate_is_refused(self):
        def negative(record: dict) -> None:
            record["rates"]["stt.audio_seconds"]["usd_per_unit"] = "-0.00005"

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(cost.RateTableError) as caught:
                table_with(tmp, negative)
            self.assertIn("negative", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
