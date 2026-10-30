"""At 80% of the daily cap, a *new* call routes managed (ticket 103).

Seam: :meth:`cascade.routing.RoutingSwitch.decide` with the durable daily
counter passed as its budget line, and :class:`cascade.counter.DailyCounter`'s
crossing alert sink.

The expected percentages are written as literals from the settled money policy
(80% of a 25 USD cap is 20 USD), never recomputed with the code under test.
Ticket 101's :class:`cascade.cost.CallCost` is the only money input; ticket
102's counter owns the crossing record, so a second charge on the same line
cannot alert twice.
"""

from __future__ import annotations

import asyncio
import unittest
from decimal import Decimal

from cascade import cost
from cascade.cost import CallCost, LegCost
from cascade.counter import DailyCounter
from cascade.routing import CallSubject, RoutingSwitch
from cascade.store import MemoryStore

NOON = 1_793_361_600.0
NEXT_NOON = NOON + 86_400.0
TENANT_SUBJECT = CallSubject("tenant-call-103", "tenant")


def run(coro):
    return asyncio.run(coro)


def measured(amount: str, leg: str = "stt") -> CallCost:
    """A priced call whose one leg cost ``amount`` USD (ticket 101's shape)."""
    return CallCost(cost.RATE_TABLE, (LegCost(leg, Decimal(amount)),))


def unmeasured(reason: str) -> CallCost:
    """A cost ticket 101 could not price: no leg measured, never zero."""
    return CallCost(cost.RATE_TABLE, (LegCost("tts", None, reasons=(reason,)),))


class BelowTheLineTests(unittest.TestCase):
    def test_a_new_call_below_the_80_percent_line_routes_cascade(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("19.975"))
            return await switch.decide(TENANT_SUBJECT, budget=counter)

        decision = run(scenario())

        self.assertEqual("cascade", decision.disposition)
        self.assertEqual("", decision.reason)

    def test_at_80_1_percent_a_new_call_routes_managed_with_its_reason(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("20.025"))
            return await switch.decide(TENANT_SUBJECT, budget=counter)

        decision = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertIn("80.1%", decision.reason)
        self.assertIn("route managed", decision.reason)

    def test_at_exactly_80_percent_a_new_call_routes_managed(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("20"))
            return await switch.decide(TENANT_SUBJECT, budget=counter)

        decision = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertIn("80.0%", decision.reason)

    def test_a_caller_refusal_and_the_budget_refusal_are_both_kept(self):
        # The caller's predicate (an adapter refusal) and the day's own reason
        # are different facts; the decision must not silently drop either.
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("20.025"))
            return await switch.decide(
                TENANT_SUBJECT,
                refusal="the body names an unknown voice",
                budget=counter,
            )

        decision = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertIn("the body names an unknown voice", decision.reason)
        self.assertIn("80.1%", decision.reason)


class LiveCallTests(unittest.TestCase):
    def test_a_live_call_is_not_moved_when_the_line_crosses_later(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("1"))
            live = await switch.decide(TENANT_SUBJECT, budget=counter)
            # The call is already running; later spend moves only new calls.
            await counter.charge(measured("24"))
            new_call = await switch.decide(
                CallSubject("tenant-call-104", "tenant"), budget=counter
            )
            return live, new_call

        live, new_call = run(scenario())

        self.assertEqual("cascade", live.disposition)
        self.assertEqual("managed", new_call.disposition)


