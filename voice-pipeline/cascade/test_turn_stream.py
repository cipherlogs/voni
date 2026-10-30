"""The cascade turn stream: provider events in, spoken replies out.

Seam: :class:`cascade.turn_stream.CascadeTurnStream` is the ``CallStream`` the
browser call now serves. It composes the pieces the cascade already owns —
``EventRules`` for the provider-owned turn boundary, ``MetaLLM.complete`` for
the reply, the synthesis session's ``speak`` for audio, and the call
lifecycle's ``emit_audio`` for the one call-level sequence.

The tests drive the stream with the events a real Meta speech adapter yields
and assert what the caller hears, not how the stream is wired internally. The
one internal that is a contract is the barge-in ``Cancel``: the synthesis
session must be told to stop, and the reply task must stop pulling audio.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.call import OutboundAudio
from cascade.meta_llm import MetaLLMTurn, TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechEnd, SpeechStart
from cascade.testing import FakeClock
from cascade.tools import ToolResult
from cascade.turn_stream import CascadeTurnStream
from providers import SentenceAudio, TokenDelta, ToolCallRequest


class ScriptedLLM:
    """One canned completion per call; the second call is the tool answer."""

    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.requests: list[list[dict]] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.requests.append(messages)
        reply = self.replies.pop(0)
        record = turn if turn is not None else MetaLLMTurn()
        for text in reply["deltas"]:
            record.content_text += text
            yield TokenDelta(text=text)
        for call in reply.get("calls", ()):
            record.tool_calls.append(call)
            yield ToolCallRequest(
                name=call.name, arguments={"code": "1"}, call_id=call.call_id
            )
        record.finish_reason = reply.get("finish_reason", "stop")
        record.usage = reply.get("usage", TurnUsage(prompt_tokens=4, completion_tokens=5))
        record.finished = True


class FakeTTS:
    """The opened synthesis session: one replayed frame per sentence."""

    def __init__(self, gate: asyncio.Event | None = None) -> None:
        self.gate = gate
        self.spoken: list[str] = []
        self.cancels = 0
        self.closed = False
        self.speaking = asyncio.Event()

    async def speak(self, text: str):
        self.spoken.append(text)
        self.speaking.set()
        yield SentenceAudio(pcm=text.encode("utf-8")[:8], sample_rate=24000, text=text)
        if self.gate is not None:
            await self.gate.wait()

    async def cancel(self):
        self.cancels += 1

    async def close(self) -> None:
        self.closed = True


class RecordingLedger:
    """The timing ledger seam: marks are irrelevant here, so count nothing."""

    def mark(self, _name: str) -> None:
        return None


class RecordingAudio:
    def __init__(self) -> None:
        self.frames: list[OutboundAudio] = []

    async def __call__(self, audio: SentenceAudio, *, kind="reply", flush_id=None):
        frame = OutboundAudio(
            seq=len(self.frames) + 1,
            epoch=0,
            pcm=audio.pcm,
            sample_rate=audio.sample_rate,
            kind=kind,
            flush_id=flush_id,
        )
        self.frames.append(frame)
        return frame


class FakeToolExecutor:
    def __init__(self) -> None:
        self.calls = []

    async def execute(self, call):
        self.calls.append(call)
        return ToolResult(name=call.name, tool_call_id=call.call_id,
                          payload={"ok": True, "email": "one unread"})


class StreamTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.audio = RecordingAudio()

    def make(
        self,
        *,
        replies,
        tts=None,
        executor=None,
        may_request=None,
        sleep=None,
        stall_guard_ms=None,
        on_end_call=None,
    ):
        self.llm = ScriptedLLM(replies)
        self.tts = FakeTTS() if tts is None else tts
        stream = CascadeTurnStream(
            llm=self.llm,
            tts=self.tts,
            tools=({"type": "function", "function": {"name": "check_email"}},),
            emit_audio=self.audio,
            may_request=may_request,
            tool_executor=executor,
            ledger=RecordingLedger(),
            clock=self.clock,
            sleep=sleep,
            stall_guard_ms=stall_guard_ms,
            on_end_call=on_end_call,
        )
        return stream

    def run_events(self, stream, events):
        async def run():
            await stream.start()
            for event in events:
                await stream.event(event)
            await stream.drain()

        asyncio.run(run())

    def test_a_completion_is_answered_and_spoken_through_the_call_audio_seam(self):
        stream = self.make(replies=[{"deltas": ["Hello there. ", "How can I help?"]}])
        self.run_events(
            stream,
            [
                SpeechStart("t1"),
                SpeechComplete("book a demo", turn_id="t1"),
            ],
        )

        # Each sentence was handed to synthesis and its audio put on the wire.
        self.assertEqual(["Hello there.", "How can I help?"], self.tts.spoken)
        self.assertEqual(2, len(self.audio.frames))
        self.assertEqual("reply", self.audio.frames[0].kind)
        # The model saw the authoritative final, never a partial.
        self.assertEqual("book a demo", self.llm.requests[0][0]["content"])
        self.assertEqual(1, stream.turn_count())
        self.assertEqual(
            4, stream.turn_usage()["0:t1"].prompt_tokens
        )

    def test_a_speech_end_alone_never_asks_the_model(self):
        stream = self.make(replies=[{"deltas": ["unused"]}])
        self.run_events(
            stream, [SpeechStart("t1"), SpeechEnd(turn_id="t1")]
        )

        self.assertEqual([], self.llm.requests)
        self.assertEqual(0, stream.turn_count())
        self.assertEqual({}, stream.turn_usage())

    def test_a_speech_start_while_speaking_cancels_the_voice(self):
        gate = asyncio.Event()
        stream = self.make(replies=[{"deltas": ["A long reply. And more."]}],
                           tts=FakeTTS(gate=gate))

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            await asyncio.wait_for(stream._tts.speaking.wait(), timeout=1)
            await stream.event(SpeechStart("t2"))
            self.assertEqual(1, stream._tts.cancels)
            gate.set()
            await stream.drain()

        asyncio.run(run())

    def test_a_tool_call_runs_through_the_executor_and_the_same_turn_continues(self):
        from cascade.meta_llm import MetaToolCall

        executor = FakeToolExecutor()
        stream = self.make(
            replies=[
                {
                    "deltas": [""],
                    "finish_reason": "tool_calls",
                    "calls": [MetaToolCall(0, "c1", "check_email", '{"code": "1"}')],
                },
                {"deltas": ["One unread email."]},
            ],
            executor=executor,
        )
        self.run_events(
            stream,
            [SpeechStart("t1"), SpeechComplete("check my email", turn_id="t1")],
        )

        self.assertEqual(1, len(executor.calls))
        self.assertEqual("check_email", executor.calls[0].name)
        self.assertEqual(["One unread email."], self.tts.spoken)
        self.assertEqual(1, stream.turn_count())


class KeepaliveTTS(FakeTTS):
    """The opened synthesis session, with the idle keepalive seam counted."""

    def __init__(self, gate: asyncio.Event | None = None, clock=None) -> None:
        super().__init__(gate)
        self.keepalive_calls = 0
        self.keepalives = 0
        self.keepalive_at: list[float] = []
        self.clock = clock

    async def keepalive_if_idle(self) -> None:
        self.keepalive_calls += 1
        self.keepalives += 1
        if self.clock is not None:
            self.keepalive_at.append(self.clock())


class FlipGate:
    """The call's request gate: the first sentence's audio flips the LLM leg."""

    def __init__(self) -> None:
        self.llm_open = True

    def __call__(self, leg: str) -> bool:
        return self.llm_open if leg == "llm" else True


class FlipTTS(FakeTTS):
    """The voice that closes the LLM leg once its first sentence is spoken."""

    def __init__(self, gate: FlipGate) -> None:
        super().__init__()
        self.flip = gate

    async def speak(self, text: str):
        self.flip.llm_open = False
        async for audio in super().speak(text):
            yield audio


class EndCallLLM:
    """A model that calls ``end_call`` and keeps generating after the signal."""

    def __init__(self, closing_line: str) -> None:
        self.closing_line = closing_line
        self.requests: list[list[dict]] = []

    async def complete(self, *, messages, tools=None, turn=None):
        from cascade.meta_llm import MetaToolCall
        from cascade.tools import END_CALL_TOOL

        self.requests.append(messages)
        record = turn if turn is not None else MetaLLMTurn()
        call = MetaToolCall(
            0,
            "call_end",
            END_CALL_TOOL,
            '{"closing_line": "%s"}' % self.closing_line,
        )
        record.tool_calls.append(call)
        yield ToolCallRequest(
            name=END_CALL_TOOL,
            arguments={"closing_line": self.closing_line},
            call_id="call_end",
        )
        # Anything the model generates after the end-call signal is not speech.
        record.content_text += "This must never be spoken."
        yield TokenDelta(text=" This must never be spoken.")
        record.finish_reason = "tool_calls"
        record.usage = TurnUsage(prompt_tokens=4, completion_tokens=5)
        record.finished = True


class EndCallExecutor:
    async def execute(self, call):
        from cascade.tools import EndCallSignal

        return EndCallSignal(
            call_id="call", tool_call_id=call.call_id,
            closing_line=call.arguments["closing_line"],
        )


class ClosingThenAnswerLLM(EndCallLLM):
    """Calls ``end_call`` once, then answers the caller's next turn."""

    async def complete(self, *, messages, tools=None, turn=None):
        if not self.requests:
            async for item in super().complete(
                messages=messages, tools=tools, turn=turn
            ):
                yield item
            return
        self.requests.append(messages)
        record = turn if turn is not None else MetaLLMTurn()
        answer = "Sure, I am still here."
        record.content_text += answer
        yield TokenDelta(text=answer)
        record.finish_reason = "stop"
        record.usage = TurnUsage(prompt_tokens=4, completion_tokens=5)
        record.finished = True


