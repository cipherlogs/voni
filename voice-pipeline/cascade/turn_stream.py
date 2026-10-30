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

One ticker drives both time-based duties on the injected clock:
:meth:`EventRules.tick` at ``turn.stall_guard_ms`` while a final is held, and
``AssemblyAIStreamingTTS.keepalive_if_idle`` at ``tts.keepalive_interval_ms``
while no reply is sounding. A new held final wakes the wait, so the guard is
never later than its named bound and a test can drive the same loop with a fake
clock instead of sleeping.

``end_call`` is call control (ticket 87): the signal's closing line is spoken
through the same voice, the logical turn is closed, and the call is asked to
drain and send its end message. Nothing generated after the signal is spoken.

The model request is gated on the LLM leg and synthesis on the TTS leg, so a
closed LLM leg never cuts audio that was already generated.
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
from cascade.thresholds import require_bound
from cascade.tools import (
    END_CALL_TOOL,
    EndCallSignal,
    ToolLoop,
    closing_line_from,
    continue_after_tool,
    execute_turn_calls,
)
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

#: One recorded turn's usage is on the meter; the call checks its ceiling.
BilledSink = Callable[[], Awaitable[None]]

#: ``end_call`` has spoken its closing line; the call drains and hangs up.
EndCallSink = Callable[[], Awaitable[None]]

