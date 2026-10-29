"""Ticket 43: finish reasons and empty replies.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "``stop`` is normal.
``length`` and ``content_filter`` speak what was generated, mark the reply
truncated, and do not retry. ``tool_calls`` hands off to the tool loop.
``function_call`` is treated as ``tool_calls`` for compatibility." Edge-case
catalog: "``finish_reason: stop`` with empty content — no audio; close the turn;
record it."

The seam is ``MetaLLMTurn.disposition``, computed when the turn closes. It is
what the orchestrator reads instead of re-interpreting a vendor string.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import MetaLLM, MetaLLMTurn, ReplyOutcome
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


def delta_frame(delta: dict, finish_reason=None) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    )


def tool_frame(**call) -> bytes:
    return delta_frame({"tool_calls": [{"index": 0, "type": "function", **call}]})


DONE = b"data: [DONE]\n\n"


def make_llm(*chunks):
    factory = ScriptedSessionFactory([Response(chunks=tuple(chunks))])
    return MetaLLM(
        api_key=API_KEY, reasoning_effort="low", session_factory=factory
    )


def run(llm):
    async def scenario():
        turn = MetaLLMTurn()
        events = [event async for event in llm.complete(
            turn=turn, messages=[{"role": "user", "content": "hi"}]
        )]
        return events, turn

    return asyncio.run(scenario())


class NormalAndTruncatedTests(unittest.TestCase):
    def test_stop_closes_normally_and_speaks_what_was_generated(self):
        llm = make_llm(delta_frame({"content": "All set."}), delta_frame({}, "stop"), DONE)

        _, turn = run(llm)

        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.NORMAL)
        self.assertTrue(disposition.speak)
        self.assertEqual(disposition.finish_reason, "stop")
        self.assertFalse(disposition.truncated)
        self.assertFalse(disposition.filtered)
        self.assertFalse(disposition.retry_allowed)

    def test_length_speaks_the_partial_reply_and_marks_it_truncated(self):
        llm = make_llm(
            delta_frame({"content": "The rate is"}),
            delta_frame({}, "length"),
            DONE,
        )

        events, turn = run(llm)

        self.assertEqual([event.text for event in events], ["The rate is"])
        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.TRUNCATED)
        self.assertTrue(disposition.truncated)
        self.assertTrue(disposition.speak)
        self.assertFalse(disposition.retry_allowed)
        self.assertTrue(turn.truncated)

    def test_content_filter_speaks_the_partial_reply_and_marks_it_filtered(self):
        llm = make_llm(
            delta_frame({"content": "I can"}),
            delta_frame({}, "content_filter"),
            DONE,
        )

        events, turn = run(llm)

        self.assertEqual([event.text for event in events], ["I can"])
        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.FILTERED)
        self.assertTrue(disposition.filtered)
        self.assertTrue(disposition.speak)
        self.assertFalse(disposition.retry_allowed)
        self.assertTrue(turn.filtered)


class ToolHandoffTests(unittest.TestCase):
    def test_tool_calls_hand_off_and_their_content_is_not_spoken(self):
        llm = make_llm(
            delta_frame({"content": "Let me check that."}),
            tool_frame(
                id="call_a",
                function={"name": "lookup_rate", "arguments": "{}"},
            ),
            delta_frame({}, "tool_calls"),
            DONE,
        )

        events, turn = run(llm)

        # The orchestrator discards this content from audio and speaks a hold
        # line; the disposition is the instruction, the text stays for history.
        self.assertEqual(
            [event.text for event in events if hasattr(event, "text")],
            ["Let me check that."],
        )
        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.TOOL_HANDOFF)
        self.assertFalse(disposition.speak)
        self.assertTrue(disposition.hold_line)
        self.assertEqual(disposition.finish_reason, "tool_calls")

    def test_function_call_is_treated_as_a_tool_handoff(self):
        llm = make_llm(
            delta_frame(
                {
                    "function_call": {
                        "name": "lookup_rate",
                        "arguments": '{"term": 30}',
                    }
                }
            ),
            delta_frame({}, "function_call"),
            DONE,
        )

        _, turn = run(llm)

        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.TOOL_HANDOFF)
        self.assertTrue(disposition.hold_line)
        self.assertEqual(turn.tool_calls[0].name, "lookup_rate")
        self.assertEqual(turn.tool_calls[0].arguments, '{"term": 30}')


class EmptyReplyTests(unittest.TestCase):
    def test_stop_with_empty_content_speaks_nothing_and_records_the_turn(self):
        llm = make_llm(delta_frame({}, "stop"), DONE)

        events, turn = run(llm)

        self.assertEqual(events, [])
        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.EMPTY)
        self.assertFalse(disposition.speak)
        self.assertFalse(disposition.retry_allowed)
        self.assertEqual(disposition.finish_reason, "stop")

    def test_stop_with_only_reasoning_is_an_empty_reply_not_a_spoken_thought(self):
        llm = make_llm(
            delta_frame({"reasoning_content": "Nothing worth saying."}),
            delta_frame({}, "stop"),
            DONE,
        )

        events, turn = run(llm)

        self.assertEqual(events, [])
        self.assertIs(turn.disposition.outcome, ReplyOutcome.EMPTY)
        self.assertEqual(turn.reasoning_text, "Nothing worth saying.")

    def test_stop_with_whitespace_only_content_speaks_nothing(self):
        llm = make_llm(delta_frame({"content": "  \n "}), delta_frame({}, "stop"), DONE)

        _, turn = run(llm)

        self.assertIs(turn.disposition.outcome, ReplyOutcome.EMPTY)


class IncompleteStreamTests(unittest.TestCase):
    """The retry seam ticket 42 consumes: retry only before the first token."""

    def test_a_cut_stream_with_no_content_may_still_be_retried(self):
        llm = make_llm(delta_frame({"reasoning_content": "thinking"}))

        _, turn = run(llm)

        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.INCOMPLETE)
        self.assertFalse(disposition.speak)
        self.assertTrue(disposition.retry_allowed)

    def test_a_cut_stream_after_content_must_not_restart_the_reply(self):
        llm = make_llm(delta_frame({"content": "The rate is"}))

        _, turn = run(llm)

        disposition = turn.disposition
        self.assertIs(disposition.outcome, ReplyOutcome.INCOMPLETE)
        self.assertTrue(disposition.speak)
        self.assertFalse(disposition.retry_allowed)

    def test_an_unknown_finish_reason_is_not_guessed_to_be_a_normal_stop(self):
        llm = make_llm(
            delta_frame({"content": "partial"}), delta_frame({}, "vendor_new"), DONE
        )

        _, turn = run(llm)

        self.assertIs(turn.disposition.outcome, ReplyOutcome.INCOMPLETE)
        self.assertEqual(turn.finish_reason, "vendor_new")
        self.assertFalse(turn.disposition.retry_allowed)


if __name__ == "__main__":
    unittest.main()
