"""The agent's own voice is never a command, an interruption or a reply (93).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Echo. The existing echo/overheard classifier suppresses the agent's own
voice: played-back speech does not become an interruption, a command or a
reply. It is one classifier, :func:`cascade.floor.is_echo`, the Python port of
``judgeOverlap`` in ``voni/src/lib/voice/barge-in.ts``; this ticket adds no
second copy and no second word list.

A final is classified by :class:`cascade.floor.FinalGate` (ticket 71) and is
counted under ``overheard`` with no reply and no ``Cancel``. A partial is
classified by :class:`cascade.floor.FloorArbiter` (ticket 70): an echoed partial
waits, so the agent keeps the floor and the cut path is never asked to cut. The
control in each test is the same line said by the caller when the agent said
something else — that line still takes the floor.
"""

import asyncio
import re
import unittest
from pathlib import Path

from cascade.barge_in import BargeInCutPath
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
from providers import SentenceAudio, TokenDelta

_REPO_ROOT = Path(__file__).resolve().parents[2]
BARGE_IN_TS = _REPO_ROOT / "voni" / "src" / "lib" / "voice" / "barge-in.ts"
CASCADE_DIR = Path(__file__).resolve().parent

AGENT_LINE = "Book a demo and I will send you the details today."
AGENT_STOP_LINE = "please stop the timer and wait for me"
ECHOED_LINE = "book a demo and send the details today"
ECHOED_COMMAND = "please stop the timer and wait"


