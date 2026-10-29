"""The unheard tail resumes with zero model calls (ticket 90).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Resume. The tail located by ticket 89 is re-synthesized on a new
``flush_id`` through the same opened voice session (same voice, same language),
continuing the existing reply rather than starting a new answer. No model is
asked anything: the tail is speech, not a new completion. A new caller turn
that has already taken the floor cancels a stale resume.

The tail is spoken exactly once and never repeats the part the caller already
heard: word-level where the session's ``WordBoundaries`` are complete (ticket
51), the start of the sentence not fully played otherwise (ticket 89's rule).
The resume record is the seam the call ledger and the case table read.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import Cancellation, ResumeGranularity, ResumePoint
from cascade.barge_in import (
    BargeInCutPath,
    FillerResume,
    NoUnheardTailError,
    StaleResumeError,
    TailResume,
)
from cascade.test_tts_support import (
    audio_ms,
    begin,
    cancelled,
    flush_done,
    open_session,
    pcm_ms,
    sent_texts,
    sent_types,
    word_boundaries,
    words,
)
from cascade.testing.clock import FakeClock
from providers import SentenceAudio

SAMPLE_RATE = 24000
AGENT_LINE = "Hello there."


def reply_frames():
    """A live two-sentence reply, word-timed, so a cut is word-level."""
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
    ]


def run(scenario, timeout_s: float = 5.0):
    async def guarded():
        return await asyncio.wait_for(scenario(), timeout_s)

    return asyncio.run(guarded())


class CountingModel:
    """The one thing a resume must never touch: the model."""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, **_kwargs):
        self.calls += 1
        if False:  # pragma: no cover - an async generator with no yields
            yield None

    def prefetch(self, **_kwargs):
        self.calls += 1
        raise AssertionError("a resume must not prefetch a model request")


async def finished():
    """A producer that yields one frame and finishes."""
    yield SentenceAudio(pcm=b"answer", sample_rate=SAMPLE_RATE, text="An answer.")


class FakeTTS:
    """A synthesis session that records every request it is asked to speak."""

    def __init__(self, *, granularity=ResumeGranularity.WORD, text="there."):
        self.flush_id = None
        self.cancels = 0
        self.spoken: list[str] = []
        self.frames: asyncio.Queue = asyncio.Queue()
        self.resume = ResumePoint(
            granularity=granularity,
            text=text,
            flush_id=0,
            word_index=1 if granularity is ResumeGranularity.WORD else None,
            reason="fixture",
        )

    def feed(self, flush_id: int | None, pcm: bytes) -> None:
        self.frames.put_nowait((flush_id, pcm))

    def resume_point(self, played_ms: float) -> ResumePoint:
        return self.resume

    async def speak(self, text):
        self.spoken.append(text)
        while True:
            flush_id, pcm = await self.frames.get()
            if flush_id is None:
                return
            self.flush_id = flush_id
            yield SentenceAudio(pcm=pcm, sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancels += 1
        return Cancellation()


class Harness:
    """One cut path over a recording sink, with a pending filler plan."""

    def __init__(self, *, tts=None) -> None:
        self.tts = tts if tts is not None else FakeTTS()
        self.clock = FakeClock()
        self.played: list[bytes] = []
        self.flushes: list[object] = []
        self.played_event = asyncio.Event()
        self.model = CountingModel()
        self.path = BargeInCutPath(
            tts=self.tts,
            on_audio=self._on_audio,
            flush_playout=self._flush_playout,
            clock=self.clock,
        )

    async def _on_audio(self, chunk: SentenceAudio) -> None:
        self.played.append(chunk.pcm)
        self.played_event.set()

    async def _flush_playout(self, flush) -> None:
        self.flushes.append(flush)

    async def cut_with_tail(self, played_ms: float = 400) -> FillerResume:
        """Play one frame, cut, and return the filler plan carrying the tail."""
        self.path.start(finished(), turn="turn-1", reply=AGENT_LINE)
        await self.path.join()
        await self.path.cut("partial", speech_started_at=0.0, played_ms=played_ms)
        return await self.path.interrupt("backchannel")


class NewFlushIdTest(unittest.TestCase):
    def test_the_tail_is_resynthesized_on_the_sessions_new_flush_id(self):
        tts, factory = open_session(
            reply_frames()
            + [
                # Between Cancel and Cancelled: the old request's audio.
                audio_ms(120, flush_id=0),
                cancelled(audio_duration_seconds=0.12),
                # The vendor assigns the next request its new id.
                audio_ms(300, flush_id=5),
                flush_done(flush_id=5, audio_duration_ms=300),
                audio_ms(400, flush_id=6),
                flush_done(flush_id=6, audio_duration_ms=400),
            ]
        )
        harness = Harness(tts=tts)

        async def scenario():
            async for _ in tts.speak("Hello there. Friend."):
                pass
            harness.path.start(finished(), turn="turn-1", reply="Hello there. Friend.")
            await harness.path.join()
            await harness.path.cut("partial", speech_started_at=0.0, played_ms=400)
            plan = await harness.path.interrupt("backchannel")
            resume = await harness.path.resume(plan)
            await harness.path.join()
            return plan, resume

        plan, resume = run(scenario)

        self.assertIsInstance(resume, TailResume)
        self.assertEqual("there. Friend.", plan.text)
        # The original reply is sent per sentence; after Cancel only the tail
        # is generated, and its sentences join back to exactly the located tail.
        sent = sent_texts(factory)
        self.assertEqual(["Hello there. ", "Friend.", "there. ", "Friend."], sent)
        self.assertEqual(plan.text, "".join(sent[2:]))
        self.assertNotIn("Hello", "".join(sent[2:]))
        self.assertEqual(5, resume.flush_id)
        # The stale frame never reached the client; the tail did, once.
        self.assertEqual(pcm_ms(400), harness.played[-1])
        self.assertEqual(2, resume.frames)

    def test_the_resume_reuses_the_open_socket_so_voice_and_language_are_unchanged(
        self,
    ):
        tts, factory = open_session(
            reply_frames()
            + [
                cancelled(audio_duration_seconds=0.0),
                audio_ms(300, flush_id=5),
                flush_done(flush_id=5, audio_duration_ms=300),
                audio_ms(400, flush_id=6),
                flush_done(flush_id=6, audio_duration_ms=400),
            ]
        )
        harness = Harness(tts=tts)

        async def scenario():
            await anext_speak(tts, "Hello there. Friend.")
            harness.path.start(finished(), turn="turn-1", reply="Hello there. Friend.")
            await harness.path.join()
            await harness.path.cut("partial", speech_started_at=0.0, played_ms=400)
            resume = await harness.path.resume(
                await harness.path.interrupt("backchannel")
            )
            await harness.path.join()
            return resume

        resume = run(scenario)

        # One socket, one Begin: the re-synthesis is the same session speaking.
        self.assertEqual(1, len(factory.connections))
        self.assertFalse(factory.socket.closed)
        self.assertEqual("anna", tts.binding.voice_id)
        self.assertEqual("English", tts.binding.language)
        self.assertIn("voice_id=anna", factory.connections[0]["url"])
        self.assertIn("language=English", factory.connections[0]["url"])
        self.assertEqual(
            [
                "Generate",
                "Flush",
                "Generate",
                "Flush",
                "Cancel",
                "Generate",
                "Flush",
                "Generate",
                "Flush",
            ],
            sent_types(factory),
        )

    def test_a_resume_continues_the_same_reply_and_turn(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail()
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            await harness.path.join()
            return plan, resume

        plan, resume = run(scenario)

        self.assertEqual("turn-1", resume.turn)
        self.assertEqual(AGENT_LINE, resume.reply)
        self.assertEqual(plan.cut.seam.flush_id, resume.source_flush_id)
        self.assertEqual(plan.budget_ms, resume.budget_ms)
        self.assertFalse(resume.is_reply)
        self.assertTrue(resume.continues_reply)
        self.assertFalse(resume.starts_new_answer)


class GranularityTest(unittest.TestCase):
    def test_a_word_level_cut_resumes_from_the_first_unheard_word(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            await harness.path.join()
            return resume

        resume = run(scenario)

        self.assertIs(ResumeGranularity.WORD, resume.granularity)
        self.assertEqual("there.", resume.text)
        # The heard prefix is gone; only the offered repeat remains.
        self.assertNotIn("Hello", resume.text)

    def test_incomplete_boundaries_resume_from_the_sentence_start(self):
        async def scenario():
            harness = Harness(
                tts=FakeTTS(
                    granularity=ResumeGranularity.SENTENCE, text="Hello there. "
                )
            )
            plan = await harness.cut_with_tail(played_ms=400)
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            await harness.path.join()
            return resume

        resume = run(scenario)

        self.assertIs(ResumeGranularity.SENTENCE, resume.granularity)
        self.assertEqual("Hello there. ", resume.text)


class SpokenExactlyOnceTest(unittest.TestCase):
    def test_the_tail_is_spoken_once_and_a_second_resume_is_stale(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            await harness.path.join()
            refusal = None
            try:
                await harness.path.resume(plan)
            except StaleResumeError as error:
                refusal = error
            return harness, plan, resume, refusal

        harness, plan, resume, refusal = run(scenario)

        self.assertEqual(["there."], harness.tts.spoken)
        self.assertEqual([b"answer", b"tail"], harness.played)
        self.assertTrue(plan.resumed)
        self.assertIsInstance(refusal, StaleResumeError)
        self.assertIn("already", str(refusal))


class StaleResumeTest(unittest.TestCase):
    def test_a_new_caller_turn_cancels_a_stale_resume(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            harness.played_event.clear()
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail-start")
            await harness.played_event.wait()
            harness.played_event.clear()

            # The next caller turn wins: the stale tail must not keep playing.
            harness.path.start(finished(), turn="turn-2", reply="An answer.")
            await harness.path.join()
            return harness, plan, resume

        harness, plan, resume = run(scenario)

        self.assertTrue(resume.cancelled)
        self.assertEqual([b"answer", b"tail-start", b"answer"], harness.played)

    def test_a_second_barge_in_cancels_a_stale_resume(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail-start")
            await harness.played_event.wait()

            await harness.path.cut("partial", speech_started_at=0.0, played_ms=0)
            return resume

        resume = run(scenario)

        self.assertTrue(resume.cancelled)

    def test_a_cancelled_plan_is_never_spoken(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            plan.cancel()
            with self.assertRaises(StaleResumeError):
                await harness.path.resume(plan)
            return harness

        harness = run(scenario)

        self.assertEqual([], harness.tts.spoken)

    def test_a_whole_reply_has_no_tail_to_resume(self):
        tts, _ = open_session(
            reply_frames()
            + [
                audio_ms(400, flush_id=1),
                flush_done(flush_id=1, audio_duration_ms=400),
                word_boundaries(
                    flush_id=1,
                    audio_start_ms=700,
                    entries=words(("friend.", 700, 1100)),
                ),
            ]
        )
        harness = Harness(tts=tts)

        async def scenario():
            async for _ in tts.speak("Hello there. Friend."):
                pass
            harness.path.start(finished(), turn="turn-1", reply="Hello there. Friend.")
            await harness.path.join()
            await harness.path.cut(
                "partial", speech_started_at=0.0, played_ms=1100
            )
            plan = await harness.path.interrupt("backchannel")
            with self.assertRaises(NoUnheardTailError):
                await harness.path.resume(plan)
            return plan

        plan = run(scenario)

        self.assertEqual("", plan.text)
        self.assertFalse(plan.resumable)


class ZeroModelCallsTest(unittest.TestCase):
    def test_a_counting_model_sees_zero_calls_across_the_resume(self):
        async def scenario():
            harness = Harness()
            plan = await harness.cut_with_tail(played_ms=400)
            resume = await harness.path.resume(plan)
            harness.tts.feed(5, b"tail")
            harness.tts.feed(None, b"")
            await harness.path.join()
            return harness, resume

        harness, resume = run(scenario)

        self.assertEqual(0, harness.model.calls)
        self.assertEqual(0, resume.model_calls)


async def anext_speak(tts, text: str) -> None:
    async for _ in tts.speak(text):
        pass


if __name__ == "__main__":
    unittest.main()
