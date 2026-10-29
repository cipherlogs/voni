"""Ticket 42: the model failure policy by phase.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "``400`` is a
configuration or conversation-structure bug: fail the turn, alert, do not open
the breaker. ``429``, ``5xx`` and timeouts are retryable: open the breaker after
the retry policy, retry once before the first content token, and never restart a
mid-reply completion (that would repeat speech). A second failure on the leg
ends the call."

The seam is ``MetaLLMTurn.failure_decisions``: every terminal or retried
failure is recorded with its attempt, its phase (``connect``, ``turn`` or
``reply``), the verdict from :mod:`cascade.failures`, and what the policy did.
The breaker is the ticket-17 :class:`CallRungs`, so these tests read the durable
record a future call would see rather than a spy.
"""

import asyncio
import json
import unittest
from dataclasses import dataclass

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.failures import FailureClass
from cascade.ladders import LLM_LADDER, CallRungs, read_choices
from cascade.meta_llm import (
    MetaLLM,
    MetaLLMLegExhausted,
    MetaLLMRequestError,
    MetaLLMReplyInterrupted,
    MetaLLMTurn,
    MetaLLMTurnFailed,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing import Response, ScriptedSessionFactory
from cascade.testing.clock import FakeClock

API_KEY = "test-meta-key"
INTERVAL_S = 30.0


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


def tool_finish_frame() -> bytes:
    """One complete call plus the handoff; the request is emitted here."""
    return sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_a",
                                "type": "function",
                                "function": {
                                    "name": "lookup_rate",
                                    "arguments": '{"amount": 40000}',
                                },
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
    )


DONE = b"data: [DONE]\n\n"
OK_STREAM = (content_frame("Your rate is 6.2%."), stop_frame(), DONE)


def closed_llm_record(**changes) -> ProviderBreakerRecord:
    fields = {"leg": "llm", "provider": "spark", "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def leg_harness(record=None) -> tuple[CallRungs, Breaker]:
    """A real breaker behind the call's frozen rungs; no spy."""
    record = record or closed_llm_record()
    clock = FakeClock(0.0)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
        }
    )
    breaker = Breaker(store, probe_interval_s=INTERVAL_S, now=clock)
    transitions = BreakerTransitions(breaker)
    choices = asyncio.run(read_choices(breaker, ladders=(LLM_LADDER,)))
    return CallRungs(choices, transitions=transitions), breaker


def make_llm(factory, **overrides) -> MetaLLM:
    options = {
        "api_key": API_KEY,
        "reasoning_effort": "low",
        "session_factory": factory,
    }
    options.update(overrides)
    return MetaLLM(**options)


def run(llm):
    """Drive one completion; return (events, turn, raised exception)."""

    async def scenario():
        turn = MetaLLMTurn()
        events = []
        error = None
        try:
            async for event in llm.complete(
                turn=turn, messages=[{"role": "user", "content": "rate?"}]
            ):
                events.append(event)
        except BaseException as exc:
            error = exc
        return events, turn, error

    return asyncio.run(scenario())


def read_state(breaker: Breaker) -> str:
    return asyncio.run(breaker.read("llm")).state


@dataclass
class FaultPlan:
    """One scripted attempt that can fail *after* yielding frames.

    ``ScriptedSessionFactory`` faults before the first chunk; a mid-reply
    failure needs a stream that speaks and then dies, so this local seam exists
    only in the test.
    """

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


