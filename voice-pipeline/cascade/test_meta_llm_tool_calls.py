"""Ticket 39: tool-call deltas accumulate by index into one request.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "Tool-call deltas are
accumulated by ``index``, including a split ``id``, a split ``name``, and split
``arguments``. Exactly one ``ToolCallRequest`` is emitted per index when
``finish_reason`` is ``tool_calls`` or the stream ends. A missing or empty
``call_id`` produces a request that is not executed; the turn is closed with a
hold line and the denial is recorded. A ``call_id`` outside 1-64 characters is a
provider contract violation and fails the turn."

Argument *validation* (schema, tool-failure result) is ticket 40. This file only
pins the seam: a payload that is not a JSON object is withheld and recorded, so
it can never be executed as an empty object.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import (
    CALL_ID_MAX_LENGTH,
    MetaLLM,
    MetaLLMTurn,
    ToolCallIdentityError,
)
from cascade.testing import Response, ScriptedSessionFactory
from metrics import TimingLedger

API_KEY = "test-meta-key"


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


def delta_frame(delta: dict, finish_reason=None) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    )


def tool_frame(*calls: dict, finish_reason=None) -> bytes:
    return delta_frame({"tool_calls": list(calls)}, finish_reason=finish_reason)


def call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
    """One vendor tool-call delta; each field is optional and may be split."""
    delta: dict = {"index": index, "type": "function"}
    if call_id is not None:
        delta["id"] = call_id
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    if function:
        delta["function"] = function
    return delta


DONE = b"data: [DONE]\n\n"


def make_llm(*chunks, **overrides):
    factory = ScriptedSessionFactory([Response(chunks=tuple(chunks))])
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


def requests(events):
    return [event for event in events if hasattr(event, "call_id")]


class SplitDeltaTests(unittest.TestCase):
    def test_split_id_name_and_arguments_accumulate_into_one_request(self):
        llm = make_llm(
            tool_frame(
                call_delta(
                    0,
                    call_id="call_",
                    name="look",
                    arguments="",
                )
            ),
            tool_frame(call_delta(0, call_id="7x", name="up_", arguments='{"am')),
            tool_frame(call_delta(0, name="rate", arguments='ount": 4')),
            tool_frame(call_delta(0, arguments="0000}"), finish_reason="tool_calls"),
            sse(
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 3,
                        "total_tokens": 13,
                    },
                }
            ),
            DONE,
        )

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(requests(events)), 1)
        request = requests(events)[0]
        self.assertEqual(request.call_id, "call_7x")
        self.assertEqual(request.name, "lookup_rate")
        self.assertEqual(request.arguments, {"amount": 40000})
        self.assertEqual(len(turn.tool_calls), 1)
        self.assertEqual(turn.tool_calls[0].arguments, '{"amount": 40000}')
        self.assertEqual(turn.tool_calls[0].index, 0)

    def test_two_indices_produce_two_requests_in_index_order(self):
        """Deltas may interleave and arrive index 1 first; order is by index."""
        llm = make_llm(
            tool_frame(call_delta(1, call_id="call_b", name="fees")),
            tool_frame(call_delta(0, call_id="call_a", name="lookup_")),
            tool_frame(call_delta(1, arguments='{"term": 30}')),
            tool_frame(call_delta(0, name="rate")),
            tool_frame(call_delta(0, arguments="{}"), finish_reason="tool_calls"),
            DONE,
        )

        events, turn, error = run(llm)

        self.assertIsNone(error)
        emitted = requests(events)
        self.assertEqual([request.call_id for request in emitted], ["call_a", "call_b"])
        self.assertEqual(
            [request.name for request in emitted], ["lookup_rate", "fees"]
        )
        self.assertEqual([call.index for call in turn.tool_calls], [0, 1])


class EmissionOnceTests(unittest.TestCase):
    def test_exactly_one_request_per_index_on_the_finish_reason(self):
        llm = make_llm(
            tool_frame(call_delta(0, call_id="call_a", name="lookup_rate",
                                  arguments="{}")),
            tool_frame(call_delta(1, call_id="call_b", name="fees",
                                  arguments='{"term": 30}')),
            tool_frame(finish_reason="tool_calls"),
            sse({"choices": [], "usage": {"total_tokens": 12}}),
            DONE,
        )

        events, turn, _ = run(llm)

        self.assertEqual(len(requests(events)), 2)
        self.assertEqual(len(turn.tool_calls), 2)

    def test_stream_end_without_a_finish_reason_still_emits_one_per_index(self):
        llm = make_llm(
            tool_frame(call_delta(0, call_id="call_a", name="lookup_rate",
                                  arguments="{}")),
            DONE,
        )

        events, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(len(requests(events)), 1)
        self.assertEqual(requests(events)[0].name, "lookup_rate")
        self.assertIsNone(turn.finish_reason)

    def test_content_on_a_tool_turn_is_still_yielded_for_the_orchestrator(self):
        """Audio suppression is the orchestrator's rule (ticket 43 disposition)."""
        llm = make_llm(
            delta_frame({"content": "Let me check."}),
            tool_frame(call_delta(0, call_id="call_a", name="lookup_rate",
                                  arguments="{}")),
            tool_frame(finish_reason="tool_calls"),
            DONE,
        )

        events, turn, _ = run(llm)

        self.assertEqual(turn.content_text, "Let me check.")
        self.assertEqual(len(requests(events)), 1)


