"""Ticket 81: a tool call executes over the app's existing HTTP route.

The pipeline does not reimplement ``executeTool`` (ADR 0006). These tests read
the recorded POST the injected scripted HTTP session saw, so they fail if the
hop drifts from the route's contract: the tool secret in the bearer header, the
signed call's id as the only call context, the model's call id for dedupe, and
a bound read from the registry instead of invented here.

Seams under test:

* ``ToolExecutor`` -> the route wire (URL, method, headers, JSON body, timeout)
  and the bounded wait. Catches a re-pointed call, an unauthenticated request
  and an unbounded hop; misses which HTTP conditions become failure results
  (ticket 84).
* ``ToolResult.tool_message`` -> the ``role: "tool"`` message the model reads.
  Catches a lost or mismatched call id; misses narration and the hold line
  (ticket 85).
* ``continue_after_tool`` -> one new model request in the same logical turn.
  Catches a dropped result or a second tool execution; misses the loop cap
  (ticket 87) and multi-call ordering (ticket 86).
* ``EndCallSignal`` -> call control, never HTTP. Catches an ``end_call`` that
  opens a request or speaks; misses the closing line and the hangup (87).
"""

import asyncio
import json
import unittest
from pathlib import Path

from cascade import thresholds
from cascade.envelope import sign_body, verify_envelope
from cascade.meta_llm import MessageHistory, MetaLLM, MetaLLMTurn, MetaToolCall
from cascade.testing import FakeClock, Response, ScriptedLLM, ScriptedSessionFactory
from cascade.thresholds import UnsetBoundError
from cascade.tools import (
    END_CALL_TOOL,
    TOOL_SECRET_ENV,
    TOOL_TIMEOUT_BOUND,
    EndCallSignal,
    ToolContextError,
    ToolExecutor,
    ToolFailure,
    ToolRequest,
    ToolResult,
    ToolSecretError,
    ToolTurnError,
    continue_after_tool,
)
from providers import TokenDelta, ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"

# The pinned cross-language envelope vector (ticket 64): the same body and
# signature the app side produces, so this file never invents an identity.
VECTORS = json.loads(
    Path(__file__).with_name("envelope_vectors.json").read_text(encoding="utf-8")
)


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


def a_call(name="search_properties", arguments=None, call_id="call_1"):
    return ToolCallRequest(
        name=name,
        arguments={"location": "Dubai"} if arguments is None else arguments,
        call_id=call_id,
    )


def tool_turn(name="search_properties", call_id="call_1") -> MetaLLMTurn:
    """A finished stream that handed the turn to the tool loop."""
    turn = MetaLLMTurn(
        content_text="",
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id=call_id,
                name=name,
                arguments='{"location": "Dubai"}',
            )
        ],
    )
    turn.close()
    return turn


def collect(events) -> list:
    async def run():
        return [event async for event in events]

    return asyncio.run(run())


