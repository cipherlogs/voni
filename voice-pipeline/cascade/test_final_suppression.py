"""A final that is filler or the agent's own voice is counted, never answered.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Final suppression. A final classified as a
backchannel or an echo is counted and produces no reply and no ``Cancel``. A
command final takes the floor and steers the next turn. A normal final
generates a reply.

Echo is not a new word list: :func:`cascade.floor.is_echo` is the single Python
port of the browser's similarity rule (``judgeOverlap`` in
``voni/src/lib/voice/barge-in.ts``: at least two words, at least
``ECHO_SHARE`` of them already spoken by the agent). The share is asserted
against the TypeScript source so the two mirrors cannot drift. The agent's own
line must be checked *before* the command set, or an echo of "please stop the
timer" would become a command.

Counting is the ledger's job: the existing ``backchannel``, ``overheard`` and
``yield`` counters. Suppression is not a reply trigger either — the completion
is still the only event that can ask for one, and a suppressed completion asks
for nothing.
"""

import asyncio
import re
import unittest
from pathlib import Path

from cascade.event_rules import EventKind, EventRules
from cascade.floor import (
    ECHO_SHARE,
    FinalAction,
    FinalGate,
    FinalReason,
    FloorArbiter,
    is_echo,
)
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.turn_state import TurnStateStore
from metrics import TimingLedger
from providers import TokenDelta

_REPO_ROOT = Path(__file__).resolve().parents[2]
BARGE_IN_TS = _REPO_ROOT / "voni" / "src" / "lib" / "voice" / "barge-in.ts"

AGENT_LINE = "Book a demo and I will send you the details today."
ECHOED_LINE = "book a demo and send the details today"
AGENT_STOP_LINE = "please stop the timer and wait for me"


class RecordingReplySink:
    """The reply seam: exactly one ``complete()`` per replied turn."""

    def __init__(self, llm):
        self.llm = llm
        self.turns = []
        self.texts = []

    async def __call__(self, turn):
        self.turns.append(turn.id)
        self.texts.append(turn.final_text)
        async for _ in self.llm.complete(
            messages=[{"role": "user", "content": turn.final_text}]
        ):
            pass


class SuppressedFinalTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.sink = RecordingReplySink(self.llm)
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)
        self.gate = FinalGate(ledger=self.ledger, arbiter=self.arbiter)
        # The agent's current sentence, read at classification time: echo is
        # measured against what the agent is saying, not against a word list.
        self.agent_line = [""]
        self.rules = EventRules(
            turns=self.turns,
            on_reply=self.sink,
            ledger=self.ledger,
            final_gate=self.gate,
            agent_text=lambda: self.agent_line[0],
        )

    async def drive(self, *events):
        outcomes = []
        for event in events:
            outcomes.append(await self.rules.apply(event))
        return outcomes

    def complete(self, text, *, turn_id="t1", agent_text=""):
        self.agent_line[0] = agent_text
        return asyncio.run(
            self.drive(
                SpeechStart(turn_id),
                SpeechComplete(turn_id=turn_id, text=text),
            )
        )[-1]

    def test_a_backchannel_final_is_counted_and_never_answered(self):
        self.arbiter.agent_speaks()

        outcome = self.complete("uh-huh")

        self.assertEqual(EventKind.SPEECH_COMPLETE, outcome.kind)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(FinalAction.SUPPRESSED, outcome.final.action)
        self.assertEqual(FinalReason.BACKCHANNEL, outcome.final.reason)
        self.assertFalse(outcome.final.cancel)
        self.assertEqual([], self.sink.turns)
        self.assertEqual([], self.llm.requests)
        counts = self.ledger.summary()["counts"]
        self.assertEqual(1, counts["backchannel"])
        self.assertEqual(0, counts["yield"])

    def test_a_suppressed_final_leaves_the_agents_reply_holding_the_floor(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        outcome = self.complete("okay")

        self.assertFalse(outcome.reply_requested)
        self.assertTrue(self.arbiter.holds_floor)
        self.assertEqual(1, self.ledger.summary()["counts"]["backchannel"])

    def test_an_echo_final_is_counted_and_never_answered(self):
        self.arbiter.agent_speaks()

        outcome = self.complete(ECHOED_LINE, agent_text=AGENT_LINE)

        self.assertEqual(FinalAction.SUPPRESSED, outcome.final.action)
        self.assertEqual(FinalReason.ECHO, outcome.final.reason)
        self.assertFalse(outcome.reply_requested)
        self.assertFalse(outcome.final.cancel)
        self.assertEqual([], self.sink.turns)
        self.assertEqual(1, self.ledger.summary()["counts"]["overheard"])

    def test_the_agents_own_words_never_become_a_command(self):
        self.arbiter.agent_speaks()

        outcome = self.complete(
            "please stop the timer and wait", agent_text=AGENT_STOP_LINE
        )

        self.assertEqual(FinalReason.ECHO, outcome.final.reason)
        self.assertEqual(FinalAction.SUPPRESSED, outcome.final.action)
        self.assertFalse(outcome.final.cancel)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_a_paraphrase_that_is_not_the_agent_is_answered(self):
        self.arbiter.agent_speaks()

        outcome = self.complete(
            "I need financing for a used car", agent_text=AGENT_LINE
        )

        self.assertEqual(FinalAction.REPLY, outcome.final.action)
        self.assertTrue(outcome.reply_requested)
        self.assertEqual(1, len(self.sink.turns))

    def test_a_single_echoed_word_is_not_enough_to_suppress(self):
        outcome = self.complete("demo", agent_text=AGENT_LINE)

        self.assertEqual(FinalAction.REPLY, outcome.final.action)
        self.assertTrue(outcome.reply_requested)


class CommandFinalTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Stopping."))]])
        self.sink = RecordingReplySink(self.llm)
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)
        self.gate = FinalGate(ledger=self.ledger, arbiter=self.arbiter)
        self.rules = EventRules(
            turns=self.turns,
            on_reply=self.sink,
            ledger=self.ledger,
            final_gate=self.gate,
        )

    def test_a_command_final_takes_the_floor_and_steers_the_next_turn(self):
        self.arbiter.agent_speaks()
        self.clock.advance(2.0)

        async def drive():
            await self.rules.apply(SpeechStart("t2"))
            return await self.rules.apply(
                SpeechComplete(turn_id="t2", text="stop")
            )

        outcome = asyncio.run(drive())

        self.assertEqual(FinalAction.STEER, outcome.final.action)
        self.assertEqual(FinalReason.COMMAND, outcome.final.reason)
        self.assertEqual("stop", outcome.final.steer_text)
        self.assertTrue(outcome.final.cancel)
        self.assertTrue(outcome.reply_requested)
        self.assertEqual(1, self.ledger.summary()["counts"]["yield"])
        self.assertEqual(["stop"], self.sink.texts)

    def test_a_normal_final_generates_a_reply(self):
        async def drive():
            await self.rules.apply(SpeechStart("t3"))
            return await self.rules.apply(
                SpeechComplete(turn_id="t3", text="I'd like a demo")
            )

        outcome = asyncio.run(drive())

        self.assertEqual(FinalAction.REPLY, outcome.final.action)
        self.assertEqual(FinalReason.NORMAL, outcome.final.reason)
        self.assertTrue(outcome.reply_requested)
        self.assertFalse(outcome.final.cancel)
        self.assertEqual(["I'd like a demo"], self.sink.texts)
        self.assertEqual(1, len(self.llm.requests))


