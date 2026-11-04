"""The call trace is a turn-level ledger (demo-verification 04).

Seam: the call's own trace JSONL. The tests write through the one
:class:`cascade.events.EventStream` (the sanitizer and the only write path) and
then read the file, so they assert the evidence a defect card will cite — a row
per event, against its logical turn — rather than an internal call.

Two seams are covered:

* :class:`cascade.events.TurnLedger` directly, for the row vocabulary, the
  one-emit-per-event rule and the sanitizer proof;
* :class:`cascade.turn_stream.CascadeTurnStream` and
  :class:`cascade.call.CallLifecycle` for a whole call, so the rows are the
  ones a real three-turn call leaves and the end document's turn summary agrees
  with them.

Expected values are literals from the ticket's acceptance list (three turns,
three chains, one greeting-only end row) and from a caller utterance and tool
payload that must never appear in the trace.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Alias the bare ``end_intent`` seam to the packaged module (see test_ack.py).
try:
    import end_intent  # noqa: F401
except ModuleNotFoundError:
    import cascade.end_intent as _cascade_end_intent

    sys.modules["end_intent"] = _cascade_end_intent

from cascade.ack import ACK_LINES

from cascade.call import CallLifecycle, OpenedLeg
from cascade.events import (
    CallEventLog,
    EventStream,
    EventWriter,
    OperationalEvents,
    TurnLedger,
    connect_fallback,
    turn_fallback,
)
from cascade.meta_llm import MetaLLMTurn, TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    BrowserStop,
    RecordingAudioSink,
    signed_message,
)
from cascade.testing import FakeClock, Step, ScriptedSTT
from cascade.tools import ToolResult
from cascade.turn_stream import CascadeTurnStream
from cascade.voice_binding import bind_voice
from providers import SentenceAudio, TokenDelta, ToolCallRequest

SUBJECT = "demo:audrey"

#: The caller's words and the tool's payload: neither may reach a turn row.
CALLER_UTTERANCE = "my card number is 4111 1111 1111 1111"
TOOL_PAYLOAD = "one unread email from the caller"
CREDENTIAL = "sk_test_ABCDEFGH12345678"


def ledger_for(directory: str, *, now=lambda: 1.0) -> TurnLedger:
    log = CallEventLog(directory, call_id=CALL_ID)
    stream = EventStream(
        EventWriter(pipeline="cascade", call_id=CALL_ID),
        sink=log,
        subject_kind="demo",
    )
    return TurnLedger(
        OperationalEvents(stream, subject=SUBJECT, now=now), now=now
    )


def rows_in(directory: str) -> list[dict]:
    path = Path(directory) / f"{CALL_ID}.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line]


class TurnRowTests(unittest.TestCase):
    """One row per event, against its logical turn, with no free-form text."""

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-turn-ledger-")
        self.ledger = ledger_for(self.directory, now=lambda: 1.5)

    def test_a_caller_final_row_names_the_turn_phase_and_timestamp(self):
        self.ledger.user_final(
            "0:t1", chars=len(CALLER_UTTERANCE), empty=False, wants_end=False
        )

        rows = rows_in(self.directory)
        self.assertEqual(1, len(rows))
        row = rows[0]
        self.assertEqual("turn.user_final", row["type"])
        self.assertEqual("0:t1", row["turn"])
        self.assertEqual("turn", row["phase"])
        self.assertEqual(1500.0, row["atMs"])
        self.assertEqual(len(CALLER_UTTERANCE), row["chars"])
        self.assertFalse(row["empty"])
        self.assertFalse(row["wantsEnd"])
        self.assertEqual([], self.rejected_text(row))

    def test_every_turn_row_exists_with_its_phase_and_turn(self):
        self.ledger.user_final("0:t1", chars=3)
        self.ledger.reply_start("0:t1")
        self.ledger.first_audio("0:t1", seq=7)
        self.ledger.ack("0:t1", line="Mm.")
        self.ledger.cut("0:t1", reason="barge_in")
        self.ledger.tool_call("0:t1", name="check_email", call_id="c1", index=0)
        self.ledger.tool_result(
            "0:t1", name="check_email", call_id="c1", ok=True
        )
        self.ledger.goodbye("0:t1", reason="end_call")
        self.ledger.hangup("0:t1", reason="end_call")

        rows = rows_in(self.directory)
        self.assertEqual(
            [
                "turn.user_final",
                "turn.reply_start",
                "turn.first_audio",
                "turn.ack",
                "turn.cut",
                "turn.tool_call",
                "turn.tool_result",
                "turn.goodbye",
                "turn.hangup",
            ],
            [row["type"] for row in rows],
            "the turn vocabulary is incomplete or out of order",
        )
        for row in rows:
            self.assertEqual(CALL_ID, row["callId"])
            self.assertEqual("0:t1", row["turn"])
            self.assertIn("atMs", row)
            self.assertIn("phase", row)
        phases = {row["type"]: row["phase"] for row in rows}
        self.assertEqual("turn", phases["turn.reply_start"])
        self.assertEqual("drain", phases["turn.goodbye"])
        self.assertEqual("drain", phases["turn.hangup"])

    def test_a_second_emit_of_the_same_event_writes_nothing(self):
        self.ledger.user_final("0:t1", chars=3)
        self.ledger.user_final("0:t1", chars=3)
        self.ledger.reply_start("0:t1")
        self.ledger.reply_start("0:t1")
        self.ledger.first_audio("0:t1", seq=7)
        self.ledger.first_audio("0:t1", seq=8)
        self.ledger.tool_call("0:t1", name="check_email", call_id="c1", index=0)
        self.ledger.tool_call("0:t1", name="check_email", call_id="c1", index=0)
        self.ledger.tool_result("0:t1", name="check_email", call_id="c1", ok=True)
        self.ledger.tool_result("0:t1", name="check_email", call_id="c1", ok=True)
        self.ledger.cut("0:t1", reason="barge_in")
        self.ledger.cut("0:t1", reason="barge_in")

        counts: dict[str, int] = {}
        for row in rows_in(self.directory):
            counts[row["type"]] = counts.get(row["type"], 0) + 1
        self.assertEqual(
            {name: 1 for name in counts},
            counts,
            "an event was emitted twice",
        )

    def test_a_turn_row_never_carries_caller_words_a_tool_result_or_a_secret(self):
        self.ledger.user_final(
            "0:t1", chars=len(CALLER_UTTERANCE), wants_end=False
        )
        # The model controls the tool name; a credential-shaped one is redacted
        # at the one write boundary like every other value.
        self.ledger.tool_call("0:t1", name=CREDENTIAL, call_id="c1", index=0)
        self.ledger.tool_result(
            "0:t1", name="send_email", call_id="c1", ok=True, code="delivered"
        )

        text = (Path(self.directory) / f"{CALL_ID}.jsonl").read_text()
        self.assertNotIn(CALLER_UTTERANCE, text)
        self.assertNotIn(TOOL_PAYLOAD, text)
        self.assertNotIn(CREDENTIAL, text)
        for row in rows_in(self.directory):
            self.assertEqual([], self.rejected_text(row))
            self.assertEqual([], self.rejected_keys(row))

    def test_a_fallback_row_names_the_provider_and_the_turn_it_contaminated(self):
        self.ledger.fallback(
            turn_fallback(
                "llm",
                from_provider="spark",
                to_provider="gateway",
                trigger="mid_turn_failure",
                turn="0:t2",
                reason="spark closed with 1013",
            )
        )
        self.ledger.fallback(
            connect_fallback(
                "tts",
                primary="assemblyai",
                selected="cartesia",
                trigger="breaker_open",
            )
        )

        rows = [row for row in rows_in(self.directory) if row["type"] == "provider_fallback"]
        self.assertEqual(2, len(rows))
        self.assertEqual(("0:t2", "turn"), (rows[0]["turn"], rows[0]["phase"]))
        self.assertEqual(("spark", "gateway"), (rows[0]["from"], rows[0]["to"]))
        self.assertIsNone(rows[1]["turn"])
        self.assertEqual("connect", rows[1]["phase"])
        self.assertEqual(("assemblyai", "cartesia"), (rows[1]["from"], rows[1]["to"]))

    def rejected_text(self, row: dict) -> list[str]:
        """Any free-form caller/tool text that reached the row, by field name."""
        forbidden = ("text", "transcript", "arguments", "payload", "result", "content")
        return [key for key in row if key in forbidden]

    def rejected_keys(self, row: dict) -> list[str]:
        return [key for key in row if key in ("audio", "pcm", "data", "base64")]


class ScriptedLLM:
    """One canned completion per request; the tool answer is the next one."""

    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.requests: list[list[dict]] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.requests.append(messages)
        reply = self.replies.pop(0)
        record = turn if turn is not None else MetaLLMTurn()
        for text in reply.get("deltas", ()):
            record.content_text += text
            yield TokenDelta(text=text)
        for call in reply.get("calls", ()):
            from cascade.meta_llm import MetaToolCall

            record.tool_calls.append(
                MetaToolCall(call.index, call.call_id, call.name, call.arguments)
            )
            yield ToolCallRequest(
                name=call.name,
                arguments={"card": CALLER_UTTERANCE},
                call_id=call.call_id,
            )
        record.finish_reason = reply.get("finish_reason", "stop")
        record.usage = reply.get("usage", TurnUsage(prompt_tokens=4, completion_tokens=5))
        record.finished = True


class FailingLLM:
    """A model request that ends the call with a named error, not a reply."""

    async def complete(self, *, messages, tools=None, turn=None):
        raise RuntimeError("the model stream broke")
        yield  # pragma: no cover - an async generator never reaches this


class LedgerTTS:
    """The opened synthesis session: one replayed frame per sentence."""

    def __init__(self, gate: asyncio.Event | None = None) -> None:
        self.gate = gate
        self.spoken: list[str] = []
        self.cancels = 0
        self.speaking = asyncio.Event()

    async def speak(self, text: str):
        self.spoken.append(text)
        self.speaking.set()
        yield SentenceAudio(pcm=text.encode("utf-8")[:8], sample_rate=24000, text=text)
        if self.gate is not None:
            await self.gate.wait()

    async def cancel(self) -> None:
        self.cancels += 1


class RecordingAudio:
    def __init__(self) -> None:
        self.frames: list = []

    async def __call__(self, audio, *, kind="reply", flush_id=None):
        from cascade.call import OutboundAudio

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


class PayloadExecutor:
    def __init__(self) -> None:
        self.calls = []

    async def execute(self, call):
        self.calls.append(call)
        return ToolResult(
            name=call.name,
            tool_call_id=call.call_id,
            payload={"ok": True, "email": TOOL_PAYLOAD},
        )


class StreamLedgerTests(unittest.TestCase):
    """A real call's turn layer writes the rows a defect card cites."""

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-turn-stream-")
        self.clock = FakeClock()
        self.ledger = ledger_for(self.directory, now=self.clock)
        self.audio = RecordingAudio()

    def make(
        self,
        *,
        replies,
        tts=None,
        executor=None,
        on_end_call=None,
        ack_lines=(),
        ack_delay_ms=None,
        ack_judge=None,
        ack_judge_timeout_ms=None,
    ):
        self.llm = replies if not isinstance(replies, list) else ScriptedLLM(replies)
        self.tts = tts if tts is not None else LedgerTTS()
        return CascadeTurnStream(
            llm=self.llm,
            tts=self.tts,
            tools=({"type": "function", "function": {"name": "check_email"}},),
            emit_audio=self.audio,
            tool_executor=executor,
            ledger=None,
            clock=self.clock,
            turn_events=self.ledger,
            on_end_call=on_end_call,
            ack_lines=ack_lines,
            ack_delay_ms=ack_delay_ms,
            ack_judge=ack_judge,
            ack_judge_timeout_ms=ack_judge_timeout_ms,
        )

    async def settle(self, stream, turns: int) -> None:
        for _ in range(1000):
            if stream.turn_count() >= turns:
                return
            await asyncio.sleep(0)
        self.fail(f"the stream only completed {stream.turn_count()} of {turns} turns")

    def test_a_three_turn_call_writes_three_complete_turn_chains(self):
        stream = self.make(
            replies=[
                {"deltas": ["First reply."]},
                {"deltas": ["Second reply."]},
                {"deltas": ["Third reply."]},
            ]
        )

        async def run():
            await stream.start()
            for number in (1, 2, 3):
                self.clock.advance(1.0)
                await stream.event(SpeechStart(f"t{number}"))
                self.clock.advance(0.1)
                await stream.event(
                    SpeechComplete(f"turn {number}", turn_id=f"t{number}")
                )
            await self.settle(stream, 3)
            await stream.drain()

        asyncio.run(run())

        rows = [row for row in rows_in(self.directory) if row["type"].startswith("turn.")]
        by_turn: dict[str, list[str]] = {}
        for row in rows:
            by_turn.setdefault(row["turn"], []).append(row["type"])
        self.assertEqual(["0:t1", "0:t2", "0:t3"], sorted(by_turn))
        for turn, types in by_turn.items():
            self.assertEqual(
                ["turn.user_final", "turn.reply_start", "turn.first_audio"],
                types,
                f"turn {turn} did not write one complete chain",
            )
        self.assertTrue(all(row["atMs"] >= 0 for row in rows))

    def test_a_duplicate_completion_writes_no_second_caller_final(self):
        stream = self.make(replies=[{"deltas": ["Only reply."]}])

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            await self.settle(stream, 1)
            await stream.drain()

        asyncio.run(run())

        finals = [
            row for row in rows_in(self.directory) if row["type"] == "turn.user_final"
        ]
        self.assertEqual(1, len(finals), "the duplicate completion made a second turn")
        self.assertEqual("0:t1", finals[0]["turn"])

    def test_a_barge_in_writes_a_cut_row_for_the_cut_turn(self):
        gate = asyncio.Event()
        stream = self.make(
            replies=[{"deltas": ["A long reply. And more."]}],
            tts=LedgerTTS(gate=gate),
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("tell me", turn_id="t1"))
            await asyncio.wait_for(stream._tts.speaking.wait(), timeout=1)
            await stream.event(SpeechStart("t2"))
            gate.set()
            await stream.drain()

        asyncio.run(run())

        cuts = [row for row in rows_in(self.directory) if row["type"] == "turn.cut"]
        self.assertEqual(1, len(cuts))
        self.assertEqual("0:t1", cuts[0]["turn"])
        self.assertEqual("barge_in", cuts[0]["reason"])

    def test_a_spoken_ack_is_recorded_with_its_exact_line_and_turn(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can help with that."
                yield TokenDelta(text="I can help with that.")
                record.finished = True

        async def negative_judge(_: str):
            return "negative"

        stream = self.make(
            replies=SlowLLM(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=negative_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("this is ridiculous", turn_id="t1"))
            for _ in range(200):
                if any(frame.kind == "ack" for frame in self.audio.frames):
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        acks = [row for row in rows_in(self.directory) if row["type"] == "turn.ack"]
        self.assertEqual(1, len(acks), "the cover the caller heard left no row")
        self.assertEqual("0:t1", acks[0]["turn"])
        self.assertEqual(
            self.tts.spoken[0],
            acks[0]["line"],
            "the row does not name the exact line spoken",
        )
        from cascade.ack import ACK_TONE_GROUPS

        allowed = set(ACK_TONE_GROUPS["en"]["sympathetic"]) | set(
            ACK_TONE_GROUPS["en"]["thinking"]
        )
        self.assertIn(acks[0]["line"], allowed)

    def test_a_silent_judge_records_no_ack_row(self):
        gate = asyncio.Event()

        class SlowLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                await gate.wait()
                record = turn if turn is not None else MetaLLMTurn()
                record.content_text += "I can help with that."
                yield TokenDelta(text="I can help with that.")
                record.finished = True

        async def silent_judge(_: str):
            return None

        stream = self.make(
            replies=SlowLLM(),
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=5,
            ack_judge=silent_judge,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("this is ridiculous", turn_id="t1"))
            for _ in range(200):
                if self.tts.spoken:
                    break
                await asyncio.sleep(0.001)
            gate.set()
            await stream.drain()

        asyncio.run(run())

        acks = [row for row in rows_in(self.directory) if row["type"] == "turn.ack"]
        self.assertEqual([], acks, "a silenced cover left a row")

    def test_an_ack_that_never_speaks_records_nothing(self):
        stream = self.make(
            replies=[{"deltas": ["I can help with that."]}],
            ack_lines=ACK_LINES["en"],
            ack_delay_ms=50,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            await self.settle(stream, 1)
            await stream.drain()

        asyncio.run(run())

        acks = [row for row in rows_in(self.directory) if row["type"] == "turn.ack"]
        self.assertEqual([], acks, "a skipped ack left a row claiming it was heard")

    def test_tool_rows_name_the_call_and_never_carry_arguments_or_payload(self):
        from cascade.meta_llm import MetaToolCall

        executor = PayloadExecutor()
        stream = self.make(
            replies=[
                {
                    "deltas": [""],
                    "finish_reason": "tool_calls",
                    "calls": [
                        MetaToolCall(0, "c1", "check_email", '{"code": "1"}')
                    ],
                },
                {"deltas": ["One unread email."]},
            ],
            executor=executor,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("check my email", turn_id="t1"))
            await self.settle(stream, 1)
            await stream.drain()

        asyncio.run(run())

        calls = [row for row in rows_in(self.directory) if row["type"] == "turn.tool_call"]
        results = [
            row for row in rows_in(self.directory) if row["type"] == "turn.tool_result"
        ]
        self.assertEqual(1, len(calls))
        self.assertEqual(
            ("check_email", "c1", 0),
            (calls[0]["name"], calls[0]["toolCallId"], calls[0]["index"]),
        )
        self.assertEqual(1, len(results))
        self.assertEqual(
            ("check_email", "c1"), (results[0]["name"], results[0]["toolCallId"])
        )
        self.assertTrue(results[0]["ok"])
        text = (Path(self.directory) / f"{CALL_ID}.jsonl").read_text()
        self.assertNotIn(TOOL_PAYLOAD, text)
        self.assertNotIn('"card"', text)
        self.assertNotIn(CALLER_UTTERANCE, text)

    def test_an_end_call_writes_the_goodbye_and_hangup_rows(self):
        ended: list[str] = []

        async def on_end_call() -> None:
            ended.append("end_call")

        class EndCallLLM:
            async def complete(self, *, messages, tools=None, turn=None):
                from cascade.meta_llm import MetaToolCall
                from cascade.tools import END_CALL_TOOL

                record = turn if turn is not None else MetaLLMTurn()
                record.tool_calls.append(
                    MetaToolCall(0, "call_end", END_CALL_TOOL, '{"closing_line": "Bye."}')
                )
                yield ToolCallRequest(
                    name=END_CALL_TOOL,
                    arguments={"closing_line": "Bye."},
                    call_id="call_end",
                )
                record.finish_reason = "tool_calls"
                record.finished = True

        class EndCallExecutor:
            async def execute(self, call):
                from cascade.tools import EndCallSignal

                return EndCallSignal(
                    call_id="call_end",
                    tool_call_id="call_end",
                    closing_line="Bye.",
                )

        stream = self.make(
            replies=EndCallLLM(),
            executor=EndCallExecutor(),
            on_end_call=on_end_call,
        )

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("goodbye", turn_id="t1"))
            await self.settle(stream, 1)
            await stream.drain()

        asyncio.run(run())

        rows = rows_in(self.directory)
        goodbye = [row for row in rows if row["type"] == "turn.goodbye"]
        hangup = [row for row in rows if row["type"] == "turn.hangup"]
        self.assertEqual(1, len(goodbye), "the goodbye drain was not recorded")
        self.assertEqual(1, len(hangup), "the hangup was not recorded")
        self.assertEqual(
            ("0:t1", "drain", "end_call"),
            (goodbye[0]["turn"], goodbye[0]["phase"], goodbye[0]["reason"]),
        )
        self.assertEqual(("0:t1", "end_call"), (hangup[0]["turn"], hangup[0]["reason"]))
        self.assertEqual(["end_call"], ended)

    def test_a_failed_reply_writes_a_turn_failed_row_naming_the_error_class(self):
        stream = self.make(replies=FailingLLM())

        async def run():
            await stream.start()
            await stream.event(SpeechStart("t1"))
            await stream.event(SpeechComplete("hello", turn_id="t1"))
            for _ in range(100):
                await asyncio.sleep(0)
            with self.assertRaises(RuntimeError):
                await stream.drain()

        asyncio.run(run())

        failed = [row for row in rows_in(self.directory) if row["type"] == "turn.failed"]
        self.assertEqual(1, len(failed), "the failed turn left no row")
        self.assertEqual(
            ("0:t1", "llm", "RuntimeError"),
            (failed[0]["turn"], failed[0]["leg"], failed[0]["name"]),
        )


class LifecycleVoice:
    """The opened synthesis session: a greeting plus one frame per sentence."""

    def __init__(self) -> None:
        self.binding = bind_voice("lola")
        self.spoken: list[str] = []
        self.closed = False

    async def speak_greeting(self, text: str):
        yield SentenceAudio(pcm=b"\x01\x00", sample_rate=24000, text=text)

    async def speak(self, text: str):
        self.spoken.append(text)
        yield SentenceAudio(pcm=b"\x02\x00", sample_rate=24000, text=text)

    async def cancel(self) -> None:
        return None

    async def close(self) -> None:
        self.closed = True


class StopAfterTurns:
    """The browser seam: hang up once the call has answered ``turns`` turns."""

    def __init__(self, stream, turns: int) -> None:
        self.stream = stream
        self.turns = turns
        self.sent: list[dict] = []
        self.closed = False

    async def receive(self):
        for _ in range(5000):
            if self.stream.turn_count() >= self.turns:
                return BrowserStop()
            await asyncio.sleep(0)
        return BrowserStop()

    async def send(self, message) -> None:
        self.sent.append(dict(message))

    async def close(self) -> None:
        self.closed = True


class CallLedgerTests(unittest.TestCase):
    """A whole call: the end document, the trace and a resumed session."""

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-turn-call-")
        self.clock = FakeClock()

    def events_for(self) -> tuple[OperationalEvents, TurnLedger]:
        log = CallEventLog(self.directory, call_id=CALL_ID)
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID),
            sink=log,
            subject_kind="demo",
        )
        events = OperationalEvents(stream, subject=SUBJECT, now=self.clock)
        return events, TurnLedger(events, now=self.clock)

    def run_call(
        self,
        *,
        turns: int,
        trace=(),
        replies=(),
    ) -> dict:
        events, ledger = self.events_for()
        audio = RecordingAudio()
        voice = LifecycleVoice()
        turn_stream = CascadeTurnStream(
            llm=ScriptedLLM(list(replies)),
            tts=voice,
            tools=(),
            emit_audio=audio,
            clock=self.clock,
            turn_events=ledger,
        )
        transport = StopAfterTurns(turn_stream, turns)
        speech = ScriptedSTT(trace, clock=self.clock)

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg", speech)

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "voice leg", voice)

        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=turn_stream,
            send_audio=RecordingAudioSink(),
            clock=self.clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            operational_events=events,
        )
        asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
        return transport.sent[-1]

    def sidecar(self) -> dict:
        path = Path(self.directory) / f"{CALL_ID}.end.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_a_three_turn_call_agrees_with_the_persisted_turn_rows(self):
        trace = []
        replies = []
        for number in (1, 2, 3):
            trace.extend(
                [
                    SpeechStart(f"t{number}"),
                    SpeechComplete(f"turn {number}", turn_id=f"t{number}"),
                ]
            )
            replies.append({"deltas": [f"Reply {number}."]})

        sent = self.run_call(turns=3, trace=trace, replies=replies)

        rows = rows_in(self.directory)
        self.assertEqual("end", rows[-1]["type"], "the end row is not last")
        summary = rows[-1]["turnSummary"]
        self.assertEqual(3, summary["turns"])
        self.assertEqual(3, summary["turnsWithReply"])
        self.assertEqual(["0:t1", "0:t2", "0:t3"], summary["turnIds"])
        self.assertTrue(summary["agrees"], "the end row disagrees with its turn rows")
        self.assertEqual(3, sent["turns"])
        self.assertEqual(sent["turns"], self.sidecar()["turns"])

        by_turn: dict[str, list[str]] = {}
        for row in rows:
            if row["type"].startswith("turn."):
                by_turn.setdefault(row["turn"], []).append(row["type"])
        self.assertEqual(["0:t1", "0:t2", "0:t3"], sorted(by_turn))
        for types in by_turn.values():
            self.assertEqual(
                ["turn.user_final", "turn.reply_start", "turn.first_audio"], types
            )

    def test_a_greeting_only_call_records_one_end_row_and_zero_turns(self):
        sent = self.run_call(turns=0, trace=(), replies=())

        rows = rows_in(self.directory)
        self.assertEqual([], [row for row in rows if row["type"].startswith("turn.")])
        self.assertEqual(1, len([row for row in rows if row["type"] == "end"]))
        self.assertEqual(0, sent["turns"])
        self.assertEqual(0, self.sidecar()["turns"])
        self.assertEqual(
            {"turns": 0, "turnsWithReply": 0, "turnIds": [], "agrees": True},
            rows[-1]["turnSummary"],
        )

    def test_a_hold_return_continues_one_trace_and_its_turn_ids(self):
        trace = [
            SpeechStart("t1"),
            SpeechComplete("first", turn_id="t1"),
        ]
        self.run_call(turns=1, trace=trace, replies=[{"deltas": ["First."]}])
        self.run_call(turns=1, trace=trace, replies=[{"deltas": ["Second."]}])

        files = sorted(path.name for path in Path(self.directory).iterdir())
        self.assertEqual([f"{CALL_ID}.end.json", f"{CALL_ID}.jsonl"], files)

        rows = rows_in(self.directory)
        ends = [row for row in rows if row["type"] == "end"]
        self.assertEqual(1, len(ends), "the hold return appended a second end row")
        turn_ids = [row["turn"] for row in rows if row["type"] == "turn.reply_start"]
        self.assertEqual(["0:t1", "1:t1"], turn_ids, "the resumed session reused an id")
        self.assertEqual(["1:t1"], ends[0]["turnSummary"]["turnIds"])
        self.assertEqual(1, ends[0]["turnSummary"]["turns"])
        self.assertTrue(ends[0]["turnSummary"]["agrees"])

    def test_a_provider_protocol_failure_is_named_in_the_trace(self):
        from cascade.failures import FailureClass, FailureVerdict
        from cascade.meta_stt import SpeechCallFailure

        failure = SpeechCallFailure(
            verdict=FailureVerdict(
                leg="stt",
                code=1013,
                failure_class=FailureClass.TRIGGER,
                reason="rate limited",
            ),
            stage="stream",
            reason="the speech session closed with 1013",
        )
        sent = self.run_call(
            turns=1,
            trace=[SpeechStart("t1"), Step(exc=failure)],
            replies=[],
        )

        rows = rows_in(self.directory)
        errors = [row for row in rows if row["type"] == "protocol.error"]
        self.assertEqual(1, len(errors), "the protocol failure left no row")
        self.assertEqual("stt", errors[0]["leg"])
        self.assertEqual(1013, errors[0]["code"])
        self.assertIn("trigger", errors[0]["reason"])
        self.assertEqual("error", sent["endedBy"])


if __name__ == "__main__":
    unittest.main()
