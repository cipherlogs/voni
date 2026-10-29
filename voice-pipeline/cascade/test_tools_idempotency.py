"""Ticket 83: turn-keyed tool idempotency.

An LLM retry must not double a side effect. These tests count what the route
actually saw: a repeated ``(name, canonical arguments)`` inside one logical turn
replays the memo, a reconnect that keeps the same turn keeps replaying, and a
new turn executes again. They fail if the memo dies with the stream, if two
spellings of the same arguments execute twice, or if a replay answers with a
stale call id.

Seams under test:

* ``canonical_arguments`` -> the memo key. Catches an argument order or an
  ``1``/``1.0`` spelling that turns one call into two. Misses schema meaning
  (ticket 40 owns validation before the hop).
* ``ToolExecutor`` + ``ToolCallMemo`` -> the route wire and the replayed
  outcome. Catches a second POST/payment for a retried call, a memo that a
  reconnect resets, and a memo that a new turn does not reset. Misses ordering
  (86), the cap (87) and failure mapping (84).
"""

import asyncio
import json
import unittest

from cascade.testing import Response, ScriptedSessionFactory
from cascade.tools import (
    ToolCallMemo,
    ToolExecutor,
    ToolResult,
    canonical_arguments,
)
from providers import ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"
TURN_ONE = "1:turn-1"
TURN_TWO = "1:turn-2"


class CountingRoute:
    """A session factory that counts invocations, not just recorded posts."""

    def __init__(self, bodies):
        self._bodies = list(bodies)
        self.invocations = 0
        self.posts = []

    def __call__(self, *, timeout_s: float = 0.0):
        self.invocations += 1
        body = self._bodies[min(self.invocations - 1, len(self._bodies) - 1)]
        session = ScriptedSessionFactory([Response(body=body)])(timeout_s=timeout_s)
        self.posts.append(session)
        return session


def make_executor(factory, memo=None, **overrides):
    options = {
        "base_url": BASE_URL,
        "call_id": CALL_ID,
        "secret": TOOL_SECRET,
        "session_factory": factory,
        "timeout_ms": 2000,
    }
    if memo is not None:
        options["memo"] = memo
    options.update(overrides)
    return ToolExecutor(**options)


def a_call(call_id, arguments=None):
    return ToolCallRequest(
        name="search_properties",
        arguments={"location": "Dubai", "limit": 2} if arguments is None else arguments,
        call_id=call_id,
    )


def execute(executor, call):
    return asyncio.run(executor.execute(call))


class CanonicalArgumentsTests(unittest.TestCase):
    def test_object_keys_are_sorted_and_scalar_formatting_is_normalised(self):
        self.assertEqual(
            canonical_arguments({"b": [1, {"y": 2, "x": 1}], "a": 1.0}),
            canonical_arguments({"a": 1, "b": [1.0, {"x": 1, "y": 2.0}]}),
        )

    def test_different_values_and_types_are_different_keys(self):
        self.assertNotEqual(
            canonical_arguments({"amount": 1}),
            canonical_arguments({"amount": "1"}),
        )
        self.assertNotEqual(
            canonical_arguments({"amount": True}),
            canonical_arguments({"amount": 1}),
        )
        self.assertNotEqual(
            canonical_arguments({"location": "Dubai"}),
            canonical_arguments({"location": "Abu Dhabi"}),
        )

    def test_the_canonical_form_is_json_an_artifact_can_carry(self):
        canonical = canonical_arguments({"z": "é", "a": [True, None, 1.5]})
        self.assertEqual(json.loads(canonical), {"a": [True, None, 1.5], "z": "é"})


class TurnMemoTests(unittest.TestCase):
    def test_a_repeated_call_in_one_turn_replays_and_does_not_execute_twice(self):
        route = ScriptedSessionFactory(
            [Response(body=b'{"ok": true, "data": {"count": 1}}')]
        )
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)

        first = execute(executor, a_call("call_a"))
        second = execute(executor, a_call("call_b"))

        self.assertEqual(len(route.posts), 1, "the route saw a second side effect")
        self.assertIsInstance(first, ToolResult)
        self.assertFalse(first.replayed)
        self.assertTrue(second.replayed)
        self.assertEqual(second.payload, first.payload)
        self.assertEqual(second.tool_call_id, "call_b")

    def test_a_reconnect_in_the_same_turn_keeps_replaying(self):
        route = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)
        execute(executor, a_call("call_a"))

        # The model reconnected: a new stream, the same logical turn. The
        # orchestrator re-labels the turn with the same key, which must not
        # clear the memo.
        memo.begin_turn(TURN_ONE)
        replayed = execute(executor, a_call("call_a_again"))

        self.assertEqual(len(route.posts), 1)
        self.assertTrue(replayed.replayed)

    def test_a_new_turn_resets_the_memo(self):
        route = ScriptedSessionFactory(
            [
                Response(body=b'{"ok": true, "data": {"count": 1}}'),
                Response(body=b'{"ok": true, "data": {"count": 2}}'),
            ]
        )
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)
        execute(executor, a_call("call_a"))

        memo.begin_turn(TURN_TWO)
        second = execute(executor, a_call("call_b"))

        self.assertEqual(len(route.posts), 2, "the new turn replayed the old result")
        self.assertFalse(second.replayed)

    def test_different_arguments_or_tools_are_not_memoised_as_one_call(self):
        route = ScriptedSessionFactory(
            [
                Response(body=b'{"ok": true, "data": {"count": 1}}'),
                Response(body=b'{"ok": true, "data": {"count": 2}}'),
                Response(body=b'{"ok": true, "data": {"count": 3}}'),
            ]
        )
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)

        execute(executor, a_call("call_a", {"location": "Dubai"}))
        execute(executor, a_call("call_b", {"location": "Abu Dhabi"}))
        execute(
            executor,
            ToolCallRequest(
                name="check_availability",
                arguments={"location": "Dubai"},
                call_id="call_c",
            ),
        )

        self.assertEqual(len(route.posts), 3)

    def test_a_route_refusal_is_replayed_too(self):
        route = ScriptedSessionFactory(
            [Response(body=b'{"ok": false, "error": "No match."}')]
        )
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)

        first = execute(executor, a_call("call_a"))
        second = execute(executor, a_call("call_b"))

        self.assertEqual(len(route.posts), 1)
        self.assertFalse(first.ok)
        self.assertFalse(second.ok)
        self.assertTrue(second.replayed)
        self.assertEqual(second.reason, "No match.")


class CountingExecutorTests(unittest.TestCase):
    def test_a_counting_executor_sees_one_invocation_for_a_retried_call(self):
        route = CountingRoute([b'{"ok": true, "data": {"count": 1}}'])
        memo = ToolCallMemo(TURN_ONE)
        executor = make_executor(route, memo=memo)

        execute(executor, a_call("call_a"))
        execute(executor, a_call("call_b"))

        self.assertEqual(route.invocations, 1)


if __name__ == "__main__":
    unittest.main()