class RouteRequestTests(unittest.TestCase):
    def test_a_tool_call_posts_to_the_existing_route_with_the_tool_secret(self):
        factory = ScriptedSessionFactory(
            [Response(body=b'{"ok": true, "data": {"count": 1}}')]
        )
        executor = make_executor(factory)

        outcome = asyncio.run(executor.execute(a_call()))

        self.assertEqual(len(factory.posts), 1)
        post = factory.posts[0]
        self.assertEqual(post["url"], f"{BASE_URL}/api/tools/search_properties")
        self.assertEqual(post["headers"]["authorization"], f"Bearer {TOOL_SECRET}")
        self.assertEqual(post["headers"]["content-type"], "application/json")
        self.assertEqual(
            post["json"],
            {
                "toolCallId": "call_1",
                "arguments": {"location": "Dubai"},
                "context": {"kind": "call", "callId": CALL_ID},
            },
        )
        self.assertIsInstance(outcome, ToolResult)
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.tool_call_id, "call_1")
        self.assertEqual(
            outcome.tool_message(),
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": '{"ok": true, "data": {"count": 1}}',
            },
        )

    def test_a_route_refusal_is_returned_as_a_failed_tool_message(self):
        factory = ScriptedSessionFactory(
            [Response(body=b'{"ok": false, "error": "Property not found.", "retryable": false}')]
        )
        executor = make_executor(factory)

        outcome = asyncio.run(executor.execute(a_call(call_id="call_9")))

        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.tool_call_id, "call_9")
        message = outcome.tool_message()
        self.assertEqual(message["role"], "tool")
        self.assertEqual(message["tool_call_id"], "call_9")
        self.assertEqual(
            json.loads(message["content"]),
            {"ok": False, "error": "Property not found.", "retryable": False},
        )

    def test_a_missing_tool_secret_refuses_before_any_request(self):
        factory = ScriptedSessionFactory([])
        executor = make_executor(factory, secret="")

        with self.assertRaises(ToolSecretError) as raised:
            asyncio.run(executor.execute(a_call()))

        self.assertIn(TOOL_SECRET_ENV, str(raised.exception))
        self.assertEqual(factory.posts, [])

    def test_the_call_context_is_the_signed_call_and_never_a_model_value(self):
        request = ToolRequest(
            name="book_viewing",
            call_id=CALL_ID,
            tool_call_id="call_2",
            arguments={"reference": "MAR-1"},
        )

        self.assertEqual(request.body()["context"], {"kind": "call", "callId": CALL_ID})
        self.assertNotIn("callId", request.body())


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
    """Scripted session factory whose one response never completes."""

    def __init__(self):
        self.sessions = []
        self.posts = []

    def __call__(self, *, timeout_s: float = 0.0):
        self.sessions.append({"timeout_s": timeout_s})
        session = HangingSession()
        self.posts.extend(session.posts)
        return session


class HopBoundTests(unittest.TestCase):
    def test_an_unset_tool_timeout_is_named_and_never_invented(self):
        bound = thresholds.bound(TOOL_TIMEOUT_BOUND)
        if not bound.is_open:
            self.skipTest("ticket 76 has supplied the tool timeout bound")
        factory = ScriptedSessionFactory([])
        executor = make_executor(factory, timeout_ms=None)

        with self.assertRaises(UnsetBoundError) as raised:
            asyncio.run(executor.execute(a_call()))

        self.assertIn(TOOL_TIMEOUT_BOUND, str(raised.exception))
        self.assertEqual(factory.posts, [])

    def test_the_registry_bound_is_the_hop_timeout_the_route_sees(self):
        bound = thresholds.bound(TOOL_TIMEOUT_BOUND)
        if bound.is_open:
            self.skipTest("ticket 76 has supplied the tool timeout bound")
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = make_executor(factory, timeout_ms=None)

        asyncio.run(executor.execute(a_call()))

        self.assertEqual(factory.sessions[0]["timeout_s"], float(bound.value) / 1000.0)

    def test_a_hanging_tool_is_bounded_and_reports_the_bound(self):
        route = HangingRoute()
        executor = make_executor(route, timeout_ms=10)

        outcome = asyncio.run(
            asyncio.wait_for(executor.execute(a_call()), timeout=2.0)
        )

        # Ticket 84: the bound is reported as a failure result, not raised.
        self.assertIsInstance(outcome, ToolFailure)
        self.assertTrue(outcome.indeterminate)
        self.assertIn(TOOL_TIMEOUT_BOUND, outcome.reason)
        self.assertEqual(len(route.sessions), 1)


class GatedResponse:
    """A route that answers only when the test releases it."""

    status = 200

    def __init__(self, release: asyncio.Event, body: bytes) -> None:
        self._release = release
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def iter_bytes(self):
        await self._release.wait()
        yield self._body


class GatedSession:
    def __init__(self, release: asyncio.Event, body: bytes) -> None:
        self._release = release
        self._body = body
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers=None, json=None):
        self.posts.append({"url": url, "headers": headers, "json": json})
        return GatedResponse(self._release, self._body)


class GatedRoute:
    """Scripted route whose one response waits for an explicit release."""

    def __init__(self, body: bytes = b'{"ok": true, "data": {"count": 1}}') -> None:
        self.release = asyncio.Event()
        self._body = body
        self.posts = []

    def __call__(self, *, timeout_s: float = 0.0):
        session = GatedSession(self.release, self._body)
        self.posts.extend(session.posts)
        return session


