"""The bounded reconnect budget (ticket 94).

Spec: `.scratch/meta-cascade/spec.md`, "Reconnect, sequence dedupe, partial
reply" and the operational note that the 60-minute speech session and the
3,600-second voice session are vendor facts, not bugs.

Every expected value below comes from that prose, not from the budget:

* one failure reconnect per leg per call;
* a planned reconnect (session expiry, the speech lifetime limit, or ours) is
  counted separately and never spends the failure budget or opens the breaker;
* a second failure on the same leg ends the call cleanly;
* a model failure after speech was already queued never restarts the
  completion, because a restart would repeat the speech;
* the per-leg counters are in the end message and the reconnect mark is in the
  ledger.

The budget only decides. Opening a session, replaying audio, draining a queued
sentence and sending the end message belong to tickets 95-99, so nothing here
opens a socket or awaits anything.
"""

from __future__ import annotations

import unittest

from cascade.failures import SESSION_LIMIT, classify_llm, classify_stt, classify_tts
from cascade.reconnect import (
    DELIBERATE,
    ReconnectAction,
    ReconnectBudget,
    ReconnectError,
)
from cascade.testing import FakeClock
from metrics import TimingLedger


class OneReconnectPerLegTest(unittest.TestCase):
    """Each leg gets one failure reconnect per call (spec, M10)."""

    def test_each_leg_gets_one_failure_reconnect(self):
        for leg, verdict in (
            ("stt", classify_stt(1011)),
            ("llm", classify_llm(503)),
            ("tts", classify_tts(1006)),
        ):
            with self.subTest(leg=leg):
                budget = ReconnectBudget(now=FakeClock())

                decision = budget.failed(verdict)

                self.assertEqual(ReconnectAction.RECONNECT, decision.action)
                self.assertFalse(decision.planned)
                self.assertTrue(decision.opens_breaker)
                self.assertEqual(1, budget.counters(leg).failure_reconnects)
                self.assertEqual(0, budget.counters(leg).budget_left)

    def test_a_second_failure_on_the_same_leg_ends_the_call(self):
        budget = ReconnectBudget(now=FakeClock())

        first = budget.failed(classify_stt(1011))
        second = budget.failed(classify_stt(1011))

        self.assertEqual(ReconnectAction.RECONNECT, first.action)
        self.assertEqual(ReconnectAction.END, second.action)
        self.assertIn("stt", second.reason)
        self.assertEqual("stt", second.verdict.leg)
        self.assertEqual(1011, second.verdict.code)
        self.assertEqual(2, budget.counters("stt").failures)
        self.assertEqual(1, budget.counters("stt").failure_reconnects)

    def test_two_injected_failures_produce_one_reconnect_and_then_an_end(self):
        budget = ReconnectBudget(now=FakeClock())

        actions = [
            budget.failed(classify_tts(3005)).action,
            budget.failed(classify_tts(1011)).action,
        ]

        self.assertEqual(
            [ReconnectAction.RECONNECT, ReconnectAction.END], actions
        )
        self.assertEqual(1, budget.counters("tts").failure_reconnects)
        self.assertEqual(0, budget.counters("tts").budget_left)

    def test_the_budget_is_per_leg_not_per_call(self):
        budget = ReconnectBudget(now=FakeClock())

        self.assertEqual(
            ReconnectAction.RECONNECT, budget.failed(classify_stt(1011)).action
        )
        self.assertEqual(
            ReconnectAction.RECONNECT, budget.failed(classify_tts(1006)).action
        )
        self.assertEqual(
            ReconnectAction.RECONNECT, budget.failed(classify_llm(429)).action
        )

        for leg in ("stt", "llm", "tts"):
            with self.subTest(leg=leg):
                self.assertEqual(1, budget.counters(leg).failure_reconnects)
                self.assertEqual(0, budget.counters(leg).budget_left)


