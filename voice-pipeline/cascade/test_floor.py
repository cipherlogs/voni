"""Tests for floor arbitration while the agent holds the floor (ticket 70).

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — Floor arbitration. While the agent holds the
floor (speaking, thinking or with a live reply), a caller partial is one of
three things: **take the floor**, **backchannel** (counted, never answered, no
cancel) or **wait**. Unsure input waits; the decision fails closed.

The vocabulary is take the floor / yield / wait — ``commit`` is not cascade
vocabulary. The command and filler sets are the existing ones in ``turns``;
this module invents no word list. The final is still the only reply trigger
(``cascade.event_rules``), so arbitration can cancel the agent's reply but can
never start one.

Every test injects the clock and the ledger and drives the public
``FloorArbiter``/``EventRules`` seams, so nothing reads the wall clock.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path

from cascade.event_rules import EventKind, EventRules
from cascade.floor import FloorArbiter, FloorHold
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.turn_state import TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript, TokenDelta
from turns import ESTABLISHED_MS, is_backchannel, is_command_overlap

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE = str(_REPO_ROOT / "telephony-bot")
sys.path.insert(0, _BRIDGE)
try:
    from voice_judge import (  # noqa: E402 - path bootstrap above
        classify_user_turn,
        heuristic_barge_in_score,
    )
finally:
    # Leave the path as we found it: a permanent bridge entry shadows
    # telephony-bot/server.py over voice-pipeline/server.py for later modules.
    sys.path.remove(_BRIDGE)

CASES_PATH = _REPO_ROOT / "voni" / "src" / "lib" / "voice" / "floor-cases.json"


def cases():
    return json.loads(CASES_PATH.read_text())["cases"]


class RecordingReplySink:
    """The reply seam: exactly one ``complete()`` per replied turn."""

    def __init__(self, llm):
        self.llm = llm
        self.turns = []

    async def __call__(self, turn):
        self.turns.append(turn.id)
        async for _ in self.llm.complete(
            messages=[{"role": "user", "content": turn.final_text}]
        ):
            pass


class TakeTheFloorTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = TimingLedger(now=self.clock)
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)

    def test_an_established_command_takes_the_floor_and_counts_a_yield(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        decision = self.arbiter.arbitrate("stop", barge_probability=0.45)

        self.assertEqual("take_floor", decision.action)
        self.assertEqual(FloorHold.SPEAKING, decision.hold)
        self.assertEqual("stop", decision.text)
        self.assertEqual(3000.0, decision.floor_held_ms)
        self.assertEqual(1, self.ledger.summary()["counts"]["yield"])
        self.assertEqual(0, self.ledger.summary()["counts"]["backchannel"])

    def test_a_multi_word_interruption_takes_the_floor_at_the_judge_threshold(self):
        self.arbiter.agent_speaks()
        self.clock.advance(2.0)

        decision = self.arbiter.arbitrate(
            "book a demo", barge_probability=0.72
        )

        self.assertEqual("take_floor", decision.action)

    def test_an_early_command_waits_for_the_talk_over_guard(self):
        self.arbiter.agent_speaks()
        self.clock.advance(0.2)

        decision = self.arbiter.arbitrate("stop", barge_probability=0.9)

        self.assertEqual("wait", decision.action)
        self.assertEqual(200.0, decision.floor_held_ms)
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_a_thinking_hold_is_already_established(self):
        self.arbiter.agent_thinks()

        decision = self.arbiter.arbitrate("stop", barge_probability=0.45)

        self.assertEqual("take_floor", decision.action)
        self.assertEqual(FloorHold.THINKING, decision.hold)

    def test_the_talk_over_window_is_not_reset_by_every_audio_frame(self):
        self.arbiter.agent_speaks()
        self.clock.advance(0.5)
        self.arbiter.agent_speaks()  # a per-frame caller must not postpone the cut
        self.clock.advance(0.4)

        decision = self.arbiter.arbitrate("stop", barge_probability=0.45)

        self.assertEqual(900.0, decision.floor_held_ms)
        self.assertEqual("take_floor", decision.action)

    def test_a_backchannel_is_counted_never_answered_and_does_not_cut(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        decision = self.arbiter.arbitrate("uh-huh", barge_probability=0.9)

        self.assertEqual("backchannel", decision.action)
        self.assertEqual(1, self.ledger.summary()["counts"]["backchannel"])
        self.assertEqual(0, self.ledger.summary()["counts"]["yield"])

    def test_unsure_input_waits_fail_closed(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        self.assertEqual(
            "wait", self.arbiter.arbitrate("price", barge_probability=0.45).action
        )
        self.assertEqual(
            "wait", self.arbiter.arbitrate("", barge_probability=0.9).action
        )
        self.assertEqual(
            "wait", self.arbiter.arbitrate("   ", barge_probability=0.9).action
        )

    def test_a_silent_agent_is_not_arbitrating_and_still_waits(self):
        decision = self.arbiter.arbitrate("book a demo", barge_probability=0.9)

        self.assertEqual("wait", decision.action)
        self.assertEqual(FloorHold.SILENT, decision.hold)
        self.assertEqual(0.0, decision.floor_held_ms)
        counts = self.ledger.summary()["counts"]
        self.assertEqual(0, counts["yield"])
        self.assertEqual(0, counts["backchannel"])

    def test_releasing_the_floor_returns_the_arbiter_to_silence(self):
        self.arbiter.agent_speaks()
        self.clock.advance(3.0)

        self.arbiter.agent_silent()

        self.assertFalse(self.arbiter.holds_floor)
        self.assertEqual(
            "wait", self.arbiter.arbitrate("stop", barge_probability=0.9).action
        )


class ArbitrationIsNotAReplyTest(unittest.TestCase):
    """A start or partial during the agent's reply is arbitration, never a reply.

    Ticket 70 pins the floor half; ticket 67's rule still holds: the
    ``speechComplete`` is the only event that may invoke the reply seam.
    """

    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.ledger = TimingLedger(now=self.clock)
        self.llm = ScriptedLLM([[Step(TokenDelta(text="Sure."))]])
        self.sink = RecordingReplySink(self.llm)
        self.rules = EventRules(
            turns=self.turns, ledger=self.ledger, on_reply=self.sink
        )
        self.arbiter = FloorArbiter(clock=self.clock, ledger=self.ledger)

    def assert_no_reply_yet(self):
        self.assertEqual([], self.sink.turns)
        self.assertEqual([], self.llm.requests)

    def test_a_speech_start_while_the_agent_speaks_is_arbitration_not_a_reply(self):
        self.arbiter.agent_speaks()
        self.clock.advance(1.0)

        outcome = asyncio.run(self.rules.apply(SpeechStart("t2")))
        decision = self.arbiter.arbitrate_speech_start()

        self.assertEqual(EventKind.SPEECH_START, outcome.kind)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual(FloorHold.SPEAKING, decision.hold)
        self.assertEqual("wait", decision.action)
        self.assertTrue(self.arbiter.holds_floor)
        self.assert_no_reply_yet()

    def test_a_backchannel_partial_keeps_the_floor_and_never_replies(self):
        self.arbiter.agent_speaks()
        asyncio.run(self.rules.apply(SpeechStart("t2")))
        self.clock.advance(2.0)
        asyncio.run(self.rules.apply(PartialTranscript("uh-huh")))

        decision = self.arbiter.arbitrate("uh-huh", barge_probability=0.9)

        self.assertEqual("backchannel", decision.action)
        self.assertTrue(self.arbiter.holds_floor)
        self.assertEqual(1, self.ledger.summary()["counts"]["backchannel"])
        self.assert_no_reply_yet()

    def test_only_the_completion_replies_after_a_command_took_the_floor(self):
        self.arbiter.agent_speaks()
        asyncio.run(self.rules.apply(SpeechStart("t2")))
        self.clock.advance(2.0)
        asyncio.run(self.rules.apply(PartialTranscript("stop")))

        taken = self.arbiter.arbitrate("stop", barge_probability=0.45)

        self.assertEqual("take_floor", taken.action)
        self.assertEqual(1, self.ledger.summary()["counts"]["yield"])
        self.assert_no_reply_yet()

        outcome = asyncio.run(
            self.rules.apply(SpeechComplete(turn_id="t2", text="stop"))
        )

        self.assertTrue(outcome.reply_requested)
        self.assertEqual(1, len(self.sink.turns))
        self.assertEqual(1, len(self.llm.requests))


class SharedFixtureParityTest(unittest.TestCase):
    """The cascade, the bridge judge and the browser judge read one table.

    ``voni/src/lib/voice/floor-cases.json`` is read by this file and by
    ``voni/src/lib/voice/floor-parity.test.ts``; neither side may widen a word
    list privately. The recorded verdicts are the external contract: a mapping
    that stops holding is drift, not a new expected value.
    """

    def test_every_case_classifies_into_the_existing_word_sets(self):
        for case in cases():
            self.assertEqual(
                case["command"], is_command_overlap(case["text"]), case["name"]
            )
            self.assertEqual(
                case["backchannel"], is_backchannel(case["text"]), case["name"]
            )

    def test_the_cascade_decision_matches_the_recorded_action(self):
        clock = FakeClock()
        arbiter = FloorArbiter(clock=clock)
        for case in cases():
            arbiter.agent_speaks()
            clock.advance(case["agentSpeakingMs"] / 1000.0)

            decision = arbiter.arbitrate(
                case["text"], barge_probability=case["judgeScore"]
            )
            arbiter.agent_silent()

            self.assertEqual(case["cascade"], decision.action, case["name"])

    def test_the_browser_verdict_maps_onto_the_cascade_action(self):
        allowed = {
            "yield": {"take_floor"},
            "ignore": {"backchannel", "wait"},
            "judge": {"take_floor", "wait"},
        }
        for case in cases():
            expected = allowed[case["tsVerdict"]]
            if case["agentSpeakingMs"] < ESTABLISHED_MS:
                # The browser judge has no talk-over window; the cascade waits
                # inside the existing establishment guard whatever it says.
                expected = expected | {"wait"}
            self.assertIn(
                case["cascade"],
                expected,
                f"{case['name']}: {case['tsVerdict']} -> {case['cascade']}",
            )

    def test_the_bridge_judge_agrees_on_the_score_and_the_floor(self):
        for case in cases():
            score = heuristic_barge_in_score(
                case["text"], case["agentSpeakingMs"]
            )
            self.assertEqual(case["judgeScore"], score, case["name"])

            decision, _ = classify_user_turn(
                case["text"], case["agentSpeakingMs"]
            )
            if decision == "yield":
                self.assertEqual("take_floor", case["cascade"], case["name"])
            else:
                self.assertIn(
                    case["cascade"], {"wait", "backchannel"}, case["name"]
                )

    def test_bare_assent_is_never_a_command_never_filler_and_never_a_cut(self):
        assent = [case for case in cases() if case.get("softConfirm")]
        self.assertEqual({"yes", "yeah"}, {case["text"] for case in assent})
        for case in assent:
            self.assertFalse(case["command"], case["name"])
            self.assertFalse(case["backchannel"], case["name"])
            self.assertEqual("wait", case["cascade"], case["name"])


if __name__ == "__main__":
    unittest.main()