async def until(predicate, *, tries: int = 200) -> None:
    """Yield to the loop until a condition holds; no wall-clock sleep."""
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("the expected state was never reached")


class StallGuardTickerTest(unittest.TestCase):
    """The held final is answered by the guard's ticker, not a model timeout."""

    def test_a_held_final_is_answered_when_the_stall_guard_ticks(self):
        from cascade.thresholds import require_bound

        guard_ms = float(require_bound("turn.stall_guard_ms"))
        clock = FakeClock()
        audio = RecordingAudio()
        llm = ScriptedLLM([{"deltas": ["Answering the second caller turn."]}])
        stream = CascadeTurnStream(
            llm=llm,
            tts=FakeTTS(),
            emit_audio=audio,
            ledger=RecordingLedger(),
            clock=clock,
            sleep=clock.sleep,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechStart("t2"))
            await stream.event(SpeechComplete("the second turn", turn_id="t2"))
            # The ticker advances the injected clock to the guard's deadline;
            # no wall-clock sleep is involved.
            for _ in range(100):
                if audio.frames:
                    break
                await asyncio.sleep(0)
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(1, len(llm.requests), "the held final was never answered")
        self.assertEqual("the second turn", llm.requests[0][0]["content"])
        order = stream._rules.reply_order
        self.assertEqual(1, len(order.abandonments))
        self.assertEqual(guard_ms, order.abandonments[0].waited_ms)
        self.assertEqual(guard_ms, order.answered[0].waited_ms)

    def test_no_stall_ticker_runs_until_start(self):
        clock = FakeClock()
        stream = CascadeTurnStream(
            llm=ScriptedLLM([]),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=clock,
            sleep=clock.sleep,
        )
        self.assertIsNone(stream._tick_task)
        asyncio.run(stream.drain())
        self.assertIsNone(stream._tick_task)