class UnknownDayTests(unittest.TestCase):
    def test_a_failed_counter_read_routes_managed_and_never_cascades(self):
        class BudgetOutage(MemoryStore):
            async def read(self, key):
                if key.startswith("budget.daily:"):
                    from cascade.store import StoreUnavailable

                    raise StoreUnavailable(f"the day bucket {key!r} is unreachable")
                return await super().read(key)

        async def scenario():
            store = BudgetOutage()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            return await switch.decide(TENANT_SUBJECT, budget=counter)

        decision = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertIn("daily counter is unreadable", decision.reason)
        self.assertIn("never read as zero", decision.reason)

    def test_an_unmeasured_day_routes_managed_and_never_reads_as_zero(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(unmeasured("the vendor did not report usage"))
            return await switch.decide(TENANT_SUBJECT, budget=counter)

        decision = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertIn("unmeasured", decision.reason)
        self.assertIn("cannot be proved to be inside the cap", decision.reason)


class AlertTests(unittest.TestCase):
    def test_the_80_percent_crossing_alerts_once_per_day_and_again_after_a_reset(self):
        async def scenario():
            alerts = []
            counter = DailyCounter(
                MemoryStore(), now=lambda: NOON, on_crossing=alerts.append
            )
            await counter.charge(measured("20"), at=NOON)
            # More spend on the same day is not a second crossing.
            await counter.charge(measured("1"), at=NOON)
            # A new UTC day is a fresh crossing set: the alert fires again.
            await counter.charge(measured("20"), at=NEXT_NOON)
            return alerts

        alerts = run(scenario())

        self.assertEqual(["route_managed", "route_managed"], [a.line for a in alerts])
        self.assertEqual(["2026-10-30", "2026-10-31"], [a.day for a in alerts])

    def test_a_second_instance_does_not_alert_for_a_line_already_crossed(self):
        async def scenario():
            store = MemoryStore()
            first, second = [], []
            writer = DailyCounter(
                store, now=lambda: NOON, on_crossing=first.append
            )
            reader = DailyCounter(
                store, now=lambda: NOON, on_crossing=second.append
            )
            await writer.charge(measured("20"), at=NOON)
            await reader.charge(measured("1"), at=NOON)
            return first, second

        first, second = run(scenario())

        self.assertEqual(["route_managed"], [a.line for a in first])
        self.assertEqual([], second)


class BeforeTheFirstFrameTests(unittest.TestCase):
    def test_one_decision_reads_the_switch_once_and_today_once(self):
        class CountingStore(MemoryStore):
            def __init__(self):
                super().__init__()
                self.reads = []

            async def read(self, key):
                self.reads.append(key)
                return await super().read(key)

        async def scenario():
            store = CountingStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("20.025"))
            store.reads.clear()
            return await switch.decide(TENANT_SUBJECT, budget=counter), store.reads

        decision, reads = run(scenario())

        self.assertEqual("managed", decision.disposition)
        self.assertEqual([counter_key(), "routing:switch"], reads)
        self.assertEqual(NOON, decision.decided_at)
        document = decision.to_document()
        self.assertEqual("managed", document["disposition"])
        self.assertIn("80.1%", document["reason"])
        self.assertNotIn("provider_fallback", document)

    def test_a_budget_routing_refusal_writes_no_fallback_and_no_store_row(self):
        class CountingStore(MemoryStore):
            def __init__(self):
                super().__init__()
                self.writes = 0

            async def compare_and_set(self, key, expected_version, stored):
                self.writes += 1
                return await super().compare_and_set(
                    key, expected_version, stored
                )

        async def scenario():
            store = CountingStore()
            switch = RoutingSwitch(store, now=lambda: NOON)
            await switch.set_mode("all", actor="test", reason="measure a call")
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("20.025"))
            store.writes = 0
            return await switch.decide(TENANT_SUBJECT, budget=counter), store

        decision, store = run(scenario())

        self.assertEqual("managed", decision.disposition)
        # A refusal is a routing decision: it records a reason and writes
        # nothing, so it cannot be a provider-fallback event or a second row.
        self.assertEqual(0, store.writes)
        document = decision.to_document()
        self.assertNotIn("type", document)
        self.assertNotIn("trigger", document)
        self.assertNotIn("from", document)
        self.assertNotIn("to", document)


def counter_key() -> str:
    return "budget.daily:2026-10-30"