class SuppressionIsTheDifferenceTest(unittest.TestCase):
    """The control: without the gate the same backchannel would be answered."""

    def test_a_backchannel_is_answered_when_no_final_gate_is_wired(self):
        clock = FakeClock()
        turns = TurnStateStore(clock=clock, source="meta")
        llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        sink = RecordingReplySink(llm)
        rules = EventRules(turns=turns, on_reply=sink)

        async def drive():
            await rules.apply(SpeechStart("t1"))
            return await rules.apply(
                SpeechComplete(turn_id="t1", text="uh-huh")
            )

        outcome = asyncio.run(drive())

        self.assertTrue(outcome.reply_requested)
        self.assertEqual(["uh-huh"], sink.texts)


class SharedEchoClassifierTest(unittest.TestCase):
    """One similarity rule, mirrored from the browser, never re-declared."""

    def test_the_echo_share_matches_the_browser_judge(self):
        source = BARGE_IN_TS.read_text()
        match = re.search(r"const ECHO_SHARE = ([0-9.]+);", source)
        self.assertIsNotNone(match, "barge-in.ts no longer declares ECHO_SHARE")
        self.assertEqual(float(match.group(1)), ECHO_SHARE)

    def test_is_echo_needs_at_least_two_words(self):
        self.assertFalse(is_echo("details", AGENT_LINE))
        self.assertFalse(is_echo("", AGENT_LINE))

    def test_is_echo_measures_the_share_of_the_callers_words(self):
        self.assertTrue(is_echo(ECHOED_LINE, AGENT_LINE))
        self.assertFalse(is_echo("book a demo for my brother", AGENT_LINE))
        self.assertTrue(is_echo("BOOK A DEMO!", AGENT_LINE))

    def test_is_echo_with_no_agent_line_is_never_an_echo(self):
        self.assertFalse(is_echo(ECHOED_LINE, ""))

    def test_the_gate_without_a_floor_is_not_cancelling_anything(self):
        gate = FinalGate()

        decision = gate.classify("stop")

        self.assertEqual(FinalAction.STEER, decision.action)
        self.assertFalse(decision.cancel)


if __name__ == "__main__":
    unittest.main()
