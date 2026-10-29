"""The negative suite: no speculative commit across ``speechEnd``.

Spec: `.scratch/meta-cascade/spec.md` "Orchestrator: logical turns, provider
boundary, floor arbitration" — No speculative commit. Three prohibitions are
proved here, not assumed:

1. **No model request at ``speechEnd``.** Between ``speechEnd`` and the
   ``speechComplete`` of the same turn there are zero requests — not a
   completion, not a speculative prefetch. ``speechEnd`` records the boundary
   and nothing else.
2. **End-of-stream is a call-end frame.** It is sent when the call ends and
   never at ``speechEnd`` (or at ``speechComplete``): the client cannot force a
   turn on the provider.
3. **A partial is never a user message.** It updates turn state and nothing
   else; the model only ever sees the authoritative ``speechComplete`` text.

The suite is sensitive by construction: a test reintroduces a speculative
request *at* ``speechEnd`` and asserts the window check catches it, and every
guard named here has a red-proof recorded in the ticket answer. The vocabulary
is take the floor / yield / wait: nothing here is called a commit.
"""

import asyncio
import json
import unittest
from collections.abc import AsyncIterator

from cascade.event_rules import EventKind, EventRules
from cascade.floor import FinalGate, FloorArbiter
from cascade.meta_stt import (
    END_STREAM_FRAME,
    MetaStreamingSTT,
    SpeechComplete,
    SpeechEnd,
    SpeechStart,
)
from cascade.prefetch import PrefetchSpeculator
from cascade.testing.clock import FakeClock
from cascade.testing.scripted import ScriptedPrefetch
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.turn_state import TurnStateStore
from metrics import TimingLedger
from providers import LLMStream, PartialTranscript, TokenDelta


def user(text):
    return [{"role": "system", "content": "You are Voni."}, {"role": "user", "content": text}]


class TimedLLM(LLMStream):
    """An LLM that records *when* every request was made, not just that it was."""

    def __init__(self, clock):
        self.clock = clock
        self.calls: list[tuple[float, str]] = []
        self.requests: list[list[dict]] = []
        self.prefetches: list[ScriptedPrefetch] = []

    async def complete(self, *, messages, tools=None) -> AsyncIterator:
        self.calls.append((self.clock(), "complete"))
        self.requests.append(list(messages))
        yield TokenDelta(text="Sure.")

    def prefetch(self, *, messages, tools=None) -> ScriptedPrefetch:
        self.calls.append((self.clock(), "prefetch"))
        handle = ScriptedPrefetch(list(messages), tools)
        self.prefetches.append(handle)
        return handle


def requests_between(calls, start, end):
    """Every model request made in ``[start, end)``. Must be empty per turn."""
    return [call for call in calls if start <= call[0] < end]


class RecordingReplySink:
    def __init__(self, llm):
        self.llm = llm
        self.texts = []

    async def __call__(self, turn):
        self.texts.append(turn.final_text)
        async for _ in self.llm.complete(messages=user(turn.final_text)):
            pass


def build_rules(*, clock, rules_cls=EventRules, speculate=None):
    turns = TurnStateStore(clock=clock, source="meta")
    ledger = TimingLedger(now=clock)
    llm = TimedLLM(clock)
    sink = RecordingReplySink(llm)
    arbiter = FloorArbiter(clock=clock, ledger=ledger)
    speculator = PrefetchSpeculator(llm=llm, ledger=ledger, arbiter=arbiter)
    gate = FinalGate(ledger=ledger, arbiter=arbiter)
    kwargs = dict(turns=turns, on_reply=sink, ledger=ledger, final_gate=gate)
    if speculate is not None:
        kwargs["speculate"] = speculate
    rules = rules_cls(**kwargs)
    return turns, ledger, llm, sink, arbiter, speculator, rules


class ZeroRequestsAtSpeechEndTest(unittest.TestCase):
    def test_zero_model_requests_between_speech_end_and_speech_complete(self):
        clock = FakeClock()
        turns, ledger, llm, sink, arbiter, speculator, rules = build_rules(
            clock=clock
        )

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            clock.advance(1.0)
            partial = await rules.apply(PartialTranscript("book a dem"))
            # The only speculation of the turn starts while the turn speaks.
            self.assertIsNotNone(
                speculator.offer(
                    "book a dem",
                    messages=user("book a dem"),
                    phase=partial.turn.phase,
                )
            )
            clock.advance(1.0)
            end = await rules.apply(SpeechEnd("t1"))
            window_start = clock()
            clock.advance(0.5)
            # A replayed partial after the boundary: state only, no work.
            await rules.apply(PartialTranscript("book a demo"))
            refused = speculator.offer(
                "book a demo",
                messages=user("book a demo"),
                phase=turns.get("t1").phase,
            )
            clock.advance(0.5)
            done = await rules.apply(
                SpeechComplete(turn_id="t1", text="book a demo tomorrow")
            )
            return end, window_start, clock(), refused, done

        end, window_start, window_end, refused, done = asyncio.run(scenario())

        self.assertEqual(EventKind.SPEECH_END, end.kind)
        self.assertIsNotNone(end.endpointing_ms)
        self.assertIsNone(refused, "no speculation may start at or after speechEnd")
        self.assertEqual([], requests_between(llm.calls, window_start, window_end))
        self.assertEqual(2.0, window_start)
        self.assertEqual(3.0, window_end)
        self.assertEqual(
            [(1.0, "prefetch"), (3.0, "complete")],
            llm.calls,
        )
        self.assertEqual(["book a demo tomorrow"], sink.texts)

    def test_a_speculative_request_at_speech_end_is_caught_by_the_suite(self):
        """The regression this suite exists for, made explicit.

        ``speculate`` is a model request issued from ``speechEnd`` — exactly
        the shape a future "reduce the reply gap" change would take. The window
        check must fail on it.
        """

        clock = FakeClock()
        llm = TimedLLM(clock)

        class SpeculativeAtSpeechEnd(EventRules):
            def __init__(self, *, speculate, **kwargs):
                super().__init__(**kwargs)
                self._speculate = speculate

            def _on_speech_end(self, event):
                outcome = super()._on_speech_end(event)
                if outcome.kind is EventKind.SPEECH_END:
                    self._speculate()
                return outcome

        turns, ledger, _llm, sink, arbiter, speculator, rules = build_rules(
            clock=clock,
            rules_cls=SpeculativeAtSpeechEnd,
            speculate=lambda: llm.prefetch(messages=user("book a dem")),
        )

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            await rules.apply(PartialTranscript("book a dem"))
            await rules.apply(SpeechEnd("t1"))
            window_start = clock()
            clock.advance(1.0)
            await rules.apply(SpeechComplete(turn_id="t1", text="book a demo"))
            return window_start, clock()

        window_start, window_end = asyncio.run(scenario())

        violations = requests_between(llm.calls, window_start, window_end)
        self.assertEqual([(0.0, "prefetch")], violations)