class PlannedReconnectTest(unittest.TestCase):
    """Session limits and deliberate rotations are not failures (spec, M10)."""

    def test_a_voice_session_expiry_is_planned_and_spends_no_budget(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.planned("tts", code=3008)

        self.assertEqual(ReconnectAction.PLANNED_RECONNECT, decision.action)
        self.assertTrue(decision.planned)
        self.assertFalse(decision.opens_breaker)
        self.assertEqual(0, budget.counters("tts").failures)
        self.assertEqual(1, budget.counters("tts").planned_reconnects)
        self.assertEqual(1, budget.counters("tts").budget_left)

    def test_the_speech_lifetime_limit_is_planned_and_spends_no_budget(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.planned("stt", code=SESSION_LIMIT)

        self.assertEqual(ReconnectAction.PLANNED_RECONNECT, decision.action)
        self.assertTrue(decision.planned)
        self.assertFalse(decision.opens_breaker)
        self.assertEqual(1, budget.counters("stt").planned_reconnects)
        self.assertEqual(1, budget.counters("stt").budget_left)

    def test_a_deliberate_rotation_is_planned_and_spends_no_budget(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.planned("tts", code=DELIBERATE)

        self.assertEqual(ReconnectAction.PLANNED_RECONNECT, decision.action)
        self.assertTrue(decision.planned)
        self.assertEqual(DELIBERATE, decision.verdict.code)
        self.assertEqual(1, budget.counters("tts").planned_reconnects)

    def test_a_planned_reconnect_does_not_consume_the_failure_budget(self):
        budget = ReconnectBudget(now=FakeClock())

        budget.planned("stt", code=SESSION_LIMIT)
        after_limit = budget.failed(classify_stt(1011))
        after_failure = budget.failed(classify_stt(1011))

        self.assertEqual(ReconnectAction.RECONNECT, after_limit.action)
        self.assertEqual(1, budget.counters("stt").planned_reconnects)
        self.assertEqual(1, budget.counters("stt").failure_reconnects)
        self.assertEqual(
            ReconnectAction.END, after_failure.action,
            "the failure budget still ends the call on its second failure",
        )

    def test_a_session_limit_verdict_is_routed_as_planned_not_as_a_failure(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_tts(3008))

        self.assertEqual(ReconnectAction.PLANNED_RECONNECT, decision.action)
        self.assertTrue(decision.planned)
        self.assertFalse(decision.opens_breaker)
        self.assertEqual(0, budget.counters("tts").failures)
        self.assertEqual(1, budget.counters("tts").budget_left)

    def test_a_trigger_cannot_be_recorded_as_planned(self):
        budget = ReconnectBudget(now=FakeClock())

        with self.assertRaises(ReconnectError):
            budget.planned("tts", code=1006)


class MidReplyModelFailureTest(unittest.TestCase):
    """A model restart after speech would repeat it (spec, M10)."""

    def test_a_mid_reply_model_failure_drains_and_never_restarts(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_llm(503), mid_reply=True)

        self.assertEqual(ReconnectAction.DRAIN, decision.action)
        self.assertIn("restart", decision.reason)
        self.assertEqual(0, budget.counters("llm").failure_reconnects)
        self.assertEqual(0, budget.counters("llm").budget_left)
        self.assertEqual(1, budget.counters("llm").failures)

    def test_a_pre_speech_model_failure_still_gets_its_one_reconnect(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_llm(503), mid_reply=False)

        self.assertEqual(ReconnectAction.RECONNECT, decision.action)
        self.assertEqual(1, budget.counters("llm").failure_reconnects)

    def test_a_second_model_failure_after_a_drain_ends_the_call(self):
        budget = ReconnectBudget(now=FakeClock())

        drained = budget.failed(classify_llm(None, timed_out=True), mid_reply=True)
        ended = budget.failed(classify_llm(503))

        self.assertEqual(ReconnectAction.DRAIN, drained.action)
        self.assertEqual(ReconnectAction.END, ended.action)

    def test_a_third_failure_on_an_ended_leg_stays_ended(self):
        budget = ReconnectBudget(now=FakeClock())

        budget.failed(classify_stt(1011))
        budget.failed(classify_stt(1011))
        third = budget.failed(classify_stt(1011))

        self.assertEqual(ReconnectAction.END, third.action)
        self.assertEqual(1, budget.counters("stt").failure_reconnects)


class NonReconnectableFailureTest(unittest.TestCase):
    """A deterministic bug fails visibly and never spends the budget."""

    def test_a_deterministic_speech_bug_is_not_reconnected(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_stt(1008))

        self.assertEqual(ReconnectAction.FAIL, decision.action)
        self.assertFalse(decision.opens_breaker)
        self.assertEqual(0, budget.counters("stt").failure_reconnects)
        self.assertEqual(1, budget.counters("stt").budget_left)
        self.assertEqual(1, budget.counters("stt").failures)

    def test_a_deterministic_voice_bug_is_not_reconnected(self):
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_tts(3006))

        self.assertEqual(ReconnectAction.FAIL, decision.action)
        self.assertFalse(decision.opens_breaker)
        self.assertEqual(1, budget.counters("tts").budget_left)
        self.assertEqual(1, budget.counters("tts").failures)

    def test_a_bug_does_not_silently_disarm_the_legs_one_reconnect(self):
        budget = ReconnectBudget(now=FakeClock())

        budget.failed(classify_llm(400))
        later = budget.failed(classify_llm(503))

        self.assertEqual(ReconnectAction.RECONNECT, later.action)
        self.assertEqual(1, budget.counters("llm").failure_reconnects)

    def test_a_failure_with_no_immediate_retry_spends_the_budget(self):
        """Speech 1013 is a trigger, but a reconnect now would be a storm."""
        budget = ReconnectBudget(now=FakeClock())

        decision = budget.failed(classify_stt(1013), immediate=False)

        self.assertEqual(ReconnectAction.FAIL, decision.action)
        self.assertTrue(decision.opens_breaker)
        self.assertEqual(1, budget.counters("stt").failures)
        self.assertEqual(0, budget.counters("stt").failure_reconnects)
        self.assertEqual(0, budget.counters("stt").budget_left)

    def test_a_no_immediate_retry_cannot_leave_the_budget_for_a_later_claim(self):
        budget = ReconnectBudget(now=FakeClock())

        budget.failed(classify_stt(1013), immediate=False)
        later = budget.failed(classify_stt(1011))

        self.assertEqual(ReconnectAction.END, later.action)


class VisibleBudgetTest(unittest.TestCase):
    """The counters reach the end message and the ledger (ticket 94)."""

    def test_a_reconnect_writes_the_ledger_reconnect_mark(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        budget = ReconnectBudget(ledger=ledger, now=clock)

        budget.failed(classify_stt(1011))

        self.assertIn("reconnect", ledger.summary()["marks"])

    def test_a_planned_reconnect_writes_the_ledger_reconnect_mark(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        budget = ReconnectBudget(ledger=ledger, now=clock)

        budget.planned("tts", code=3008)

        self.assertIn("reconnect", ledger.summary()["marks"])

    def test_the_end_message_document_names_every_leg_and_its_budget(self):
        budget = ReconnectBudget(now=FakeClock())
        budget.failed(classify_stt(1011))
        budget.planned("tts", code=3008)

        document = budget.to_document()

        self.assertEqual(1, document["budgetPerLeg"])
        self.assertEqual(
            {
                "failures": 1,
                "failureReconnects": 1,
                "plannedReconnects": 0,
                "budgetLeft": 0,
            },
            document["legs"]["stt"],
        )
        self.assertEqual(
            {
                "failures": 0,
                "failureReconnects": 0,
                "plannedReconnects": 1,
                "budgetLeft": 1,
            },
            document["legs"]["tts"],
        )
        self.assertEqual(
            {
                "failures": 0,
                "failureReconnects": 0,
                "plannedReconnects": 0,
                "budgetLeft": 1,
            },
            document["legs"]["llm"],
        )

    def test_each_event_names_the_leg_reason_and_whether_it_was_planned(self):
        clock = FakeClock(start=100.0)
        budget = ReconnectBudget(now=clock)
        budget.failed(classify_stt(1011))
        clock.advance(2.0)
        budget.planned("tts", code=3008)

        events = budget.to_document()["events"]

        self.assertEqual(2, len(events))
        self.assertEqual("stt", events[0]["leg"])
        self.assertFalse(events[0]["planned"])
        self.assertEqual("trigger", events[0]["failureClass"])
        self.assertEqual(100.0, events[0]["at"])
        self.assertEqual("tts", events[1]["leg"])
        self.assertTrue(events[1]["planned"])
        self.assertEqual("planned_reconnect", events[1]["failureClass"])
        self.assertEqual(102.0, events[1]["at"])

    def test_an_unknown_leg_is_refused_by_name(self):
        budget = ReconnectBudget(now=FakeClock())

        with self.assertRaises(ReconnectError):
            budget.counters("asr")
        with self.assertRaises(ReconnectError):
            budget.planned("asr", code=SESSION_LIMIT)


if __name__ == "__main__":
    unittest.main()
