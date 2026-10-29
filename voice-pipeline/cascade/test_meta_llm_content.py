"""Ticket 37: only content is speech; reasoning is recorded, never spoken.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "Content deltas are
yielded as text. ``reasoning_content`` is recorded for usage and telemetry but
never sent to TTS; a reasoning-only delta does not mark ``first_token``. The
first content delta marks ``first_token``."

The seam is ``MetaLLM.complete()`` plus the per-turn record and the injected
ledger. The SSE frames below are inline strings; ticket 45 owns the recorded
vendor fixtures that replay whole streams.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import MetaLLM, MetaLLMTurn
from cascade.testing import Response, ScriptedSessionFactory
from metrics import TimingLedger

API_KEY = "test-meta-key"
SYSTEM_PROMPT = "You are Voni. Speak briefly."


def sse(payload) -> bytes:
    """One Server-Sent Events frame, terminated the way the vendor sends it."""
    return (
        b"data: "
        + json.dumps(payload, ensure_ascii=False).encode("utf-8")
        + b"\n\n"
    )


def delta_frame(delta: dict, finish_reason=None) -> bytes:
    return sse(
        {
            "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish_reason}
            ]
        }
    )


DONE = b"data: [DONE]\n\n"


def collect(llm, **kwargs):
    """Drive one completion; return the emitted events and the turn record."""
    async def run():
        turn = MetaLLMTurn()
        events = [event async for event in llm.complete(turn=turn, **kwargs)]
        return events, turn

    return asyncio.run(run())


def make_llm(factory, **overrides):
    options = {
        "api_key": API_KEY,
        "reasoning_effort": "low",
        "system_prompt": SYSTEM_PROMPT,
        "session_factory": factory,
    }
    options.update(overrides)
    return MetaLLM(**options)


def make_llm_with_stream(*chunks, ledger=None):
    factory = ScriptedSessionFactory([Response(chunks=tuple(chunks))])
    return make_llm(factory, ledger=ledger), factory


class ContentDeltaTests(unittest.TestCase):
    def test_content_deltas_are_the_only_text_yielded_in_order(self):
        llm, _ = make_llm_with_stream(
            delta_frame({"role": "assistant", "content": ""}),
            delta_frame({"content": "Hel"}),
            delta_frame({"content": "lo "}),
            delta_frame({"content": "there"}),
            delta_frame({}, finish_reason="stop"),
            DONE,
        )

        events, turn = collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual([event.text for event in events], ["Hel", "lo ", "there"])
        self.assertEqual(turn.content_text, "Hello there")

    def test_multibyte_character_split_across_chunks_is_reassembled(self):
        body = (
            delta_frame({"content": "héllo 🙌"}, finish_reason="stop") + DONE
        )
        # Cut two bytes into the four-byte emoji sequence: a chunk boundary is
        # a byte boundary, not a character boundary.
        cut = body.index("🙌".encode("utf-8")) + 2
        llm, _ = make_llm_with_stream(body[:cut], body[cut:])

        events, turn = collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual([event.text for event in events], ["héllo 🙌"])
        self.assertEqual(turn.content_text, "héllo 🙌")


class ReasoningIsNotSpeechTests(unittest.TestCase):
    def test_reasoning_deltas_are_recorded_and_never_yielded(self):
        llm, _ = make_llm_with_stream(
            delta_frame({"reasoning_content": "The caller wants "}),
            delta_frame({"reasoning_content": "a rate."}),
            delta_frame({"content": "Our rate is 6.2%."}),
            delta_frame({}, finish_reason="stop"),
            DONE,
        )

        events, turn = collect(llm, messages=[{"role": "user", "content": "rate?"}])

        self.assertEqual([event.text for event in events], ["Our rate is 6.2%."])
        self.assertEqual(turn.reasoning_text, "The caller wants a rate.")
        self.assertEqual(turn.reasoning_deltas, 2)
        self.assertEqual(turn.content_text, "Our rate is 6.2%.")

    def test_a_fixture_that_reasons_before_it_speaks_leaks_no_reasoning(self):
        """The anti-lie fixture: treating reasoning as content fails here."""
        llm, _ = make_llm_with_stream(
            delta_frame(
                {"reasoning_content": "The caller wants a rate. I should quote 6.2%."}
            ),
            delta_frame({"reasoning_content": " Keep it to one sentence."}),
            delta_frame({"content": "Six point two percent."}),
            delta_frame({}, finish_reason="stop"),
            DONE,
        )
        events, turn = collect(
            llm, messages=[{"role": "user", "content": "rate?"}]
        )

        spoken = "".join(event.text for event in events)
        self.assertEqual(spoken, "Six point two percent.")
        self.assertNotIn("quote", spoken)
        self.assertNotIn("reasoning", spoken.lower())
        self.assertEqual(turn.reasoning_text.count("6.2%"), 1)


class FirstTokenTests(unittest.TestCase):
    def test_first_content_delta_marks_first_token(self):
        ledger = TimingLedger(now=lambda: 0.0)
        llm, _ = make_llm_with_stream(
            delta_frame({"reasoning_content": "thinking first"}),
            delta_frame({"content": "Answer"}),
            delta_frame({}, finish_reason="stop"),
            DONE,
            ledger=ledger,
        )

        collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertIn("first_token", ledger.summary()["marks"])

    def test_reasoning_only_stream_marks_no_first_token_and_speaks_nothing(self):
        ledger = TimingLedger(now=lambda: 0.0)
        llm, _ = make_llm_with_stream(
            delta_frame({"reasoning_content": "thinking only"}),
            delta_frame({}, finish_reason="stop"),
            DONE,
            ledger=ledger,
        )

        events, turn = collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual(events, [])
        self.assertEqual(turn.reasoning_text, "thinking only")
        self.assertEqual(turn.content_text, "")
        self.assertNotIn("first_token", ledger.summary()["marks"])

    def test_the_ledger_is_optional_and_never_invented(self):
        llm, _ = make_llm_with_stream(
            delta_frame({"content": "Hi"}, finish_reason="stop"), DONE
        )

        events, turn = collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual([event.text for event in events], ["Hi"])
        self.assertEqual(turn.reasoning_text, "")


if __name__ == "__main__":
    unittest.main()
