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

    def make(self, *, replies, tts=None, executor=None):
        self.llm = ScriptedLLM(replies)
        self.tts = FakeTTS() if tts is None else tts
        stream = CascadeTurnStream(
            llm=self.llm,
            tts=self.tts,
            tools=({"type": "function", "function": {"name": "check_email"}},),
            emit_audio=self.audio,
            tool_executor=executor,
            ledger=RecordingLedger(),
            clock=self.clock,
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


if __name__ == "__main__":
    unittest.main()