class OffAudioPathTests(unittest.TestCase):
    def test_the_hop_runs_while_the_audio_path_keeps_producing(self):
        route = GatedRoute()

        async def scenario():
            executor = make_executor(route, timeout_ms=2000)
            hop = executor.start(a_call())
            # One scheduling turn lets the hop reach the network and block.
            await asyncio.sleep(0)
            hold_line = "One moment."
            pending = hop.done
            route.release.set()
            return pending, hold_line, await hop.outcome()

        pending, hold_line, outcome = asyncio.run(scenario())

        self.assertEqual(hold_line, "One moment.")
        self.assertFalse(pending, "the reply stream awaited the tool hop inline")
        self.assertTrue(outcome.ok)


class EndCallSignalTests(unittest.TestCase):
    def test_end_call_makes_no_request(self):
        factory = ScriptedSessionFactory([])
        executor = make_executor(factory)

        outcome = asyncio.run(
            executor.execute(a_call(name=END_CALL_TOOL, arguments={}, call_id="call_end"))
        )

        self.assertIsInstance(outcome, EndCallSignal)
        self.assertEqual(outcome.call_id, CALL_ID)
        self.assertEqual(outcome.tool_call_id, "call_end")
        self.assertEqual(factory.posts, [])

    def test_end_call_speaks_nothing_and_requests_no_continuation(self):
        llm = ScriptedLLM([])
        history = MessageHistory()
        history.append_user("That's all, thanks.")
        turn = tool_turn()

        events = collect(
            continue_after_tool(
                llm=llm,
                history=history,
                turn=turn,
                outcome=EndCallSignal(call_id=CALL_ID, tool_call_id="call_end"),
            )
        )

        self.assertEqual(events, [])
        self.assertEqual(llm.requests, [])
        self.assertEqual(
            history.messages, ({"role": "user", "content": "That's all, thanks."},)
        )


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


CONTINUED_REPLY = (
    sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": "Two properties match."},
                    "finish_reason": None,
                }
            ]
        }
    )
    + sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    + b"data: [DONE]\n\n"
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_properties",
            "description": "Search the portfolio.",
            "parameters": {"type": "object"},
        },
    }
]


class ContinuationTests(unittest.TestCase):
    def test_the_tool_result_continues_the_turn_with_a_new_model_request(self):
        result = ToolResult(
            name="search_properties",
            tool_call_id="call_1",
            payload={"ok": True, "data": {"count": 1}},
        )
        llm = ScriptedLLM([[TokenDelta(text="Two properties match.")]])
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")
        turn = tool_turn()

        events = collect(
            continue_after_tool(
                llm=llm,
                history=history,
                turn=turn,
                outcome=result,
                tools=TOOLS,
            )
        )

        self.assertEqual([event.text for event in events], ["Two properties match."])
        self.assertEqual(len(llm.requests), 1)
        messages = llm.requests[0]["messages"]
        self.assertEqual(
            messages[0], {"role": "user", "content": "Any villas in Dubai?"}
        )
        assistant, tool_message = messages[1], messages[2]
        self.assertEqual(assistant["role"], "assistant")
        self.assertEqual(assistant["tool_calls"][0]["id"], "call_1")
        self.assertEqual(tool_message["role"], "tool")
        self.assertEqual(tool_message["tool_call_id"], "call_1")
        self.assertEqual(
            json.loads(tool_message["content"]), {"ok": True, "data": {"count": 1}}
        )
        self.assertEqual(llm.requests[0]["tools"], TOOLS)
        self.assertEqual(len(history.messages), 3)

    def test_a_fake_route_asserts_one_request_and_the_continued_reply(self):
        route = ScriptedSessionFactory(
            [Response(body=b'{"ok": true, "data": {"count": 2}}')]
        )
        model = ScriptedSessionFactory([Response(chunks=(CONTINUED_REPLY,))])
        executor = make_executor(route)
        llm = MetaLLM(api_key="test-key", reasoning_effort="low", session_factory=model)
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")
        turn = tool_turn()

        async def scenario():
            outcome = await executor.execute(a_call())
            continued = MetaLLMTurn()
            events = [
                event
                async for event in continue_after_tool(
                    llm=llm,
                    history=history,
                    turn=turn,
                    outcome=outcome,
                    tools=TOOLS,
                    record=continued,
                )
            ]
            return events, continued

        events, continued = asyncio.run(scenario())

        self.assertEqual(len(route.posts), 1, "the fake route saw more than one request")
        self.assertEqual(len(model.posts), 1, "the turn did not continue exactly once")
        self.assertEqual(route.posts[0]["json"]["toolCallId"], "call_1")
        sent = model.posts[0]["json"]["messages"]
        tool_messages = [message for message in sent if message.get("role") == "tool"]
        self.assertEqual(len(tool_messages), 1)
        self.assertEqual(tool_messages[0]["tool_call_id"], "call_1")
        self.assertEqual(
            json.loads(tool_messages[0]["content"]),
            {"ok": True, "data": {"count": 2}},
        )
        self.assertEqual(
            [event.text for event in events], ["Two properties match."]
        )
        self.assertEqual(continued.content_text, "Two properties match.")

    def test_a_turn_with_several_calls_is_refused_rather_than_half_answered(self):
        turn = MetaLLMTurn(
            finish_reason="tool_calls",
            tool_calls=[
                MetaToolCall(index=0, call_id="call_1", name="search_properties"),
                MetaToolCall(index=1, call_id="call_2", name="check_availability"),
            ],
        )
        turn.close()
        result = ToolResult(name="search_properties", tool_call_id="call_1", payload={"ok": True})
        llm = ScriptedLLM([])
        history = MessageHistory()

        with self.assertRaises(ToolTurnError) as raised:
            collect(
                continue_after_tool(
                    llm=llm, history=history, turn=turn, outcome=result
                )
            )

        self.assertIn("one call", str(raised.exception))
        self.assertEqual(llm.requests, [])
        self.assertEqual(history.messages, ())


