"""A filler interruption neither cuts the agent nor becomes a reply (ticket 91).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Filler. A filler interruption is a backchannel: no ``Cancel`` and no
reply. If audio was cut for another reason, the filler-resume contract still
applies and still makes zero LLM calls: the same reply's located tail (ticket
89) is carried forward, never restarted and never answered over. Ticket 90
speaks that tail on the synthesis session; this ticket owns the rule that a
filler is not a reply and the budget the resume is held to.

The filler-resume budget is ``fillerResumeTailMs`` from the frozen scoreboard
record, read through the one threshold registry. It is never re-declared here.

Every test injects the clock; the synthesis session is the real adapter over
recorded frames, so the recovered tail is the session's own word boundaries.
"""

import asyncio
import json
import unittest
from pathlib import Path

from cascade.barge_in import (
    FILLER_RESUME_BUDGET_MS,
    BargeInCut,
    BargeInCutPath,
    FillerResume,
)
from cascade.tts_support import (
    audio_ms,
    begin,
    flush_done,
    open_session,
    sent_types,
    word_boundaries,
    words,
)
from cascade.testing.clock import FakeClock
from cascade.thresholds import require_bound
from providers import SentenceAudio

SAMPLE_RATE = 24000
_REPO_ROOT = Path(__file__).resolve().parents[2]
BUDGETS_PATH = _REPO_ROOT / "voni" / "src" / "lib" / "demo" / "scoreboard-budgets.json"
AGENT_LINE = "Hello there. Friend."


def reply_frames():
    """A live two-sentence reply with its first sentence word-timed."""
    return [
        begin(),
        audio_ms(700, flush_id=0),
        flush_done(flush_id=0, audio_duration_ms=700),
        word_boundaries(
            flush_id=0,
            audio_start_ms=0,
            entries=words(("hello", 0, 300), ("there.", 300, 700)),
        ),
        audio_ms(400, flush_id=1),
        flush_done(flush_id=1, audio_duration_ms=400),
        word_boundaries(
            flush_id=1,
            audio_start_ms=700,
            entries=words(("friend.", 700, 1100)),
        ),
    ]


def live_session():
    """An open call whose reply has played once, so its tail can be located."""
    tts, factory = open_session(reply_frames())

    async def play():
        return [chunk async for chunk in tts.speak(AGENT_LINE)]

    asyncio.run(play())
    return tts, factory


async def endless_audio():
    """A reply producer that yields one chunk and then never finishes."""
    yield SentenceAudio(pcm=b"heard", sample_rate=SAMPLE_RATE, text=AGENT_LINE)
    await asyncio.Event().wait()


def run(scenario, timeout_s: float = 5.0):
    async def guarded():
        return await asyncio.wait_for(scenario(), timeout_s)

    return asyncio.run(guarded())


class Path:
    """One cut path over a recording sink, driven through the public seam."""

    def __init__(self, tts) -> None:
        self.tts = tts
        self.played: list[bytes] = []
        self.flushes: list[object] = []
        self.played_event = asyncio.Event()
        self.path = BargeInCutPath(
            tts=tts,
            on_audio=self._on_audio,
            flush_playout=self._flush_playout,
            clock=FakeClock(),
        )

    async def _on_audio(self, chunk: SentenceAudio) -> None:
        self.played.append(chunk.pcm)
        self.played_event.set()

    async def _flush_playout(self, flush) -> None:
        self.flushes.append(flush)