class ConversationBugTests(unittest.TestCase):
    """A request bug is our bug, not an outage: fail the turn and alert."""

    def test_a_400_fails_the_turn_alerts_and_leaves_the_leg_closed(self):
        rungs, breaker = leg_harness()
        alerts = []
        factory = ScriptedSessionFactory(
            [Response(status=400, body=b'{"error": "bad message order"}')]
        )
        llm = make_llm(factory, rungs=rungs, on_alert=alerts.append)

        events, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMTurnFailed)
        self.assertEqual(events, [])
        self.assertEqual(len(factory.posts), 1)
        self.assertEqual(alerts, [turn.last_failure])
        self.assertEqual(read_state(breaker), "closed")

        decision = turn.last_failure
        self.assertEqual(decision.attempt, 1)
        self.assertEqual(decision.phase, "connect")
        self.assertFalse(decision.retry)
        self.assertFalse(decision.opened_leg)
        self.assertIs(decision.verdict.failure_class, FailureClass.BUG)
        self.assertEqual(decision.verdict.code, 400)
        self.assertIn("400", str(error))
        self.assertEqual(
            decision.to_document(),
            {
                "attempt": 1,
                "phase": "connect",
                "code": 400,
                "failureClass": "bug",
                "retry": False,
                "openedLeg": False,
                "reason": decision.reason,
            },
        )

    def test_a_400_does_not_spend_the_legs_retry_budget(self):
        """A bug is not an outage: the next transient failure still retries."""
        rungs, breaker = leg_harness()
        factory = ScriptedSessionFactory(
            [
                Response(status=400, body=b'{"error": "bad message order"}'),
                Response(status=429, body=b"slow down"),
                Response(chunks=OK_STREAM),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        _, _, bug_error = run(llm)
        self.assertIsInstance(bug_error, MetaLLMTurnFailed)

        _, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(factory.posts), 3)
        self.assertEqual(read_state(breaker), "closed")
        self.assertTrue(turn.failure_decisions[0].retry)


class RetryBeforeFirstTokenTests(unittest.TestCase):
    """Retryable failures retry once; only a spent policy opens the leg."""

    def test_a_429_is_retried_once_and_the_reply_is_spoken_once(self):
        rungs, breaker = leg_harness()
        alerts = []
        factory = ScriptedSessionFactory(
            [Response(status=429, body=b"slow down"), Response(chunks=OK_STREAM)]
        )
        llm = make_llm(factory, rungs=rungs, on_alert=alerts.append)

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(factory.posts), 2)
        self.assertEqual([event.text for event in events], ["Your rate is 6.2%."])
        self.assertEqual(turn.finish_reason, "stop")
        self.assertEqual(alerts, [])
        self.assertEqual(read_state(breaker), "closed")

        decision = turn.failure_decisions[0]
        self.assertTrue(decision.retry)
        self.assertFalse(decision.opened_leg)
        self.assertEqual(decision.phase, "connect")
        self.assertEqual(decision.attempt, 1)

    def test_a_second_retryable_failure_opens_the_leg_and_ends_the_call(self):
        for status in (429, 500, 503):
            with self.subTest(status=status):
                rungs, breaker = leg_harness()
                alerts = []
                factory = ScriptedSessionFactory(
                    [
                        Response(status=status, body=b"unavailable"),
                        Response(status=status, body=b"unavailable"),
                    ]
                )
                llm = make_llm(factory, rungs=rungs, on_alert=alerts.append)

                events, turn, error = run(llm)

                self.assertIsInstance(error, MetaLLMLegExhausted)
                self.assertEqual(events, [])
                self.assertEqual(len(factory.posts), 2)
                self.assertEqual(read_state(breaker), "open")
                self.assertEqual(turn.failure_decisions[0].attempt, 1)
                self.assertTrue(turn.failure_decisions[0].retry)
                last = turn.last_failure
                self.assertEqual(last.attempt, 2)
                self.assertFalse(last.retry)
                self.assertTrue(last.opened_leg)
                self.assertEqual(last.phase, "connect")
                self.assertEqual(alerts, [last])
                self.assertIn(str(status), str(error))

    def test_a_timeout_before_the_first_token_is_retried(self):
        rungs, breaker = leg_harness()
        factory = ScriptedSessionFactory(
            [Response(exc=TimeoutError("stalled")), Response(chunks=OK_STREAM)]
        )
        llm = make_llm(factory, rungs=rungs)

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(factory.posts), 2)
        self.assertEqual([event.text for event in events], ["Your rate is 6.2%."])
        self.assertEqual(read_state(breaker), "closed")
        self.assertIn("timeout", turn.last_failure.reason)
        self.assertEqual(turn.last_failure.verdict.code, "timeout")

    def test_a_timeout_after_reasoning_is_a_turn_phase_retry(self):
        """A 200 whose stream dies before content is retryable, and named."""
        rungs, breaker = leg_harness()
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(reasoning_frame("thinking about the rate"),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(chunks=OK_STREAM),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(factory.posts), 2)
        self.assertEqual([event.text for event in events], ["Your rate is 6.2%."])
        self.assertEqual(read_state(breaker), "closed")
        decision = turn.failure_decisions[0]
        self.assertEqual(decision.phase, "turn")
        self.assertTrue(decision.retry)
        self.assertEqual(turn.reasoning_text, "thinking about the rate")

    def test_a_second_failure_on_the_leg_ends_the_call_without_a_retry(self):
        rungs, breaker = leg_harness()
        factory = ScriptedSessionFactory(
            [
                Response(status=429, body=b"slow down"),
                Response(chunks=OK_STREAM),
                Response(status=429, body=b"slow down"),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        _, first_turn, first_error = run(llm)
        self.assertIsNone(first_error)
        self.assertEqual(len(factory.posts), 2)

        _, second_turn, second_error = run(llm)

        self.assertIsInstance(second_error, MetaLLMLegExhausted)
        self.assertEqual(len(factory.posts), 3)
        self.assertEqual(read_state(breaker), "open")
        self.assertFalse(second_turn.last_failure.retry)
        self.assertTrue(second_turn.last_failure.opened_leg)

    def test_a_second_failure_that_lands_mid_reply_still_ends_the_call(self):
        rungs, breaker = leg_harness()
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(reasoning_frame("thinking"),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(chunks=OK_STREAM),
                FaultPlan(
                    chunks=(content_frame("The rate is"),),
                    error=TimeoutError("read timed out"),
                ),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        _, _, first_error = run(llm)
        self.assertIsNone(first_error)

        _, second_turn, second_error = run(llm)

        self.assertIsInstance(second_error, MetaLLMLegExhausted)
        self.assertEqual(len(factory.posts), 3)
        self.assertEqual(second_turn.last_failure.phase, "reply")
        self.assertFalse(second_turn.last_failure.retry)
        self.assertEqual(read_state(breaker), "open")


class MidReplyFailureTests(unittest.TestCase):
    """A reply already in the caller's ear is never restarted."""

    def test_a_failure_after_the_first_token_never_posts_again(self):
        rungs, breaker = leg_harness()
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(content_frame("The rate is"),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(chunks=OK_STREAM),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        events, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertEqual(len(factory.posts), 1)
        self.assertEqual([event.text for event in events], ["The rate is"])
        decision = turn.last_failure
        self.assertEqual(decision.phase, "reply")
        self.assertFalse(decision.retry)
        self.assertTrue(decision.opened_leg)
        self.assertEqual(read_state(breaker), "open")
        self.assertTrue(turn.interrupted)
        self.assertFalse(turn.disposition.retry_allowed)

    def test_the_interrupted_reply_keeps_what_was_already_queued_for_speech(self):
        rungs, breaker = leg_harness()
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(content_frame("The rate is 6.2"), content_frame(" percent.")),
                    error=TimeoutError("read timed out"),
                )
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        events, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertEqual(
            "".join(event.text for event in events), "The rate is 6.2 percent."
        )
        self.assertTrue(turn.disposition.speak)
        self.assertEqual(read_state(breaker), "open")

    def test_a_tool_handoff_is_not_retried_into_a_second_execution(self):
        rungs, breaker = leg_harness()
        factory = FaultFactory(
            [
                FaultPlan(
                    chunks=(tool_finish_frame(),),
                    error=TimeoutError("read timed out"),
                ),
                FaultPlan(chunks=OK_STREAM),
            ]
        )
        llm = make_llm(factory, rungs=rungs)

        events, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMReplyInterrupted)
        self.assertEqual(len(factory.posts), 1)
        self.assertEqual(
            [event.call_id for event in events if hasattr(event, "call_id")],
            ["call_a"],
        )
        self.assertEqual(turn.last_failure.phase, "reply")
        self.assertFalse(turn.last_failure.retry)
        self.assertEqual(read_state(breaker), "open")


class UnclassifiedFailureTests(unittest.TestCase):
    def test_a_401_fails_the_turn_alerts_and_does_not_retry_or_open(self):
        rungs, breaker = leg_harness()
        alerts = []
        factory = ScriptedSessionFactory(
            [Response(status=401, body=b'{"error": "bad key"}')]
        )
        llm = make_llm(factory, rungs=rungs, on_alert=alerts.append)

        _, turn, error = run(llm)

        self.assertIsInstance(error, MetaLLMRequestError)
        self.assertEqual(len(factory.posts), 1)
        self.assertEqual(read_state(breaker), "closed")
        decision = turn.last_failure
        self.assertIs(decision.verdict.failure_class, FailureClass.DO_NOT_OPEN)
        self.assertFalse(decision.retry)
        self.assertEqual(alerts, [decision])


if __name__ == "__main__":
    unittest.main()