class KeepaliveTickerTest(unittest.TestCase):
    """The synthesis session's idle keepalive is driven by a ticker."""

    def test_the_keepalive_is_sent_on_the_recorded_interval_while_idle(self):
        from cascade.thresholds import require_bound

        interval = float(require_bound("tts.keepalive_interval_ms")) / 1000.0
        clock = FakeClock()
        tts = KeepaliveTTS(clock=clock)
        stream = CascadeTurnStream(
            llm=ScriptedLLM([]),
            tts=tts,
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=clock,
            sleep=clock.sleep,
        )

        async def run():
            await stream.start()
            for _ in range(100):
                if tts.keepalives:
                    break
                await asyncio.sleep(0)
            await stream.drain()

        asyncio.run(run())

        self.assertGreaterEqual(tts.keepalives, 1)
        self.assertEqual(interval, tts.keepalive_at[0], "the recorded interval")
        self.assertTrue(
            all(
                later - earlier == interval
                for earlier, later in zip(tts.keepalive_at, tts.keepalive_at[1:])
            )
        )

    def test_no_keepalive_is_sent_while_a_reply_is_sounding(self):
        clock = FakeClock()
        gate = asyncio.Event()
        tts = KeepaliveTTS(gate=gate)
        stream = CascadeTurnStream(
            llm=ScriptedLLM([{"deltas": ["A long reply. And more."]}]),
            tts=tts,
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=clock,
            sleep=clock.sleep,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            await asyncio.wait_for(tts.speaking.wait(), timeout=1)
            before = tts.keepalive_calls
            # The ticker runs on the same virtual interval; while the reply is
            # in flight it must skip the keepalive instead of sending it.
            for _ in range(100):
                if stream.keepalives_skipped:
                    break
                await asyncio.sleep(0)
            gate.set()
            await stream.drain()
            return before

        before = asyncio.run(run())

        self.assertGreaterEqual(stream.keepalives_skipped, 1)
        self.assertEqual(before, tts.keepalive_calls)


class LegGateTest(unittest.TestCase):
    """The model request is gated on the LLM leg; audio still drains."""

    def test_audio_already_generated_drains_after_the_llm_leg_closes(self):
        gate = FlipGate()
        audio = RecordingAudio()
        stream = CascadeTurnStream(
            llm=ScriptedLLM([{"deltas": ["One. ", "Two."]}]),
            tts=FlipTTS(gate),
            emit_audio=audio,
            may_request=gate,
            ledger=RecordingLedger(),
            clock=FakeClock(),
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("say two sentences", turn_id="t1"))
            await stream.drain()
            # A later final may not ask a closed LLM leg for another reply.
            await stream.event(SpeechStart("t2"))
            await stream.event(SpeechComplete("one more", turn_id="t2"))
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["One.", "Two."], stream._tts.spoken)
        self.assertEqual(2, len(audio.frames), "the second sentence was cut")
        self.assertEqual(1, len(stream._llm.requests))


