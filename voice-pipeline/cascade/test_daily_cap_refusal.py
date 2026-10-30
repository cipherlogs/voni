"""At 100% of the daily cap, a new call refuses cascade and still runs (104).

Seam: :func:`cascade.admission.admit_new_call` with ticket 102's
:class:`~cascade.counter.DailyCounter` passed as its budget line, plus
:meth:`cascade.routing.RoutingSwitch.decide` for the frozen decision a live call
carries.

The distinction this module pins is the one the ticket exists for: a refusal is
a *routing* decision that routes the new call managed. It is never a refusal of
the call, never a ``provider_fallback`` event, and never a write. A live call's
frozen decision is untouched by a later crossing; only its own ceiling may stop
it (ticket 105).

Expected money values are literals from the settled policy: 100% of a 25 USD
cap is 25 USD, 99.9% is 24.975 USD. They are never recomputed with the code
under test.
"""

from __future__ import annotations

import asyncio
import unittest
from decimal import Decimal

from cascade import cost
from cascade.admission import Admission, admit_new_call
from cascade.cost import CallCost, LegCost
from cascade.counter import REFUSED_LINE, DailyCounter
from cascade.routing import CallSubject, RoutingSwitch
from cascade.store import MemoryStore, StoreUnavailable

NOON = 1_793_361_600.0
NEXT_NOON = NOON + 86_400.0
TENANT = CallSubject("tenant-call-104", "tenant")
SECOND_TENANT = CallSubject("tenant-call-104b", "tenant")


def run(coro):
    return asyncio.run(coro)


def measured(amount: str, leg: str = "stt") -> CallCost:
    """A priced call whose one leg cost ``amount`` USD (ticket 101's shape)."""
    return CallCost(cost.RATE_TABLE, (LegCost(leg, Decimal(amount)),))


