"""Ticket 84: a tool failure is a result and never a crash.

An outage, a refusal, an unreadable body or a timeout is something the model can
speak about, so every one of them becomes a ``role: "tool"`` message carrying the
call id it answers. These tests read the outcome the executor returns and the
message the model's next request sees, so they fail if a route condition escapes
as an exception, if a failure is reported as success, if the call id is lost, or
if a timed-out side effect is silently retried behind the caller's back.

Seams under test:

* ``ToolExecutor.execute`` -> the failure result for each route condition.
  Catches a 500/timeout/unreadable body that crashes or reads as success, and a
  timeout that is not recorded indeterminate. Misses the loop cap (87) and the
  spoken hold line (85).
* ``ToolFailure`` -> the classification the turn records. Catches a transient
  condition marked terminal (or the reverse) and an indeterminate side effect
  that is not marked as one.
* ``continue_after_tool`` -> the same logical turn continues after a failure.
  Catches a failure that ends the call instead of being answered. Misses
  ordering of several calls (86).
* ``DeniedCall`` -> the call with no executable identity. Catches a denial that
  is counted as success; it can never be a tool message, so it is terminal.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall
from cascade.testing import Response, ScriptedLLM, ScriptedSessionFactory
from cascade.tools import (
    TOOL_HTTP_ERROR,
    TOOL_MALFORMED_RESULT,
    TOOL_TIMEOUT,
    TOOL_TRANSPORT_ERROR,
    TOOL_UNREADABLE_BODY,
    DeniedCall,
    ToolCallMemo,
    ToolExecutor,
    ToolFailure,
    ToolFailureClass,
    ToolResult,
    continue_after_tool,
)
from providers import TokenDelta, ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"


def make_executor(factory, **overrides):
    options = {
        "base_url": BASE_URL,
        "call_id": CALL_ID,
        "secret": TOOL_SECRET,
        "session_factory": factory,
        "timeout_ms": 2000,
    }
    options.update(overrides)
    return ToolExecutor(**options)


def a_call(call_id="call_1", name="search_properties"):
    return ToolCallRequest(
        name=name, arguments={"location": "Dubai"}, call_id=call_id
    )


def execute(executor, call):
    return asyncio.run(executor.execute(call))


class HangingResponse:
    """A route that accepted the POST and never answers."""

    status = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def iter_bytes(self):
        await asyncio.Event().wait()
        yield b""


class HangingSession:
    def __init__(self):
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers=None, json=None):
        self.posts.append({"url": url, "headers": headers, "json": json})
        return HangingResponse()


class HangingRoute:
    def __init__(self):
        self.sessions = []
        self.posts = []

    def __call__(self, *, timeout_s: float = 0.0):
        self.sessions.append({"timeout_s": timeout_s})
        session = HangingSession()
        self.posts.extend(session.posts)
        return session


class RouteCallFailureTests(unittest.TestCase):
    def test_a_500_becomes_a_failure_result_and_the_turn_continues(self):
        factory = ScriptedSessionFactory([Response(status=500, body=b"boom")])
        executor = make_executor(factory)

        outcome = execute(executor, a_call(call_id="call_500"))

        self.assertIsInstance(outcome, ToolFailure, "a 500 escaped as a success")
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.tool_call_id, "call_500")
        self.assertEqual(outcome.code, TOOL_HTTP_ERROR)
        self.assertEqual(outcome.status, 500)
        self.assertEqual(outcome.classification, ToolFailureClass.RECOVERABLE)
        self.assertIn("HTTP 500", outcome.reason)
        self.assertEqual(
            factory.posts[0]["json"]["toolCallId"], "call_500", "the route cannot dedupe"
        )

        message = outcome.tool_message()
        self.assertEqual(message["role"], "tool")
        self.assertEqual(message["tool_call_id"], "call_500")
        payload = json.loads(message["content"])
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["failure"])
        self.assertIn("HTTP 500", payload["error"])

    def test_a_401_and_a_404_are_terminal_failures_with_the_matching_call_id(self):
        for status in (401, 404):
            with self.subTest(status=status):
                factory = ScriptedSessionFactory(
                    [Response(status=status, body=b'{"ok": false}')]
                )
                outcome = execute(make_executor(factory), a_call(call_id="call_x"))

                self.assertIsInstance(outcome, ToolFailure)
                self.assertFalse(outcome.ok)
                self.assertEqual(outcome.tool_call_id, "call_x")
                self.assertEqual(outcome.status, status)
                self.assertEqual(outcome.classification, ToolFailureClass.TERMINAL)
                self.assertIn(f"HTTP {status}", outcome.reason)

    def test_an_unreadable_body_is_a_failure_not_a_crash(self):
        for body, code in (
            (b"<html>not json</html>", TOOL_UNREADABLE_BODY),
            (b'["ok"]', TOOL_MALFORMED_RESULT),
        ):
            with self.subTest(body=body):
                factory = ScriptedSessionFactory([Response(body=body)])
                outcome = execute(make_executor(factory), a_call(call_id="call_body"))

                self.assertIsInstance(outcome, ToolFailure)
                self.assertFalse(outcome.ok)
                self.assertEqual(outcome.tool_call_id, "call_body")
                self.assertEqual(outcome.code, code)
                self.assertEqual(
                    outcome.classification, ToolFailureClass.RECOVERABLE
                )

    def test_a_connection_drop_after_the_request_is_indeterminate(self):
        factory = ScriptedSessionFactory(
            [Response(exc=ConnectionResetError("reset by peer"))]
        )

        outcome = execute(make_executor(factory), a_call(call_id="call_drop"))

        self.assertIsInstance(outcome, ToolFailure)
        self.assertEqual(outcome.code, TOOL_TRANSPORT_ERROR)
        self.assertTrue(outcome.indeterminate)
        self.assertEqual(outcome.classification, ToolFailureClass.RECOVERABLE)

    def test_the_route_own_refusal_stays_a_result_and_not_a_failure(self):
        factory = ScriptedSessionFactory(
            [Response(body=b'{"ok": false, "error": "Property not found."}')]
        )

        outcome = execute(make_executor(factory), a_call(call_id="call_refused"))

        self.assertIsInstance(outcome, ToolResult)
        self.assertNotIsInstance(outcome, ToolFailure)
        self.assertFalse(outcome.ok)


class TimeoutFailureTests(unittest.TestCase):
    def test_a_timeout_is_recorded_indeterminate_and_never_raises(self):
        route = HangingRoute()
        executor = make_executor(route, timeout_ms=10)

        outcome = execute(executor, a_call(call_id="call_slow"))

        self.assertIsInstance(outcome, ToolFailure, "a timeout escaped as a crash")
        self.assertEqual(outcome.code, TOOL_TIMEOUT)
        self.assertEqual(outcome.tool_call_id, "call_slow")
        self.assertTrue(outcome.indeterminate)
        self.assertEqual(outcome.classification, ToolFailureClass.RECOVERABLE)
        self.assertIn("10 ms", outcome.reason)
        self.assertTrue(json.loads(outcome.tool_message()["content"])["indeterminate"])

    def test_a_timed_out_side_effect_is_not_retried_in_the_turn(self):
        route = HangingRoute()
        memo = ToolCallMemo("1:turn-1")
        executor = make_executor(route, timeout_ms=10, memo=memo)

        first = execute(executor, a_call(call_id="call_a"))
        second = execute(executor, a_call(call_id="call_b"))

        self.assertEqual(len(route.sessions), 1, "the timed-out side effect ran twice")
        self.assertTrue(first.indeterminate)
        self.assertTrue(second.replayed)
        self.assertTrue(second.indeterminate)
        self.assertEqual(second.tool_call_id, "call_b")


class DeniedCallClassificationTests(unittest.TestCase):
    def test_a_call_without_an_id_is_terminal_and_never_a_success(self):
        factory = ScriptedSessionFactory([])
        outcome = execute(make_executor(factory), a_call(call_id=""))

        self.assertIsInstance(outcome, DeniedCall)
        self.assertIsNot(outcome, ToolResult)
        self.assertEqual(outcome.classification, ToolFailureClass.TERMINAL)
        self.assertEqual(outcome.tool_call_id, "")
        self.assertEqual(factory.posts, [])


class FailureContinuationTests(unittest.TestCase):
    def test_a_failed_tool_is_answered_and_the_same_turn_continues(self):
        factory = ScriptedSessionFactory([Response(status=500, body=b"boom")])
        executor = make_executor(factory)
        llm = ScriptedLLM([[TokenDelta(text="I couldn't check that just now.")]])
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")
        turn = MetaLLMTurn(
            content_text="",
            finish_reason="tool_calls",
            tool_calls=[
                MetaToolCall(
                    index=0,
                    call_id="call_1",
                    name="search_properties",
                    arguments='{"location": "Dubai"}',
                )
            ],
        )
        turn.close()

        async def scenario():
            outcome = await executor.execute(a_call())
            events = [
                event
                async for event in continue_after_tool(
                    llm=llm, history=history, turn=turn, outcome=outcome
                )
            ]
            return events

        events = asyncio.run(scenario())

        self.assertEqual(
            [event.text for event in events],
            ["I couldn't check that just now."],
            "the call ended because one tool failed",
        )
        self.assertEqual(len(llm.requests), 1)
        tool_messages = [
            message
            for message in llm.requests[0]["messages"]
            if message.get("role") == "tool"
        ]
        self.assertEqual(len(tool_messages), 1)
        self.assertEqual(tool_messages[0]["tool_call_id"], "call_1")
        payload = json.loads(tool_messages[0]["content"])
        self.assertTrue(payload["failure"])
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
