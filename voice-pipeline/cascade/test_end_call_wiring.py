"""The served stream finishes an ``end_call``: close the line, end the call.

Ticket 87 makes ``end_call`` call control. Ticket 75's lifecycle is the one that
sends the end message, so the turn stream must hand the signal to it after the
bound voice spoke the model's closing line. Nothing speakable follows the
signal: the model's later tokens, and any later final, produce no audio.

Seam: :class:`cascade.turn_stream.CascadeTurnStream` and
:class:`cascade.call.CallLifecycle`. Both a stream-only test and one live call
are pinned; deleting either wiring fails by name.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.call import CallLifecycle, OpenedLeg
from cascade.meta_llm import MetaLLMTurn, MetaToolCall, TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    FakeVoice,
    RecordingAudioSink,
    signed_message,
)
from cascade.test_second_failure import LiveTransport
from cascade.testing import FakeClock, ScriptedSTT
from cascade.tools import END_CALL_TOOL, EndCallSignal
from cascade.turn_stream import CascadeTurnStream
from metrics import TimingLedger
from providers import TokenDelta, ToolCallRequest

CLOSING = "Thanks for calling. Goodbye!"


class EndCallModel:
    """A model that calls ``end_call`` and keeps generating after the signal."""

    def __init__(self) -> None:
        self.requests: list[list[dict]] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.requests.append(messages)
        record = turn if turn is not None else MetaLLMTurn()
        call = MetaToolCall(
            0,
            "call_end",
            END_CALL_TOOL,
            '{"closing_line": "%s"}' % CLOSING,
        )
        record.tool_calls.append(call)
        yield ToolCallRequest(
            name=END_CALL_TOOL,
            arguments={"closing_line": CLOSING},
            call_id="call_end",
        )
        record.content_text += "This must never be spoken."
        yield TokenDelta(text=" This must never be spoken.")
        record.finish_reason = "tool_calls"
        record.usage = TurnUsage(prompt_tokens=4, completion_tokens=5)
        record.finished = True


class EndCallExecutor:
    async def execute(self, call):
        return EndCallSignal(
            call_id=CALL_ID,
            tool_call_id=call.call_id,
            closing_line=call.arguments["closing_line"],
        )


class SpeakRecorder(FakeVoice):
    """The opened voice: the greeting path plus the reply/closing path."""

    def __init__(self) -> None:
        super().__init__()
        self.spoken: list[str] = []

    async def speak(self, text: str):
        from providers import SentenceAudio

        self.spoken.append(text)
        for chunk in (b"\x30\x00", b"\x31\x00"):
            yield SentenceAudio(pcm=chunk, sample_rate=24000, text=text)


class EndCallLifecycleTest(unittest.TestCase):
    def test_end_call_speaks_the_line_then_drains_and_sends_the_end_message(self):
        clock = FakeClock()
        voice = SpeakRecorder()
        llm = EndCallModel()
        audio = RecordingAudioSink()
        transport = LiveTransport()

        async def open_speech(_body):
            return OpenedLeg(
                "stt",
                "meta",
                "primary",
                "speech leg",
                ScriptedSTT(
                    [
                        SpeechStart("t1"),
                        SpeechComplete("that's all", turn_id="t1"),
                    ],
                    clock=clock,
                ),
            )

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "voice leg", voice)

        holder: dict[str, CallLifecycle] = {}

        async def emit_audio(audio_frame, *, kind="reply", flush_id=None):
            return await holder["lifecycle"].emit_audio(
                audio_frame, kind=kind, flush_id=flush_id
            )

        async def request_end() -> None:
            holder["lifecycle"].request_end("end_call")

        stream = CascadeTurnStream(
            llm=llm,
            tts=voice,
            emit_audio=emit_audio,
            tool_executor=EndCallExecutor(),
            ledger=TimingLedger(now=clock),
            clock=clock,
            on_end_call=request_end,
        )
        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=audio,
            ledger=TimingLedger(now=clock),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
        )
        holder["lifecycle"] = lifecycle

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))

        self.assertEqual("stop", end.ended_by)
        self.assertEqual([CLOSING], voice.spoken)
        self.assertIsNone(end.goodbye, "an end_call is not a second-failure goodbye")
        self.assertEqual(1, len(llm.requests))
        self.assertEqual(1, end.turns)
        self.assertEqual("end", transport.sent[-1]["type"])
        self.assertTrue(transport.closed)


if __name__ == "__main__":
    unittest.main()
