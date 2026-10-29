"""Ticket 40: arguments are validated before a tool is ever invoked.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "The arguments string
is parsed as JSON. A malformed or non-object result is a tool failure, never a
silent execution with `{}`. The model may emit invalid JSON or arguments outside
the schema; validate before invoking." Edge-case catalog "Tools and model
output": invalid JSON and valid-but-not-an-object both "do not execute; return a
tool failure; the model can correct".

The seam is the turn record: a withheld call is a :class:`ToolDenial` that
carries the call id and a stable failure code, so the tool loop can append the
`role: "tool"` result the model corrects from on the next request. A schema the
cascade cannot enforce is our bug, not the model's, and fails the turn by name.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import (
    MetaLLM,
    MetaLLMTurn,
    ToolSchemaError,
)
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_rate",
            "description": "Current refinance rate",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {"type": "integer", "minimum": 1},
                    "term": {"type": "integer"},
                },
                "required": ["amount"],
                "additionalProperties": False,
            },
        },
    }
]


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


def delta_frame(delta: dict, finish_reason=None) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    )


def tool_frame(*calls: dict, finish_reason=None) -> bytes:
    return delta_frame({"tool_calls": list(calls)}, finish_reason=finish_reason)


def call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
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


def make_llm(*chunks):
    factory = ScriptedSessionFactory([Response(chunks=tuple(chunks))])
    return MetaLLM(api_key=API_KEY, reasoning_effort="low", session_factory=factory)


def run(llm, tools=TOOLS):
    """Drive one completion; return (events, turn, raised exception)."""

    async def scenario():
        turn = MetaLLMTurn()
        events = []
        error = None
        try:
            async for event in llm.complete(
                turn=turn,
                messages=[{"role": "user", "content": "rate?"}],
                tools=tools,
            ):
                events.append(event)
        except BaseException as exc:
            error = exc
        return events, turn, error

    return asyncio.run(scenario())


def requests(events):
    return [event for event in events if hasattr(event, "call_id")]


def argument_call(arguments: str):
    return make_llm(
        tool_frame(
            call_delta(0, call_id="call_a", name="lookup_rate"),
            call_delta(0, arguments=arguments),
        ),
        tool_frame(finish_reason="tool_calls"),
        DONE,
    )


class CorrectableFailureTests(unittest.TestCase):
    """Malformed and non-object payloads become results, not executions."""

    def test_malformed_json_is_a_correctable_tool_failure(self):
        events, turn, error = run(argument_call('{"amount": 4'))

        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        failures = turn.tool_failures
        self.assertEqual(len(failures), 1)
        failure = failures[0]
        self.assertEqual(failure.name, "lookup_rate")
        self.assertEqual(failure.call_id, "call_a")
        self.assertEqual(failure.code, "invalid_json")
        self.assertIn("JSON", failure.reason)

    def test_non_object_json_is_a_correctable_tool_failure(self):
        for raw in ("[1, 2]", '"a string"', "42", "null", "true"):
            with self.subTest(arguments=raw):
                events, turn, error = run(argument_call(raw))

                self.assertIsNone(error)
                self.assertEqual(requests(events), [])
                self.assertEqual(len(turn.tool_failures), 1)
                self.assertEqual(turn.tool_failures[0].code, "not_an_object")
                self.assertIn("object", turn.tool_failures[0].reason)

    def test_absent_arguments_are_a_correctable_tool_failure(self):
        events, turn, error = run(
            make_llm(
                tool_frame(call_delta(0, call_id="call_a", name="lookup_rate")),
                tool_frame(finish_reason="tool_calls"),
                DONE,
            )
        )

        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertEqual(turn.tool_failures[0].code, "missing_arguments")

    def test_the_failure_is_returned_as_a_tool_result_the_model_can_correct(self):
        _, turn, _ = run(argument_call("not json"))

        message = turn.tool_failures[0].as_tool_message()

        self.assertEqual(message["role"], "tool")
        self.assertEqual(message["tool_call_id"], "call_a")
        content = json.loads(message["content"])
        self.assertEqual(content["error"], "invalid_json")
        self.assertIn("arguments", content["message"])

    def test_a_denied_call_without_an_id_has_no_tool_result(self):
        """The vendor cannot be answered without a call id; the turn holds."""
        _, turn, error = run(
            make_llm(
                tool_frame(
                    call_delta(0, name="lookup_rate", arguments='{"amount": 4}')
                ),
                tool_frame(finish_reason="tool_calls"),
                DONE,
            )
        )

        self.assertIsNone(error)
        self.assertTrue(turn.hold_line_required)
        denial = turn.denied_tool_calls[0]
        self.assertFalse(denial.correctable)
        with self.assertRaises(ValueError):
            denial.as_tool_message()

    def test_valid_arguments_are_still_emitted_as_a_request(self):
        llm = make_llm(
            tool_frame(
                call_delta(0, call_id="call_a", name="lookup_rate"),
                call_delta(0, arguments='{"amount": 40000, "term": 30}'),
            ),
            tool_frame(finish_reason="tool_calls"),
            DONE,
        )

        events, turn, error = run(llm)

        self.assertIsNone(error)
        emitted = requests(events)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0].arguments, {"amount": 40000, "term": 30})
        self.assertEqual(turn.tool_failures, [])


class SchemaValidationTests(unittest.TestCase):
    """Arguments outside the declared schema never reach the tool loop."""

    def assert_refused(self, arguments: str, *needles: str):
        events, turn, error = run(argument_call(arguments))

        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertEqual(len(turn.tool_failures), 1)
        failure = turn.tool_failures[0]
        self.assertEqual(failure.code, "schema_violation")
        for needle in needles:
            self.assertIn(needle, failure.reason)
        return failure

    def test_a_missing_required_property_is_refused(self):
        self.assert_refused("{}", "amount", "required")

    def test_a_wrong_property_type_is_refused(self):
        self.assert_refused('{"amount": "a lot"}', "amount", "integer")

    def test_a_value_outside_the_declared_bound_is_refused(self):
        self.assert_refused('{"amount": 0}', "amount", "minimum")

    def test_an_undeclared_property_is_refused(self):
        self.assert_refused(
            '{"amount": 5, "account": "123"}', "account", "additional"
        )

    def test_a_nested_violation_names_its_path(self):
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "lookup_rate",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "applicant": {
                                "type": "object",
                                "properties": {"age": {"type": "integer"}},
                                "required": ["age"],
                            }
                        },
                        "required": ["applicant"],
                    },
                },
            }
        ]
        factory = ScriptedSessionFactory(
            [
                Response(
                    chunks=(
                        tool_frame(
                            call_delta(0, call_id="call_a", name="lookup_rate"),
                            call_delta(
                                0, arguments='{"applicant": {"age": "old"}}'
                            ),
                        ),
                        tool_frame(finish_reason="tool_calls"),
                        DONE,
                    )
                )
            ]
        )
        llm = MetaLLM(api_key=API_KEY, reasoning_effort="low", session_factory=factory)

        events, turn, error = run(llm, tools=tools)

        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertIn("applicant.age", turn.tool_failures[0].reason)

    def test_a_schema_the_cascade_cannot_enforce_fails_the_turn_by_name(self):
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "lookup_rate",
                    "parameters": {
                        "type": "object",
                        "properties": {"amount": {"$ref": "#/$defs/money"}},
                    },
                },
            }
        ]
        factory = ScriptedSessionFactory(
            [
                Response(
                    chunks=(
                        tool_frame(
                            call_delta(0, call_id="call_a", name="lookup_rate"),
                            call_delta(0, arguments='{"amount": 5}'),
                        ),
                        tool_frame(finish_reason="tool_calls"),
                        DONE,
                    )
                )
            ]
        )
        llm = MetaLLM(api_key=API_KEY, reasoning_effort="low", session_factory=factory)

        _, turn, error = run(llm, tools=tools)

        self.assertIsInstance(error, ToolSchemaError)
        self.assertIn("$ref", str(error))

    def test_no_declared_schema_skips_schema_validation_but_not_json_parsing(self):
        tools_without_parameters = [
            {"type": "function", "function": {"name": "lookup_rate"}}
        ]
        events, turn, error = run(
            make_llm(
                tool_frame(
                    call_delta(0, call_id="call_a", name="lookup_rate"),
                    call_delta(0, arguments='{"anything": 1}'),
                ),
                tool_frame(finish_reason="tool_calls"),
                DONE,
            ),
            tools=tools_without_parameters,
        )

        self.assertIsNone(error)
        self.assertEqual(len(requests(events)), 1)
        self.assertEqual(requests(events)[0].arguments, {"anything": 1})


class SchemaKeywordTests(unittest.TestCase):
    """The enforced subset keeps working as the schemas grow."""

    def run_schema(self, schema, arguments):
        tools = [
            {"type": "function", "function": {"name": "lookup_rate", "parameters": schema}}
        ]
        return run(
            make_llm(
                tool_frame(
                    call_delta(0, call_id="call_a", name="lookup_rate"),
                    call_delta(0, arguments=arguments),
                ),
                tool_frame(finish_reason="tool_calls"),
                DONE,
            ),
            tools=tools,
        )

    def test_enum_membership_is_enforced(self):
        schema = {
            "type": "object",
            "properties": {"kind": {"type": "string", "enum": ["fixed", "variable"]}},
            "required": ["kind"],
        }

        events, turn, error = self.run_schema(schema, '{"kind": "balloon"}')
        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertIn("enum", turn.tool_failures[0].reason)

        events, turn, error = self.run_schema(schema, '{"kind": "fixed"}')
        self.assertIsNone(error)
        self.assertEqual(len(requests(events)), 1)

    def test_array_item_violations_name_the_index(self):
        schema = {
            "type": "object",
            "properties": {
                "tags": {"type": "array", "items": {"type": "string"}}
            },
        }

        events, turn, error = self.run_schema(schema, '{"tags": ["ok", 2]}')

        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertIn("tags[1]", turn.tool_failures[0].reason)

    def test_any_of_accepts_one_branch_and_refuses_none(self):
        schema = {
            "type": "object",
            "properties": {
                "amount": {
                    "anyOf": [
                        {"type": "integer", "minimum": 1},
                        {"type": "string", "enum": ["max"]},
                    ]
                }
            },
            "required": ["amount"],
        }

        _, turn, error = self.run_schema(schema, '{"amount": "max"}')
        self.assertIsNone(error)
        self.assertEqual(turn.tool_failures, [])

        events, turn, error = self.run_schema(schema, '{"amount": 0}')
        self.assertIsNone(error)
        self.assertEqual(requests(events), [])
        self.assertIn("anyOf", turn.tool_failures[0].reason)


if __name__ == "__main__":
    unittest.main()