class FillerKeepsTheFloorTest(unittest.TestCase):
    def test_a_backchannel_sends_no_cancel_and_no_reply(self):
        tts, factory = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            generation = recorder.path.generation
            sent_before = sent_types(factory)
            result = await recorder.path.interrupt("backchannel")
            still_producing = recorder.path.reply_in_flight
            return generation, sent_before, result, still_producing

        generation, sent_before, plan, still_producing = run(scenario)

        self.assertIsInstance(plan, FillerResume)
        self.assertFalse(plan.is_reply)
        self.assertEqual(0, plan.model_calls)
        # The agent keeps speaking: no Cancel, no flush, no new generation.
        self.assertEqual(sent_types(factory), sent_before)
        self.assertNotIn("Cancel", sent_types(factory))
        self.assertEqual(generation, recorder.path.generation)
        self.assertTrue(still_producing)
        self.assertEqual([b"heard"], recorder.played)
        self.assertEqual([], recorder.flushes)

    def test_a_filler_is_never_counted_as_a_reply_turn(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            plan = await recorder.path.interrupt("backchannel")
            return plan

        plan = run(scenario)

        self.assertFalse(plan.is_reply)
        self.assertEqual("", plan.text)
        self.assertFalse(plan.resumable)

    def test_wait_changes_nothing(self):
        tts, factory = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            result = await recorder.path.interrupt("wait")
            return result, recorder.path.reply_in_flight

        result, still_producing = run(scenario)

        self.assertIsNone(result)
        self.assertNotIn("Cancel", sent_types(factory))
        self.assertTrue(still_producing)

    def test_an_unknown_action_is_refused_rather_than_treated_as_a_filler(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            return await recorder.path.interrupt("yield")

        with self.assertRaises(ValueError):
            run(scenario)


class FillerResumeTest(unittest.TestCase):
    def test_a_cut_for_another_reason_still_recovers_its_tail(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            cut = await recorder.path.cut("partial", played_ms=400)
            plan = await recorder.path.interrupt("backchannel")
            return cut, plan

        cut, plan = run(scenario)

        self.assertIsInstance(cut, BargeInCut)
        self.assertIsInstance(plan, FillerResume)
        self.assertEqual("there. Friend.", plan.text)
        self.assertTrue(plan.resumable)
        self.assertFalse(plan.is_reply)
        self.assertEqual(0, plan.model_calls)

    def test_a_filler_misclassified_as_a_real_cut_is_recovered(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            # The judge said "take the floor" for a backchannel: the cut is real.
            cut = await recorder.path.interrupt("take_floor", played_ms=400)
            plan = await recorder.path.interrupt("backchannel")
            return cut, plan

        cut, plan = run(scenario)

        self.assertIsInstance(cut, BargeInCut)
        self.assertEqual(1, len(tts.cancellations))
        self.assertIn("there.", plan.text)
        # The recovery never asks the model for a new answer.
        self.assertEqual(0, plan.model_calls)

    def test_the_budget_is_the_frozen_table_value_not_a_literal(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            await recorder.path.cut("partial", played_ms=400)
            return await recorder.path.interrupt("backchannel")

        plan = run(scenario)
        frozen = json.loads(BUDGETS_PATH.read_text())["budgets"]["fillerResumeTailMs"]

        self.assertEqual(float(require_bound("barge_in.filler_resume_tail_ms")), plan.budget_ms)
        self.assertEqual(frozen, plan.budget_ms)
        self.assertEqual(FILLER_RESUME_BUDGET_MS, plan.budget_ms)

    def test_a_real_reply_cancels_a_pending_filler_resume(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            await recorder.path.cut("partial", played_ms=400)
            plan = await recorder.path.interrupt("backchannel")
            recorder.path.start(endless_audio(), turn="turn-2", reply="A new answer.")
            return plan

        plan = run(scenario)

        self.assertTrue(plan.cancelled)
        self.assertFalse(plan.is_reply)

    def test_a_second_cut_supersedes_a_pending_filler_resume(self):
        tts, _ = live_session()
        recorder = Path(tts)

        async def scenario():
            recorder.path.start(endless_audio(), turn="turn-1", reply=AGENT_LINE)
            await recorder.played_event.wait()
            await recorder.path.cut("partial", played_ms=400)
            plan = await recorder.path.interrupt("backchannel")
            await recorder.path.cut("command", played_ms=120)
            return plan

        plan = run(scenario)

        self.assertTrue(plan.cancelled)


if __name__ == "__main__":
    unittest.main()
