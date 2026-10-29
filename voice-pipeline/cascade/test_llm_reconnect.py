"""Ticket 96: the model reconnects only before it has spoken.

Spec: `.scratch/meta-cascade/spec.md`, "Reconnect, sequence dedupe, partial
reply" — "A failure before the first content token may retry once. A failure
mid-reply does not restart the completion: it drains the sentences already
queued, closes the turn at the last complete sentence, and never cuts
mid-word. History records the spoken prefix, not the unspoken tail, so the
next turn matches what the caller heard."

The retry decision is the ticket-94 :class:`cascade.reconnect.ReconnectBudget`,
not a second counter: this module reports ``RECONNECT`` before speech,
``DRAIN`` once text has been yielded, and ``END`` when the leg's one reconnect
is already spent. A restart after speech is the one thing these tests must
never see.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass

from cascade.meta_llm import (
    MessageHistory,
    MetaLLM,
    MetaLLMLegExhausted,
    MetaLLMReplyInterrupted,
    MetaLLMTurn,
    last_complete_sentence,
)
from cascade.reconnect import ReconnectAction
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


def content_frame(text: str) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
    )


def reasoning_frame(text: str) -> bytes:
    return sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {"reasoning_content": text},
                    "finish_reason": None,
                }
            ]
        }
    )


def stop_frame() -> bytes:
    return sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})


DONE = b"data: [DONE]\n\n"


@dataclass
class FaultPlan:
    """One scripted attempt that can fail *after* yielding frames."""

    chunks: tuple[bytes, ...] = ()
    error: BaseException | None = None
    status: int = 200


class _FaultSession:
    def __init__(self, plan: FaultPlan, log: list) -> None:
        self._plan = plan
        self._log = log
        self.status = plan.status

    async def __aenter__(self) -> "_FaultSession":
        return self

    async def __aexit__(self, *args) -> bool:
        return False

    def post(self, url, *, headers=None, json=None):
        self._log.append({"url": url, "headers": headers, "json": json})
        return self

    async def iter_bytes(self):
        for chunk in self._plan.chunks:
            yield chunk
        if self._plan.error is not None:
            raise self._plan.error


class FaultFactory:
    """A session factory whose attempts are :class:`FaultPlan` values."""

    def __init__(self, plans) -> None:
        self._plans = list(plans)
        self.posts: list[dict] = []

    def __call__(self, *, timeout_s: float = 0.0):
        index = len(self.posts)
        plan = self._plans[min(index, len(self._plans) - 1)]
        return _FaultSession(plan, self.posts)


def make_llm(factory, **overrides) -> MetaLLM:
    options = {
        "api_key": API_KEY,
        "reasoning_effort": "low",
        "session_factory": factory,
    }
    options.update(overrides)
    return MetaLLM(**options)


def run(llm, *, messages=None, history: MessageHistory | None = None):
    """Drive one completion; return (events, turn, raised exception)."""

    async def scenario():
        turn = MetaLLMTurn()
        events = []
        error = None
        try:
            async for event in llm.complete(
                turn=turn,
                messages=messages
                if messages is not None
                else [{"role": "user", "content": "rate?"}],
            ):
                events.append(event)
        except BaseException as exc:
            error = exc
        if history is not None:
            history.append_reply(turn)
        return events, turn, error

    return asyncio.run(scenario())


class MidReplyDrainTest(unittest.TestCase):
    """A reply already in the caller's ear finishes its sentences, never restarts."""

    def test_a_mid_reply_failure_closes_at_the_last_complete_sentence(self):
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(content_frame("Hi there. The rate is 6"),),
                    error=TimeoutError("read timed out"),
                )
            ]
        )
        history = MessageHistory()
        history.append_user("rate?")

        events, turn, error = run(make_llm(factory), history=history)

        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertEqual(
            "".join(event.text for event in events), "Hi there. The rate is 6"
        )
        self.assertEqual(
            turn.spoken_text,
            "Hi there.",
            "the drain closes at the last complete sentence, never mid-word",
        )
        self.assertEqual(turn.unspoken_text, " The rate is 6")
        self.assertEqual(
            history.messages[-1],
            {"role": "assistant", "content": "Hi there."},
            "history records the spoken prefix, not the unspoken tail",
        )

    def test_the_next_turn_sees_exactly_what_the_caller_heard(self):
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(content_frame("Hi there. The rate is 6"),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(
                    chunks=(
                        content_frame("It is 6.2 percent."),
                        stop_frame(),
                        DONE,
                    )
                ),
            ]
        )
        llm = make_llm(factory)
        history = MessageHistory()
        history.append_user("rate?")

        _, turn, error = run(llm, history=history)
        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertIsNotNone(turn.spoken_text)

        events, second, second_error = run(llm, messages=history.request_messages())

        self.assertIsNone(second_error)
        self.assertEqual([event.text for event in events], ["It is 6.2 percent."])
        posted = factory.posts[-1]["json"]["messages"]
        self.assertEqual(
            posted,
            [
                {"role": "user", "content": "rate?"},
                {"role": "assistant", "content": "Hi there."},
            ],
            "the next request carries only the words the caller actually heard",
        )
        self.assertNotIn("The rate is 6", json.dumps(posted))

    def test_last_complete_sentence_never_cuts_a_word(self):
        self.assertEqual(
            last_complete_sentence("Hi there. The rate is 6"),
            "Hi there.",
        )
        self.assertEqual(last_complete_sentence("No sentence yet"), "")
        self.assertEqual(
            last_complete_sentence("One. Two! Three?"), "One. Two! Three?"
        )
        self.assertEqual(
            last_complete_sentence('She said "done." Then left'),
            'She said "done."',
        )