#: The idle keepalive cadence (ticket 53's bound; never a literal here).
KEEPALIVE_BOUND = "tts.keepalive_interval_ms"


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
        sleep: Callable[[float], Awaitable[None]] | None = None,
        stall_guard_ms: float | None = None,
        on_caption: CaptionSink | None = None,
        on_interrupted: InterruptSink | None = None,
        on_turn_billed: BilledSink | None = None,
        on_end_call: EndCallSink | None = None,
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
        self._sleep = sleep if sleep is not None else asyncio.sleep
        self._on_caption = on_caption
        self._on_interrupted = on_interrupted
        self._on_turn_billed = on_turn_billed
        self._on_end_call = on_end_call

        self._turns = TurnStateStore(clock=self._clock, source="meta")
        self._rules = EventRules(
            turns=self._turns,
            on_reply=self._request_reply,
            ledger=ledger,
            clock=self._clock,
            stall_guard_ms=stall_guard_ms,
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
        #: ``end_call`` won: no model request or spoken content follows it.
        self._ending = False
        #: The one ticker: the stall guard's deadline and the idle keepalive.
        self._tick_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._next_keepalive_at: float | None = None
        self._keepalive_interval_s: float | None = None
        #: Idle ticks that found a reply in flight (audio is its own traffic).
        self.keepalives_skipped = 0

    # -- CallStream -------------------------------------------------------

    async def start(self) -> None:
        """The opening is over; the turn layer may answer finals.

        The ticker starts here because both of its duties only exist once the
        call is streaming: the stall guard's deadline on a held final, and the
        synthesis session's idle keepalive between replies.
        """
        if self._tick_task is None:
            self._next_keepalive_at = self._clock() + self._keepalive_interval()
            self._tick_task = asyncio.ensure_future(self._tick_loop())
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
        # A new held final (or a settled one) moves the ticker's next deadline;
        # the wake interrupts a keepalive wait so the guard is never late.
        self._wake.set()

    async def context(self, text: str) -> None:
        """Hold a browser context line for the next request only."""
        self._history.add_hidden_context(text)

    async def drain(self) -> None:
        """Finish the in-flight reply, then stop; a failure still surfaces."""
        ticker, self._tick_task = self._tick_task, None
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
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
        if self._ending:
            return
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
            record = await self._run_turn(state, record)
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
                # The turn's usage chunk exists now: the call records and
                # prices it before the next utterance, not at the next event.
                await self._notify_billed()
                await self._rules.settle(state)

    async def _run_turn(self, state: TurnState, record: MetaLLMTurn) -> MetaLLMTurn:
        """One logical turn: a reply, then any bounded tool rounds."""
        while True:
            if self._ending:
                return record
            if self._may_request is not None and not self._may_request("llm"):
                return record
            calls: list[ToolCallRequest] = []
            async for item in self._complete(record):
                if isinstance(item, ToolCallRequest):
                    calls.append(item)
                    if item.name == END_CALL_TOOL and closing_line_from(
                        item.arguments
                    ) is not None:
                        # The model has already decided to end the call: the
                        # closing line is the only speakable content left.
                        self._stop_speech()
                elif isinstance(item, TokenDelta):
                    await self._say(item.text)
            await self._flush()
            if not record.tool_calls or self._tool_executor is None:
                return record
            outcomes = await execute_turn_calls(self._tool_executor, record, calls)
            signal = next(
                (item for item in outcomes if isinstance(item, EndCallSignal)), None
            )
            if signal is not None:
                await self._finish_end_call(signal, state)
                return record
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

    # -- end call ---------------------------------------------------------

    def _stop_speech(self) -> None:
        """No model request or spoken sentence follows the end-call signal."""
        self._ending = True
        self._buffer = ""

    async def _finish_end_call(self, signal: EndCallSignal, state: TurnState) -> None:
        """Speak the closing line through the bound voice, then end the call.

        The line is the one content still allowed after the signal; the logical
        turn is closed as ``end_call`` and the lifecycle is asked to drain and
        send its one end message.
        """
        self._stop_speech()
        line = (signal.closing_line or "").strip()
        if line:
            await self._speak(line, force=True)
        self._turns.close(turn=state.id, reason="end_call")
        if self._on_end_call is not None:
            await self._on_end_call()

    async def _notify_billed(self) -> None:
        """Tell the call a turn's usage is recorded; a sink failure surfaces."""
        if self._on_turn_billed is None:
            return
        try:
            await self._on_turn_billed()
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._failure = error

    # -- the ticker -------------------------------------------------------

    def _keepalive_interval(self) -> float:
        """The idle keepalive cadence, read once from the named bound."""
        if self._keepalive_interval_s is None:
            self._keepalive_interval_s = float(require_bound(KEEPALIVE_BOUND)) / 1000.0
        return self._keepalive_interval_s

    def _next_tick_at(self) -> float:
        """The earliest of the stall guard's deadline and the keepalive's."""
        deadlines = [self._next_keepalive_at]
        due = self._rules.reply_order.due_at()
        if due is not None:
            deadlines.append(due)
        return min(value for value in deadlines if value is not None)

    async def _tick_loop(self) -> None:
        """One ticker for the stall guard's deadline and the idle keepalive.

        Both are measured on the injected clock, so a fake clock drives the
        same loop a real call drives and no test sleeps. A new held final wakes
        the sleep, so the guard is never later than its named bound.
        """
        try:
            while True:
                delay = max(0.0, self._next_tick_at() - self._clock())
                if delay > 0:
                    await self._sleep_until(delay)
                await self._service_ticks()
        except asyncio.CancelledError:
            raise
        except BaseException as error:  # a ticker failure is the call's failure
            self._failure = error

    async def _sleep_until(self, delay: float) -> None:
        sleeper = asyncio.ensure_future(self._sleep(delay))
        waker = asyncio.ensure_future(self._wake.wait())
        try:
            await asyncio.wait(
                {sleeper, waker}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (sleeper, waker):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sleeper, waker, return_exceptions=True)
            self._wake.clear()

    async def _service_ticks(self) -> None:
        now = self._clock()
        if self._next_keepalive_at is not None and now >= self._next_keepalive_at:
            self._next_keepalive_at = now + self._keepalive_interval()
            await self._keepalive_if_idle()
        due = self._rules.reply_order.due_at()
        if due is not None and self._clock() >= due:
            await self._rules.tick()

    async def _keepalive_if_idle(self) -> None:
        """Keep the synthesis session alive between replies; never over audio."""
        if self._ending:
            return
        task = self._reply_task
        if self._speaking or (task is not None and not task.done()):
            # A reply in flight is not idle: its frames are their own traffic.
            self.keepalives_skipped += 1
            return
        keepalive = getattr(self._tts, "keepalive_if_idle", None)
        if not callable(keepalive):
            return
        await keepalive()

    # -- speech -----------------------------------------------------------

    async def _say(self, text: str) -> None:
        """Buffer generated text and speak every whole sentence it completes."""
        if not text or self._ending:
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
        if self._ending:
            self._buffer = ""
            return
        sentence = self._buffer.strip()
        self._buffer = ""
        if sentence:
            await self._speak(sentence)

    async def _speak(self, text: str, *, force: bool = False) -> None:
        if not text:
            return
        if self._ending and not force:
            return
        # Synthesis is the TTS leg's request: a closed model leg must not cut
        # audio that was already generated (ticket 105 drains, never truncates).
        if (
            not force
            and self._may_request is not None
            and not self._may_request("tts")
        ):
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
