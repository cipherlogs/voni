"""The cascade turn stream: the one ``CallStream`` the browser call serves.

:class:`cascade.call.CallLifecycle` owns the order a call opens, streams and
drains in. This module owns the turn layer inside that order, and it composes
the pieces the cascade already has rather than re-implementing them:

* :class:`cascade.event_rules.EventRules` applies provider events to the
  logical turn store. Only an authoritative ``speechComplete`` reaches the
  reply sink; ``speechEnd`` never asks the model for anything.
* ``MetaLLM.complete`` (or the body's BYO client) streams one reply. Sentence
  boundaries are found with :func:`cascade.meta_llm.last_complete_sentence`, so
  synthesis starts on the first whole sentence and never on a cut word.
* the opened synthesis session's ``speak`` yields the audio; every frame goes
  through ``CallLifecycle.emit_audio``, so the call owns the one monotonic
  ``seq`` and this module cannot invent a second counter.
* :class:`cascade.tools.ToolExecutor` runs a tool handoff through the app's
  existing route, and :func:`cascade.tools.continue_after_tool` continues the
  same logical turn with the ``role: "tool"`` results.

Barge-in is the caller winning the floor: a real ``speechStart`` while audio is
sounding sends the synthesis session's ``Cancel`` and stops the reply task. The
cancelled turn is settled so a later final is not held behind it.

Nothing here reads a wall clock for a bound: the lifecycle owns
``turn.reply_task_ms``, the stall guard and the drain, and injects the clock it
measures with.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from cascade.event_rules import EventRules
from cascade.meta_llm import MessageHistory, MetaLLMTurn, last_complete_sentence
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.tools import ToolLoop, continue_after_tool, execute_turn_calls
from cascade.turn_state import TurnState, TurnStateStore
from metrics import TimingLedger
from providers import PartialTranscript, TokenDelta, ToolCallRequest

#: One outbound audio frame: the call lifecycle's ``emit_audio``.
AudioEmitter = Callable[..., Awaitable[Any]]

#: Whether a vendor request may still be made on a leg (the call's ceiling).
RequestGate = Callable[[str], bool]

#: One browser caption: role, text and whether it is the final text.
CaptionSink = Callable[[str, str, bool], Awaitable[None]]

#: The client's playout flush after a barge-in.
InterruptSink = Callable[[], Awaitable[None]]


class CascadeTurnStream:
    """The turn layer for one cascade call, on the lifecycle's seams."""

    def __init__(
        self,
        *,
        llm: Any,
        tts: Any,
        tools: Sequence[Mapping[str, Any]] = (),
        emit_audio: AudioEmitter,
        may_request: RequestGate | None = None,
        tool_executor: Any | None = None,
        locale_code: str = "en",
        ledger: TimingLedger | None = None,
        clock: Callable[[], float] | None = None,
        on_caption: CaptionSink | None = None,
        on_interrupted: InterruptSink | None = None,
    ) -> None:
        self._llm = llm
        self._tts = tts
        self._tools = tuple(tools)
        self._emit_audio = emit_audio
        self._may_request = may_request
        self._tool_executor = tool_executor
        self._locale_code = locale_code
        self._ledger = ledger
        self._clock = clock if clock is not None else time.monotonic
        self._on_caption = on_caption
        self._on_interrupted = on_interrupted

        self._turns = TurnStateStore(clock=self._clock, source="meta")
        self._rules = EventRules(
            turns=self._turns,
            on_reply=self._request_reply,
            ledger=ledger,
            clock=self._clock,
        )
        # The system prompt belongs to the model client; this history holds the
        # conversation and the browser's hidden context only.
        self._history = MessageHistory()
        self._tool_loop: ToolLoop | None = None

        self._reply_task: asyncio.Task | None = None
        self._active: TurnState | None = None
        self._speaking = False
        self._buffer = ""
        self._failure: BaseException | None = None
        self._records: dict[str, MetaLLMTurn] = {}
        self._completed: list[str] = []

    # -- CallStream -------------------------------------------------------

    async def start(self) -> None:
        """The opening is over; the turn layer may now answer finals."""
        return None

    async def event(self, event: Any) -> None:
        """Apply one provider event, and cut a sounding reply on a real start."""
        if self._failure is not None:
            raise self._failure
        if isinstance(event, SpeechStart) and self._speaking:
            await self._cancel_reply()
        await self._rules.apply(event)
        if isinstance(event, PartialTranscript):
            await self._caption("user", event.text, False)
        elif isinstance(event, SpeechComplete):
            await self._caption("user", event.text, True)

    async def context(self, text: str) -> None:
        """Hold a browser context line for the next request only."""
        self._history.add_hidden_context(text)

    async def drain(self) -> None:
        """Finish the in-flight reply, then stop; a failure still surfaces."""
        task = self._reply_task
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self._failure is not None:
            raise self._failure

    def turn_count(self) -> int:
        """How many logical turns produced a model reply."""
        return len(self._completed)

    def turn_usage(self) -> Mapping[str, Any]:
        """Each completed logical turn's vendor usage chunk, by turn id.

        An in-flight turn is absent, so the lifecycle records it once, when its
        usage chunk exists. A turn that never saw a chunk reports unmeasured,
        never zero.
        """
        return {
            turn: self._records[turn].usage
            for turn in self._completed
            if turn in self._records
        }

    # -- the reply --------------------------------------------------------

    async def _request_reply(self, state: TurnState) -> None:
        """Schedule one reply; the event loop stays free for barge-in."""
        if self._may_request is not None and not self._may_request("llm"):
            return
        self._active = state
        self._reply_task = asyncio.ensure_future(self._reply(state))
        self._reply_task.add_done_callback(self._reply_done)

    def _reply_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._failure = error

    async def _reply(self, state: TurnState) -> None:
        # One loop turn so a context update delivered with the final lands in
        # this request: the lifecycle replays buffered events before buffered
        # contexts, and the caller's context is for the next reply.
        await asyncio.sleep(0)
        key = state.id.event_id
        self._buffer = ""
        record = MetaLLMTurn()
        cancelled = False
        try:
            self._history.append_user(state.final_text)
            record = await self._run_turn(record)
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            record.close()
            self._records[key] = record
            if key not in self._completed:
                self._completed.append(key)
            self._speaking = False
            self._active = None
            if not cancelled:
                await self._rules.settle(state)

    async def _run_turn(self, record: MetaLLMTurn) -> MetaLLMTurn:
        """One logical turn: a reply, then any bounded tool rounds."""
        while True:
            if self._may_request is not None and not self._may_request("llm"):
                return record
            calls: list[ToolCallRequest] = []
            async for item in self._complete(record):
                if isinstance(item, ToolCallRequest):
                    calls.append(item)
                elif isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
            if not record.tool_calls or self._tool_executor is None:
                return record
            outcomes = await execute_turn_calls(self._tool_executor, record, calls)
            record = await self._continue_after_tools(record, outcomes)
            if not record.tool_calls:
                return record

    def _complete(self, record: MetaLLMTurn):
        """One model request for this logical turn, streaming its deltas."""
        return self._llm.complete(
            messages=self._history.request_messages(),
            tools=list(self._tools) or None,
            turn=record,
        )

    async def _continue_after_tools(self, record: MetaLLMTurn, outcomes: Any):
        next_record = MetaLLMTurn()
        async for item in continue_after_tool(
            llm=self._llm,
            history=self._history,
            turn=record,
            outcome=outcomes,
            tools=list(self._tools) or None,
            record=next_record,
            ledger=self._ledger,
            loop=self._loop(),
        ):
            if isinstance(item, TokenDelta):
                await self._say(item.text)
        await self._flush()
        return next_record

    def _loop(self) -> ToolLoop:
        if self._tool_loop is None:
            self._tool_loop = ToolLoop(locale_code=self._locale_code)
        return self._tool_loop

    # -- speech -----------------------------------------------------------

    async def _say(self, text: str) -> None:
        """Buffer generated text and speak every whole sentence it completes."""
        if not text:
            return
        self._buffer += text
        while True:
            sentence = last_complete_sentence(self._buffer)
            if not sentence:
                return
            self._buffer = self._buffer[len(sentence) :].lstrip()
            await self._speak(sentence)

    async def _flush(self) -> None:
        """Speak the reply's final, unterminated sentence."""
        sentence = self._buffer.strip()
        self._buffer = ""
        if sentence:
            await self._speak(sentence)

    async def _speak(self, text: str) -> None:
        if not text:
            return
        if self._may_request is not None and not self._may_request("llm"):
            return
        await self._caption("agent", text, False)
        async for audio in self._tts.speak(text):
            self._speaking = True
            await self._emit_audio(
                audio, kind="reply", flush_id=getattr(self._tts, "flush_id", None)
            )

    async def _cancel_reply(self) -> None:
        """Cut the sounding reply with ``Cancel``, then release the floor."""
        state = self._active
        task = self._reply_task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._cancel_voice()
        self._speaking = False
        self._buffer = ""
        if state is not None:
            await self._rules.settle(state, reason="barge_in")
        self._active = None
        if self._on_interrupted is not None:
            await self._on_interrupted()

    async def _cancel_voice(self) -> None:
        cancel = getattr(self._tts, "cancel", None)
        if not callable(cancel):
            return
        result = cancel()
        if inspect.isawaitable(result):
            await result

    async def _caption(self, role: str, text: str, final: bool) -> None:
        if self._on_caption is None:
            return
        await self._on_caption(role, text, final)


__all__ = ["CascadeTurnStream"]