class RetryBeforeSpeechTest(unittest.TestCase):
    """Only a failure before the first content token may post again."""

    def test_a_failure_before_the_first_token_retries_once_through_the_budget(self):
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(reasoning_frame("The caller asked about rates."),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(
                    chunks=(
                        content_frame("Your rate is 6.2 percent."),
                        stop_frame(),
                        DONE,
                    )
                ),
            ]
        )
        llm = make_llm(factory)

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(factory.posts), 2, "one retry, never two")
        spoken = "".join(event.text for event in events)
        self.assertEqual(spoken, "Your rate is 6.2 percent.")
        self.assertEqual(
            spoken.count("6.2 percent"),
            1,
            "the retry speaks the reply once; the failed attempt said nothing",
        )
        decision = turn.failure_decisions[0]
        self.assertEqual(decision.phase, "turn")
        self.assertTrue(decision.retry)
        self.assertEqual(
            llm.reconnect_budget.counters("llm").failure_reconnects, 1
        )
        self.assertEqual(llm.reconnect_budget.counters("llm").budget_left, 0)

    def test_a_second_failure_ends_the_call_without_a_second_retry(self):
        factory = FaultFactory(
            [
                FaultPlan(error=TimeoutError("stalled")),
                FaultPlan(error=TimeoutError("stalled again")),
                FaultPlan(
                    chunks=(
                        content_frame("never spoken"),
                        stop_frame(),
                        DONE,
                    )
                ),
            ]
        )
        llm = make_llm(factory)

        events, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMLegExhausted)
        self.assertEqual(len(factory.posts), 2, "the one retry is spent")
        self.assertEqual(events, [])
        self.assertEqual(
            llm.reconnect_budget.counters("llm").failure_reconnects, 1
        )
        self.assertEqual(llm.reconnect_budget.counters("llm").budget_left, 0)
        self.assertIsNotNone(turn.last_failure)
        self.assertFalse(turn.last_failure.retry)

    def test_a_mid_reply_failure_drains_without_reconnecting(self):
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(content_frame("Hi there."),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(
                    chunks=(
                        content_frame("Hi there. Again."),
                        stop_frame(),
                        DONE,
                    )
                ),
            ]
        )
        llm = make_llm(factory)

        _, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertEqual(len(factory.posts), 1, "a spoken reply is never restarted")
        self.assertEqual(
            llm.reconnect_budget.counters("llm").failure_reconnects,
            0,
            "the drain spends no reconnect",
        )
        self.assertEqual(llm.reconnect_budget.counters("llm").failures, 1)
        self.assertEqual(llm.reconnect_budget.counters("llm").budget_left, 0)
        self.assertEqual(
            turn.last_failure.phase,
            "reply",
            "the budget reported a drain, not a reconnect",
        )
        self.assertEqual(turn.spoken_text, "Hi there.")


if __name__ == "__main__":
    unittest.main()
