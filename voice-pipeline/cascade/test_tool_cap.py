"""Ticket 87 (loop cap): the tool loop stops at ``tool.loop_cap`` and says so.

Spec: `.scratch/meta-cascade/spec.md` "Tools: HTTP execution, idempotency,
narration hold" — Continuation. A tool result continues the same logical turn
with a new model request; the loop ends on ``stop``, the tool-call cap, a second
failure or an end-call. The cap is the named ``tool.loop_cap`` bound, never a
number in this module: when a turn reaches it the loop speaks the Locale's
fallback line, ends the turn and records the cap, instead of asking the model
again forever.

Seams under test:

* ``ToolLoop`` -> the round budget and its record. Catches a cap restated in
  code, a loop that keeps going, and an unset bound that silently defaults.
* ``continue_after_tool(loop=...)`` -> the next model request and the spoken
  line. Catches a fourth request after a cap of three, a line that is not
  localized and an ended turn that is not recorded.
"""

import asyncio
import json
import unittest
from unittest import mock

from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall
from cascade.testing import FakeClock
from cascade.testing.scripted import ScriptedLLM, Step
from cascade.thresholds import UnsetBoundError, bound
from cascade.tools import (
    LOOP_CAP_LINES,
    TOOL_LOOP_CAP_BOUND,
    EndCallSignal,
    ToolLoop,
    ToolLoopCapError,
    ToolResult,
    UnknownLoopCapLineError,
    continue_after_tool,
    execute_turn_calls,
    loop_cap_line,
)
from cascade.turn_state import ToolLoopState, TurnPhase, TurnStateStore
from providers import TokenDelta, ToolCallRequest

CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"
CAP = 3


class InstantExecutor:
    """A tool that answers at once; the test reads how many rounds ran."""

    def __init__(self):
        self.executed = []

    async def execute(self, call: ToolCallRequest) -> ToolResult:
        self.executed.append(call.call_id)
        return ToolResult(
            name=call.name, tool_call_id=call.call_id, payload={"ok": True}
        )


def a_tool_turn() -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text="",
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id="call_1",
                name="search_properties",
                arguments=json.dumps({"location": "Dubai"}),
            )
        ],
    )
    turn.close()
    return turn


def always_calls_again(rounds: int = 10) -> ScriptedLLM:
    """A model that hands off to the same tool on every request it is given."""
    call = ToolCallRequest(
        name="search_properties", arguments={"location": "Dubai"}, call_id="call_1"
    )
    return ScriptedLLM([[Step(call)] for _ in range(rounds)])


async def drive(loop, llm, *, executor=None, history=None) -> list:
    """The orchestrator's loop: execute the batch, continue until nothing is asked."""
    executor = executor or InstantExecutor()
    history = history or MessageHistory()
    turn = a_tool_turn()
    first = ToolCallRequest(
        name="search_properties", arguments={"location": "Dubai"}, call_id="call_1"
    )
    outcomes = await execute_turn_calls(executor, turn, [first])
    events: list = []
    while True:
        seen = [
            event
            async for event in continue_after_tool(
                llm=llm, history=history, turn=turn, outcome=outcomes, loop=loop
            )
        ]
        events.extend(seen)
        requested = [event for event in seen if isinstance(event, ToolCallRequest)]
        if not requested:
            return events
        outcomes = await execute_turn_calls(executor, turn, requested)


def collect(events) -> list:
    async def run():
        return [event async for event in events]

    return asyncio.run(run())


