"""Turn orchestrator: STT partials → commit gate → LLM stream → ordered TTS (P1).

One committed turn flows: user Final → llm.complete() (adopting any matching
prefetch) → producer splits completed sentences as tokens arrive → consumer
synthesizes in order → on_audio per chunk. Meanwhile user partials either
prefetch (agent silent) or hit the commit gate (agent speaking): real
interruptions stop playout via flag + task cancel, backchannels only count.

Ledger marks every gap: audio_in, first_partial, final, first_token,
first_sentence_audio, first_playout. Nothing here awaits network in an audio
path — providers own that contract; this loop only sequences their streams.

Default scorer/tool gate resolve lazily from telephony-bot's voice_judge
(single behavior source); absent that module they fail closed (wait/deny).
Tests inject fakes.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Optional

from backends.cartesia_tts import split_sentences
from metrics import TimingLedger
from providers import (
    FinalTranscript,
    PartialTranscript,
    SentenceAudio,
    TokenDelta,
    ToolCallRequest,
)
from turns import BARGE_IN_THRESHOLD, commit_decision


@dataclass
class TurnResult:
    user_text: str
    reply_text: str = ""
    tool_calls: list[str] = field(default_factory=list)
    denied_tools: list[str] = field(default_factory=list)
    interrupted: bool = False


def _ensure_bridge_on_path() -> None:
    import sys
    from pathlib import Path

    bridge = str(Path(__file__).resolve().parent.parent / "telephony-bot")
    if bridge not in sys.path:
        sys.path.insert(0, bridge)


def _default_scorer(text: str, agent_speaking_ms: float) -> float:
    try:
        _ensure_bridge_on_path()
        from voice_judge import heuristic_barge_in_score

        return heuristic_barge_in_score(text, agent_speaking_ms)
    except Exception:
        return 0.0


def _default_tool_gate(name: Any) -> tuple[bool, float]:
    try:
        _ensure_bridge_on_path()
        from voice_judge import allow_tool_call

        return allow_tool_call(name)
    except Exception:
        return (False, 0.9)


class TurnOrchestrator:
    def __init__(
        self,
        *,
        stt: Any,
        llm: Any,
        tts: Any,
        on_audio: Callable[[SentenceAudio], Awaitable[None]],
        system_prompt: str = "",
        tools: list[dict] | None = None,
        language_codes: list[str] | None = None,
        sample_rate: int = 24000,
        scorer: Callable[[str, float], float] | None = None,
        tool_gate: Callable[[Any], tuple[bool, float]] | None = None,
        ledger: TimingLedger | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._on_audio = on_audio
        self._tools = tools
        self._language_codes = language_codes if language_codes is not None else ["en"]
        self._sample_rate = sample_rate
        self._scorer = scorer or _default_scorer
        self._tool_gate = tool_gate or _default_tool_gate
        self.ledger = ledger or TimingLedger(now=clock)
        self._clock = clock or time.monotonic
        self.history: list[dict] = (
            [{"role": "system", "content": system_prompt}] if system_prompt else []
        )
        self._speaking = False
        self._speech_start = 0.0
        self._interrupted = False
        self._last_partial = ""
        self._turn_task: Optional[asyncio.Task] = None
        self._floor_held = False

    async def run(self, audio: AsyncIterator[bytes]) -> list[TurnResult]:
        results: list[TurnResult] = []
        turn_tasks: list[asyncio.Task] = []
        await self._stt.open(
            language_codes=self._language_codes, sample_rate=self._sample_rate
        )
        try:
            pump = asyncio.get_running_loop().create_task(self._pump_audio(audio))
            try:
                async for event in self._stt.events():
                    if isinstance(event, PartialTranscript):
                        await self._handle_partial(event.text)
                    elif isinstance(event, FinalTranscript):
                        # A new turn while the previous reply is still live
                        # means the gate already fired (or should have): let
                        # the old turn settle so replies never overlap. The
                        # timeout is a stall guard, not a latency knob — turn
                        # tasks never need loop input to finish.
                        if self._turn_task is not None and not self._turn_task.done():
                            try:
                                await asyncio.wait_for(self._turn_task, timeout=120.0)
                            except (asyncio.TimeoutError, asyncio.CancelledError):
                                if not self._turn_task.done():
                                    self._turn_task.cancel()
                        task = asyncio.get_running_loop().create_task(
                            self._handle_final(event.text)
                        )
                        self._turn_task = task
                        turn_tasks.append(task)
                if self._turn_task is not None and not self._turn_task.done():
                    try:
                        await asyncio.wait_for(self._turn_task, timeout=120.0)
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        if not self._turn_task.done():
                            self._turn_task.cancel()
                for task in turn_tasks:
                    results.append(task.result())
            finally:
                if not pump.done():
                    pump.cancel()
                try:
                    await pump
                except asyncio.CancelledError:
                    pass
        finally:
            await self._stt.close()
        return results

    async def _pump_audio(self, audio: AsyncIterator[bytes]) -> None:
        first = True
        async for frame in audio:
            if first:
                self.ledger.mark("audio_in")
                first = False
            await self._stt.send_audio(frame)

    async def _handle_partial(self, text: str) -> None:
        if not text or text == self._last_partial:
            return
        self._last_partial = text
        self.ledger.mark("first_partial")
        turn_active = self._turn_task is not None and not self._turn_task.done()
        if self._speaking or turn_active:
            # Gate path: the agent holds the floor (speaking, thinking, or
            # reply winding down). A live-but-silent turn counts as
            # established — its final was already committed.
            if self._speaking:
                ms = (self._clock() - self._speech_start) * 1000.0
            else:
                ms = 5000.0
            prob = self._scorer(text, ms)
            decision = commit_decision(text, ms, prob)
            if decision == "commit":
                self.ledger.count("yield")
                self._interrupted = True
            elif decision == "backchannel":
                self.ledger.count("backchannel")
        else:
            # Speculative prefetch on the growing turn; the backend cancels
            # the previous one. Reads only, never awaited here.
            try:
                self._llm.prefetch(
                    messages=self.history + [{"role": "user", "content": text}],
                    tools=self._tools,
                )
                self.ledger.count("prefetch_started")
            except Exception:
                pass

    async def _handle_final(self, text: str) -> TurnResult:
        self.ledger.mark("final")
        self._last_partial = ""
        result = TurnResult(user_text=text)
        messages = self.history + [{"role": "user", "content": text}]
        self._interrupted = False
        sentence_queue: asyncio.Queue = asyncio.Queue()
        producer = asyncio.get_running_loop().create_task(
            self._produce_reply(messages, result, sentence_queue)
        )
        await self._consume_sentences(sentence_queue, producer)
        self._speaking = False
        self.history.append({"role": "user", "content": text})
        if result.reply_text:
            self.history.append({"role": "assistant", "content": result.reply_text})
        if self._interrupted:
            result.interrupted = True
        return result

    async def _produce_reply(
        self, messages: list[dict], result: TurnResult, sentence_queue: asyncio.Queue
    ) -> None:
        """Stream LLM tokens; split completed sentences onto the queue."""
        try:
            buffer = ""
            async for event in self._llm.complete(messages=messages, tools=self._tools):
                if self._interrupted:
                    break
                if isinstance(event, TokenDelta):
                    if not event.text:
                        continue
                    if not result.reply_text:
                        self.ledger.mark("first_token")
                    result.reply_text += event.text
                    buffer += event.text
                    complete, remainder = self._split_complete(buffer)
                    buffer = remainder
                    for sentence in complete:
                        sentence_queue.put_nowait(sentence)
                elif isinstance(event, ToolCallRequest):
                    allowed, _ = self._tool_gate(event.name)
                    if allowed:
                        result.tool_calls.append(event.name)
                    else:
                        result.denied_tools.append(event.name)
                        self.ledger.count("tool_denied")
            tail = buffer.strip()
            if tail and not self._interrupted:
                sentence_queue.put_nowait(tail)
        finally:
            sentence_queue.put_nowait(None)

    @staticmethod
    def _split_complete(buffer: str) -> tuple[list[str], str]:
        sentences = split_sentences(buffer)
        if len(sentences) <= 1:
            # Zero or one: either nothing complete, or the whole buffer is one
            # sentence that may still grow — hold it.
            return ([], buffer)
        return (sentences[:-1], sentences[-1])

    async def _consume_sentences(
        self, sentence_queue: asyncio.Queue, producer: asyncio.Task
    ) -> None:
        """Synthesize sentences in order; stop early on barge-in."""
        try:
            while True:
                sentence = await sentence_queue.get()
                if sentence is None or self._interrupted:
                    break
                first_chunk = True
                async for chunk in self._tts.speak(sentence):
                    if self._interrupted:
                        break
                    if first_chunk:
                        self.ledger.mark("first_sentence_audio")
                        first_chunk = False
                    await self._on_audio(chunk)
                    if not self._speaking:
                        self._speaking = True
                        self._speech_start = self._clock()
                    self.ledger.mark("first_playout")
        finally:
            if not producer.done():
                producer.cancel()
            try:
                await producer
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            self._speaking = False
            if self._interrupted:
                self.ledger.count("interruption")