class EndOfStreamOnlyAtCallEndTest(unittest.TestCase):
    """The provider owns the turn: only a call end may close the input."""

    def test_end_stream_is_never_sent_at_speech_end(self):
        clock = FakeClock()
        factory = ScriptedSocketFactory([full_turn_plan()], clock=clock)
        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            clock=clock,
        )

        async def scenario():
            await backend.open(language_codes=[], sample_rate=24000)
            async for mapped in backend.events():
                if isinstance(mapped, (SpeechEnd, SpeechComplete)):
                    break
            return text_frames(factory, 0)

        frames = asyncio.run(scenario())

        self.assertEqual(1, len(frames))
        self.assertIn("authorization", json.loads(frames[0]))
        self.assertNotIn(END_STREAM_FRAME, frames)

    def test_end_stream_is_never_sent_at_speech_complete(self):
        clock = FakeClock()
        factory = ScriptedSocketFactory([full_turn_plan()], clock=clock)
        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            clock=clock,
        )

        async def scenario():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass

        asyncio.run(scenario())

        self.assertNotIn(END_STREAM_FRAME, text_frames(factory, 0))

    def test_end_stream_is_sent_when_the_call_ends(self):
        clock = FakeClock()
        factory = ScriptedSocketFactory([full_turn_plan()], clock=clock)
        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            clock=clock,
        )

        async def scenario():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()

        asyncio.run(scenario())

        self.assertEqual([END_STREAM_FRAME], text_frames(factory, 0)[1:])


class PartialIsNeverAUserMessageTest(unittest.TestCase):
    def test_a_partial_updates_turn_state_but_is_never_a_user_message(self):
        clock = FakeClock()
        turns, ledger, llm, sink, arbiter, speculator, rules = build_rules(
            clock=clock
        )

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            partial = await rules.apply(PartialTranscript("book a demo"))
            before = (turns.user_text("t1"), partial.turn.final_text, list(llm.requests))
            done = await rules.apply(
                SpeechComplete(turn_id="t1", text="book a demo tomorrow")
            )
            return partial, before, done, turns.user_text("t1")

        partial, before, done, user_text = asyncio.run(scenario())

        self.assertEqual(EventKind.PARTIAL, partial.kind)
        self.assertEqual("book a demo", partial.turn.partial_text)
        self.assertEqual((None, "", []), before)
        self.assertEqual("book a demo tomorrow", user_text)
        self.assertEqual(["book a demo tomorrow"], sink.texts)
        self.assertEqual(1, len(llm.requests))

    def test_the_model_only_ever_sees_the_authoritative_final(self):
        clock = FakeClock()
        turns, ledger, llm, sink, arbiter, speculator, rules = build_rules(
            clock=clock
        )

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            await rules.apply(PartialTranscript("book a dem"))
            await rules.apply(PartialTranscript("book a demo"))
            await rules.apply(SpeechEnd("t1"))
            await rules.apply(SpeechComplete(turn_id="t1", text="book a demo tomorrow"))

        asyncio.run(scenario())

        self.assertEqual(1, len(llm.requests))
        self.assertEqual("book a demo tomorrow", llm.requests[0][-1]["content"])

    def test_an_empty_completion_invents_no_user_message_and_no_request(self):
        clock = FakeClock()
        turns, ledger, llm, sink, arbiter, speculator, rules = build_rules(
            clock=clock
        )

        async def scenario():
            await rules.apply(SpeechStart("t1"))
            await rules.apply(PartialTranscript("uh-huh"))
            return await rules.apply(SpeechComplete(turn_id="t1", text=""))

        outcome = asyncio.run(scenario())

        self.assertEqual(EventKind.NO_SPEECH, outcome.kind)
        self.assertFalse(outcome.reply_requested)
        self.assertEqual([], llm.requests)
        self.assertEqual(1, rules.no_speech_turns)


def untyped_ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def full_turn_plan():
    return [
        untyped_ack(),
        event("speechStart", turnId="turn-1"),
        event("transcript", text="hello"),
        event("speechEnd", turnId="turn-1"),
        event("speechComplete", turnId="turn-1", text="hello"),
        Frame(close_code=1000, reason="done"),
    ]


def text_frames(factory, index):
    sent = factory.connections[index]["socket"].sent
    return [frame for frame in sent if isinstance(frame, str)]


if __name__ == "__main__":
    unittest.main()
