"""Ticket 45: recorded model streams replay against pinned expectations.

Spec: `.scratch/meta-cascade/spec.md` "Failures" and "Testing Decisions" — a
recorded fixture is evidence, and drift must be visible. The six streams below
cover a normal reply, a reasoning-first reply, a tool-call reply, a split tool
delta, a length stop and an interrupted stream. Each file pins the spoken
deltas, the finish reason and the usage units, so a vendor contract change (or
an edited recording) fails *by fixture name* instead of passing silently.

An unknown additive SSE field is ignored: the projection only reads the fields
the contract names. An unknown field in the fixture document itself is refused
by name, so a typo cannot hide an unpinned expectation.

No vendor key is read: every replay uses the ticket-01 scripted session factory
and an explicitly supplied test key, so this runs in the Python CI job untouched.
"""

import asyncio
import json
import os
import unittest
from pathlib import Path
from unittest import mock

from cascade.meta_llm import MetaLLM, MetaLLMTurn
from cascade.testing import Response, ScriptedSessionFactory
from providers import TokenDelta

TEST_KEY = "test-meta-key"

FIXTURES = Path(__file__).with_name("fixtures") / "meta_llm"

#: Every fixture file must be replayed by a named test below; the guard compares
#: this list with the directory so a new recording cannot be dropped silently.
EXERCISED = (
    "normal-reply",
    "reasoning-first",
    "tool-call",
    "split-tool-delta",
    "length-stop",
    "interrupted-stream",
)

DOCUMENT_FIELDS = frozenset({"name", "description", "chunks", "tools", "expect"})
EXPECT_FIELDS = frozenset(
    {
        "spoken",
        "content",
        "reasoning",
        "reasoning_deltas",
        "finish_reason",
        "outcome",
        "speak",
        "retry_allowed",
        "hold_line",
        "truncated",
        "filtered",
        "tool_calls",
        "usage",
    }
)


class FixtureError(AssertionError):
    """A recorded fixture or its pinned expectation is not readable."""