class ToolLoopCapTest(unittest.TestCase):
    def test_the_cap_reads_the_named_bound_from_the_registry(self):
        self.assertEqual("tool.loop_cap", TOOL_LOOP_CAP_BOUND)
        self.assertEqual(CAP, ToolLoop().cap)
        self.assertEqual(CAP, ToolLoop(state=ToolLoopState()).cap)

    def test_the_loop_stops_at_the_cap_instead_of_asking_forever(self):
        llm = always_calls_again(20)
        executor = InstantExecutor()
        loop = ToolLoop(locale_code="en")

        events = asyncio.run(drive(loop, llm, executor=executor))

        self.assertEqual(CAP, len(llm.requests), "the loop outlived the cap")
        self.assertEqual(CAP + 1, len(executor.executed))
        self.assertEqual(CAP, loop.rounds)
        self.assertTrue(isinstance(events[-1], TokenDelta))
        self.assertEqual(LOOP_CAP_LINES["en"], events[-1].text)
        self.assertIsNotNone(loop.capped)
        self.assertEqual(CAP, loop.capped.rounds)
        self.assertEqual(CAP, loop.capped.cap)
        self.assertEqual(TOOL_LOOP_CAP_BOUND, loop.capped.bound)

    def test_the_round_budget_refuses_a_round_past_the_cap_by_name(self):
        loop = ToolLoop(cap=1)
        loop.take_round()

        with self.assertRaises(ToolLoopCapError) as caught:
            loop.take_round()

        self.assertEqual(1, caught.exception.outcome.rounds)
        self.assertEqual(1, caught.exception.outcome.cap)

    def test_the_fallback_line_is_localized_per_locale(self):
        line = loop_cap_line("es")
        self.assertEqual(LOOP_CAP_LINES["es"], line)
        self.assertNotEqual(LOOP_CAP_LINES["en"], line)
        with self.assertRaises(UnknownLoopCapLineError):
            loop_cap_line("xx")
        with self.assertRaises(UnknownLoopCapLineError):
            ToolLoop(locale_code="xx")

    def test_the_cap_ends_the_turn_and_records_it(self):
        clock = FakeClock()
        turns = TurnStateStore(clock=clock, source="meta")
        turns.open("t1")
        turns.finalise("look for a flat", turn="t1")

        def end_the_turn(outcome):
            turns.close(turn="t1", reason=outcome.reason)

        loop = ToolLoop(state=ToolLoopState(), on_cap=end_the_turn)
        events = asyncio.run(drive(loop, always_calls_again(20)))

        self.assertEqual(LOOP_CAP_LINES["en"], events[-1].text)
        self.assertTrue(loop.capped.turn_ended)
        self.assertEqual("tool_loop_cap", loop.capped.reason)
        self.assertEqual(TurnPhase.CLOSED, turns.get("t1").phase)
        self.assertEqual("tool_loop_cap", turns.get("t1").close_reason)
        self.assertEqual(
            {
                "rounds": CAP,
                "cap": CAP,
                "bound": TOOL_LOOP_CAP_BOUND,
                "locale": "en",
                "line": LOOP_CAP_LINES["en"],
                "turnEnded": True,
            },
            loop.capped.to_document(),
        )

    def test_the_cap_is_not_restated_in_code(self):
        with mock.patch("cascade.tools.require_bound", return_value=1) as require:
            loop = ToolLoop()

        require.assert_called_with(TOOL_LOOP_CAP_BOUND)
        self.assertEqual(1, loop.cap)

    def test_an_unset_cap_refuses_by_name_instead_of_defaulting(self):
        with mock.patch(
            "cascade.tools.require_bound",
            side_effect=UnsetBoundError(bound(TOOL_LOOP_CAP_BOUND)),
        ):
            with self.assertRaises(UnsetBoundError) as caught:
                ToolLoop()

        self.assertEqual(TOOL_LOOP_CAP_BOUND, caught.exception.name)

    def test_an_end_call_at_the_cap_still_ends_the_call_not_the_fallback(self):
        loop = ToolLoop(cap=1)
        loop.take_round()
        turn = a_tool_turn()
        history = MessageHistory()
        signal = EndCallSignal(
            call_id=CALL_ID, tool_call_id="call_end", closing_line="Bye."
        )

        events = collect(
            continue_after_tool(
                llm=always_calls_again(2),
                history=history,
                turn=turn,
                outcome=signal,
                loop=loop,
            )
        )

        self.assertEqual([], events)


if __name__ == "__main__":
    unittest.main()
