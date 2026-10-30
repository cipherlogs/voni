"""Ticket 86: several tool calls run in index order, one at a time.

A turn may ask for more than one tool. The vendor allows those calls to run in
parallel; side-effect order is not traded for latency, so this module runs them
sequentially in the stream's index order and appends one ``role: "tool"``
message per call, in the same order. These tests read the route's own start/end
record and the next model request, so they fail if a second hop begins before
the first ends, if a scrambled batch reorders side effects, if results are
appended out of call order, or if ``end_call`` lets a later side effect run.

Seams under test:

* ``execute_turn_calls`` -> the route's execution sequence. Catches parallel
  hops, index order lost to list order, and a side effect after ``end_call``.
  Misses the loop cap across turns (87) and failure mapping (84).
* ``continue_after_tool`` with several outcomes -> the next request's tool
  messages. Catches a missing, duplicated or reordered result message.
  Misses the spoken hold line (85).
"""

import asyncio
import json
import unittest

from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall
from cascade.testing import ScriptedLLM
from cascade.tools import (
    END_CALL_TOOL,
    EndCallSignal,
    ToolExecutor,
    ToolResult,
    ToolTurnError,
    continue_after_tool,
    execute_turn_calls,
)
from providers import TokenDelta, ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"


class SerialRoute:
    """A route that records whether a second hop starts before the first ends."""

    def __init__(self, bodies):
        self._bodies = list(bodies)
        self.posts: list[dict] = []
        self.violations: list[str] = []
        self._in_flight = False

    def __call__(self, *, timeout_s: float = 0.0):
        return SerialSession(self, timeout_s=timeout_s)

    def begin(self, record: dict) -> None:
        if self._in_flight:
            self.violations.append(record["json"]["context"]["callId"])
        self._in_flight = True

    def end(self) -> None:
        self._in_flight = False

    def next_body(self) -> bytes:
        index = len(self.posts) - 1
        return self._bodies[min(index, len(self._bodies) - 1)]


class SerialSession:
    def __init__(self, route: SerialRoute, *, timeout_s: float) -> None:
        self._route = route
        self.timeout_s = timeout_s

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers=None, json=None):
        record = {"url": url, "headers": headers, "json": json}
        self._route.posts.append(record)
        self._route.begin(record)
        return SerialResponse(self._route)


class SerialResponse:
    status = 200

    def __init__(self, route: SerialRoute) -> None:
        self._route = route

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def iter_bytes(self):
        try:
            yield self._route.next_body()
        finally:
            self._route.end()


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


def two_call_turn() -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text="",
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id="call_1",
                name="search_properties",
                arguments='{"location": "Dubai"}',
            ),
            MetaToolCall(
                index=1,
                call_id="call_2",
                name="check_availability",
                arguments='{"reference": "MAR-1"}',
            ),
        ],
    )
    turn.close()
    return turn


def call_one() -> ToolCallRequest:
    return ToolCallRequest(
        name="search_properties",
        arguments={"location": "Dubai"},
        call_id="call_1",
    )


def call_two() -> ToolCallRequest:
    return ToolCallRequest(
        name="check_availability",
        arguments={"reference": "MAR-1"},
        call_id="call_2",
    )


def post_names(route: SerialRoute) -> list[str]:
    return [record["url"].rsplit("/", 1)[-1] for record in route.posts]


class ExecutionOrderTests(unittest.TestCase):
    def test_two_calls_run_in_index_order_one_at_a_time(self):
        route = SerialRoute([b'{"ok": true}', b'{"ok": true}'])
        executor = make_executor(route)

        outcomes = asyncio.run(
            execute_turn_calls(executor, two_call_turn(), [call_one(), call_two()])
        )

        self.assertEqual(post_names(route), ["search_properties", "check_availability"])
        self.assertEqual(route.violations, [], "a second hop overlapped the first")
        self.assertEqual(
            [outcome.tool_call_id for outcome in outcomes], ["call_1", "call_2"]
        )

    def test_a_scrambled_batch_still_runs_in_index_order(self):
        route = SerialRoute([b'{"ok": true}', b'{"ok": true}'])
        executor = make_executor(route)

        asyncio.run(
            execute_turn_calls(executor, two_call_turn(), [call_two(), call_one()])
        )

        self.assertEqual(
            post_names(route),
            ["search_properties", "check_availability"],
            "side effects followed list order instead of the turn's index order",
        )

    def test_a_result_for_a_call_the_turn_did_not_request_is_refused(self):
        route = SerialRoute([b'{"ok": true}'])
        executor = make_executor(route)
        stranger = ToolCallRequest(
            name="delete_everything", arguments={}, call_id="call_9"
        )

        with self.assertRaises(ToolTurnError):
            asyncio.run(
                execute_turn_calls(executor, two_call_turn(), [stranger])
            )
        self.assertEqual(route.posts, [])


