"""Ticket 36: the Chat Completions request contract, and nothing past the wire.

The request is the one the spec pins. These tests read the recorded POST that
the injected scripted session factory saw, so they fail if the builder drifts:
bearer auth, the resolved Standard model, the full history, a streamed
completion that includes usage, and automatic tool choice only when tools
exist. Stream parsing, tool accumulation, usage recording, finish reasons and
failure policy belong to tickets 37-45 and are deliberately not exercised here.
"""

import asyncio
import unittest

from cascade.meta_llm import (
    MetaLLM,
    MetaLLMConfigError,
    ReasoningEffortError,
    build_chat_request,
    build_messages,
)
from cascade.model_guard import ModelGuardError
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"
SYSTEM_PROMPT = "You are Voni. Speak briefly and never invent a payment."


def collect(llm, **kwargs):
    async def run():
        return [event async for event in llm.complete(**kwargs)]

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


class PlainTurnRequestTests(unittest.TestCase):
    def test_posts_chat_completions_with_bearer_auth_and_streamed_usage(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)
        history = [{"role": "user", "content": "I need a loan for 40 thousand."}]

        events = collect(llm, messages=history)

        self.assertEqual(events, [])
        self.assertEqual(len(factory.posts), 1)
        post = factory.posts[0]
        self.assertTrue(post["url"].endswith("/v1/chat/completions"))
        self.assertEqual(post["url"], "https://api.meta.ai/v1/chat/completions")
        self.assertEqual(post["headers"]["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(post["json"]["model"], "muse-spark-1.3")
        self.assertIs(post["json"]["stream"], True)
        self.assertEqual(post["json"]["stream_options"], {"include_usage": True})

    def test_full_message_history_is_sent_unchanged_in_order(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)
        history = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
            {"role": "user", "content": "third"},
        ]

        collect(llm, messages=history)

        self.assertEqual(
            factory.posts[0]["json"]["messages"],
            [{"role": "system", "content": SYSTEM_PROMPT}] + history,
        )


class BuildMessagesTests(unittest.TestCase):
    def test_system_prompt_is_sent_unchanged_and_first(self):
        messages = build_messages(
            system_prompt=SYSTEM_PROMPT,
            history=[{"role": "user", "content": "hello"}],
        )

        self.assertEqual(messages[0], {"role": "system", "content": SYSTEM_PROMPT})
        self.assertEqual(messages[1], {"role": "user", "content": "hello"})

    def test_missing_system_prompt_adds_no_empty_system_message(self):
        messages = build_messages(history=[{"role": "user", "content": "hello"}])

        self.assertEqual(messages, [{"role": "user", "content": "hello"}])


class ToolRequestTests(unittest.TestCase):
    def test_tools_are_sent_with_automatic_tool_choice(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "lookup_rate",
                    "description": "Current refinance rate",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]

        collect(llm, messages=[{"role": "user", "content": "rates?"}], tools=tools)

        payload = factory.posts[0]["json"]
        self.assertEqual(payload["tools"], tools)
        self.assertEqual(payload["tool_choice"], "auto")

    def test_parallel_tool_calls_is_left_at_the_vendor_default(self):
        payload = build_chat_request(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "lookup_rate"}}],
            reasoning_effort="low",
        )

        self.assertNotIn("parallel_tool_calls", payload)

    def test_no_tools_means_no_tools_key_and_no_tool_choice(self):
        payload = build_chat_request(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": "hi"}],
            tools=None,
            reasoning_effort="low",
        )

        self.assertNotIn("tools", payload)
        self.assertNotIn("tool_choice", payload)


class HiddenContextTests(unittest.TestCase):
    def test_hidden_context_is_appended_uncaptioned_as_a_system_message(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)
        hidden = "The caller already gave their budget: 40 thousand."

        collect(
            llm,
            messages=[{"role": "user", "content": "what rate?"}],
            hidden_context=[hidden],
        )

        messages = factory.posts[0]["json"]["messages"]
        self.assertEqual(messages[-1], {"role": "system", "content": hidden})
        self.assertEqual(messages[0], {"role": "system", "content": SYSTEM_PROMPT})
        self.assertEqual(
            [message["role"] for message in messages],
            ["system", "user", "system"],
        )
        self.assertFalse(
            any(
                marker in message["content"].lower()
                for message in messages
                if message["role"] == "system"
                for marker in ("hidden context", "additional context", "note:")
            )
        )

    def test_hidden_context_belongs_to_the_next_turn_only(self):
        factory = ScriptedSessionFactory(
            [Response(chunks=(b"",)), Response(chunks=(b"",))]
        )
        llm = make_llm(factory)

        collect(llm, messages=[{"role": "user", "content": "one"}],
                hidden_context=["internal scratchpad"])
        collect(llm, messages=[{"role": "user", "content": "two"}])

        second = factory.posts[1]["json"]["messages"]
        self.assertEqual([message["role"] for message in second], ["system", "user"])
        self.assertNotIn("internal scratchpad", str(second))


