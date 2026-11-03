"""The caller's floor: a final is answered only once their audio is quiet.

Owner direction 2026-11-03: never take the floor while the caller is still
speaking. The committed ``soften`` take (``emotion-hostile``) says "Fine." and
then, after a 340 ms internal pause, "I just want to know when you open."; the
recogniser finalises each half on its own. Answering the first half was a
non-answer to a fragment, so a final now waits for ``turn.hold_silence_ms`` of
quiet caller audio (bounded by ``turn.hold_max_ms``) before the model request
starts. If the caller resumes, the held fragment is dropped and carried into
the next final: one turn, one reply, the whole sentence.

Seam: the public event seam plus ``CascadeTurnStream.caller_audio``, which the
call's pump feeds every frame. The script below moves the injected clock in
fixed virtual steps, so "the caller resumes inside the quiet window" is a
scripted fact rather than a scheduling race. No wall-clock time passes.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_turn_stream import FakeTTS, RecordingAudio, ScriptedLLM
from cascade.testing import FakeClock
from cascade.thresholds import require_bound
from cascade.turn_stream import CascadeTurnStream
from metrics import TimingLedger

#: The scripted driver's step. It is the harness's pacing, never a product
#: bound; a scripted event lands within one step of its named time.
STEP_S = 0.001

#: How often the scripted caller produces a speech frame while it keeps
#: talking. Harness pacing again, used as the tolerance of a bounded wait.
SPEECH_STEP_S = 0.010

#: The committed take's measured internal pause after "Fine.".
TAKE_PAUSE_S = 0.340

#: The whole first turn of the committed take, as the recogniser hands it over.
FIRST_FRAGMENT = "Fine."
WHOLE_SENTENCE = "I just want to know when you open."


class ClockSleep:
    """A sleep measured on the injected clock; the test owns the time.

    It waits by yielding, so a script can stop the clock mid-window and put an
    event inside it. Each test advances the clock in :data:`STEP_S` steps.
    """

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock

    async def __call__(self, seconds: float) -> None:
        deadline = self.clock() + max(0.0, seconds)
        while self.clock() < deadline:
            await asyncio.sleep(0)


async def advance(clock: FakeClock, seconds: float) -> None:
    """Move the injected clock ``seconds`` forward, a step at a time."""
    end = clock() + seconds
    while clock() < end:
        clock.advance(min(STEP_S, end - clock()))
        await asyncio.sleep(0)


async def until(predicate, *, tries: int = 20000) -> None:
    """Yield to the loop until a condition holds; no wall-clock sleep."""
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("the expected state was never reached")


class TimedLLM(ScriptedLLM):
    """The scripted model, recording the virtual time each request started."""

    def __init__(self, replies, clock: FakeClock) -> None:
        super().__init__(replies)
        self.clock = clock
        self.requested_at: list[float] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.requested_at.append(self.clock())
        async for item in super().complete(
            messages=messages, tools=tools, turn=turn
        ):
            yield item


class TurnHoldTests(unittest.TestCase):
    def make(self, *, replies, ack_lines=(), ack_delay_ms=None):
        self.clock = FakeClock()
        self.audio = RecordingAudio()
        self.llm = TimedLLM(replies, self.clock)
        self.tts = FakeTTS()
        self.stream = CascadeTurnStream(
            llm=self.llm,
            tts=self.tts,
            emit_audio=self.audio,
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            sleep=ClockSleep(self.clock),
            ack_lines=ack_lines,
            ack_delay_ms=ack_delay_ms,
        )
        return self.stream

    def test_a_final_in_the_takes_340_ms_pause_yields_one_reply(self):
        stream = self.make(replies=[{"deltas": ["I open at nine."]}])

        async def run():
            await stream.start()
            # The caller starts "Fine." at t=0; the recogniser finalises it
            # just after the words stop, with the pause still ahead.
            stream.caller_audio(speech=True)
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(FIRST_FRAGMENT, turn_id="t1"))
            await advance(self.clock, TAKE_PAUSE_S)
            # The pause ends and the caller completes the sentence.
            stream.caller_audio(speech=True)
            await stream.event(SpeechStart("t2"))
            # The second final arrives after the recogniser's own endpointing.
            await advance(self.clock, 0.6)
            await stream.event(SpeechComplete(WHOLE_SENTENCE, turn_id="t2"))
            await until(lambda: self.tts.spoken)
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(1, len(self.llm.requests), "one reply, not two")
        self.assertEqual(
            f"{FIRST_FRAGMENT} {WHOLE_SENTENCE}",
            self.llm.requests[0][0]["content"],
            "the merged final answers the whole sentence",
        )
        self.assertEqual(1, stream.turn_count())
        self.assertEqual(["I open at nine."], self.tts.spoken)
        self.assertEqual(1, stream.hold_dropped, "the fragment was not answered")

    def test_a_final_after_a_normal_pause_is_answered_with_no_added_wait(self):
        stream = self.make(replies=[{"deltas": ["I can help with that."]}])

        async def run():
            await stream.start()
            stream.caller_audio(speech=True)
            await stream.event(SpeechStart("t1"))
            # The recogniser's endpointing is longer than the quiet window, so
            # the final is already late enough: no hold, no added latency.
            await advance(self.clock, 0.9)
            await stream.event(SpeechComplete("I need help.", turn_id="t1"))
            await until(lambda: self.llm.requested_at)
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(0, stream.holds, "a normal final must not be held")
        self.assertEqual(0.0, stream.hold_waited_ms)
        self.assertEqual([0.9], self.llm.requested_at, "the request was not delayed")

    def test_a_caller_who_never_goes_quiet_is_answered_within_the_bound(self):
        bound_ms = float(require_bound("turn.hold_max_ms"))
        stream = self.make(replies=[{"deltas": ["Let me answer that."]}])

        async def run():
            await stream.start()
            stream.caller_audio(speech=True)
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(FIRST_FRAGMENT, turn_id="t1"))
            # The caller keeps making sound, so the quiet window never opens.
            while not self.llm.requested_at and self.clock() < 5.0:
                stream.caller_audio(speech=True)
                await advance(self.clock, SPEECH_STEP_S)
            await until(lambda: self.tts.spoken)
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(1, len(self.llm.requests), "the stalled caller is answered")
        # One scripted speech step is the only slack: the bound is the bound.
        self.assertLessEqual(
            stream.hold_waited_ms, bound_ms + SPEECH_STEP_S * 1000.0
        )
        self.assertGreater(stream.hold_waited_ms, 0.0)

    def test_no_ack_is_spoken_over_a_caller_whose_audio_is_still_arriving(self):
        stream = self.make(
            replies=[{"deltas": ["I open at nine."]}],
            ack_lines=("Mhm.",),
            ack_delay_ms=50,
        )

        async def run():
            await stream.start()
            stream.caller_audio(speech=True)
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(FIRST_FRAGMENT, turn_id="t1"))
            # Past the ack's delay, the caller is still speaking.
            while self.clock() < 0.3:
                stream.caller_audio(speech=True)
                await advance(self.clock, SPEECH_STEP_S)
            await advance(self.clock, 0.5)
            await until(lambda: self.tts.spoken)
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I open at nine."], self.tts.spoken)
