"""Speculation is read-only work: a prefetch can never become a reply.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Floor arbitration. While the agent is silent a
growing partial may start speculative model work. It is read-only, cancellable,
adopted only on an exact message match with the final, and never a reply: the
completion is still the only event that may ask for one.

The tests drive ``PrefetchSpeculator`` against ``ScriptedLLM`` and the ledger.
They prove the four ways a prefetch dies (a new partial replaces it, the agent
takes the floor, the final differs, the turn is suppressed) and the one way it
survives: an exact message match on a final that is going to be answered. A
prefetch that is simply deleted from the module makes every adoption test fail,
and adopting a differing prefetch is asserted to fail by name.

Vocabulary is take the floor / yield / wait: a prefetch never takes a turn.
"""

import asyncio
import unittest

from cascade.event_rules import EventRules
from cascade.floor import FloorArbiter
from cascade.prefetch import (
    DropReason,
    PrefetchSpeculator,
    message_key,
)
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.turn_state import TurnPhase, TurnStateStore
from metrics import TimingLedger
from providers import LLMStream, PartialTranscript, TokenDelta


def user(text):
    return [{"role": "system", "content": "You are Voni."}, {"role": "user", "content": text}]


class AdoptingReplySink:
    """The reply path: adopt the speculation if it matches, then answer."""

    def __init__(self, llm, speculator):
        self.llm = llm
        self.speculator = speculator
        self.adopted = None
        self.turns = []

    async def __call__(self, turn):
        self.turns.append(turn.id)
        self.adopted = self.speculator.adopt(
            turn.final_text,
            messages=user(turn.final_text),
            takes_floor=True,
        )
        async for _ in self.llm.complete(messages=user(turn.final_text)):
            pass


class ExplodingLLM(LLMStream):
    """A backend whose speculation fails: the call must survive it."""

    def __init__(self):
        self.prefetches = 0

    async def complete(self, *, messages, tools=None):
        raise AssertionError("a failing prefetch must not reach complete()")
        yield  # pragma: no cover - generator shape

    def prefetch(self, *, messages):
        self.prefetches += 1
        raise RuntimeError("429 from the gateway")


class ReadOnlyTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)
        self.speculator = PrefetchSpeculator(
            llm=self.llm, ledger=self.ledger, arbiter=self.arbiter
        )

    def test_a_prefetch_starts_read_only_work_and_never_a_reply(self):
        ticket = self.speculator.offer("book a dem", messages=user("book a dem"))

        self.assertIsNotNone(ticket)
        self.assertEqual(1, len(self.llm.prefetches))
        self.assertEqual([], self.llm.requests)
        self.assertEqual(0, self.llm.responses_served)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_started"])
        self.assertIs(ticket, self.speculator.pending)

    def test_a_prefetch_ticket_is_cancellable_and_cancel_is_idempotent(self):
        ticket = self.speculator.offer("book a dem", messages=user("book a dem"))

        ticket.cancel()
        ticket.cancel()

        self.assertTrue(ticket.cancelled)
        self.assertTrue(self.llm.prefetches[0].cancelled)

    def test_a_cancelled_ticket_is_never_adopted(self):
        ticket = self.speculator.offer("book a dem", messages=user("book a dem"))
        ticket.cancel()

        adopted = self.speculator.adopt(
            "book a dem", messages=user("book a dem"), takes_floor=True
        )

        self.assertIsNone(adopted)
        self.assertEqual(0, self.ledger.summary()["counts"]["prefetch_used"])
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])

    def test_a_failing_prefetch_never_breaks_the_call(self):
        llm = ExplodingLLM()
        speculator = PrefetchSpeculator(llm=llm, ledger=self.ledger)

        self.assertIsNone(
            speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual(1, llm.prefetches)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])


class FloorTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)
        self.speculator = PrefetchSpeculator(
            llm=self.llm, ledger=self.ledger, arbiter=self.arbiter
        )

    def test_prefetch_never_runs_while_the_agent_speaks(self):
        self.arbiter.agent_speaks()

        self.assertIsNone(
            self.speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual([], self.llm.prefetches)
        self.assertEqual(0, self.ledger.summary()["counts"]["prefetch_started"])

    def test_prefetch_never_runs_while_the_agent_thinks(self):
        self.arbiter.agent_thinks()

        self.assertIsNone(
            self.speculator.offer("book a dem", messages=user("book a dem"))
        )
        self.assertEqual([], self.llm.prefetches)

    def test_a_silent_floor_is_the_only_place_speculation_starts(self):
        self.arbiter.agent_silent()

        self.assertIsNotNone(
            self.speculator.offer("book a dem", messages=user("book a dem"))
        )


class AdoptionTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.speculator = PrefetchSpeculator(llm=self.llm, ledger=self.ledger)

    def offer(self, text="book a dem"):
        return self.speculator.offer(text, messages=user(text))

    def test_an_exact_message_match_on_an_answered_final_is_adopted_once(self):
        self.offer()

        adopted = self.speculator.adopt(
            "book a dem", messages=user("book a dem"), takes_floor=True
        )

        self.assertIsNotNone(adopted)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_used"])
        self.assertEqual(0, self.ledger.summary()["counts"]["prefetch_cancelled"])
        self.assertIsNone(self.speculator.pending)
        self.assertIsNone(
            self.speculator.adopt(
                "book a dem", messages=user("book a dem"), takes_floor=True
            )
        )
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_used"])

    def test_a_differing_final_discards_the_prefetch(self):
        self.offer("book a dem")

        adopted = self.speculator.adopt(
            "book a demo", messages=user("book a demo"), takes_floor=True
        )

        self.assertIsNone(adopted)
        self.assertEqual(0, self.ledger.summary()["counts"]["prefetch_used"])
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])
        self.assertIsNone(self.speculator.pending)
        self.assertTrue(self.llm.prefetches[0].cancelled)

    def test_a_differing_message_with_an_equal_text_is_not_adopted(self):
        self.offer("book a dem")
        history = user("book a dem") + [{"role": "assistant", "content": "Anything else?"}]

        adopted = self.speculator.adopt(
            "book a dem", messages=history, takes_floor=True
        )

        self.assertIsNone(adopted)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])

    def test_a_suppressed_final_discards_the_prefetch(self):
        self.offer()

        adopted = self.speculator.adopt(
            "book a dem", messages=user("book a dem"), takes_floor=False
        )

        self.assertIsNone(adopted)
        self.assertEqual(1, self.speculator.drops()[DropReason.SUPPRESSED])
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])

    def test_a_dropped_prefetch_invents_no_user_message(self):
        self.offer("book a dem")

        self.speculator.drop(DropReason.MISMATCH)

        self.assertEqual([], self.llm.requests)
        self.assertEqual(0, self.llm.responses_served)
        self.assertTrue(self.llm.prefetches[0].cancelled)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])
        self.assertIsNone(self.speculator.pending)

    def test_a_new_partial_cancels_the_previous_speculation(self):
        first = self.offer("book a dem")
        second = self.offer("book a demo tomorr")

        self.assertNotEqual(first.key, second.key)
        self.assertTrue(first.cancelled)
        self.assertTrue(self.llm.prefetches[0].cancelled)
        self.assertFalse(self.llm.prefetches[1].cancelled)
        self.assertEqual(2, self.ledger.summary()["counts"]["prefetch_started"])
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])
        self.assertEqual(1, self.speculator.drops()[DropReason.REPLACED])

    def test_an_identical_partial_does_not_start_a_second_prefetch(self):
        self.offer("book a dem")
        self.assertIsNone(self.offer("book a dem"))

        self.assertEqual(1, len(self.llm.prefetches))
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_started"])

    def test_speculation_stops_at_speech_end(self):
        self.offer("book a dem")
        self.speculator.drop(DropReason.CALL_END)

        refused = self.speculator.offer(
            "book a dem", messages=user("book a dem"), phase=TurnPhase.ENDPOINTED
        )

        self.assertIsNone(refused)
        self.assertEqual(1, len(self.llm.prefetches))

    def test_a_speculation_may_run_while_the_turn_is_still_speaking(self):
        started = self.speculator.offer(
            "book a dem", messages=user("book a dem"), phase=TurnPhase.SPEAKING
        )

        self.assertIsNotNone(started)


class NeverAReplyTest(unittest.TestCase):
    """The reply the caller hears belongs to the reply path, never to a prefetch.

    End to end over the two real seams: ``EventRules`` decides that the final is
    the only reply trigger, and the reply sink asks the speculator whether the
    speculation may be adopted. The prefetch itself never calls ``complete``.
    """

    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.speculator = PrefetchSpeculator(llm=self.llm, ledger=self.ledger)
        self.sink = AdoptingReplySink(self.llm, self.speculator)
        self.rules = EventRules(
            turns=self.turns, on_reply=self.sink, ledger=self.ledger
        )

    def run_turn(self, partial_text, final_text):
        async def scenario():
            await self.rules.apply(SpeechStart("t1"))
            await self.rules.apply(PartialTranscript(partial_text))
            ticket = self.speculator.offer(
                partial_text,
                messages=user(partial_text),
                phase=self.turns.get("t1").phase,
            )
            self.assertIsNotNone(ticket)
            self.assertEqual([], self.llm.requests)  # speculation is not a reply
            return await self.rules.apply(
                SpeechComplete(turn_id="t1", text=final_text)
            )

        return asyncio.run(scenario())

    def test_an_exact_match_is_adopted_and_the_turn_is_still_answered_once(self):
        self.run_turn("book a demo", "book a demo")

        self.assertIsNotNone(self.sink.adopted)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_used"])
        self.assertEqual(1, len(self.llm.requests))
        self.assertEqual("book a demo", self.llm.requests[0]["messages"][-1]["content"])

    def test_a_differing_final_discards_the_prefetch_and_still_answers_once(self):
        self.run_turn("book a dem", "book a demo")

        self.assertIsNone(self.sink.adopted)
        self.assertEqual(1, self.ledger.summary()["counts"]["prefetch_cancelled"])
        self.assertEqual(1, len(self.llm.requests))
        self.assertEqual("book a demo", self.llm.requests[0]["messages"][-1]["content"])


class MessageKeyTest(unittest.TestCase):
    def test_the_same_messages_hash_alike_regardless_of_key_order(self):
        left = [{"role": "user", "content": "book a demo", "name": "caller"}]
        right = [{"name": "caller", "content": "book a demo", "role": "user"}]

        self.assertEqual(message_key(left), message_key(right))

    def test_one_changed_word_changes_the_key(self):
        self.assertNotEqual(
            message_key(user("book a dem")), message_key(user("book a demo"))
        )

    def test_the_tool_set_is_part_of_the_key(self):
        tools = [{"type": "function", "function": {"name": "end_call"}}]

        self.assertNotEqual(
            message_key(user("book a dem")), message_key(user("book a dem"), tools)
        )


if __name__ == "__main__":
    unittest.main()