class RepeatedCallTests(unittest.TestCase):
    def test_one_tool_message_per_call_appended_in_call_order(self):
        route = SerialRoute([b'{"ok": true, "n": 1}', b'{"ok": true, "n": 2}'])
        executor = make_executor(route)
        turn = two_call_turn()
        llm = ScriptedLLM([[TokenDelta(text="Both checks are done.")]])
        history = MessageHistory()
        history.append_user("Check Dubai and MAR-1.")

        async def scenario():
            outcomes = await execute_turn_calls(
                executor, turn, [call_one(), call_two()]
            )
            events = [
                event
                async for event in continue_after_tool(
                    llm=llm, history=history, turn=turn, outcome=outcomes
                )
            ]
            return events

        events = asyncio.run(scenario())

        self.assertEqual([event.text for event in events], ["Both checks are done."])
        self.assertEqual(len(llm.requests), 1, "the turn continued more than once")
        messages = llm.requests[0]["messages"]
        tool_messages = [message for message in messages if message.get("role") == "tool"]
        self.assertEqual(len(tool_messages), 2, "one message per call is required")
        self.assertEqual(
            [message["tool_call_id"] for message in tool_messages],
            ["call_1", "call_2"],
        )
        self.assertEqual(
            [json.loads(message["content"])["n"] for message in tool_messages],
            [1, 2],
            "the results were appended in the wrong order",
        )
        self.assertEqual(
            [message["role"] for message in messages], ["user", "assistant", "tool", "tool"]
        )

    def test_out_of_order_outcomes_are_appended_in_call_order(self):
        turn = two_call_turn()
        llm = ScriptedLLM([[TokenDelta(text="Done.")]])
        history = MessageHistory()
        history.append_user("Check both.")
        first = ToolResult(
            name="search_properties", tool_call_id="call_1", payload={"ok": True, "n": 1}
        )
        second = ToolResult(
            name="check_availability", tool_call_id="call_2", payload={"ok": True, "n": 2}
        )

        collect(
            continue_after_tool(
                llm=llm, history=history, turn=turn, outcome=[second, first]
            )
        )

        tool_messages = [
            message
            for message in llm.requests[0]["messages"]
            if message.get("role") == "tool"
        ]
        self.assertEqual(
            [message["tool_call_id"] for message in tool_messages],
            ["call_1", "call_2"],
        )


class EndCallInBatchTests(unittest.TestCase):
    def test_end_call_stops_every_later_side_effect(self):
        route = SerialRoute([b'{"ok": true}'])
        executor = make_executor(route)
        turn = MetaLLMTurn(
            content_text="",
            finish_reason="tool_calls",
            tool_calls=[
                MetaToolCall(
                    index=0,
                    call_id="call_1",
                    name="search_properties",
                    arguments='{"location": "Dubai"}',
                ),
                MetaToolCall(index=1, call_id="call_end", name=END_CALL_TOOL),
                MetaToolCall(
                    index=2,
                    call_id="call_3",
                    name="book_viewing",
                    arguments='{"reference": "MAR-1"}',
                ),
            ],
        )
        turn.close()
        calls = [
            call_one(),
            ToolCallRequest(
                name=END_CALL_TOOL,
                arguments={"closing_line": "Thanks. Goodbye!"},
                call_id="call_end",
            ),
            ToolCallRequest(
                name="book_viewing", arguments={"reference": "MAR-1"}, call_id="call_3"
            ),
        ]

        outcomes = asyncio.run(execute_turn_calls(executor, turn, calls))

        self.assertEqual(post_names(route), ["search_properties"])
        self.assertEqual(len(outcomes), 2)
        self.assertIsInstance(outcomes[1], EndCallSignal)

    def test_the_result_before_end_call_is_recorded_but_nothing_follows(self):
        turn = MetaLLMTurn(
            content_text="",
            finish_reason="tool_calls",
            tool_calls=[
                MetaToolCall(index=0, call_id="call_1", name="search_properties"),
                MetaToolCall(index=1, call_id="call_end", name=END_CALL_TOOL),
            ],
        )
        turn.close()
        history = MessageHistory()
        history.append_user("That's all.")
        llm = ScriptedLLM([])
        result = ToolResult(
            name="search_properties", tool_call_id="call_1", payload={"ok": True}
        )

        events = collect(
            continue_after_tool(
                llm=llm,
                history=history,
                turn=turn,
                outcome=[
                    result,
                    EndCallSignal(call_id=CALL_ID, tool_call_id="call_end"),
                ],
            )
        )

        self.assertEqual(events, [])
        self.assertEqual(llm.requests, [], "the call continued after end_call")
        recorded = [message["role"] for message in history.messages]
        self.assertEqual(recorded, ["user", "assistant", "tool"])


def collect(events) -> list:
    async def run():
        return [event async for event in events]

    return asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