class Opener:
    """Records every cascade socket a new call actually opened."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        return object()


async def all_cascade_switch(store: MemoryStore) -> RoutingSwitch:
    switch = RoutingSwitch(store, now=lambda: NOON)
    await switch.set_mode("all", actor="test", reason="measure a call")
    return switch


class AtTheRefusalLineTests(unittest.TestCase):
    def test_at_exactly_100_percent_a_new_call_is_admitted_managed_not_refused(self):
        async def scenario():
            store = MemoryStore()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("25"), at=NOON)
            opener = Opener()
            admission = await admit_new_call(
                switch, TENANT, open_cascade=opener, budget=counter
            )
            return admission, opener, counter

        admission, opener, counter = run(scenario())

        self.assertIsInstance(admission, Admission, "a refusal is never an exception")
        self.assertEqual("managed", admission.decision.disposition)
        self.assertFalse(admission.decision.permitted)
        self.assertEqual(0, admission.connections)
        self.assertIsNone(admission.connection)
        self.assertEqual(0, opener.calls, "a managed new call opens no cascade socket")
        self.assertIn("100.0%", admission.decision.reason)
        self.assertIn("cascade is refused", admission.decision.reason)
        self.assertIn("route managed", admission.decision.reason)
        self.assertIn("the call itself is never refused", admission.decision.reason)
        self.assertTrue(run(counter.would_refuse_cascade(at=NOON)))

    def test_at_99_9_percent_a_new_call_routes_managed_without_refusing_cascade(self):
        async def scenario():
            store = MemoryStore()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("24.975"), at=NOON)
            opener = Opener()
            admission = await admit_new_call(
                switch, TENANT, open_cascade=opener, budget=counter
            )
            return admission, opener

        admission, opener = run(scenario())

        # Above the 80% line but below 100%: managed, yet cascade is not refused.
        self.assertEqual("managed", admission.decision.disposition)
        self.assertEqual(0, admission.connections)
        self.assertEqual(0, opener.calls)
        self.assertIn("99.9%", admission.decision.reason)
        self.assertIn("route managed", admission.decision.reason)
        self.assertNotIn("cascade is refused", admission.decision.reason)

    def test_the_100_percent_crossing_alerts_once_per_day_per_line(self):
        async def scenario():
            alerts = []
            counter = DailyCounter(
                MemoryStore(), now=lambda: NOON, on_crossing=alerts.append
            )
            # One charge that jumps both lines: 25 USD is 100% of the cap.
            await counter.charge(measured("25"), at=NOON)
            # More spend on the same day is not a second crossing of either line.
            await counter.charge(measured("1"), at=NOON)
            # A new UTC day is a fresh crossing set: both lines alert again.
            await counter.charge(measured("25"), at=NEXT_NOON)
            return alerts

        alerts = run(scenario())

        self.assertEqual(
            ["route_managed", REFUSED_LINE, "route_managed", REFUSED_LINE],
            [alert.line for alert in alerts],
        )
        self.assertEqual(
            ["2026-10-30", "2026-10-30", "2026-10-31", "2026-10-31"],
            [alert.day for alert in alerts],
        )
        self.assertEqual(
            [Decimal("25")] * 4,
            [alert.spend for alert in alerts],
            "each alert names the spend that crossed it (one charge crossed both)",
        )


class LiveCallTests(unittest.TestCase):
    def test_a_live_call_keeps_its_cascade_when_the_day_crosses_100_later(self):
        async def scenario():
            store = MemoryStore()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("1"), at=NOON)
            opener = Opener()
            live = await admit_new_call(
                switch, TENANT, open_cascade=opener, budget=counter
            )
            # The call is already running; a later charge refuses only new calls.
            await counter.charge(measured("24"), at=NOON)
            new = await admit_new_call(
                switch, SECOND_TENANT, open_cascade=opener, budget=counter
            )
            return live, new, opener

        live, new, opener = run(scenario())

        self.assertEqual("cascade", live.decision.disposition)
        self.assertEqual(1, live.connections)
        self.assertEqual("managed", new.decision.disposition)
        self.assertEqual(0, new.connections)
        self.assertEqual(1, opener.calls, "the live call's socket is not moved or closed")


class UnknownDayTests(unittest.TestCase):
    def test_a_failed_counter_read_at_admission_fails_closed_to_managed(self):
        class BudgetOutage(MemoryStore):
            async def read(self, key):
                if key.startswith("budget.daily:"):
                    raise StoreUnavailable(f"the day bucket {key!r} is unreachable")
                return await super().read(key)

        async def scenario():
            store = BudgetOutage()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            opener = Opener()
            admission = await admit_new_call(
                switch, TENANT, open_cascade=opener, budget=counter
            )
            return admission, opener

        admission, opener = run(scenario())

        self.assertEqual("managed", admission.decision.disposition)
        self.assertEqual(0, admission.connections)
        self.assertEqual(0, opener.calls)
        self.assertIn("daily counter is unreadable", admission.decision.reason)
        self.assertIn("never read as zero", admission.decision.reason)


class NotAFallbackTests(unittest.TestCase):
    def test_a_100_percent_refusal_writes_no_row_and_is_not_a_fallback(self):
        class CountingStore(MemoryStore):
            def __init__(self):
                super().__init__()
                self.writes = 0

            async def compare_and_set(self, key, expected_version, stored):
                self.writes += 1
                return await super().compare_and_set(key, expected_version, stored)

        async def scenario():
            store = CountingStore()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("25"), at=NOON)
            store.writes = 0
            admission = await admit_new_call(
                switch, TENANT, open_cascade=Opener(), budget=counter
            )
            return admission, store

        admission, store = run(scenario())
        document = admission.decision.to_document()

        self.assertEqual("managed", document["disposition"])
        self.assertEqual(0, store.writes, "a refusal is a decision, not a write")
        for key in ("type", "trigger", "from", "to", "provider_fallback"):
            self.assertNotIn(key, document)
        self.assertNotIn("provider_fallback", repr(document))

    def test_an_opener_failure_propagates_as_its_ordinary_error(self):
        """No cascade-specific wrapper: a real failure stays the error it was."""
        class OpenerUnavailable(RuntimeError):
            pass

        async def scenario():
            store = MemoryStore()
            switch = await all_cascade_switch(store)
            counter = DailyCounter(store, now=lambda: NOON)
            await counter.charge(measured("1"), at=NOON)

            async def failing_opener():
                raise OpenerUnavailable("the cascade opener could not connect")

            return await admit_new_call(
                switch, TENANT, open_cascade=failing_opener, budget=counter
            )

        with self.assertRaises(OpenerUnavailable) as caught:
            run(scenario())

        self.assertEqual(
            "OpenerUnavailable", type(caught.exception).__name__,
            "the opener's ordinary error is never wrapped in a cascade-specific one",
        )


if __name__ == "__main__":
    unittest.main()