class EndCallSignalTest(unittest.TestCase):
    """``end_call`` is spoken, ends the turn and asks the call to hang up."""

    def test_the_closing_line_is_spoken_after_the_signal_and_nothing_else(self):
        closing = "Thanks for calling. Goodbye!"
        ended: list[str] = []

        async def on_end_call() -> None:
            ended.append("end")

        audio = RecordingAudio()
        stream = CascadeTurnStream(
            llm=EndCallLLM(closing),
            tts=FakeTTS(),
            emit_audio=audio,
            tool_executor=EndCallExecutor(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            on_end_call=on_end_call,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("that's all", turn_id="t1"))
            await stream.drain()
            await stream.event(SpeechStart("t2"))
            await stream.event(SpeechComplete("one more", turn_id="t2"))
            await stream.drain()

        asyncio.run(run())

        self.assertEqual([closing], stream._tts.spoken)
        self.assertEqual(["end"], ended)
        self.assertEqual(1, len(stream._llm.requests))

    def test_a_barge_in_during_the_goodbye_keeps_listening_and_never_hangs_up(self):
        closing = "Thanks for calling. Goodbye!"
        gate = asyncio.Event()
        ended: list[str] = []
        audio = RecordingAudio()
        tts = FakeTTS(gate=gate)
        llm = ClosingThenAnswerLLM(closing)

        async def on_end_call() -> None:
            ended.append("end")

        stream = CascadeTurnStream(
            llm=llm,
            tts=tts,
            emit_audio=audio,
            tool_executor=EndCallExecutor(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            on_end_call=on_end_call,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("that's all", turn_id="t1"))
            # The closing line is sounding, suspended mid-frame: the caller
            # talks over the goodbye.
            await asyncio.wait_for(tts.speaking.wait(), timeout=1)
            await until(lambda: stream._speaking)
            await stream.event(SpeechStart("t2"))
            gate.set()
            # The caller's next turn still gets its reply.
            await stream.event(
                SpeechComplete("wait, one more question", turn_id="t2")
            )
            await until(
                lambda: len(llm.requests) == 2 and len(audio.frames) >= 2
            )
            await stream.drain()

        asyncio.run(run())

        self.assertEqual([], ended, "a barge-in during the goodbye still hung up")
        self.assertEqual([closing, "Sure, I am still here."], tts.spoken)
        self.assertEqual(2, len(audio.frames))


if __name__ == "__main__":
    unittest.main()