def load(name: str) -> dict:
    path = FIXTURES / f"{name}.json"
    if not path.is_file():
        raise FixtureError(f"fixture {name!r} does not exist at {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    validate_document(document, expected_name=name)
    return document


def validate_document(document: object, *, expected_name: str | None = None) -> None:
    if not isinstance(document, dict):
        raise FixtureError("a fixture document must be a JSON object")
    name = document.get("name")
    label = repr(name if isinstance(name, str) else expected_name)
    unknown = sorted(set(document) - DOCUMENT_FIELDS)
    if unknown:
        raise FixtureError(
            f"fixture {label} has unknown field(s) {', '.join(unknown)}; "
            "the loader refuses a field it would not replay"
        )
    missing = sorted({"name", "description", "chunks", "expect"} - set(document))
    if missing:
        raise FixtureError(f"fixture {label} is missing {', '.join(missing)}")
    if expected_name is not None and name != expected_name:
        raise FixtureError(
            f"fixture file {expected_name!r} names itself {name!r}"
        )
    chunks = document["chunks"]
    if not isinstance(chunks, list) or not all(
        isinstance(chunk, str) for chunk in chunks
    ):
        raise FixtureError(f"fixture {label} chunks must be a list of strings")
    expect = document["expect"]
    if not isinstance(expect, dict):
        raise FixtureError(f"fixture {label} expect must be an object")
    unknown = sorted(set(expect) - EXPECT_FIELDS)
    if unknown:
        raise FixtureError(
            f"fixture {label} pins unknown expectation field(s) "
            f"{', '.join(unknown)}"
        )
    missing = sorted(EXPECT_FIELDS - set(expect))
    if missing:
        raise FixtureError(
            f"fixture {label} does not pin {', '.join(missing)}; an unpinned "
            "known field could drift silently"
        )


def project(events, turn: MetaLLMTurn) -> dict:
    """What the caller and the turn record observe, and nothing vendor-private."""
    disposition = turn.disposition
    return {
        "spoken": [event.text for event in events if isinstance(event, TokenDelta)],
        "content": turn.content_text,
        "reasoning": turn.reasoning_text,
        "reasoning_deltas": turn.reasoning_deltas,
        "finish_reason": turn.finish_reason,
        "outcome": disposition.outcome.value,
        "speak": disposition.speak,
        "retry_allowed": disposition.retry_allowed,
        "hold_line": disposition.hold_line,
        "truncated": disposition.truncated,
        "filtered": disposition.filtered,
        "tool_calls": [
            {
                "index": call.index,
                "call_id": call.call_id,
                "name": call.name,
                "arguments": call.arguments,
            }
            for call in turn.tool_calls
        ],
        "usage": turn.usage.as_dict(),
    }


def replay(document: dict) -> dict:
    chunks = tuple(chunk.encode("utf-8") for chunk in document["chunks"])
    factory = ScriptedSessionFactory([Response(chunks=chunks)])
    llm = MetaLLM(
        api_key=TEST_KEY, reasoning_effort="low", session_factory=factory
    )
    tools = document.get("tools") or None

    async def scenario():
        turn = MetaLLMTurn()
        events = [
            event
            async for event in llm.complete(
                turn=turn,
                messages=[{"role": "user", "content": "what rate can I get?"}],
                tools=tools,
            )
        ]
        return project(events, turn)

    return asyncio.run(scenario())


def assert_parity(document: dict) -> dict:
    """Replay one fixture and fail by name on the first pinned field that moved."""
    validate_document(document)
    actual = replay(document)
    expected = document["expect"]
    drifted = [
        field for field in sorted(EXPECT_FIELDS) if actual[field] != expected[field]
    ]
    if drifted:
        detail = "; ".join(
            f"{field} pinned {expected[field]!r}, replayed {actual[field]!r}"
            for field in drifted
        )
        raise AssertionError(
            f"fixture {document['name']!r} drifted at "
            f"{', '.join(drifted)}: {detail}"
        )
    return actual


class RecordedStreamTests(unittest.TestCase):
    def test_normal_reply_replays(self):
        actual = assert_parity(load("normal-reply"))
        self.assertEqual(actual["outcome"], "normal")

    def test_reasoning_first_reply_replays_without_speaking_reasoning(self):
        actual = assert_parity(load("reasoning-first"))
        self.assertEqual(actual["spoken"], ["Let me check that."])
        self.assertEqual(actual["usage"]["reasoning_tokens"], 12)

    def test_tool_call_reply_replays_one_request(self):
        actual = assert_parity(load("tool-call"))
        self.assertEqual(len(actual["tool_calls"]), 1)

    def test_split_tool_delta_replays_one_joined_request(self):
        actual = assert_parity(load("split-tool-delta"))
        self.assertEqual(actual["tool_calls"][0]["call_id"], "call_rate_2")
        self.assertEqual(
            actual["tool_calls"][0]["arguments"],
            '{"amount": 250000, "term": 15}',
        )

    def test_length_stop_replays_as_truncated(self):
        actual = assert_parity(load("length-stop"))
        self.assertEqual(actual["outcome"], "truncated")

    def test_interrupted_stream_replays_unmeasured(self):
        actual = assert_parity(load("interrupted-stream"))
        self.assertFalse(actual["usage"]["measured"])
        self.assertIsNone(actual["finish_reason"])

    def test_every_recorded_fixture_is_exercised(self):
        on_disk = {path.stem for path in FIXTURES.glob("*.json")}

        self.assertEqual(on_disk, set(EXERCISED), sorted(on_disk ^ set(EXERCISED)))


class FixtureDriftTests(unittest.TestCase):
    """A changed known field is a visible failure, never a silent pass."""

    def test_a_changed_finish_reason_fails_by_the_fixture_name(self):
        document = load("normal-reply")
        document["chunks"] = [
            chunk.replace('"finish_reason":"stop"', '"finish_reason":"length"')
            for chunk in document["chunks"]
        ]

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("normal-reply", message)
        self.assertIn("finish_reason", message)

    def test_changed_content_fails_by_the_fixture_name(self):
        document = load("normal-reply")
        document["chunks"][0] = document["chunks"][0].replace(
            "Your rate is ", "Our rate is "
        )

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("normal-reply", message)
        self.assertIn("spoken", message)

    def test_a_changed_usage_unit_fails_by_the_fixture_name(self):
        document = load("normal-reply")
        document["chunks"] = [
            chunk.replace('"total_tokens":51', '"total_tokens":52')
            for chunk in document["chunks"]
        ]

        with self.assertRaises(AssertionError) as caught:
            assert_parity(document)

        message = str(caught.exception)
        self.assertIn("normal-reply", message)
        self.assertIn("usage", message)

    def test_an_unknown_additive_stream_field_is_ignored(self):
        document = load("normal-reply")
        augmented = []
        for chunk in document["chunks"]:
            if not chunk.startswith("data: {"):
                augmented.append(chunk)
                continue
            payload = json.loads(chunk[len("data: "):])
            payload["vendor_trace_id"] = "trace-abc"
            for choice in payload.get("choices") or ():
                choice["delta"]["vendor_extension"] = {"confidence": 0.99}
            augmented.append("data: " + json.dumps(payload) + "\n\n")
        document["chunks"] = augmented

        assert_parity(document)  # same pinned projection

    def test_an_unknown_fixture_field_is_refused_by_name(self):
        document = load("normal-reply")
        document["vendor_extra"] = "not part of the document contract"

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("normal-reply", str(caught.exception))
        self.assertIn("vendor_extra", str(caught.exception))

    def test_an_unpinned_known_field_is_refused_by_name(self):
        document = load("normal-reply")
        del document["expect"]["usage"]

        with self.assertRaises(FixtureError) as caught:
            assert_parity(document)

        self.assertIn("normal-reply", str(caught.exception))
        self.assertIn("usage", str(caught.exception))


class NoVendorKeyTests(unittest.TestCase):
    def test_replays_with_an_empty_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            assert_parity(load("tool-call"))


if __name__ == "__main__":
    unittest.main()
