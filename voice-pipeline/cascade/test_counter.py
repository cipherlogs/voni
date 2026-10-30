"""The durable daily counter: one UTC bucket, atomic, shared (ticket 102).

Seam: ``cascade.counter`` — ``day_key`` for the bucket boundary, and
:class:`counter.DailyCounter` over a :class:`cascade.store.DurableStore`.

Charges are ticket 101's :class:`cascade.cost.CallCost` values, never a test's
guess at a price: the one integration test prices real ticket 100 units and the
expected amount is hand-worked from the vendor rate table.

Expected spend values are written as literals from the ticket's policy (80% and
100% of a 25 USD cap), never recomputed with the code under test.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from decimal import Decimal
from pathlib import Path

from cascade import cost, counter, thresholds
from cascade.assemblyai_tts import Billing
from cascade.cost import CallCost, LegCost
from cascade.store import MemoryStore, SqliteStore, StoreUnavailable, StoredDocument
from cascade.usage import UsageMeter

# One second either side of the 2026-10-31 UTC boundary.
BEFORE_MIDNIGHT = 1_793_404_799.0
MIDNIGHT = 1_793_404_800.0
NOON = 1_793_361_600.0


def run(coro):
    return asyncio.run(coro)


def measured(amount: str, leg: str = "stt") -> CallCost:
    """A priced call whose one leg cost ``amount`` USD (ticket 101's shape)."""
    return CallCost(cost.RATE_TABLE, (LegCost(leg, Decimal(amount)),))


def unmeasured(reason: str = "the vendor did not report it") -> CallCost:
    """A cost ticket 101 could not price: no leg measured."""
    return CallCost(cost.RATE_TABLE, (LegCost("tts", None, reasons=(reason,)),))


class RacyStore(MemoryStore):
    """A memory store that yields between a read and its compare-and-set.

    Without this, two ``asyncio`` charges never interleave and the atomicity
    assertion would pass even if the counter ignored its compare-and-set.
    """

    async def compare_and_set(self, key, expected_version, stored):
        await asyncio.sleep(0)
        return await super().compare_and_set(key, expected_version, stored)


class DayKeyTests(unittest.TestCase):
    def test_a_day_key_is_the_utc_calendar_date(self):
        self.assertEqual(counter.day_key(0), "1970-01-01")
        self.assertEqual(counter.day_key(NOON), "2026-10-30")
        self.assertEqual(counter.day_key(MIDNIGHT), "2026-10-31")

    def test_the_last_second_of_a_utc_day_belongs_to_that_day(self):
        self.assertEqual(counter.day_key(BEFORE_MIDNIGHT), "2026-10-30")
        self.assertEqual(counter.day_key(MIDNIGHT), "2026-10-31")

    def test_the_bucket_does_not_follow_the_host_timezone(self):
        # 2026-10-31T00:00:00Z is still 2026-10-30 in New York; a local-date
        # bucket would put this charge on the wrong day for any non-UTC host.
        original = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "America/New_York"
            time.tzset()
            self.assertEqual(counter.day_key(MIDNIGHT), "2026-10-31")
        finally:
            if original is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original
            time.tzset()

    def test_the_boundary_comes_from_the_threshold_registry(self):
        self.assertEqual(thresholds.lookup("budget.day_boundary"), "UTC")
        daily = counter.DailyCounter(MemoryStore())
        self.assertEqual(daily.boundary, "UTC")
        self.assertEqual(daily.day_key(NOON), "2026-10-30")

    def test_a_boundary_other_than_utc_is_refused_by_name(self):
        with self.assertRaises(counter.UnsupportedDayBoundary) as caught:
            counter.DailyCounter(MemoryStore(), boundary="Europe/Berlin")
        self.assertIn("Europe/Berlin", str(caught.exception))

        with self.assertRaises(counter.UnsupportedDayBoundary):
            counter.day_key(NOON, boundary="local")

    def test_the_record_key_names_the_day(self):
        self.assertEqual(counter.record_key("2026-10-30"), "budget.daily:2026-10-30")


class LimitsTests(unittest.TestCase):
    def test_the_cap_and_both_lines_come_from_the_registry(self):
        daily = counter.DailyCounter(MemoryStore())

        self.assertEqual(daily.cap, Decimal("25"))
        self.assertEqual(daily.managed_ratio, Decimal("0.8"))
        self.assertEqual(daily.refuse_ratio, Decimal("1.0"))

    def test_an_open_cap_is_refused_by_name_not_defaulted(self):
        open_cap = thresholds.Bound(
            name="budget.daily_cap",
            unit="usd",
            gate="budget.daily-cap",
            ticket="103",
            value=None,
            source="",
            date="",
        )
        registry = thresholds.Registry(
            {
                "budget.daily_cap": open_cap,
                "budget.day_boundary": thresholds.bound("budget.day_boundary"),
                "budget.route_managed_ratio": thresholds.bound(
                    "budget.route_managed_ratio"
                ),
                "budget.refuse_cascade_ratio": thresholds.bound(
                    "budget.refuse_cascade_ratio"
                ),
            }
        )

        with self.assertRaises(thresholds.UnsetBoundError) as caught:
            counter.DailyCounter(MemoryStore(), registry=registry)
        self.assertEqual(caught.exception.name, "budget.daily_cap")

    def test_a_limit_that_cannot_be_used_is_refused(self):
        for kwargs in (
            {"cap": "0"},
            {"cap": "-1"},
            {"managed_ratio": "1.2"},
            {"refuse_ratio": "0"},
            {"managed_ratio": "0.9", "refuse_ratio": "0.8"},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    counter.DailyCounter(MemoryStore(), **kwargs)


class SharedTotalTests(unittest.TestCase):
    def test_an_unwritten_day_reads_as_no_spend(self):
        store = MemoryStore()
        daily = counter.DailyCounter(store)

        budget = run(daily.snapshot(at=NOON))

        self.assertEqual(budget.day, "2026-10-30")
        self.assertEqual(budget.spent, Decimal("0"))
        self.assertEqual(budget.committed, Decimal("0"))
        self.assertEqual(budget.ratio, Decimal("0"))
        self.assertFalse(budget.would_route_managed)
        self.assertFalse(budget.would_refuse_cascade)
        self.assertIsNone(budget.version)

    def test_two_instances_read_one_total(self):
        store = MemoryStore()
        first = counter.DailyCounter(store)
        second = counter.DailyCounter(store)

        async def scenario():
            await first.charge(measured("3.5"), at=NOON)
            return await second.snapshot(at=NOON)

        budget = run(scenario())
        self.assertEqual(budget.spent, Decimal("3.5"))
        self.assertEqual(budget.version, 1)

    def test_a_failed_read_raises_and_never_reads_as_zero(self):
        store = MemoryStore()
        store.fail_reads = True
        daily = counter.DailyCounter(store)

        with self.assertRaises(StoreUnavailable):
            run(daily.snapshot(at=NOON))
        with self.assertRaises(StoreUnavailable):
            run(daily.ratio(at=NOON))
        with self.assertRaises(StoreUnavailable):
            run(daily.would_route_managed(at=NOON))
        with self.assertRaises(StoreUnavailable):
            run(daily.would_refuse_cascade(at=NOON))

    def test_a_failed_write_never_claims_the_charge_landed(self):
        store = MemoryStore()
        store.fail_writes = True

        with self.assertRaises(StoreUnavailable):
            run(counter.DailyCounter(store).charge(measured("1"), at=NOON))

    def test_a_corrupt_record_is_refused_not_read_as_zero(self):
        store = MemoryStore(
            {
                "budget.daily:2026-10-30": StoredDocument(
                    1, {"recordVersion": 1, "day": "2026-10-30", "spent": "free"}
                )
            }
        )

        with self.assertRaises(counter.CounterCorrupt):
            run(counter.DailyCounter(store).snapshot(at=NOON))

    def test_an_unknown_record_version_is_refused(self):
        store = MemoryStore(
            {
                "budget.daily:2026-10-30": StoredDocument(
                    1,
                    {
                        "recordVersion": 99,
                        "day": "2026-10-30",
                        "spent": "1",
                        "reserved": {},
                        "unmeasured": [],
                        "crossed": [],
                    },
                )
            }
        )

        with self.assertRaises(counter.UnsupportedCounterVersion):
            run(counter.DailyCounter(store).snapshot(at=NOON))

    def test_a_durable_store_is_shared_across_instances(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "counter.sqlite"
            first = counter.DailyCounter(SqliteStore(path))
            second = counter.DailyCounter(SqliteStore(path))

            async def scenario():
                await first.charge(measured("2.25"), at=NOON)
                return await second.snapshot(at=NOON)

            self.assertEqual(run(scenario()).spent, Decimal("2.25"))


class FakeClock:
    def __init__(self, at: float) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at

    def advance_to(self, at: float) -> None:
        self.at = at


class AtomicCrossingTests(unittest.TestCase):
    def test_simultaneous_charges_sum_and_cross_each_line_once(self):
        store = RacyStore()
        first = counter.DailyCounter(store)
        second = counter.DailyCounter(store)

        async def scenario():
            results = await asyncio.gather(
                first.charge(measured("20"), at=NOON),
                second.charge(measured("20"), at=NOON),
            )
            return results, await first.snapshot(at=NOON)

        results, budget = run(scenario())

        self.assertEqual(budget.spent, Decimal("40"))
        self.assertEqual(sorted(result.version for result in results), [1, 2])

        crossings = [c for result in results for c in result.crossings]
        self.assertEqual(
            sorted(event.line for event in crossings),
            sorted([counter.MANAGED_LINE, counter.REFUSED_LINE]),
        )

    def test_a_charge_that_never_wins_its_write_is_reported_not_dropped(self):
        store = RacyStore()
        first = counter.DailyCounter(store, attempts=1)
        second = counter.DailyCounter(store, attempts=1)

        async def scenario():
            results = await asyncio.gather(
                first.charge(measured("20"), at=NOON),
                second.charge(measured("20"), at=NOON),
                return_exceptions=True,
            )
            return results, await first.snapshot(at=NOON)

        results, budget = run(scenario())

        failures = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], counter.CounterConflict)
        self.assertEqual(budget.spent, Decimal("20"))


        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            await daily.charge(measured("19.975"), at=NOON)
            return (
                await daily.ratio(at=NOON),
                await daily.would_route_managed(at=NOON),
                await daily.would_refuse_cascade(at=NOON),
            )

        ratio, managed, refused = run(scenario())
        self.assertEqual(ratio, Decimal("0.799"))
        self.assertFalse(managed)
        self.assertFalse(refused)

    def test_seventy_eight_percent_still_cascades(self):
        daily = counter.DailyCounter(MemoryStore())

        # 19.525 / 25 = 78.1%: below the 80% line, so still cascade.
        async def scenario():
            await daily.charge(measured("19.525"), at=NOON)
            return await daily.snapshot(at=NOON)

        budget = run(scenario())
        self.assertEqual(budget.percent, "78.1")
        self.assertFalse(budget.would_route_managed)
        self.assertEqual(budget.routing_refusal, "")

    def test_crossing_eighty_percent_routes_new_calls_managed_once(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            below = await daily.charge(measured("19.975"), at=NOON)
            crossing = await daily.charge(measured("0.05"), at=NOON)
            after = await daily.charge(measured("1"), at=NOON)
            return below, crossing, after, await daily.snapshot(at=NOON)

        below, crossing, after, budget = run(scenario())

        self.assertEqual(below.crossings, ())
        self.assertEqual(
            [event.line for event in crossing.crossings], [counter.MANAGED_LINE]
        )
        self.assertEqual(
            crossing.crossings[0].spend, Decimal("20.025")
        )
        self.assertEqual(crossing.crossings[0].cap, Decimal("25"))
        self.assertEqual(crossing.crossings[0].to_document()["day"], "2026-10-30")
        self.assertEqual(after.crossings, ())
        self.assertTrue(budget.would_route_managed)
        self.assertFalse(budget.would_refuse_cascade)
        self.assertEqual(budget.crossed, (counter.MANAGED_LINE,))
        self.assertIn("route managed", budget.routing_refusal)
        self.assertEqual(
            budget.to_document()["wouldRouteManaged"],
            True,
        )
        self.assertEqual(budget.to_document()["spent"], "21.025")
        self.assertEqual(budget.to_document()["day"], "2026-10-30")
        self.assertEqual(budget.to_document()["version"], 3)

    def test_crossing_one_hundred_percent_refuses_cascade_once(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            crossing = await daily.charge(measured("25"), at=NOON)
            after = await daily.charge(measured("1"), at=NOON)
            return crossing, after, await daily.snapshot(at=NOON)

        crossing, after, budget = run(scenario())

        self.assertEqual(
            [event.line for event in crossing.crossings],
            [counter.MANAGED_LINE, counter.REFUSED_LINE],
        )
        self.assertEqual(after.crossings, ())
        self.assertTrue(budget.would_route_managed)
        self.assertTrue(budget.would_refuse_cascade)
        self.assertIn("refused for new calls", budget.routing_refusal)

    def test_a_live_call_keeps_being_charged_after_the_lines(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            await daily.charge(measured("25"), at=NOON)
            live = await daily.charge(measured("2"), at=NOON)
            return live, await daily.snapshot(at=NOON)

        live, budget = run(scenario())

        # The counter never moves or refuses a live call: it reports the lines
        # for the *next* call, and a running call keeps being charged.
        self.assertTrue(live.charged)
        self.assertEqual(live.amount, Decimal("2"))
        self.assertEqual(budget.spent, Decimal("27"))

    def test_each_day_crosses_and_alerts_again_after_midnight(self):
        clock = FakeClock(NOON)
        daily = counter.DailyCounter(MemoryStore(), now=clock)

        async def scenario():
            first = await daily.charge(measured("20"))
            clock.advance_to(MIDNIGHT)
            second = await daily.charge(measured("20"))
            third = await daily.charge(measured("1"))
            return first, second, third

        first, second, third = run(scenario())

        self.assertEqual(
            [event.line for event in first.crossings], [counter.MANAGED_LINE]
        )
        self.assertEqual(first.day, "2026-10-30")
        self.assertEqual(
            [event.line for event in second.crossings], [counter.MANAGED_LINE]
        )
        self.assertEqual(second.day, "2026-10-31")
        self.assertEqual(third.crossings, ())


class ReservationTests(unittest.TestCase):
    def test_a_hold_counts_against_the_line_before_the_money_lands(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            hold = await daily.reserve("call-1", measured("20"), at=NOON)
            return hold, await daily.snapshot(at=NOON)

        hold, budget = run(scenario())

        self.assertEqual(hold.call_id, "call-1")
        self.assertEqual(hold.day, "2026-10-30")
        self.assertEqual(hold.amount, Decimal("20"))
        self.assertEqual(budget.spent, Decimal("0"))
        self.assertEqual(budget.held, Decimal("20"))
        self.assertEqual(budget.committed, Decimal("20"))
        self.assertTrue(budget.would_route_managed)
        # A hold moves the routing line but is not a charged crossing: the
        # alert fires when the money is actually charged, so a released hold
        # can never leave a false crossing behind.
        self.assertEqual(budget.crossed, ())

    def test_reserving_again_replaces_the_same_calls_hold(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            await daily.reserve("call-1", measured("1"), at=NOON)
            await daily.reserve("call-2", measured("2"), at=NOON)
            await daily.reserve("call-1", measured("2.5"), at=NOON)
            return await daily.snapshot(at=NOON)

        budget = run(scenario())
        self.assertEqual(budget.held, Decimal("4.5"))
        self.assertEqual(
            [hold.amount for hold in budget.reserved],
            [Decimal("2.5"), Decimal("2")],
        )

    def test_a_measured_settle_releases_the_hold_and_charges_the_cost(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            hold = await daily.reserve("call-1", measured("0.5"), at=NOON)
            settled = await daily.settle(hold, measured("0.7"), at=NOON)
            return settled, await daily.snapshot(at=NOON)

        settled, budget = run(scenario())

        self.assertTrue(settled.charged)
        self.assertEqual(settled.amount, Decimal("0.7"))
        self.assertEqual(budget.spent, Decimal("0.7"))
        self.assertEqual(budget.held, Decimal("0"))

    def test_an_unmeasured_settle_keeps_the_hold_and_flags_the_day(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            hold = await daily.reserve("call-1", measured("0.5"), at=NOON)
            settled = await daily.settle(
                hold, unmeasured("the model never reported usage"), at=NOON
            )
            return settled, await daily.snapshot(at=NOON)

        settled, budget = run(scenario())

        self.assertFalse(settled.charged)
        self.assertIsNone(settled.amount)
        self.assertEqual(budget.spent, Decimal("0"))
        self.assertEqual(budget.held, Decimal("0.5"))
        self.assertIsNone(budget.ratio)
        self.assertTrue(budget.would_route_managed)
        self.assertTrue(budget.would_refuse_cascade)
        self.assertIn("unmeasured", budget.routing_refusal)
        self.assertIn("the model never reported usage", budget.routing_refusal)

    def test_an_unmeasured_reservation_is_refused_by_its_reasons(self):
        daily = counter.DailyCounter(MemoryStore())

        with self.assertRaises(cost.UnmeasuredCostError) as caught:
            run(daily.reserve("call-1", unmeasured("no tts frame"), at=NOON))
        self.assertIn("no tts frame", str(caught.exception))

    def test_release_drops_a_hold_and_is_idempotent(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            hold = await daily.reserve("call-1", measured("0.5"), at=NOON)
            first = await daily.release(hold)
            second = await daily.release(hold)
            return first, second, await daily.snapshot(at=NOON)

        first, second, budget = run(scenario())
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(budget.held, Decimal("0"))

    def test_a_call_spanning_midnight_settles_on_the_new_day(self):
        clock = FakeClock(BEFORE_MIDNIGHT)
        daily = counter.DailyCounter(MemoryStore(), now=clock)

        async def scenario():
            hold = await daily.reserve("call-1", measured("0.5"))
            clock.advance_to(MIDNIGHT + 1)
            settled = await daily.settle(hold, measured("0.7"))
            return (
                settled,
                await daily.snapshot(at=BEFORE_MIDNIGHT),
                await daily.snapshot(),
            )

        settled, before, after = run(scenario())

        self.assertEqual(settled.day, "2026-10-31")
        self.assertEqual(before.spent, Decimal("0"))
        self.assertEqual(before.held, Decimal("0"))
        self.assertEqual(after.spent, Decimal("0.7"))
        self.assertEqual(after.committed, Decimal("0.7"))
        # The empty earlier bucket is not invented: it was written and zeroed.
        self.assertEqual(before.version, 2)


class CountingRuleTests(unittest.TestCase):
    def test_a_reconnect_replay_and_a_fallback_leg_are_both_counted(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            await daily.charge(measured("0.0045", "stt"), at=NOON)
            await daily.charge(measured("0.015", "tts"), at=NOON)
            return await daily.snapshot(at=NOON)

        # Two vendor records, two charges: the vendor bills both, so neither is
        # deduplicated against the other.
        self.assertEqual(run(scenario()).spent, Decimal("0.0195"))

    def test_charging_money_uses_ticket_101s_price_not_an_estimate(self):
        daily = counter.DailyCounter(MemoryStore())
        priced = cost.cost_call(
            call_with_a_greeting_and_a_prefetch_that_used_tokens()
        )

        async def scenario():
            await daily.charge(priced, at=NOON)
            return await daily.snapshot(at=NOON)

        # Hand-worked: 100 s STT * 0.18/3600 = 0.005; 1,000 TTS chars * 15/1M
        # = 0.015; two prompts of 4,000 tokens * 1.25/1M = 0.01. Total 0.03.
        self.assertEqual(priced.amount, Decimal("0.03"))
        self.assertEqual(run(scenario()).spent, Decimal("0.03"))

    def test_a_prefetch_that_produced_no_usage_adds_nothing_and_is_not_zero(self):
        daily = counter.DailyCounter(MemoryStore())
        priced = cost.cost_call(UsageMeter().usage())

        async def scenario():
            charged = await daily.charge(priced, at=NOON)
            return charged, await daily.snapshot(at=NOON)

        charged, budget = run(scenario())

        self.assertIsNone(priced.amount)
        self.assertFalse(charged.charged)
        self.assertEqual(budget.spent, Decimal("0"))
        self.assertIsNone(budget.ratio)
        self.assertTrue(budget.unmeasured)
        self.assertEqual(budget.crossed, ())

    def test_a_measured_zero_is_a_charge_not_an_absence(self):
        daily = counter.DailyCounter(MemoryStore())

        async def scenario():
            charged = await daily.charge(measured("0"), at=NOON)
            return charged, await daily.snapshot(at=NOON)

        charged, budget = run(scenario())

        self.assertTrue(charged.charged)
        self.assertEqual(charged.amount, Decimal("0"))
        self.assertEqual(budget.spent, Decimal("0"))
        self.assertEqual(budget.unmeasured, ())
        self.assertEqual(budget.ratio, Decimal("0"))


def call_with_a_greeting_and_a_prefetch_that_used_tokens():
    """Ticket 100's meter for one call: a real turn, a billed prefetch, TTS.

    Hand-worked cost (USD), from the vendor prices in ``cascade/rates/v1.json``:
      stt   100 s           * 0.18/3600        = 0.005
      llm   turn-1 4,000 prompt tokens         = 0.005
      llm   turn-2 4,000 prompt tokens         = 0.005  (the prefetch)
      tts   1,000 chars     * 15/1M            = 0.015
      total                                    = 0.03
    """
    meter = UsageMeter()
    usage_frame = {
        "prompt_tokens": 4_000,
        "completion_tokens": 0,
        "prompt_tokens_details": {"cached_tokens": 0},
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    meter.record_llm("turn-1", usage_frame)
    meter.record_llm("prefetch-1", usage_frame)
    meter.record_stt({"audio_duration_seconds": 100})
    meter.record_tts(
        Billing(
            characters=1_000,
            measured=True,
            source="Termination.billed_characters",
            total_input_char_length=1_000,
            audio_duration_seconds=4.0,
            session_duration_seconds=5,
        )
    )
    return meter.usage()


if __name__ == "__main__":
    unittest.main()
