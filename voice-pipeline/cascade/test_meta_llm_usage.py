"""Ticket 38: per-turn usage, with unmeasured as a real value.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "The final chunk with
``stream_options.include_usage`` carries prompt, completion, total, cached and
reasoning token counts. Usage is recorded per turn. A stream that is interrupted
before the usage chunk records ``unmeasured``, never zero." And the edge-case
catalog: "Usage is missing because the stream was interrupted — ``unmeasured``,
never zero; no cost claim."

The seam is ``MetaLLM.complete()`` plus ``MetaLLMTurn.usage``. A cost table
(ticket 101) cites those units; it must never re-parse the stream.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import MetaLLM, MetaLLMTurn
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"


def sse(payload) -> bytes:
    return b"data: " + json.dumps(payload).encode("utf-8") + b"\n\n"


def delta_frame(delta: dict, finish_reason=None) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    )


def usage_frame(usage: dict) -> bytes:
    """The final chunk ``include_usage`` adds: no choices, only counts."""
    return sse({"choices": [], "usage": usage})


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


def run(llm, *, stop_after=None):
    """Drive one completion; return (events, turn, raised exception)."""
    async def scenario():
        turn = MetaLLMTurn()
        events = []
        error = None
        try:
            async for event in llm.complete(
                turn=turn, messages=[{"role": "user", "content": "hi"}]
            ):
                events.append(event)
                if stop_after is not None and len(events) >= stop_after:
                    break
        except BaseException as exc:  # the test asserts on it, not swallows it
            error = exc
        return events, turn, error

    return asyncio.run(scenario())


class RecordedUsageTests(unittest.TestCase):
    def test_final_usage_chunk_records_every_per_turn_unit(self):
        llm = make_llm(
            delta_frame({"content": "Six point two percent."}),
            delta_frame({}, finish_reason="stop"),
            usage_frame(
                {
                    "prompt_tokens": 128,
                    "completion_tokens": 24,
                    "total_tokens": 152,
                    "prompt_tokens_details": {"cached_tokens": 64},
                    "completion_tokens_details": {"reasoning_tokens": 12},
                }
            ),
            DONE,
        )

        _, turn, error = run(llm)

        self.assertIsNone(error)
        usage = turn.usage
        self.assertTrue(usage.measured)
        self.assertEqual(usage.prompt_tokens, 128)
        self.assertEqual(usage.completion_tokens, 24)
        self.assertEqual(usage.total_tokens, 152)
        self.assertEqual(usage.cached_tokens, 64)
        self.assertEqual(usage.reasoning_tokens, 12)

    def test_usage_on_the_last_content_chunk_is_captured_too(self):
        """Some streams attach usage to the final choice instead of a bare chunk."""
        llm = make_llm(
            sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "Done."},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 8,
                        "completion_tokens": 2,
                        "total_tokens": 10,
                    },
                }
            ),
            DONE,
        )

        _, turn, _ = run(llm)

        self.assertEqual(turn.usage.prompt_tokens, 8)
        self.assertEqual(turn.usage.completion_tokens, 2)
        self.assertEqual(turn.usage.total_tokens, 10)

    def test_a_missing_cached_or_reasoning_count_is_absent_not_zero(self):
        llm = make_llm(
            delta_frame({"content": "Hi"}, finish_reason="stop"),
            usage_frame(
                {"prompt_tokens": 20, "completion_tokens": 4, "total_tokens": 24}
            ),
            DONE,
        )

        _, turn, _ = run(llm)

        self.assertEqual(turn.usage.prompt_tokens, 20)
        self.assertIsNone(turn.usage.cached_tokens)
        self.assertIsNone(turn.usage.reasoning_tokens)

    def test_per_turn_units_are_citable_without_reparsing_the_stream(self):
        llm = make_llm(
            delta_frame({"content": "Hi"}, finish_reason="stop"),
            usage_frame(
                {
                    "prompt_tokens": 20,
                    "completion_tokens": 4,
                    "total_tokens": 24,
                    "prompt_tokens_details": {"cached_tokens": 16},
                    "completion_tokens_details": {"reasoning_tokens": 1},
                }
            ),
            DONE,
        )

        _, turn, _ = run(llm)

        self.assertEqual(
            turn.usage.as_dict(),
            {
                "prompt_tokens": 20,
                "completion_tokens": 4,
                "total_tokens": 24,
                "cached_tokens": 16,
                "reasoning_tokens": 1,
                "measured": True,
            },
        )
        self.assertIs(llm.last_turn, turn)


class UnmeasuredUsageTests(unittest.TestCase):
    def test_an_interrupted_stream_records_unmeasured_never_zero(self):
        factory = ScriptedSessionFactory(
            [
                Response(
                    chunks=(delta_frame({"content": "Half a sen"}),),
                    exc=ConnectionResetError("vendor dropped the stream"),
                )
            ]
        )
        llm = MetaLLM(
            api_key=API_KEY, reasoning_effort="low", session_factory=factory
        )

        _, turn, error = run(llm)

        self.assertIsInstance(error, ConnectionResetError)
        self.assertFalse(turn.usage.measured)
        self.assertIsNone(turn.usage.prompt_tokens)
        self.assertIsNone(turn.usage.completion_tokens)
        self.assertIsNone(turn.usage.total_tokens)
        self.assertIsNone(turn.usage.cached_tokens)
        self.assertIsNone(turn.usage.reasoning_tokens)
        self.assertTrue(turn.interrupted)

    def test_a_stream_abandoned_by_the_caller_records_unmeasured(self):
        """A barge-in stops consuming; no usage chunk was ever read."""
        llm = make_llm(
            delta_frame({"content": "One"}),
            delta_frame({"content": " two"}),
            delta_frame({}, finish_reason="stop"),
            usage_frame(
                {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
            ),
            DONE,
        )

        events, turn, _ = run(llm, stop_after=1)

        self.assertEqual([event.text for event in events], ["One"])
        self.assertFalse(turn.usage.measured)
        self.assertIsNone(turn.usage.total_tokens)
        self.assertTrue(turn.interrupted)

    def test_a_stream_that_ends_without_usage_is_unmeasured(self):
        llm = make_llm(
            delta_frame({"content": "Hi"}, finish_reason="stop"),
            DONE,
        )

        _, turn, error = run(llm)

        self.assertIsNone(error)
        self.assertFalse(turn.usage.measured)
        self.assertIsNone(turn.usage.total_tokens)
        self.assertEqual(
            turn.usage.as_dict()["measured"], False
        )


if __name__ == "__main__":
    unittest.main()
