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
import sys
import unittest

# The cascade calls the bare ``end_intent`` seam; alias the packaged module so
# the turn layer's ``should_cover`` import succeeds without touching behavior.
try:
    import end_intent  # noqa: F401
except ModuleNotFoundError:
    import cascade.end_intent as _cascade_end_intent

    sys.modules["end_intent"] = _cascade_end_intent

from cascade.ack import ACK_LINES, ACK_TONE_GROUPS, cover_line
from cascade.call import OutboundAudio
from cascade.jev import make_cover_judge
from cascade.meta_llm import MetaLLMTurn, TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechEnd, SpeechStart
from cascade.testing import FakeClock
from cascade.tools import ToolResult
from cascade.turn_stream import CascadeTurnStream
from providers import SentenceAudio, TokenDelta, ToolCallRequest


class FakeCoverLogger:
    """Injectable redacted logger for the Jev cover on the wire."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def info(self, msg, *args):
        try:
            line = msg % args if args else str(msg)
        except Exception:
            line = str(msg)
        self.lines.append(line)


def _jev_tone_data(pick: str, probability: float) -> dict:
    return {"answers": {"judge": {"pick": pick, "probability": probability}}}


class _JevFakeResp:
    def __init__(self, data, status: int = 200) -> None:
        self._data = data
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return self._data


def _jev_factory_for(data, *, status: int = 200):
    def factory(url, headers, payload, timeout_s):
        return _JevFakeResp(data, status=status)

    return factory


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
        on_caption=None,
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
            on_caption=on_caption,
        )
        return stream

    def run_events(self, stream, events):
        async def run():
            await stream.start()
            for event in events:
                await stream.event(event)
            await stream.drain()

        asyncio.run(run())

    def test_the_stream_names_the_model_it_serves(self):
        # The call prices its llm leg from this: a demo override must be priced
        # on its own model's rates, so the stream has to name it (ADR-0014).
        stream = self.make(replies=["one reply"])
        self.assertIsNone(stream.model, "a turn layer without a model names none")

        self.llm.model = "muse-wonder-1.0"
        self.assertEqual("muse-wonder-1.0", stream.model)

        self.llm.model = ""
        self.assertIsNone(stream.model, "a blank model is not a model")

    def test_a_reply_ends_with_one_final_agent_caption(self):
        captions: list[tuple[str, str, bool]] = []

        async def collect(role, text, final):
            captions.append((role, text, final))

        stream = self.make(
            replies=[{"deltas": ["Hello there. ", "How can I help?"]}],
            on_caption=collect,
        )
        self.run_events(
            stream,
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
        )

        agent = [c for c in captions if c[0] == "agent"]
        self.assertTrue(any(not final for _, _, final in agent), "streams partials")
        finals = [text for _, text, final in agent if final]
        self.assertEqual(["Hello there. How can I help?"], finals)

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
        self.assertEqual(1, stream.request_count())
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
        self.assertEqual(0, stream.request_count())
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
        # The tool round is a second model request on the same logical turn.
        self.assertEqual(2, stream.request_count())


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


class SpokenGoodbyeLLM(EndCallLLM):
    """Streams the goodbye as content, then calls ``end_call`` (Gemini's shape)."""

    async def complete(self, *, messages, tools=None, turn=None):
        self.requests.append(messages)
        record = turn if turn is not None else MetaLLMTurn()
        record.content_text += self.closing_line
        yield TokenDelta(text=self.closing_line)
        from cascade.meta_llm import MetaToolCall
        from cascade.tools import END_CALL_TOOL

        record.tool_calls.append(
            MetaToolCall(
                0,
                "call_end",
                END_CALL_TOOL,
                '{"closing_line": "%s"}' % self.closing_line,
            )
        )
        yield ToolCallRequest(
            name=END_CALL_TOOL,
            arguments={"closing_line": self.closing_line},
            call_id="call_end",
        )
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


class AckTest(unittest.TestCase):
    """One short spoken line covers a reply that has not started yet.

    Jev-only smart cover: a fast confident judge speaks immediately, is
    captioned as an agent final, and leaves a ledger ``ack`` row. A silent,
    slow, failing, or unknown-tone judge — or an end-intent, greeting,
    filler-only, or reply-started turn, or a missing judge — means no audio
    and no caption.
    """

    def test_a_slow_reply_is_covered_by_one_ack_that_is_captioned_as_agent_final(
        self,
    ):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, final):
            captions.append((role, text, final))

        audio = RecordingAudio()
        rows: list[tuple] = []

        class Rows:
            def __getattr__(self, name):
                if name.startswith("__"):
                    raise AttributeError(name)

                def record(*args, **kwargs):
                    rows.append((name, args, kwargs))

                return record

        async def confident_judge(_: str):
            return "neutral"

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=audio,
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=confident_judge,
            on_caption=on_caption,
            turn_events=Rows(),
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("book a viewing on Tuesday", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        expected = cover_line("en", "book a viewing on Tuesday", tone="neutral")
        self.assertIsNotNone(expected)
        self.assertEqual([expected, "I can do that."], stream._tts.spoken)
        self.assertIn(("agent", expected, True), captions, "the ack is an agent final")
        self.assertIn(("agent", "I can do that.", True), captions, "the reply is final")
        self.assertEqual(
            [f.kind for f in audio.frames if f.kind == "ack"],
            ["ack"],
            "the cover rides one ack frame",
        )
        ack_rows = [row for row in rows if row[0] == "ack"]
        self.assertEqual(1, len(ack_rows), "the cover left one ledger ack row")
        self.assertEqual(expected, ack_rows[0][2].get("line"))

    def test_the_ack_is_chosen_from_the_judge_tone(self):
        groups = ACK_TONE_GROUPS["en"]

        def speak_ack(final: str, tone: str) -> str:
            gate = asyncio.Event()

            class SlowLLM:
                async def complete(self, *, messages, tools=None, turn=None):
                    await gate.wait()
                    record = turn if turn is not None else MetaLLMTurn()
                    record.content_text += "I can do that."
                    yield TokenDelta(text="I can do that.")
                    record.finished = True

            async def fixed_judge(_: str):
                return tone

            tts = FakeTTS()
            stream = CascadeTurnStream(
                llm=SlowLLM(),
                tts=tts,
                emit_audio=RecordingAudio(),
                ledger=RecordingLedger(),
                clock=FakeClock(),
                ack_lines=ACK_LINES["en"],
                ack_delay_ms=5,
                ack_judge=fixed_judge,
            )

            async def run():
                await stream.start()
                await stream.event(SpeechStart("t1"))
                await stream.event(SpeechComplete(final, turn_id="t1"))
                for _ in range(200):
                    if tts.spoken:
                        break
                    await asyncio.sleep(0.001)
                gate.set()
                await stream.drain()

            asyncio.run(run())
            return tts.spoken[0]

        angry = speak_ack("This is ridiculous.", "negative")
        self.assertNotIn(angry, ("Okay.", "Yeah."), "a complaint got a bright ack")
        self.assertIn(angry, set(groups["sympathetic"]) | set(groups["thinking"]))

        question = speak_ack("What does it cost?", "question")
        self.assertIn(
            question, set(groups["thinking"]) | set(groups["statement"])
        )

    def test_a_neutral_judge_never_gets_the_statement_bridge(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def neutral_judge(_: str):
            return "neutral"

        tts = FakeTTS()
        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=tts,
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=neutral_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(
                SpeechComplete("I'm calling about the flat.", turn_id="t1")
            )
            for _ in range(200):
                if tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertNotIn(
            tts.spoken[0],
            (
                "Good question, one sec.",
                "Got it, one moment.",
                "Let me check that.",
            ),
        )

    def test_a_fast_reply_never_speaks_an_ack(self):
        class FastLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        stream = CascadeTurnStream(
            llm=FastLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=50,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("book a viewing on Tuesday", turn_id="t1"))
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)

    def test_no_judge_means_silence(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, final):
            captions.append((role, text, final))

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            on_caption=on_caption,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("book a viewing on Tuesday", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)
        agent_finals = [text for role, text, final in captions if role == "agent" and final]
        self.assertEqual(["I can do that."], agent_finals)

    def test_a_greeting_turn_hears_silence_not_a_sound(self):
        """Saying Hi never produces any cover back: silence is better."""
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "Hello! How can I help?"
                yield TokenDelta(text="Hello! How can I help?")
                record.finished = True

        async def confident_judge(_: str):
            return "neutral"

        audio = RecordingAudio()
        rows: list[tuple] = []

        class Rows:
            def __getattr__(self, name):
                if name.startswith("__"):
                    raise AttributeError(name)

                def record(*args, **kwargs):
                    rows.append((name, args, kwargs))

                return record

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, final):
            captions.append((role, text, final))

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=audio,
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=confident_judge,
            turn_events=Rows(),
            on_caption=on_caption,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("Hi", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["Hello! How can I help?"], stream._tts.spoken)
        self.assertEqual([], [kind for kind in [f.kind for f in audio.frames] if kind == "ack"])
        self.assertEqual([], [row for row in rows if row[0] == "ack"])
        self.assertNotIn("Okay.", [text for _, text, _ in captions])

    def test_a_filler_only_turn_hears_silence(self):
        """A filler-only final never takes the cover: it hears nothing extra."""
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def confident_judge(_: str):
            return "neutral"

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=confident_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("mm-hmm", turn_id="t1"))
            for _ in range(400):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertNotIn("So.", stream._tts.spoken)
        for line in ACK_LINES["en"]:
            self.assertNotIn(line, stream._tts.spoken[:-1])

    def test_an_end_intent_turn_hears_silence(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "Okay, bye!"
                yield TokenDelta(text="Okay, bye!")
                record.finished = True

        async def confident_judge(_: str):
            return "neutral"

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, final):
            captions.append((role, text, final))

        audio = RecordingAudio()
        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=audio,
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=confident_judge,
            on_caption=on_caption,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("can you please hang up?", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual([], [f.kind for f in audio.frames if f.kind == "ack"])
        agent_finals = [text for role, text, final in captions if role == "agent" and final]
        self.assertNotIn("Okay.", agent_finals)

    def test_the_ack_is_captioned_as_agent_final_but_never_enters_memory(self):
        """The cover is same-voice ephemera: captioned at once, never recalled."""
        gate = asyncio.Event()
        final = "What does it cost?"

        async def question_judge(_: str):
            return "question"

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, done):
            captions.append((role, text, done))

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=question_judge,
            on_caption=on_caption,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(final, turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        expected = cover_line("en", final, tone="question")
        self.assertIn(expected, stream._tts.spoken)
        agent_finals = [text for role, text, final_ in captions if role == "agent" and final_]
        self.assertIn(expected, agent_finals)
        self.assertIn("I can do that.", agent_finals)
        memory = " ".join(
            str(message.get("content", ""))
            for message in stream._history.request_messages()
        )
        self.assertNotIn(expected, memory)

    def test_a_timed_out_judge_is_silence(self):
        """A judge that never answers covers nothing: the reply speaks alone."""
        gate = asyncio.Event()
        final = "What does it cost?"

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def stalled_judge(_: str):
            await asyncio.sleep(10)
            return "neutral"

        captions: list[tuple[str, str, bool]] = []

        async def on_caption(role, text, final_):
            captions.append((role, text, final_))

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=stalled_judge,
            ack_judge_timeout_ms=10,
            on_caption=on_caption,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(final, turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)
        agent_finals = [text for role, text, final_ in captions if role == "agent" and final_]
        self.assertEqual(["I can do that."], agent_finals)

    def test_a_failing_judge_is_silence(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def broken_judge(_: str):
            raise RuntimeError("judge is down")

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=broken_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)

    def test_an_unknown_tone_judge_is_silence(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def weird_judge(_: str):
            return "cheerful"

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=weird_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)

    def test_a_judge_silence_is_obeyed_on_the_wire(self):
        """A judge that picks None covers nothing: the reply speaks alone."""
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        async def silent_judge(_: str):
            return None

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=FakeTTS(),
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=silent_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t1"))
            for _ in range(200):
                if stream._tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(["I can do that."], stream._tts.spoken)

    def test_two_consecutive_turns_never_repeat_the_cover(self):
        """The pipeline rotates the line inside the tone on the wire."""
        gates = [asyncio.Event(), asyncio.Event()]
        calls = 0

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                nonlocal calls
                index = calls
                calls += 1
                if index < len(gates):
                    await gates[index].wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += f"Reply number {index} here."
                yield TokenDelta(text=f"Reply number {index} here.")
                record.finished = True

        async def question_judge(_: str):
            return "question"

        tts = FakeTTS()
        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=tts,
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=question_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t1"))
            for _ in range(200):
                if tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gates[0].set()
            await stream.drain()
            await stream.event(SpeechStart("t2"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t2"))
            for _ in range(400):
                if len(tts.spoken) >= 3:
                    break
                await asyncio.sleep(0.001)
            gates[1].set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(4, len(tts.spoken))
        self.assertNotEqual(tts.spoken[0], tts.spoken[2])


class JevSmartCoverWireTest(unittest.TestCase):
    """The Jev smart cover speaks through the wire with tiered gates + logs.

    No live network: the judge is ``make_cover_judge`` with an injected fake
    ``session_factory`` and an injectable fake logger. A mid-confidence
    question (0.75) speaks under the 0.6 tier (silence under the old 0.85);
    a mid-confidence negative (0.7) stays silent under its 0.85 gate.
    """

    def _run_one_turn(self, *, final, pick, prob, may_request=None):
        gate = asyncio.Event()
        logger = FakeCoverLogger()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can do that."
                yield TokenDelta(text="I can do that.")
                record.finished = True

        captions: list[tuple[str, str, bool]] = []
        audio = RecordingAudio()
        rows: list[tuple] = []

        class Rows:
            def __getattr__(self, name):
                if name.startswith("__"):
                    raise AttributeError(name)

                def record(*args, **kwargs):
                    rows.append((name, args, kwargs))

                return record

        judge = make_cover_judge(
            "en",
            api_key="test-key",
            timeout_s=0.2,
            session_factory=_jev_factory_for(_jev_tone_data(pick, prob)),
            logger=logger,
        )
        tts = FakeTTS()

        async def on_caption(role, text, final_):
            captions.append((role, text, final_))

        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=tts,
            emit_audio=audio,
            may_request=may_request,
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=judge,
            ack_judge_timeout_ms=500,
            on_caption=on_caption,
            turn_events=Rows(),
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(final, turn_id="t1"))
            for _ in range(400):
                if tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())
        return stream, tts, audio, captions, rows, logger

    def test_mid_confidence_question_speaks_under_the_tiered_gate(self):
        stream, tts, audio, captions, rows, logger = self._run_one_turn(
            final="What does it cost?", pick="question", prob=0.75,
        )
        # Instant single attempt: the cover speaks before the reply.
        self.assertEqual(2, len(tts.spoken))
        self.assertIn(tts.spoken[0], set(ACK_TONE_GROUPS["en"]["thinking"])
                      | set(ACK_TONE_GROUPS["en"]["statement"]))
        self.assertEqual("I can do that.", tts.spoken[1])
        # Caption-before-audio + ledger ack row stay.
        self.assertIn(("agent", tts.spoken[0], True), captions)
        ack_rows = [row for row in rows if row[0] == "ack"]
        self.assertEqual(1, len(ack_rows))
        self.assertEqual(tts.spoken[0], ack_rows[0][2].get("line"))
        # Redacted log: tone + bucket + latency + reason, no caller text/key.
        self.assertEqual(1, len(logger.lines))
        line = logger.lines[0]
        self.assertIn("tone=question", line)
        self.assertIn("bucket=0.6-0.85", line)
        self.assertIn("latency_ms=", line)
        self.assertIn("reason=ok", line)
        self.assertNotIn("What does it cost?", line)
        self.assertNotIn("test-key", line)

    def test_mid_confidence_negative_stays_silent_under_its_own_gate(self):
        stream, tts, audio, captions, rows, logger = self._run_one_turn(
            final="This is ridiculous.", pick="negative", prob=0.7,
        )
        self.assertEqual(["I can do that."], tts.spoken)
        self.assertEqual([], [row for row in rows if row[0] == "ack"])
        self.assertIn("reason=low-conf", logger.lines[0])

    def test_two_question_turns_rotate_through_every_line_on_the_wire(self):
        gates = [asyncio.Event(), asyncio.Event()]
        calls = 0
        logger = FakeCoverLogger()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                nonlocal calls
                index = calls
                calls += 1
                if index < len(gates):
                    await gates[index].wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += f"Reply number {index} here."
                yield TokenDelta(text=f"Reply number {index} here.")
                record.finished = True

        judge = make_cover_judge(
            "en",
            api_key="test-key",
            timeout_s=0.2,
            session_factory=_jev_factory_for(_jev_tone_data("question", 0.9)),
            logger=logger,
        )
        tts = FakeTTS()
        stream = CascadeTurnStream(
            llm=SlowLLM(),
            tts=tts,
            emit_audio=RecordingAudio(),
            ledger=RecordingLedger(),
            clock=FakeClock(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=judge,
            ack_judge_timeout_ms=500,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t1"))
            for _ in range(400):
                if tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gates[0].set()
            await stream.drain()
            await stream.event(SpeechStart("t2"))
            await stream.event(SpeechComplete("What does it cost?", turn_id="t2"))
            for _ in range(400):
                if len(tts.spoken) >= 3:
                    break
                await asyncio.sleep(0.001)
            gates[1].set()
            await stream.drain()

        asyncio.run(run())

        self.assertEqual(4, len(tts.spoken))
        self.assertNotEqual(tts.spoken[0], tts.spoken[2])
        # Full rotation would walk palette order, not just alternate two:
        # the second cover is the candidate after the first.
        expected_second = cover_line(
            "en", "What does it cost?", previous=tts.spoken[0], tone="question",
        )
        self.assertEqual(expected_second, tts.spoken[2])

    def test_a_closed_tts_leg_never_speaks_the_cover(self):
        def closed(leg: str) -> bool:
            return False if leg == "tts" else True

        stream, tts, audio, captions, rows, logger = self._run_one_turn(
            final="What does it cost?", pick="question", prob=0.9,
            may_request=closed,
        )
        self.assertEqual([], [f.kind for f in audio.frames if f.kind == "ack"])
        self.assertEqual([], [row for row in rows if row[0] == "ack"])
        self.assertIn("reason=ok", logger.lines[0], "jev still judged; the leg skipped audio")


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

    def test_a_goodbye_streamed_before_the_tool_is_spoken_only_once(self):
        closing = "Okay, bye!"
        ended: list[str] = []

        async def on_end_call() -> None:
            ended.append("end")

        audio = RecordingAudio()
        stream = CascadeTurnStream(
            llm=SpokenGoodbyeLLM(closing),
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

        asyncio.run(run())

        self.assertEqual(["Bye!"], stream._tts.spoken)
        self.assertEqual(["end"], ended)

    def _run_caller_request(self, final_text, reply_text, *, locale="en", calls=(), executor=None):
        ended: list[str] = []

        async def on_end_call() -> None:
            ended.append("end")

        audio = RecordingAudio()
        stream = CascadeTurnStream(
            llm=ScriptedLLM([{"deltas": [reply_text], "calls": calls}]),
            tts=FakeTTS(),
            emit_audio=audio,
            tool_executor=executor,
            locale_code=locale,
            ledger=RecordingLedger(),
            clock=FakeClock(),
            on_end_call=on_end_call,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete(final_text, turn_id="t1"))
            await stream.drain()

        asyncio.run(run())
        return stream, ended

    def test_a_caller_asking_to_hang_up_ends_the_call_without_a_tool_call(self):
        stream, ended = self._run_caller_request(
            "Okay, that's all I needed. Please hang up now.",
            "Okay, bye!",
        )

        self.assertEqual(["Bye!"], stream._tts.spoken)
        self.assertEqual(["end"], ended, "the caller's request is call control")

    def test_a_german_caller_asking_to_hang_up_ends_the_call(self):
        stream, ended = self._run_caller_request(
            "Bitte legen Sie jetzt auf.",
            "Auf Wiederhören!",
            locale="de",
        )

        self.assertEqual(["Auf Wiederhören!"], stream._tts.spoken)
        self.assertEqual(["end"], ended)

    def test_a_negated_hang_up_leaves_the_call_open(self):
        stream, ended = self._run_caller_request(
            "Please don't hang up, I have one more question.",
            "Of course, go ahead.",
        )

        self.assertEqual([], ended)
        self.assertEqual(["Go ahead."], stream._tts.spoken)

    def test_an_empty_model_hang_up_still_ends_on_the_callers_request(self):
        from cascade.meta_llm import MetaToolCall, ToolDenial
        from cascade.tools import HANG_UP_TOOL, TOOL_CLOSING_LINE_MISSING, DeniedCall

        class DenyingExecutor:
            async def execute(self, call):
                return DeniedCall(
                    name=call.name,
                    denial=ToolDenial(
                        name=call.name,
                        reason="no closing line",
                        call_id=call.call_id,
                        code=TOOL_CLOSING_LINE_MISSING,
                    ),
                )

        stream, ended = self._run_caller_request(
            "Hang up now, please.",
            "Okay, bye!",
            calls=[MetaToolCall(0, "call_hang_up", HANG_UP_TOOL, "{}")],
            executor=DenyingExecutor(),
        )

        self.assertEqual(["Bye!"], stream._tts.spoken)
        self.assertEqual(["end"], ended)

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
        self.assertEqual([closing, "I am still here."], tts.spoken)
        self.assertEqual(2, len(audio.frames))


if __name__ == "__main__":
    unittest.main()
