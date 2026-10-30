"""Ticket 87 (end call): call control, the closing line and the hangup.

Spec: `.scratch/meta-cascade/spec.md` "Tools: HTTP execution, idempotency,
narration hold" — End call. ``end_call`` is call control, never an HTTP tool. It
speaks the closing line through the same synthesis path the reply uses, ends
the turn and arms the one-shot hangup; a barge-in during the goodbye disarms the
hangup and the caller wins. An ``end_call`` without a closing line is denied and
recorded, never half-executed.

Seams under test:

* ``ToolExecutor.start`` -> the route and the outcome. Catches an ``end_call``
  that becomes an HTTP request, a signal with no closing line and a denial that
  is not recorded on the turn.
* ``CallClosing.speak`` -> the voice session, the audio sink and the logical
  turn. Catches a second synthesis path, a hangup armed before the line played,
  and a turn that never ends.
* ``CallClosing.barge_in`` -> the disarm. Catches a hangup that fires after the
  caller took the floor back, and a stale frame played over the caller.
"""

import asyncio
import unittest

from cascade.assemblyai_tts import Cancellation
from cascade.barge_in import BargeInCutPath
from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall, ToolDenial
from cascade.testing import FakeClock, Response, ScriptedSessionFactory
from cascade.testing.scripted import ScriptedLLM, ScriptedTTS
from cascade.tools import (
    END_CALL_TOOL,
    TOOL_CLOSING_LINE_MISSING,
    CallClosing,
    DeniedCall,
    EndCallDenied,
    EndCallSignal,
    ToolExecutor,
    continue_after_tool,
    execute_turn_calls,
)
from cascade.turn_state import LogicalTurnId, TurnPhase, TurnStateStore
from metrics import TimingLedger
from providers import SentenceAudio, TokenDelta, ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"
CLOSING = "Thanks for calling. Goodbye!"


def make_executor(factory):
    return ToolExecutor(
        base_url=BASE_URL,
        call_id=CALL_ID,
        secret=TOOL_SECRET,
        session_factory=factory,
        timeout_ms=2000,
    )


def end_call(arguments=None, call_id="call_end"):
    return ToolCallRequest(
        name=END_CALL_TOOL,
        arguments={"closing_line": CLOSING} if arguments is None else arguments,
        call_id=call_id,
    )


def tool_turn() -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text="",
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id="call_end",
                name=END_CALL_TOOL,
                arguments="{}",
            )
        ],
    )
    turn.close()
    return turn


def collect(events) -> list:
    async def run():
        return [event async for event in events]

    return asyncio.run(run())


