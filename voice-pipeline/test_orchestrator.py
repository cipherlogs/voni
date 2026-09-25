"""Tests for the cascade turn orchestrator.

Fakes stand in for all three providers; the scripts below prove the turn
loop: partials prefetch, finals commit, tokens become ordered audio,
barge-in interrupts, backchannels don't, bad tools are denied.
"""

import asyncio
import unittest
from collections.abc import AsyncIterator

from metrics import TimingLedger
from orchestrator import TurnOrchestrator, TurnResult
from providers import (
    FinalTranscript,
    PartialTranscript,
    SentenceAudio,
    TokenDelta,
    ToolCallRequest,
)


async def empty_audio() -> AsyncIterator[bytes]:
    if False:
        yield b""


async def frames(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


class FakeSTT:
    def __init__(self, events: list) -> None:
        self._events = events
        self.audio_bytes = 0
        self.opened_with: dict | None = None

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        self.opened_with = {"language_codes": language_codes, "sample_rate": sample_rate}

    async def send_audio(self, pcm: bytes) -> None:
        self.audio_bytes += len(pcm)

    async def events(self):
        for event in self._events:
            yield event

    async def close(self) -> None:
        pass


class FakeLLM:
    def __init__(
        self,
        tokens: list[str],
        tool_calls: list[ToolCallRequest] | None = None,
        token_delay: float = 0.0,
    ) -> None:
        self._tokens = tokens
        self._tool_calls = tool_calls or []
        self._token_delay = token_delay
        self.prefetches = 0
        self.cancels = 0
        self.completions = 0
        self.tokens_seen = 0
        self.messages_seen: list[list[dict]] = []

    async def complete(self, *, messages, tools=None):
        self.messages_seen.append(messages)
        self.completions += 1
        for token in self._tokens:
            self.tokens_seen += 1
            if self._token_delay:
                await asyncio.sleep(self._token_delay)
            yield TokenDelta(text=token)
        for call in self._tool_calls:
            yield call

    def prefetch(self, *, messages, tools=None):
        self.prefetches += 1

        outer = self

        class Handle:
            def cancel(self) -> None:
                outer.cancels += 1

        return Handle()


class FakeTTS:
    def __init__(self) -> None:
        self.spoken: list[str] = []

    async def speak(self, text: str):
        self.spoken.append(text)
        yield SentenceAudio(pcm=text.encode(), sample_rate=24000, text=text)


def make_orchestrator(stt, llm, tts, **kwargs):
    audio_out: list[SentenceAudio] = []

    async def on_audio(chunk: SentenceAudio) -> None:
        audio_out.append(chunk)

    kwargs.setdefault("scorer", lambda text, ms: 0.0)
    kwargs.setdefault("tool_gate", lambda name: (True, 0.5))
    orch = TurnOrchestrator(
        stt=stt, llm=llm, tts=tts, on_audio=on_audio, system_prompt="sys", **kwargs
    )
    return orch, audio_out


async def wait_until(cond, timeout: float = 2.0) -> None:
    import time

    start = time.monotonic()
    while not cond():
        if time.monotonic() - start > timeout:
            raise TimeoutError("wait_until timed out")
        await asyncio.sleep(0.005)


class LiveFakeSTT(FakeSTT):
    """Queue-fed STT: events arrive over time like a real stream."""

    def __init__(self) -> None:
        super().__init__([])
        self._queue: asyncio.Queue = asyncio.Queue()

    async def push(self, event) -> None:
        await self._queue.put(event)

    async def finish(self) -> None:
        await self._queue.put(None)

    async def events(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event


class TurnLoopTests(unittest.TestCase):
    def test_full_turn_streams_ordered_audio(self):
        async def run():
            stt = FakeSTT(
                [
                    PartialTranscript(text="hi"),
                    PartialTranscript(text="hi there"),
                    FinalTranscript(text="hi there"),
                ]
            )
            llm = FakeLLM(tokens=["Hey", " there!"])
            tts = FakeTTS()
            orch, audio_out = make_orchestrator(stt, llm, tts)
            results = await orch.run(frames(b"\x00" * 320))
            return orch, audio_out, results, stt, llm, tts

        orch, audio_out, results, stt, llm, tts = asyncio.run(run())
        self.assertEqual(len(results), 1)
        result = results[0]
        assert isinstance(result, TurnResult)
        self.assertEqual(result.user_text, "hi there")
        self.assertEqual(result.reply_text, "Hey there!")
        self.assertFalse(result.interrupted)
        # Prefetch fired on partials; one completion served the turn.
        self.assertGreaterEqual(llm.prefetches, 1)
        self.assertEqual(llm.completions, 1)
        # Ordered audio reached the playout callback.
        self.assertEqual(b"".join(c.pcm for c in audio_out), b"Hey there!")
        self.assertTrue(stt.audio_bytes > 0)
        gaps = orch.ledger.summary()["gaps_ms"]
        self.assertIsNotNone(gaps["audio_in_to_first_partial"])
        self.assertIsNotNone(gaps["final_to_first_playout"])

    def test_empty_audio_produces_no_turns(self):
        async def run():
            orch, audio_out = make_orchestrator(FakeSTT([]), FakeLLM([]), FakeTTS())
            return await orch.run(empty_audio()), audio_out

        results, audio_out = asyncio.run(run())
        self.assertEqual(results, [])
        self.assertEqual(audio_out, [])

    def test_history_accumulates_across_turns(self):
        async def run():
            stt = FakeSTT(
                [FinalTranscript(text="one"), FinalTranscript(text="two")]
            )
            llm = FakeLLM(tokens=["r"])
            orch, _ = make_orchestrator(stt, llm, FakeTTS())
            results = await orch.run(frames(b"\x00"))
            return orch, results

        orch, results = asyncio.run(run())
        self.assertEqual(len(results), 2)
        roles = [m["role"] for m in orch.history]
        self.assertEqual(roles, ["system", "user", "assistant", "user", "assistant"])

    def test_hidden_context_is_history_only_and_applies_to_next_turn(self):
        async def run():
            stt = FakeSTT([FinalTranscript(text="one")])
            llm = FakeLLM(tokens=["reply"])
            orch, _ = make_orchestrator(stt, llm, FakeTTS())
            orch.add_context("The user's microphone is muted.")
            events: list[tuple[str, dict]] = []
            orch._on_event = lambda kind, payload: events.append((kind, payload))  # type: ignore[assignment]
            results = await orch.run(frames(b"\x00"))
            return orch, llm, events, results

        orch, llm, events, results = asyncio.run(run())
        self.assertEqual(results[0].reply_text, "reply")
        self.assertEqual(
            llm.messages_seen[0],
            [
                {"role": "system", "content": "sys"},
                {"role": "system", "content": "The user's microphone is muted."},
                {"role": "user", "content": "one"},
            ],
        )
        self.assertNotIn("context", [kind for kind, _ in events])
        self.assertEqual(orch.history[1]["role"], "system")


class BargeInTests(unittest.TestCase):
    def test_real_interruption_stops_audio(self):
        async def run():
            stt = LiveFakeSTT()
            llm = FakeLLM(tokens=["Once", " upon", " a", " time"], token_delay=0.02)
            orch, audio_out = make_orchestrator(
                stt, llm, FakeTTS(), scorer=lambda text, ms: 0.9
            )
            task = asyncio.create_task(orch.run(frames(b"\x00")))
            await stt.push(FinalTranscript(text="tell me a story"))
            await wait_until(lambda: llm.tokens_seen >= 1)
            await stt.push(PartialTranscript(text="stop, what is the price"))
            await stt.push(FinalTranscript(text="stop, what is the price"))
            await stt.finish()
            results = await task
            return orch, results, audio_out

        orch, results, audio_out = asyncio.run(run())
        interrupted = [r for r in results if r.interrupted]
        self.assertTrue(interrupted, "expected an interrupted turn")
        counts = orch.ledger.summary()["counts"]
        self.assertGreaterEqual(counts["yield"] + counts["interruption"], 1)

    def test_soft_yield_suppresses_stale_reply(self):
        # Commit arrives while the reply is still one held sentence: no
        # stale audio plays, the turn still records the yield, and the
        # interrupting turn speaks normally.
        async def run():
            stt = LiveFakeSTT()
            llm = FakeLLM(tokens=["Hello", " there."], token_delay=0.02)
            orch, audio_out = make_orchestrator(
                stt, llm, FakeTTS(), scorer=lambda text, ms: 0.9
            )
            task = asyncio.create_task(orch.run(frames(b"\x00")))
            await stt.push(FinalTranscript(text="tell me"))
            await wait_until(lambda: llm.tokens_seen >= 1)
            await stt.push(PartialTranscript(text="stop now please"))
            await stt.push(FinalTranscript(text="stop now please"))
            await stt.finish()
            results = await task
            return orch, results, audio_out

        orch, results, audio_out = asyncio.run(run())
        self.assertEqual(len(results), 2)
        self.assertTrue(results[0].interrupted, "yielded turn marked")
        self.assertFalse(results[1].interrupted)
        self.assertEqual([c.text for c in audio_out], ["Hello there."])

    def test_backchannel_does_not_interrupt(self):
        async def run():
            stt = LiveFakeSTT()
            llm = FakeLLM(tokens=["a", "b", "c"], token_delay=0.02)
            orch, audio_out = make_orchestrator(
                stt, llm, FakeTTS(), scorer=lambda text, ms: 0.12
            )
            task = asyncio.create_task(orch.run(frames(b"\x00")))
            await stt.push(FinalTranscript(text="tell me a story"))
            await wait_until(lambda: llm.tokens_seen >= 1)
            await stt.push(PartialTranscript(text="mhm"))
            await stt.push(PartialTranscript(text="tell me more"))
            await stt.push(FinalTranscript(text="tell me more"))
            await stt.finish()
            results = await task
            return orch, results, audio_out

        orch, results, audio_out = asyncio.run(run())
        self.assertFalse(any(r.interrupted for r in results))
        self.assertTrue(audio_out)

    def test_overlap_registers_even_when_uncommitted(self):
        # Heard-but-not-committed still counts: one "overheard" per
        # floor-holding episode, no matter how many partials streamed.
        async def run():
            stt = FakeSTT([])
            orch, _ = make_orchestrator(
                stt, FakeLLM(tokens=[]), FakeTTS(), scorer=lambda text, ms: 0.12
            )
            # Established agent speech, then overlapping partials.
            orch._speaking = True
            orch._speech_start = orch._clock() - 2.0
            await orch._handle_partial("mhm")
            await orch._handle_partial("mhm yeah")
            return orch

        orch = asyncio.run(run())
        counts = orch.ledger.summary()["counts"]
        self.assertEqual(counts["overheard"], 1)
        self.assertEqual(counts["yield"], 0)

    def test_command_overlap_steers_the_llm_in_context(self):
        # A committed "stop" reaches the model with a pivot note appended,
        # so IT chooses transition-vs-continue instead of resuming.
        async def run():
            stt = FakeSTT([FinalTranscript(text="stop that")])
            llm = FakeLLM(tokens=["Sure, stopping."])
            orch, _ = make_orchestrator(
                stt, llm, FakeTTS(), scorer=lambda text, ms: 0.9
            )
            # Established agent speech, then the steering overlap.
            orch._speaking = True
            orch._speech_start = orch._clock() - 2.0
            await orch._handle_partial("stop")
            results = await orch.run(frames(b"\x00"))
            return orch, llm, results

        orch, llm, results = asyncio.run(run())
        pivot_notes = [
            m
            for messages in llm.messages_seen
            for m in messages
            if m.get("role") == "system" and "interrupted with" in m.get("content", "")
        ]
        self.assertTrue(pivot_notes, "expected a pivot note in LLM context")
        self.assertIn("stop that", pivot_notes[0]["content"])


class ToolGateTests(unittest.TestCase):
    def test_denied_tool_recorded_not_executed(self):
        async def run():
            stt = FakeSTT([FinalTranscript(text="do it")])
            llm = FakeLLM(
                tokens=[],
                tool_calls=[ToolCallRequest(name="drop table", arguments={}, call_id="c9")],
            )
            orch, _ = make_orchestrator(
                stt, llm, FakeTTS(), tool_gate=lambda name: (False, 0.9)
            )
            results = await orch.run(frames(b"\x00"))
            return results, orch

        results, orch = asyncio.run(run())
        self.assertEqual(results[0].denied_tools, ["drop table"])
        self.assertEqual(results[0].tool_calls, [])
        self.assertEqual(orch.ledger.summary()["counts"]["tool_denied"], 1)

    def test_allowed_tool_recorded(self):
        async def run():
            stt = FakeSTT([FinalTranscript(text="look it up")])
            llm = FakeLLM(
                tokens=["ok"],
                tool_calls=[
                    ToolCallRequest(name="lookupLead", arguments={"q": "x"}, call_id="c1")
                ],
            )
            orch, _ = make_orchestrator(stt, llm, FakeTTS())
            return await orch.run(frames(b"\x00"))

        results = asyncio.run(run())
        self.assertEqual(results[0].tool_calls, ["lookupLead"])


class EndCallTests(unittest.TestCase):
    def test_end_call_speaks_goodbye_then_emits_call_end(self):
        async def run():
            events: list[tuple[str, dict]] = []

            async def on_event(kind: str, payload: dict) -> None:
                events.append((kind, payload))

            stt = FakeSTT([FinalTranscript(text="bye then")])
            tts = FakeTTS()
            llm = FakeLLM(
                tokens=[],
                tool_calls=[
                    ToolCallRequest(
                        name="end_call",
                        arguments={"closing_line": "Thanks, goodbye!"},
                        call_id="e1",
                    )
                ],
            )
            orch, _ = make_orchestrator(stt, llm, tts, on_event=on_event)
            results = await orch.run(frames(b"\x00"))
            return events, results, tts

        events, results, tts = asyncio.run(run())
        kinds = [kind for kind, _ in events]
        self.assertEqual(results[0].tool_calls, ["end_call"])
        # The goodbye goes through TTS like any sentence and lands in the
        # transcript — the caller hears it before the line drops.
        self.assertIn("Thanks, goodbye!", tts.spoken)
        self.assertIn("Thanks, goodbye!", results[0].reply_text)
        self.assertEqual(kinds[-1], "call_end")
        self.assertEqual(events[-1][1], {"closing_line": "Thanks, goodbye!"})

    def test_end_call_without_closing_line_is_denied(self):
        async def run():
            stt = FakeSTT([FinalTranscript(text="bye")])
            llm = FakeLLM(
                tokens=["later"],
                tool_calls=[ToolCallRequest(name="end_call", arguments={}, call_id="e2")],
            )
            orch, _ = make_orchestrator(stt, llm, FakeTTS())
            return await orch.run(frames(b"\x00"))

        results = asyncio.run(run())
        self.assertEqual(results[0].tool_calls, [])
        self.assertEqual(results[0].denied_tools, ["end_call"])


class EventHookTests(unittest.TestCase):
    def test_partial_final_agent_sequence_emitted(self):
        async def run():
            events: list[tuple[str, dict]] = []

            async def on_event(kind: str, payload: dict) -> None:
                events.append((kind, payload))

            stt = FakeSTT(
                [PartialTranscript(text="hi"), FinalTranscript(text="hi there")]
            )
            llm = FakeLLM(tokens=["Hey!"])
            orch, _ = make_orchestrator(stt, llm, FakeTTS(), on_event=on_event)
            results = await orch.run(frames(b"\x00"))
            return events, results

        events, results = asyncio.run(run())
        kinds = [kind for kind, _ in events]
        self.assertEqual(
            kinds, ["user_partial", "user_final", "agent_partial", "agent_final"]
        )
        self.assertEqual(events[0][1], {"text": "hi"})
        self.assertEqual(events[2][1], {"text": "Hey!"})
        self.assertEqual(events[3][1], {"text": "Hey!"})
        self.assertEqual(len(results), 1)

    def test_no_hook_no_failure(self):
        async def run():
            stt = FakeSTT([FinalTranscript(text="hi")])
            orch, _ = make_orchestrator(stt, FakeLLM(tokens=["yo"]), FakeTTS())
            return await orch.run(frames(b"\x00"))

        results = asyncio.run(run())
        self.assertEqual(results[0].reply_text, "yo")

    def test_failed_turn_emits_turn_failed(self):
        async def run():
            events: list[tuple[str, dict]] = []

            async def on_event(kind: str, payload: dict) -> None:
                events.append((kind, payload))

            class BrokenLLM(FakeLLM):
                async def complete(self, *, messages, tools=None):
                    raise RuntimeError("gateway exploded")
                    yield

            stt = FakeSTT([FinalTranscript(text="hi")])
            orch, _ = make_orchestrator(
                stt, BrokenLLM(tokens=[]), FakeTTS(), on_event=on_event
            )
            try:
                await orch.run(frames(b"\x00"))
            except RuntimeError:
                pass
            return events

        events = asyncio.run(run())
        kinds = [kind for kind, _ in events]
        self.assertIn("turn_failed", kinds)


if __name__ == "__main__":
    unittest.main()
