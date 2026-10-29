"""Under pressure the speculation goes first; the caller's turn still runs.

Spec: `.scratch/meta-cascade/spec.md` M3 "Money and eyes" — Prefetch shedding:
"Under rate pressure — a ``429``/``1013``, an exhausted remaining-quota header,
an STT concurrency limit, or a TTS control-frame pressure signal — speculative
prefetch is cancelled and refused while a real turn is still served. A prefetch
``429`` does not open the breaker; a real turn's ``429`` does."

Seams under test:

* ``PrefetchSpeculator.observe_pressure`` / ``pressure_relieved`` / ``offer`` —
  the one place a speculation starts or dies. What it catches: a speculation
  surviving a pressure signal, or a dropped one being adopted. What it misses:
  provider wire behaviour (covered by the STT/TTS adapters' own suites).
* ``cascade.failures.classify`` through ``BreakerTransitions.record_failure`` —
  the real breaker seam, so "a prefetch 429 does not demote a healthy model" is
  proved against the durable record, not against a boolean in this module.
* The ledger counters and ``drops()`` — a shed speculation must be reportable
  on the same scoreboard as the reply gap.

No number is invented here: the four pressure triggers are the spec's, the
reserve is one unit per waiting real turn (the spec's "last unit"), and the
remaining capacity comes from an injected meter. A meter that reports no
remaining header is not evidence of pressure, so nothing is assumed.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.event_rules import EventRules
from cascade.failures import classify
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.prefetch import (
    DropReason,
    PrefetchSpeculator,
    PressureKind,
    pressure_from_llm_status,
    pressure_from_stt_close,
    pressure_from_tts_close,
    quota_pressure,
    concurrency_pressure,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.turn_state import TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript, TokenDelta


def user(text):
    return [
        {"role": "system", "content": "You are Voni."},
        {"role": "user", "content": text},
    ]


class FakeBudget:
    """A provider meter: units left, and real turns that need one each."""

    def __init__(self, remaining, waiting=0):
        self._remaining = remaining
        self._waiting = waiting

    def remaining(self):
        return self._remaining

    def real_turns_waiting(self):
        return self._waiting


class ShedTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM(
            [[Step(TokenDelta(text="Sure."))], [Step(TokenDelta(text="Sure."))]]
        )
        self.speculator = PrefetchSpeculator(llm=self.llm, ledger=self.ledger)

    def counts(self):
        return self.ledger.summary()["counts"]

    def offer(self, text="book a dem"):
        return self.speculator.offer(text, messages=user(text))

    def test_a_rate_limit_cancels_the_live_prefetch_and_refuses_the_next(self):
        ticket = self.offer()

        decision = self.speculator.observe_pressure(pressure_from_llm_status(429))

        self.assertTrue(ticket.cancelled)
        self.assertTrue(self.llm.prefetches[0].cancelled)
        self.assertIsNone(self.speculator.pending)
        self.assertTrue(decision.cancelled)
        self.assertIs(decision.signal.kind, PressureKind.RATE_LIMITED)
        self.assertEqual(1, self.speculator.drops()[DropReason.SHED])
        self.assertEqual(1, self.counts()["prefetch_cancelled"])

        self.assertIsNone(self.offer("book a demo"))

        self.assertEqual(1, len(self.llm.prefetches))
        self.assertEqual(2, self.speculator.drops()[DropReason.SHED])
        self.assertEqual(2, self.counts()["prefetch_cancelled"])

    def test_a_shed_prefetch_never_commits_a_turn(self):
        self.offer()
        self.speculator.observe_pressure(pressure_from_stt_close(1013))

        adopted = self.speculator.adopt(
            "book a dem", messages=user("book a dem"), takes_floor=True
        )

        self.assertIsNone(adopted)
        self.assertEqual(0, self.counts()["prefetch_used"])
        self.assertEqual([], self.llm.requests)

    def test_every_spec_pressure_signal_sheds_the_speculation(self):
        signals = [
            pressure_from_llm_status(429),
            pressure_from_stt_close(1013),
            pressure_from_tts_close(3010),
            quota_pressure("llm", remaining=0),
            concurrency_pressure("stt"),
        ]

        for signal in signals:
            with self.subTest(signal=signal.kind):
                ledger = TimingLedger(now=FakeClock())
                llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
                speculator = PrefetchSpeculator(llm=llm, ledger=ledger)
                ticket = speculator.offer("book a dem", messages=user("book a dem"))

                decision = speculator.observe_pressure(signal)

                self.assertTrue(decision.cancelled)
                self.assertTrue(ticket.cancelled)
                self.assertIsNone(speculator.pending)
                self.assertEqual(
                    1, ledger.summary()["counts"]["prefetch_cancelled"]
                )

    def test_pressure_clears_only_when_the_provider_says_so(self):
        self.speculator.observe_pressure(pressure_from_llm_status(429))
        self.assertIsNone(self.offer())
        self.assertIsNotNone(self.speculator.shed)

        self.assertTrue(self.speculator.pressure_relieved())

        self.assertIsNone(self.speculator.shed)
        self.assertIsNotNone(self.offer())
        self.assertEqual(1, len(self.llm.prefetches))

    def test_a_status_the_spec_does_not_call_pressure_is_not_pressure(self):
        self.assertIsNone(pressure_from_llm_status(500))
        self.assertIsNone(pressure_from_stt_close(1011))
        self.assertIsNone(pressure_from_tts_close(3008))
        self.assertIsNone(quota_pressure("llm", remaining=3))
        self.assertIsNone(quota_pressure("llm", remaining=None))


class HeadroomTest(unittest.TestCase):
    """A prefetch may only take a unit no real turn is waiting for."""

    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])

    def speculator(self, remaining, waiting=0):
        return PrefetchSpeculator(
            llm=self.llm, ledger=self.ledger, budget=FakeBudget(remaining, waiting)
        )

    def counts(self):
        return self.ledger.summary()["counts"]

    def test_the_last_unit_a_waiting_turn_needs_is_never_prefetched(self):
        speculator = self.speculator(remaining=1, waiting=1)

        self.assertIsNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )

        self.assertEqual([], self.llm.prefetches)
        self.assertEqual(1, speculator.drops()[DropReason.SHED])
        self.assertEqual(1, self.counts()["prefetch_cancelled"])
        self.assertEqual(0, self.counts()["prefetch_started"])

    def test_a_unit_beyond_every_waiting_turn_may_be_prefetched(self):
        speculator = self.speculator(remaining=2, waiting=1)

        self.assertIsNotNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual(1, self.counts()["prefetch_started"])

    def test_an_exhausted_budget_refuses_prefetch_with_no_turn_waiting(self):
        speculator = self.speculator(remaining=0)

        self.assertIsNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual([], self.llm.prefetches)

    def test_a_provider_that_sends_no_remaining_number_is_not_read_as_zero(self):
        speculator = self.speculator(remaining=None)

        self.assertIsNotNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual(1, self.counts()["prefetch_started"])


class AdoptingSink:
    """The reply path: adopt if allowed, then answer the final."""

    def __init__(self, llm, speculator):
        self.llm = llm
        self.speculator = speculator
        self.adopted = None
        self.turns = []

    async def __call__(self, turn):
        self.turns.append(turn.id)
        self.adopted = self.speculator.adopt(
            turn.final_text, messages=user(turn.final_text), takes_floor=True
        )
        async for _ in self.llm.complete(messages=user(turn.final_text)):
            pass


def closed_llm_record():
    return ProviderBreakerRecord(leg="llm", provider="meta", state="closed")


def harness(record, *, start=0.0):
    clock = FakeClock(start)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
        }
    )
    breaker = Breaker(store, probe_interval_s=30.0, now=clock)
    return BreakerTransitions(breaker), breaker


class BreakerTest(unittest.TestCase):
    """A speculation must never demote a healthy model; a real turn must."""

    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.speculator = PrefetchSpeculator(llm=self.llm, ledger=self.ledger)

    def test_a_prefetch_429_does_not_open_the_breaker_but_a_real_turn_429_does(self):
        decision = self.speculator.observe_pressure(pressure_from_llm_status(429))
        transitions, breaker = harness(closed_llm_record())

        asyncio.run(
            transitions.record_failure(
                "llm", verdict=decision.verdict, phase="prefetch", turn=None
            )
        )
        self.assertEqual("closed", asyncio.run(breaker.read("llm")).state)
        self.assertFalse(decision.verdict.opens_breaker)

        asyncio.run(
            transitions.record_failure(
                "llm", verdict=classify("llm", 429), phase="reply", turn=1
            )
        )
        self.assertEqual("open", asyncio.run(breaker.read("llm")).state)

    def test_a_real_turn_is_still_served_while_prefetch_is_shed(self):
        turns = TurnStateStore(clock=self.clock, source="meta")
        sink = AdoptingSink(self.llm, self.speculator)
        rules = EventRules(turns=turns, on_reply=sink, ledger=self.ledger)
        self.speculator.observe_pressure(pressure_from_llm_status(429))

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            await rules.apply(PartialTranscript("book a dem"))
            refused = self.speculator.offer(
                "book a dem",
                messages=user("book a dem"),
                phase=turns.get("t1").phase,
            )
            self.assertIsNone(refused)
            await rules.apply(SpeechComplete(turn_id="t1", text="book a demo"))

        asyncio.run(scenario())

        self.assertEqual(1, len(sink.turns))
        self.assertIsNone(sink.adopted)
        self.assertEqual(1, len(self.llm.requests))
        self.assertEqual("book a demo", self.llm.requests[0]["messages"][-1]["content"])
        counts = self.ledger.summary()["counts"]
        self.assertEqual(0, counts["prefetch_started"])
        self.assertEqual(0, counts["prefetch_used"])
        self.assertEqual(1, counts["prefetch_cancelled"])

    def test_the_real_turn_is_served_before_any_prefetch_under_pressure(self):
        speculator = PrefetchSpeculator(
            llm=self.llm,
            ledger=self.ledger,
            budget=FakeBudget(remaining=1, waiting=1),
        )

        self.assertIsNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )

        async def real_turn():
            text = ""
            async for token in self.llm.complete(messages=user("book a demo")):
                text += token.text
            return text

        self.assertEqual("Sure.", asyncio.run(real_turn()))
        self.assertEqual([], self.llm.prefetches)
        self.assertEqual(1, len(self.llm.requests))


if __name__ == "__main__":
    unittest.main()
