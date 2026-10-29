"""Ticket 82: a tool executes only with a real call id (1-64 characters).

The vendor mints the call id, and the route dedupes on it, so a call without an
executable identity must never reach the route. These tests read the recorded
POST (or its absence) and the turn's denial record, so they fail if an
identity-less call is sent, if an overlength id is denied instead of failing the
turn, or if the exact id stops reaching the route.

Seams under test:

* ``ToolExecutor.execute/start`` -> the route wire and the hop outcome. Catches
  an executed call with a missing or blank id, an overlength id that is denied
  instead of failing the turn as a provider contract violation, and a route
  that cannot dedupe because the id was rewritten. Misses failure mapping (84),
  ordering (86) and the cap (87).
* ``continue_after_tool`` -> what a denied call does to the turn. Catches a
  continuation request for a call the vendor cannot be answered about, and a
  denial recorded twice. Misses which line is spoken (85).
"""

import asyncio
import unittest

from cascade.meta_llm import (
    CALL_ID_MAX_LENGTH,
    TOOL_CALL_ID_MISSING,
    MessageHistory,
    MetaLLMTurn,
    MetaToolCall,
    ToolCallIdentityError,
    ToolDenial,
)
from cascade.testing import Response, ScriptedLLM, ScriptedSessionFactory
from cascade.tools import (
    DeniedCall,
    ToolCallIdMissing,
    ToolExecutor,
    ToolRequest,
    continue_after_tool,
)
from metrics import TimingLedger
from providers import ToolCallRequest

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


def a_call(call_id="call_1"):
    return ToolCallRequest(
        name="search_properties", arguments={"location": "Dubai"}, call_id=call_id
    )


def a_tool_turn(call_id) -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text="",
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id=call_id,
                name="search_properties",
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


class MissingCallIdTests(unittest.TestCase):
    def test_a_missing_call_id_is_not_executed(self):
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = make_executor(factory)

        outcome = asyncio.run(executor.execute(ToolCallRequest(name="search_properties")))

        self.assertEqual(factory.posts, [], "a call with no identity reached the route")
        self.assertIsInstance(outcome, DeniedCall)
        self.assertEqual(outcome.name, "search_properties")
        self.assertEqual(outcome.denial.code, TOOL_CALL_ID_MISSING)
        self.assertTrue(outcome.hold)

    def test_an_empty_call_id_is_not_executed(self):
        for blank in ("", "   ", None):
            with self.subTest(call_id=blank):
                factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
                executor = make_executor(factory)

                outcome = asyncio.run(executor.execute(a_call(call_id=blank)))

                self.assertEqual(factory.posts, [])
                self.assertIsInstance(outcome, DeniedCall)
                self.assertIn("call_id", outcome.denial.reason)

    def test_the_denied_turn_closes_with_a_hold_and_records_the_denial(self):
        turn = a_tool_turn(call_id="")
        llm = ScriptedLLM([])
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")
        executor = make_executor(ScriptedSessionFactory([]))
        outcome = asyncio.run(executor.execute(a_call(call_id="")))

        events = collect(
            continue_after_tool(
                llm=llm, history=history, turn=turn, outcome=outcome
            )
        )

        self.assertEqual(events, [])
        self.assertEqual(llm.requests, [], "a denied call continued the turn")
        self.assertTrue(turn.hold_line_required)
        self.assertEqual(
            [denial.code for denial in turn.denied_tool_calls],
            [TOOL_CALL_ID_MISSING],
        )
        self.assertEqual(
            history.messages, ({"role": "user", "content": "Any villas in Dubai?"},)
        )

    def test_a_denial_already_on_the_turn_is_not_counted_twice(self):
        turn = a_tool_turn(call_id="")
        already = ToolDenial(
            name="search_properties",
            reason="call_id is missing or empty",
            call_id="",
            code=TOOL_CALL_ID_MISSING,
        )
        turn.denied_tool_calls.append(already)
        ledger = TimingLedger(now=lambda: 0.0)
        executor = make_executor(ScriptedSessionFactory([]))
        outcome = asyncio.run(executor.execute(a_call(call_id="")))

        collect(
            continue_after_tool(
                llm=ScriptedLLM([]),
                history=MessageHistory(),
                turn=turn,
                outcome=outcome,
                ledger=ledger,
            )
        )

        self.assertEqual(turn.denied_tool_calls, [already])
        self.assertEqual(ledger.summary()["counts"]["tool_denied"], 0)

    def test_a_new_denial_is_counted_once(self):
        turn = a_tool_turn(call_id="")
        ledger = TimingLedger(now=lambda: 0.0)
        executor = make_executor(ScriptedSessionFactory([]))
        outcome = asyncio.run(executor.execute(a_call(call_id="")))

        collect(
            continue_after_tool(
                llm=ScriptedLLM([]),
                history=MessageHistory(),
                turn=turn,
                outcome=outcome,
                ledger=ledger,
            )
        )

        self.assertEqual(len(turn.denied_tool_calls), 1)
        self.assertEqual(ledger.summary()["counts"]["tool_denied"], 1)


class OverlongCallIdTests(unittest.TestCase):
    def test_an_overlong_call_id_fails_the_turn_as_a_contract_violation(self):
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = make_executor(factory)
        overlong = "c" * (CALL_ID_MAX_LENGTH + 1)

        with self.assertRaises(ToolCallIdentityError) as raised:
            asyncio.run(executor.execute(a_call(call_id=overlong)))

        self.assertIn(str(CALL_ID_MAX_LENGTH), str(raised.exception))
        self.assertEqual(factory.posts, [])


class CarriedCallIdTests(unittest.TestCase):
    def test_a_call_id_at_the_limit_executes_and_reaches_the_route_verbatim(self):
        at_limit = "c" * CALL_ID_MAX_LENGTH
        factory = ScriptedSessionFactory([Response(body=b'{"ok": true}')])
        executor = make_executor(factory)

        asyncio.run(executor.execute(a_call(call_id=at_limit)))

        self.assertEqual(factory.posts[0]["json"]["toolCallId"], at_limit)

    def test_a_request_without_an_executable_id_cannot_be_built(self):
        with self.assertRaises(ToolCallIdMissing):
            ToolRequest(
                name="search_properties",
                call_id=CALL_ID,
                tool_call_id="",
                arguments={},
            )


if __name__ == "__main__":
    unittest.main()