class CallIdentityTests(unittest.TestCase):
    def test_a_call_id_longer_than_the_limit_fails_the_turn(self):
        overlong = "c" * (CALL_ID_MAX_LENGTH + 1)
        llm = make_llm(
            tool_frame(call_delta(0, call_id=overlong, name="lookup_rate")),
            tool_frame(finish_reason="tool_calls"),
            DONE,
        )

        events, turn, error = run(llm)

        self.assertIsInstance(error, ToolCallIdentityError)
        self.assertIn(str(CALL_ID_MAX_LENGTH), str(error))
        self.assertEqual(requests(events), [])

    def test_a_call_id_at_the_limit_is_accepted(self):
        at_limit = "c" * CALL_ID_MAX_LENGTH
        llm = make_llm(
            tool_frame(call_delta(0, call_id=at_limit, name="lookup_rate")),
            tool_frame(call_delta(0, arguments="{}"), finish_reason="tool_calls"),
            DONE,
        )

        events, _, error = run(llm)

        self.assertIsNone(error)
        self.assertEqual(requests(events)[0].call_id, at_limit)

    def test_a_missing_call_id_is_emitted_but_not_executable_and_denied(self):
        ledger = TimingLedger(now=lambda: 0.0)
        llm = make_llm(
            tool_frame(call_delta(0, name="lookup_rate", arguments="{}")),
            tool_frame(finish_reason="tool_calls"),
            DONE,
            ledger=ledger,
        )

        events, turn, error = run(llm)

        self.assertIsNone(error)
        emitted = requests(events)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0].call_id, "")
        self.assertTrue(turn.hold_line_required)
        self.assertEqual(
            [denial.name for denial in turn.denied_tool_calls], ["lookup_rate"]
        )
        self.assertIn("call_id", turn.denied_tool_calls[0].reason)
        self.assertEqual(ledger.summary()["counts"]["tool_denied"], 1)


class ArgumentsSeamTests(unittest.TestCase):
    """Ticket 40 owns validation; 39 must not leak a silent empty object."""

    def test_malformed_arguments_are_withheld_and_recorded(self):
        for raw in ("not json", '{"amount": 4', "[1, 2]", '"a string"'):
            with self.subTest(arguments=raw):
                llm = make_llm(
                    tool_frame(
                        call_delta(0, call_id="call_a", name="lookup_rate"),
                        call_delta(0, arguments=raw),
                    ),
                    tool_frame(finish_reason="tool_calls"),
                    DONE,
                )

                events, turn, error = run(llm)

                self.assertIsNone(error)
                self.assertEqual(requests(events), [])
                self.assertEqual(len(turn.rejected_tool_calls), 1)
                self.assertEqual(
                    turn.rejected_tool_calls[0].name, "lookup_rate"
                )
                self.assertIn("arguments", turn.rejected_tool_calls[0].reason)

    def test_empty_arguments_are_not_invented_as_an_empty_object(self):
        llm = make_llm(
            tool_frame(call_delta(0, call_id="call_a", name="lookup_rate")),
            tool_frame(finish_reason="tool_calls"),
            DONE,
        )

        events, turn, _ = run(llm)

        self.assertEqual(requests(events), [])
        self.assertEqual(len(turn.rejected_tool_calls), 1)


if __name__ == "__main__":
    unittest.main()