class ToolTurnReplayTests(unittest.TestCase):
    def test_assistant_tool_call_message_precedes_tool_results(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)
        assistant_turn = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_7",
                    "type": "function",
                    "function": {"name": "lookup_rate", "arguments": "{}"},
                }
            ],
        }
        tool_result = {
            "role": "tool",
            "tool_call_id": "call_7",
            "content": '{"rate": 6.2}',
        }

        collect(
            llm,
            messages=[
                {"role": "user", "content": "rates?"},
                assistant_turn,
                tool_result,
                {"role": "user", "content": "and fees?"},
            ],
        )

        messages = factory.posts[0]["json"]["messages"]
        self.assertEqual(messages[2], assistant_turn)
        self.assertEqual(messages[3], tool_result)
        self.assertLess(
            next(i for i, m in enumerate(messages) if "tool_calls" in m),
            next(i for i, m in enumerate(messages) if m["role"] == "tool"),
        )


class ReasoningEffortTests(unittest.TestCase):
    def test_absent_effort_refuses_at_construction_before_any_request(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])

        with self.assertRaises(ReasoningEffortError) as caught:
            MetaLLM(
                reasoning_effort=None,
                api_key=API_KEY,
                session_factory=factory,
            )

        message = str(caught.exception)
        self.assertIn("reasoning_effort", message)
        self.assertIn("M03", message)
        self.assertEqual(factory.posts, [])

    def test_none_effort_is_refused_because_spark_rejects_it(self):
        for value in ("none", "NONE", " none "):
            with self.subTest(value=value):
                with self.assertRaises(ReasoningEffortError) as caught:
                    MetaLLM(reasoning_effort=value, api_key=API_KEY)
                self.assertIn("HTTP 400", str(caught.exception))

    def test_configured_effort_is_sent_verbatim_without_inventing_a_value(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory, reasoning_effort="low")

        collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual(factory.posts[0]["json"]["reasoning_effort"], "low")
        self.assertEqual(llm.reasoning_effort, "low")

    def test_request_builder_refuses_an_unavailable_effort_too(self):
        """One validator: a second construction path must not skip the refusal."""
        with self.assertRaises(ReasoningEffortError):
            build_chat_request(
                model="muse-spark-1.3",
                messages=[{"role": "user", "content": "hi"}],
                reasoning_effort="none",
            )


class ModelGuardIntegrationTests(unittest.TestCase):
    def test_contributor_model_refuses_at_construction_without_a_request(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])

        with self.assertRaises(ModelGuardError):
            MetaLLM(
                model="muse-spark-1.3-contributor",
                reasoning_effort="low",
                api_key=API_KEY,
                session_factory=factory,
            )

        self.assertEqual(factory.posts, [])

    def test_model_guard_runs_before_the_effort_check(self):
        """The privacy guard must win: no effort error may mask it."""
        with self.assertRaises(ModelGuardError):
            MetaLLM(model="muse-spark-1.3-contributor", reasoning_effort=None)


class MissingAPIKeyTests(unittest.TestCase):
    def test_missing_key_refuses_by_name_before_posting(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = MetaLLM(
            reasoning_effort="low",
            api_key="",
            session_factory=factory,
        )

        with self.assertRaises(MetaLLMConfigError) as caught:
            collect(llm, messages=[{"role": "user", "content": "hi"}])

        self.assertIn("META_API_KEY", str(caught.exception))
        self.assertEqual(factory.posts, [])


class ForbiddenParameterTests(unittest.TestCase):
    def test_unsupported_parameters_are_never_present(self):
        payload = build_chat_request(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": "hi"}],
            reasoning_effort="low",
        )

        for key in (
            "store",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "n",
            "logprobs",
            "top_logprobs",
            "modalities",
            "temperature",
            "top_p",
            "parallel_tool_calls",
            "user",
            "safety_identifier",
        ):
            self.assertNotIn(key, payload)

    def test_unsupported_parameters_are_absent_from_the_wire_request(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory)

        collect(llm, messages=[{"role": "user", "content": "hi"}])

        payload = factory.posts[0]["json"]
        self.assertEqual(
            set(payload),
            {
                "model",
                "messages",
                "stream",
                "stream_options",
                "reasoning_effort",
            },
        )


if __name__ == "__main__":
    unittest.main()