class CountingEcho:
    """Wraps the shared classifier so a test can see it was the one used."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, text: str, agent_text: str) -> bool:
        self.calls += 1
        return is_echo(text, agent_text)


async def endless_audio():
    yield SentenceAudio(pcm=b"heard", sample_rate=24000, text=AGENT_LINE)
    await asyncio.Event().wait()


class FakeTTS:
    """Records the cut primitive: an echo must never reach it."""

    def __init__(self) -> None:
        self.cancels = 0
        self.closes = 0
        self.flush_id = None

    async def cancel(self):
        from cascade.assemblyai_tts import Cancellation

        self.cancels += 1
        return Cancellation()

    async def close(self) -> None:
        self.closes += 1


class EchoedPartialTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.classifier = CountingEcho()
        self.arbiter = FloorArbiter(
            clock=self.clock,
            ledger=self.ledger,
            is_echo_fn=self.classifier,
        )

    def test_the_agents_own_words_never_take_the_floor(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        decision = self.arbiter.arbitrate(
            ECHOED_COMMAND,
            barge_probability=0.9,
            agent_text=AGENT_STOP_LINE,
        )

        self.assertEqual("wait", decision.action)
        self.assertEqual(1, self.classifier.calls)
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_the_agents_own_words_are_never_a_command(self):
        self.arbiter.agent_thinks()

        decision = self.arbiter.arbitrate(
            "stop now", barge_probability=0.9, agent_text="stop now and listen"
        )

        self.assertEqual("wait", decision.action)
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_a_real_interruption_over_the_agent_still_takes_the_floor(self):
        # The control: the same shape of speech, but not the agent's words.
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        decision = self.arbiter.arbitrate(
            "book a demo", barge_probability=0.9, agent_text=AGENT_STOP_LINE
        )

        self.assertEqual("take_floor", decision.action)
        self.assertEqual(1, self.ledger.summary()["counts"]["yield"])

    def test_without_the_agent_line_the_same_partial_takes_the_floor(self):
        # No agent text proves nothing, so suppression fails closed.
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        decision = self.arbiter.arbitrate(ECHOED_COMMAND, barge_probability=0.9)

        self.assertEqual("take_floor", decision.action)


class EchoedFinalTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)
        self.gate = FinalGate(ledger=self.ledger, arbiter=self.arbiter)
        self.agent_line = [""]
        self.replies: list[str] = []

        async def on_reply(turn):
            self.replies.append(turn.final_text)
            async for _ in self.llm.complete(
                messages=[{"role": "user", "content": turn.final_text}]
            ):
                pass

        self.rules = EventRules(
            turns=self.turns,
            on_reply=on_reply,
            ledger=self.ledger,
            final_gate=self.gate,
            agent_text=lambda: self.agent_line[0],
        )

    def complete(self, text):
        async def drive():
            await self.rules.apply(SpeechStart("t1"))
            return await self.rules.apply(
                SpeechComplete(turn_id="t1", text=text)
            )

        return asyncio.run(drive())

    def test_the_agents_own_line_as_a_final_is_counted_and_not_answered(self):
        self.arbiter.agent_speaks()
        self.agent_line[0] = AGENT_LINE

        outcome = self.complete(ECHOED_LINE)

        self.assertEqual(FinalAction.SUPPRESSED, outcome.final.action)
        self.assertEqual(FinalReason.ECHO, outcome.final.reason)
        self.assertFalse(outcome.reply_requested)
        self.assertFalse(outcome.final.cancel)
        self.assertEqual([], self.replies)
        self.assertEqual([], self.llm.requests)
        self.assertEqual(1, self.ledger.summary()["counts"]["overheard"])
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_an_echo_final_never_takes_the_floor_from_the_speaking_agent(self):
        self.arbiter.agent_speaks()
        self.agent_line[0] = AGENT_STOP_LINE

        outcome = self.complete(ECHOED_COMMAND)

        self.assertFalse(outcome.final.cancel)
        self.assertTrue(self.arbiter.holds_floor)


class EndToEndEchoTest(unittest.TestCase):
    """The agent's whole line is played back: no cut, no reply, one classifier."""

    def test_played_back_speech_never_cuts_or_answers(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        turns = TurnStateStore(clock=clock, source="meta")
        tts = FakeTTS()
        arbiter = FloorArbiter(clock=clock, ledger=ledger)
        gate = FinalGate(ledger=ledger, arbiter=arbiter)
        llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        replies: list[str] = []
        agent_line = [AGENT_STOP_LINE]
        played = asyncio.Event()

        async def on_audio(chunk):
            played.set()

        path = BargeInCutPath(
            tts=tts,
            on_audio=on_audio,
            flush_playout=lambda flush: None,
            clock=clock,
            ledger=ledger,
        )

        async def on_reply(turn):
            replies.append(turn.final_text)
            async for _ in llm.complete(
                messages=[{"role": "user", "content": turn.final_text}]
            ):
                pass

        rules = EventRules(
            turns=turns,
            on_reply=on_reply,
            ledger=ledger,
            final_gate=gate,
            agent_text=lambda: agent_line[0],
        )

        async def scenario():
            arbiter.agent_speaks()
            clock.advance(2.0)
            path.start(endless_audio(), turn="turn-1", reply=AGENT_STOP_LINE)
            await played.wait()
            generation = path.generation

            # The caller's partial is the agent's own sentence played back.
            decision = arbiter.arbitrate(
                ECHOED_COMMAND,
                barge_probability=0.95,
                agent_text=agent_line[0],
            )
            if decision.action == "take_floor":  # the orchestrator's rule
                await path.cut("partial")

            await rules.apply(SpeechStart("t1"))
            outcome = await rules.apply(
                SpeechComplete(turn_id="t1", text=ECHOED_COMMAND)
            )
            if outcome.final.cancel:  # the only place a final may cut
                await path.cut("command")

            return (
                decision,
                outcome,
                generation,
                path.generation,
                path.reply_in_flight,
                path.cuts,
            )

        decision, outcome, generation, generation_after, in_flight, cuts = (
            asyncio.run(scenario())
        )

        self.assertEqual("wait", decision.action)
        self.assertEqual(EventKind.SPEECH_COMPLETE, outcome.kind)
        self.assertEqual(FinalAction.SUPPRESSED, outcome.final.action)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(0, tts.cancels)
        self.assertEqual(0, tts.closes)
        self.assertEqual((), cuts)
        self.assertEqual(generation, generation_after)
        self.assertTrue(in_flight)
        self.assertEqual([], replies)
        self.assertEqual([], llm.requests)
        self.assertEqual(1, ledger.summary()["counts"]["overheard"])
        self.assertEqual(0, ledger.summary()["counts"].get("interruption", 0))


class OneClassifierTest(unittest.TestCase):
    """One echo rule: the share comes from the browser, the port lives once."""

    def test_the_echo_share_still_matches_the_browser_judge(self):
        match = re.search(r"const ECHO_SHARE = ([0-9.]+);", BARGE_IN_TS.read_text())
        self.assertIsNotNone(match, "barge-in.ts no longer declares ECHO_SHARE")
        self.assertEqual(float(match.group(1)), ECHO_SHARE)

    def test_is_echo_is_defined_once_in_the_cascade(self):
        definitions = [
            path.name
            for path in CASCADE_DIR.glob("*.py")
            if re.search(r"^def is_echo\(", path.read_text(), re.MULTILINE)
        ]
        self.assertEqual(["floor.py"], definitions)

    def test_the_gate_and_the_arbiter_use_the_shared_rule(self):
        classifier = CountingEcho()
        arbiter = FloorArbiter(clock=FakeClock(), is_echo_fn=classifier)
        gate = FinalGate(is_echo_fn=classifier)
        arbiter.agent_speaks()

        arbiter.arbitrate(ECHOED_LINE, barge_probability=0.9, agent_text=AGENT_LINE)
        gate.classify(ECHOED_LINE, agent_text=AGENT_LINE)

        self.assertEqual(2, classifier.calls)


if __name__ == "__main__":
    unittest.main()