class EndCallSignalTest(unittest.TestCase):
    def test_end_call_with_a_closing_line_makes_no_http_request(self):
        factory = ScriptedSessionFactory([])
        executor = make_executor(factory)

        outcome = asyncio.run(executor.execute(end_call()))

        self.assertIsInstance(outcome, EndCallSignal)
        self.assertEqual(CALL_ID, outcome.call_id)
        self.assertEqual("call_end", outcome.tool_call_id)
        self.assertEqual(CLOSING, outcome.closing_line)
        self.assertEqual([], factory.posts, "end_call reached the HTTP route")

    def test_end_call_without_a_closing_line_is_denied_and_recorded(self):
        factory = ScriptedSessionFactory([])
        executor = make_executor(factory)

        outcome = asyncio.run(executor.execute(end_call(arguments={})))

        self.assertIsInstance(outcome, DeniedCall)
        self.assertEqual(TOOL_CLOSING_LINE_MISSING, outcome.denial.code)
        self.assertEqual("call_end", outcome.denial.call_id)
        self.assertEqual([], factory.posts)

    def test_a_denied_end_call_is_recorded_on_the_turn_and_never_continues(self):
        llm = ScriptedLLM([])
        ledger = TimingLedger()
        history = MessageHistory()
        history.append_user("That's all, thanks.")
        turn = tool_turn()
        denied = DeniedCall(
            name=END_CALL_TOOL,
            denial=ToolDenial(
                name=END_CALL_TOOL,
                reason="no closing line",
                call_id="call_end",
                code=TOOL_CLOSING_LINE_MISSING,
            ),
        )

        events = collect(
            continue_after_tool(
                llm=llm,
                history=history,
                turn=turn,
                outcome=denied,
                ledger=ledger,
            )
        )

        self.assertEqual([], events)
        self.assertEqual([], llm.requests)
        self.assertEqual([END_CALL_TOOL], [call.name for call in turn.denied_tool_calls])
        self.assertTrue(turn.hold_line_required)
        self.assertEqual(1, ledger.summary()["counts"]["tool_denied"])

    def test_a_blank_closing_line_is_not_a_closing_line(self):
        executor = make_executor(ScriptedSessionFactory([]))

        outcome = asyncio.run(
            executor.execute(end_call(arguments={"closing_line": "   "}))
        )

        self.assertIsInstance(outcome, DeniedCall)
        self.assertEqual(TOOL_CLOSING_LINE_MISSING, outcome.denial.code)

    def test_a_denied_end_call_in_a_batch_stops_every_later_side_effect(self):
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = make_executor(factory)
        turn = MetaLLMTurn(
            content_text="",
            finish_reason="tool_calls",
            tool_calls=[
                MetaToolCall(
                    index=0,
                    call_id="call_1",
                    name="search_properties",
                    arguments='{"location": "Dubai"}',
                ),
                MetaToolCall(index=1, call_id="call_end", name=END_CALL_TOOL),
                MetaToolCall(
                    index=2,
                    call_id="call_3",
                    name="book_viewing",
                    arguments='{"reference": "MAR-1"}',
                ),
            ],
        )
        turn.close()
        calls = [
            ToolCallRequest(
                name="search_properties",
                arguments={"location": "Dubai"},
                call_id="call_1",
            ),
            ToolCallRequest(name=END_CALL_TOOL, arguments={}, call_id="call_end"),
            ToolCallRequest(
                name="book_viewing", arguments={"reference": "MAR-1"}, call_id="call_3"
            ),
        ]

        outcomes = asyncio.run(execute_turn_calls(executor, turn, calls))

        self.assertEqual(2, len(outcomes))
        self.assertIsInstance(outcomes[1], DeniedCall)
        self.assertEqual(
            ["/api/tools/search_properties"],
            [post["url"].removeprefix(BASE_URL) for post in factory.posts],
            "a call ran after the model asked to end the call",
        )


class RecordingSink:
    """The audio sink: every frame the caller would hear."""

    def __init__(self):
        self.frames = []

    def __call__(self, audio):
        self.frames.append(audio.pcm)


class CallClosingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.voice = ScriptedTTS(clock=self.clock)
        self.sink = RecordingSink()
        self.closing = CallClosing(
            voice=self.voice, on_audio=self.sink, clock=self.clock
        )
        self.turns.open("t1")
        self.turns.finalise("the caller said goodbye", turn="t1")

    def test_the_closing_line_is_spoken_through_the_call_voice_then_the_turn_ends(self):
        signal = EndCallSignal(
            call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
        )

        outcome = asyncio.run(self.closing.speak(signal, turns=self.turns, turn="t1"))

        self.assertTrue(outcome.spoken)
        self.assertTrue(outcome.hangup_armed)
        self.assertTrue(outcome.turn_ended)
        self.assertEqual([CLOSING], self.voice.spoken)
        self.assertEqual([CLOSING.encode()], self.sink.frames)
        self.assertEqual(1, outcome.frames)
        self.assertEqual(TurnPhase.CLOSED, self.turns.get(LogicalTurnId(0, "t1")).phase)
        self.assertEqual(
            "end_call", self.turns.get(LogicalTurnId(0, "t1")).close_reason
        )
        self.assertTrue(self.closing.take_hangup())

    def test_the_hangup_is_armed_only_after_the_line_finished(self):
        seen = []
        closing = CallClosing(
            voice=self.voice,
            on_audio=lambda audio: seen.append(closing.armed),
            clock=self.clock,
        )

        asyncio.run(
            closing.speak(
                EndCallSignal(
                    call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
                )
            )
        )

        self.assertEqual([False], seen, "the hangup was armed before the line played")

    def test_the_armed_hangup_is_one_shot(self):
        asyncio.run(
            self.closing.speak(
                EndCallSignal(
                    call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
                )
            )
        )

        self.assertTrue(self.closing.take_hangup())
        self.assertFalse(self.closing.take_hangup())

    def test_a_barge_in_after_the_line_finished_still_disarms_the_hangup(self):
        asyncio.run(
            self.closing.speak(
                EndCallSignal(
                    call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
                )
            )
        )
        self.assertTrue(self.closing.armed)

        cut = asyncio.run(self.closing.barge_in(speech_started_at=0.0))

        self.assertIsNone(cut, "there was nothing left to cut")
        self.assertFalse(self.closing.armed)
        self.assertFalse(self.closing.take_hangup())

    def test_a_signal_without_a_closing_line_is_refused_by_name(self):
        with self.assertRaises(EndCallDenied):
            asyncio.run(
                self.closing.speak(
                    EndCallSignal(call_id=CALL_ID, tool_call_id="call_end")
                )
            )

        self.assertEqual([], self.voice.spoken)
        self.assertFalse(self.closing.take_hangup())

    def test_the_end_call_is_counted_once(self):
        ledger = TimingLedger(now=self.clock)
        closing = CallClosing(
            voice=self.voice, on_audio=self.sink, clock=self.clock, ledger=ledger
        )

        asyncio.run(
            closing.speak(
                EndCallSignal(
                    call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
                )
            )
        )

        self.assertEqual(1, ledger.summary()["counts"]["end_call"])


class GatedVoice:
    """The call's voice, whose closing line is released a frame at a time."""

    def __init__(self):
        self.spoken = []
        self.cancels = 0
        self.flush_id = None
        self.frames = asyncio.Queue()

    def feed(self, pcm: bytes):
        self.frames.put_nowait(pcm)

    async def speak(self, text):
        self.spoken.append(text)
        while True:
            pcm = await self.frames.get()
            yield SentenceAudio(pcm=pcm, sample_rate=24000, text=text)

    async def cancel(self):
        self.cancels += 1
        return Cancellation()


class GoodbyeBargeInTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.turns = TurnStateStore(clock=self.clock, source="meta")
        self.turns.open("t1")
        self.voice = GatedVoice()
        self.played = []
        self.first_played = asyncio.Event()

    async def scenario(self):
        played = self.played
        first = self.first_played

        def sink(audio):
            played.append(audio.pcm)
            if not first.is_set():
                first.set()

        cut_path = BargeInCutPath(
            tts=self.voice,
            on_audio=sink,
            flush_playout=lambda flush: None,
            clock=self.clock,
        )
        closing = CallClosing(
            voice=self.voice,
            on_audio=sink,
            clock=self.clock,
            cut_path=cut_path,
            ledger=TimingLedger(now=self.clock),
        )
        signal = EndCallSignal(
            call_id=CALL_ID, tool_call_id="call_end", closing_line=CLOSING
        )
        task = asyncio.ensure_future(closing.speak(signal, turns=self.turns, turn="t1"))
        self.voice.feed(b"closing-1")
        await first.wait()
        cut = await closing.barge_in(speech_started_at=0.0, played_ms=10.0)
        self.voice.feed(b"closing-2")
        outcome = await task
        return closing, cut, outcome

    def test_a_barge_in_during_the_goodbye_disarms_the_hangup(self):
        closing, cut, outcome = asyncio.run(self.scenario())

        self.assertIsNotNone(cut)
        self.assertEqual("goodbye", cut.cause)
        self.assertTrue(outcome.disarmed)
        self.assertFalse(outcome.hangup_armed)
        self.assertFalse(closing.take_hangup(), "the caller won but the call hung up")
        self.assertEqual([b"closing-1"], self.played, "a stale frame played after the cut")
        self.assertEqual(TurnPhase.SPEAKING, self.turns.get(LogicalTurnId(0, "t1")).phase)


if __name__ == "__main__":
    unittest.main()
