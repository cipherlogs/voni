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
from turns import BARGE_IN_THRESHOLD, commit_decision, is_command_overlap


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
        on_event: Callable[[str, dict], Awaitable[None]] | None = None,
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
        self._on_event = on_event
        self.ledger = ledger or TimingLedger(now=clock)
        self._clock = clock or time.monotonic
        self.history: list[dict] = (
            [{"role": "system", "content": system_prompt}] if system_prompt else []
        )
        self._speaking = False
        self._speech_start = 0.0
        self._interrupted = False
        # Soft-yield: a committed barge-in finishes the current sentence
        # before pivoting (no mid-word cut), so the gate stashes the
        # interrupting text here instead of stopping audio immediately.
        self._pending_redirect: str | None = None
        # Agent-initiated hangup: end_call is call control, not a backend
        # tool. The closing line goes through TTS like any sentence, then
        # the turn emits call_end and the browser lets playback drain before
        # closing. Cleared if the caller barges during the goodbye (they
        # took the floor back — the hangup is disarmed, like every path).
        self._end_requested: str | None = None
        self._last_partial = ""
        self._turn_task: Optional[asyncio.Task] = None
        self._floor_held = False
        # Counted once per turn: a partial arrived while the agent held the
        # floor. Heard-but-not-committed overlap still registers, even when
        # the gate waits and the reply continues.
        self._overheard_counted = False
        self.turn_results: list[TurnResult] = []

    def add_context(self, content: str) -> None:
        """Append hidden system context for the next generated turn.

        Context never enters the caption event stream and does not touch the
        current reply task, so a mute transition cannot interrupt playback.
        """
        if content:
            self.history.append({"role": "system", "content": content})

    async def run(self, audio: AsyncIterator[bytes]) -> list[TurnResult]:
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
                        # tasks never need loop input to finish. TimeoutError
                        # only: outer cancellation must propagate, never be
                        # swallowed here, or hangup stops working.
                        if self._turn_task is not None and not self._turn_task.done():
                            try:
                                await asyncio.wait_for(self._turn_task, timeout=120.0)
                            except asyncio.TimeoutError:
                                if not self._turn_task.done():
                                    self._turn_task.cancel()
                            except asyncio.CancelledError:
                                raise
                            except Exception:
                                pass  # already emitted by the watcher
                        task = asyncio.get_running_loop().create_task(
                            self._handle_final(event.text)
                        )
                        task.add_done_callback(self._watch_turn_task)
                        self._turn_task = task
                        turn_tasks.append(task)
                # Results already collected by the watcher; here we only make
                # sure no task is left dangling. Turn failures were emitted
                # as events when they happened — the drain must not re-raise
                # them (but run cancellation always propagates).
                for task in turn_tasks:
                    if task.done():
                        continue
                    try:
                        await asyncio.wait_for(task, timeout=120.0)
                    except asyncio.TimeoutError:
                        task.cancel()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        pass
            finally:
                if not pump.done():
                    pump.cancel()
                try:
                    await pump
                except asyncio.CancelledError:
                    pass
        finally:
            await self._stt.close()
        return self.turn_results

    async def _pump_audio(self, audio: AsyncIterator[bytes]) -> None:
        first = True
        async for frame in audio:
            if first:
                self.ledger.mark("audio_in")
                first = False
            await self._stt.send_audio(frame)

    async def _emit(self, kind: str, payload: dict) -> None:
        # Observability only: a failing sink must never break the turn.
        if self._on_event is None:
            return
        try:
            await self._on_event(kind, payload)
        except Exception:
            pass

    async def _handle_partial(self, text: str) -> None:
        if not text or text == self._last_partial:
            return
        self._last_partial = text
        self.ledger.mark("first_partial")
        await self._emit("user_partial", {"text": text})
        turn_active = self._turn_task is not None and not self._turn_task.done()
        if self._speaking or turn_active:
            # Gate path: the agent holds the floor (speaking, thinking, or
            # reply winding down). A live-but-silent turn counts as
            # established — its final was already committed.
            if not self._overheard_counted:
                self._overheard_counted = True
                self.ledger.count("overheard")
            if self._speaking:
                ms = (self._clock() - self._speech_start) * 1000.0
            else:
                ms = 5000.0
            prob = self._scorer(text, ms)
            decision = commit_decision(text, ms, prob)
            if decision == "commit":
                self.ledger.count("yield")
                # Graceful, not abrupt: the consumer finishes the sentence
                # it is speaking, then pivots. The producer stops at once
                # so no more gateway spend goes into the stale reply.
                self._pending_redirect = text
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

    def _watch_turn_task(self, task: asyncio.Task) -> None:
        # A failed turn must surface while the call is still live: STT events
        # never end on their own, so without this a backend failure reads as
        # eternal silence instead of an error. Successful turns collect here
        # so results survive even when the run loop is cancelled (hangup).
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            asyncio.get_running_loop().create_task(
                self._emit("turn_failed", {"error": f"{type(exc).__name__}: {exc}"})
            )
        else:
            self.turn_results.append(task.result())

    async def _handle_final(self, text: str) -> TurnResult:
        self.ledger.mark("final")
        await self._emit("user_final", {"text": text})
        self._last_partial = ""
        self._overheard_counted = False
        # A committed overlap redirected this turn: the caller steered while
        # the agent held the floor. Steering goes to the LLM in context so
        # IT chooses transition-vs-continue — the gate only guarantees it
        # is heard, with a human pivot (acknowledge briefly first, never
        # resume the cut-off sentence).
        had_redirect = self._pending_redirect is not None
        self._pending_redirect = None
        result = TurnResult(user_text=text)
        messages = self.history + [{"role": "user", "content": text}]
        if had_redirect and is_command_overlap(text):
            messages.append(
                {
                    "role": "system",
                    "content": (
                        f"The caller interrupted with: {text!r}. Acknowledge "
                        "it briefly first (e.g. 'Sorry — ...'), then follow "
                        "their new direction. Do not resume the cut-off sentence."
                    ),
                }
            )
        self._interrupted = False
        sentence_queue: asyncio.Queue = asyncio.Queue()
        producer = asyncio.get_running_loop().create_task(
            self._produce_reply(messages, result, sentence_queue)
        )
        await self._consume_sentences(sentence_queue, producer)
        self._speaking = False
        if self._pending_redirect is not None:
            # Soft-yield settled: the floor changed hands even when there
            # was no sentence left to finish (producer already stopped).
            self._pending_redirect = None
            self._interrupted = True
        self.history.append({"role": "user", "content": text})
        if result.reply_text:
            self.history.append({"role": "assistant", "content": result.reply_text})
            await self._emit("agent_final", {"text": result.reply_text})
        if self._interrupted:
            result.interrupted = True
            # The caller barged during the goodbye: the hangup disarms, the
            # pivot wins, and the agent re-decides with the floor back.
            self._end_requested = None
            await self._emit("interrupted", {"user_text": text})
        elif self._end_requested is not None:
            closing_line, self._end_requested = self._end_requested, None
            await self._emit("call_end", {"closing_line": closing_line})
        return result

    async def _produce_reply(
        self, messages: list[dict], result: TurnResult, sentence_queue: asyncio.Queue
    ) -> None:
        """Stream LLM tokens; split completed sentences onto the queue."""
        try:
            buffer = ""
            async for event in self._llm.complete(messages=messages, tools=self._tools):
                if self._interrupted or self._pending_redirect is not None:
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
                    if complete:
                        # LLM-authored text: stream instantly at zero STT cost
                        # (cascade equivalent of transcript.agent.delta).
                        await self._emit("agent_partial", {"text": result.reply_text})
                elif isinstance(event, ToolCallRequest):
                    if event.name == "end_call":
                        closing = event.arguments.get("closing_line")
                        if isinstance(closing, str) and closing.strip():
                            result.tool_calls.append(event.name)
                            self.ledger.count("end_call")
                            # Speak the goodbye through the normal sentence
                            # path, then end after this turn. Stop the LLM
                            # here so no more spend goes into a closing call.
                            closing = closing.strip()
                            sentence_queue.put_nowait(closing)
                            result.reply_text = (result.reply_text + " " + closing).strip()
                            await self._emit("agent_partial", {"text": result.reply_text})
                            self._end_requested = closing
                            break
                        result.denied_tools.append(event.name)
                        self.ledger.count("tool_denied")
                        continue
                    allowed, _ = self._tool_gate(event.name)
                    if allowed:
                        result.tool_calls.append(event.name)
                    else:
                        result.denied_tools.append(event.name)
                        self.ledger.count("tool_denied")
            tail = buffer.strip()
            if tail and not self._interrupted and self._pending_redirect is None:
                sentence_queue.put_nowait(tail)
                await self._emit("agent_partial", {"text": result.reply_text})
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
        """Synthesize sentences in order; pivot gracefully on barge-in."""
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
                # Soft-yield lands here: the sentence just finished instead
                # of being cut mid-word. Stop the stale reply now so the
                # interrupting turn owns the floor next.
                if self._pending_redirect is not None:
                    self._interrupted = True
                    break
            # A failed producer must fail the turn, not vanish: retrieve its
            # exception (also silences "never retrieved") and re-raise it so
            # the run task — and the transport's end message — carry it.
            if producer.done() and not producer.cancelled():
                exc = producer.exception()
                if exc is not None:
                    raise exc
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