def verified_vector_body():
    """Ticket 64's verified body for the pinned vector, signed for one call."""
    issued_ms = VECTORS["issued_at_ms"]
    signed = sign_body(
        body=VECTORS["body"],
        minted_fingerprint=VECTORS["minted_fingerprint"],
        account_salt=VECTORS["account_salt"],
        secret=VECTORS["secret"],
        call_id=VECTORS["call_id"],
        agent_id=VECTORS["agent_id"],
        ttl_ms=VECTORS["expires_at_ms"] - issued_ms,
        clock=FakeClock(issued_ms / 1000.0),
    )
    wire = json.loads(json.dumps(signed.message()))
    return verify_envelope(
        wire,
        secret=VECTORS["secret"],
        call_id=VECTORS["call_id"],
        clock=FakeClock(issued_ms / 1000.0),
    )


class SignedIdentityTests(unittest.TestCase):
    def test_the_hop_carries_the_call_id_the_signed_envelope_minted(self):
        verified = verified_vector_body()
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = ToolExecutor.from_verified(
            verified,
            base_url=BASE_URL,
            secret=TOOL_SECRET,
            session_factory=factory,
            timeout_ms=2000,
        )

        asyncio.run(executor.execute(a_call()))

        self.assertEqual(executor.call_id, verified.call_id)
        self.assertEqual(
            factory.posts[0]["json"]["context"],
            {"kind": "call", "callId": verified.call_id},
        )

    def test_a_hop_without_a_signed_call_id_is_refused(self):
        with self.assertRaises(ToolContextError):
            ToolExecutor(base_url=BASE_URL, call_id="")


class RouteFailureMappingTests(unittest.TestCase):
    def test_a_route_failure_is_mapped_to_the_tool_that_named_it(self):
        for status, body, code in (
            (500, b"boom", "tool_http_error"),
            (200, b"<html>not json</html>", "tool_unreadable_body"),
            (200, b'["ok"]', "tool_malformed_result"),
        ):
            with self.subTest(status=status, body=body):
                factory = ScriptedSessionFactory([Response(status=status, body=body)])
                executor = make_executor(factory)

                outcome = asyncio.run(executor.execute(a_call()))

                # Ticket 84 moved these conditions from a raise to a result.
                self.assertIsInstance(outcome, ToolFailure)
                self.assertEqual(outcome.name, "search_properties")
                self.assertEqual(outcome.tool_call_id, "call_1")
                self.assertEqual(outcome.code, code)
                self.assertFalse(outcome.ok)
