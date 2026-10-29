"""Ticket 41: message assembly, tool-turn replay and what the caller heard.

The request's message array is a conversation, not a buffer of text. These
tests pin the four rules the spec gives it:

* the body's compiled ``system_prompt`` is sent unchanged and first;
* hidden context is appended as an uncaptioned ``system`` message for exactly
  one request and never becomes speech;
* a tool turn replays the assistant message with ``tool_calls`` before the
  ``tool`` results, because the vendor answers the truncated shape with 400;
* history contains what the caller heard, with an unspoken tail absent - except
  on a narration-held tool turn, whose assistant text is kept verbatim although
  the caller heard the hold line.

The vendor's 400 is exercised with a strict local stand-in that enforces the
documented OpenAI message rule, so the test fails if the assistant message is
dropped rather than merely checking that we sent *something*.
"""

import asyncio
import json
import unittest

from cascade.meta_llm import (
    MessageAssemblyError,
    MetaLLM,
    MetaLLMTurn,
    MetaLLMTurnFailed,
    MetaToolCall,
    MessageHistory,
    assistant_reply_message,
    tool_result_message,
    tool_turn_messages,
)

API_KEY = "test-meta-key"
SYSTEM_PROMPT = "You are Voni. Speak briefly and never invent a payment."


def tool_call(index=0, call_id="call_7", name="lookup_rate", arguments="{}"):
    """One accumulated call as the turn stream records it."""
    return MetaToolCall(index=index, call_id=call_id, name=name, arguments=arguments)


def tool_turn(calls, *, content=""):
    turn = MetaLLMTurn(content_text=content, finish_reason="tool_calls")
    turn.tool_calls = list(calls)
    return turn


class SpokenPrefixTests(unittest.TestCase):
    def test_a_cut_reply_records_only_the_prefix_the_caller_heard(self):
        turn = MetaLLMTurn(content_text="The rate is 6.2 percent today.")

        message = assistant_reply_message(turn, spoken_text="The rate is")

        self.assertEqual(
            message, {"role": "assistant", "content": "The rate is"}
        )
        self.assertNotIn("6.2", str(message))

    def test_an_uncut_reply_records_everything_it_generated(self):
        turn = MetaLLMTurn(content_text="The rate is 6.2 percent.")

        message = assistant_reply_message(turn)

        self.assertEqual(
            message, {"role": "assistant", "content": "The rate is 6.2 percent."}
        )

    def test_words_the_model_never_said_cannot_enter_history(self):
        turn = MetaLLMTurn(content_text="The rate is 6.2 percent.")

        with self.assertRaises(MessageAssemblyError) as caught:
            assistant_reply_message(turn, spoken_text="The rate is 7.1 percent")

        self.assertIn("prefix", str(caught.exception))

    def test_an_entirely_unspoken_reply_is_absent_from_history(self):
        turn = MetaLLMTurn(content_text="The rate is 6.2 percent.")
        history = MessageHistory(system_prompt=SYSTEM_PROMPT)
        history.append_user("what rate?")

        appended = history.append_reply(turn, spoken_text="")

        self.assertIsNone(appended)
        self.assertEqual(
            [message["role"] for message in history.messages], ["user"]
        )


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


SSE_OK = (
    b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
    b"data: [DONE]\n\n"
)


def _tool_calls_declared(message):
    return {
        call.get("id")
        for call in message.get("tool_calls") or ()
        if isinstance(call, dict)
    }


def _message_order_valid(messages):
    """The vendor's documented rule: a tool message answers the assistant turn.

    An assistant message declares the call ids it requested; a ``tool`` message
    is valid only while one of those ids is still pending, and a new user turn
    ends the window.
    """
    pending = set()
    for message in messages:
        role = message.get("role")
        if role == "assistant":
            declared = _tool_calls_declared(message)
            if declared:
                pending = declared
        elif role == "tool":
            if message.get("tool_call_id") not in pending:
                return False
            pending.discard(message.get("tool_call_id"))
        elif role == "user":
            pending = set()
    return True


class _StrictVendorResponse:
    def __init__(self, status, chunks):
        self.status = status
        self._chunks = chunks

    async def iter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _StrictVendorPost:
    def __init__(self, factory, url, headers, payload):
        self._factory = factory
        self._url = url
        self._headers = headers
        self._payload = payload

    async def __aenter__(self):
        self._factory.posts.append(
            {"url": self._url, "headers": self._headers, "json": self._payload}
        )
        if _message_order_valid(self._payload["messages"]):
            return _StrictVendorResponse(200, (SSE_OK,))
        return _StrictVendorResponse(400, (b"invalid_request_error",))

    async def __aexit__(self, *args):
        return False


class _StrictVendorSession:
    def __init__(self, factory):
        self._factory = factory

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers, json):
        return _StrictVendorPost(self._factory, url, headers, json)


class _StrictVendorSessionFactory:
    """A vendor stand-in that enforces the message-order contract on the wire.

    This is deliberately not a canned 400: it answers 200 for a well-formed
    conversation and 400 for the truncated tool turn, so the tests below fail
    if the assembly drops the assistant message rather than merely assert that
    we sent a request.
    """

    def __init__(self):
        self.posts = []

    def __call__(self, *, timeout_s):
        return _StrictVendorSession(self)


class ToolTurnReplayTests(unittest.TestCase):
    def test_assistant_message_with_tool_calls_precedes_the_tool_results(self):
        turn = tool_turn([tool_call()])
        result = tool_result_message("call_7", '{"rate": 6.2}')

        messages = tool_turn_messages(turn, [result])

        self.assertEqual(messages[0]["role"], "assistant")
        self.assertEqual(messages[0]["tool_calls"][0]["id"], "call_7")
        self.assertEqual(messages[1], result)
        self.assertEqual(
            [message["role"] for message in messages], ["assistant", "tool"]
        )

    def test_arguments_are_replayed_exactly_as_the_model_streamed_them(self):
        turn = tool_turn(
            [tool_call(arguments='{"amount": 40000, "term_months": 60}')]
        )

        messages = tool_turn_messages(turn, [])

        self.assertEqual(
            messages[0]["tool_calls"][0]["function"]["arguments"],
            '{"amount": 40000, "term_months": 60}',
        )

    def test_narration_on_a_tool_turn_is_kept_verbatim_even_though_held(self):
        """The caller heard the hold line; the model still said this."""
        turn = tool_turn(
            [tool_call()], content="Let me look that rate up for you."
        )

        messages = tool_turn_messages(turn, [tool_result_message("call_7", "{}")])

        self.assertEqual(
            messages[0]["content"], "Let me look that rate up for you."
        )

    def test_a_tool_result_for_an_undeclared_call_is_refused(self):
        turn = tool_turn([tool_call(call_id="call_7")])

        with self.assertRaises(MessageAssemblyError) as caught:
            tool_turn_messages(turn, [tool_result_message("call_9", "{}")])

        self.assertIn("call_9", str(caught.exception))

    def test_every_call_in_the_turn_is_replayed_before_any_result(self):
        turn = tool_turn(
            [
                tool_call(index=0, call_id="call_7", name="lookup_rate"),
                tool_call(index=1, call_id="call_8", name="lookup_fees"),
            ]
        )
        results = [
            tool_result_message("call_7", '{"rate": 6.2}'),
            tool_result_message("call_8", '{"fees": 300}'),
        ]

        messages = tool_turn_messages(turn, results)

        self.assertEqual(
            [call["id"] for call in messages[0]["tool_calls"]],
            ["call_7", "call_8"],
        )
        self.assertEqual(messages[1:], results)

    def test_a_tool_turn_cannot_be_recorded_as_a_plain_reply(self):
        """Dropping tool_calls here would produce the same vendor 400."""
        turn = tool_turn([tool_call()], content="One moment.")

        with self.assertRaises(MessageAssemblyError) as caught:
            assistant_reply_message(turn)

        self.assertIn("tool", str(caught.exception).lower())


class VendorFourHundredTests(unittest.TestCase):
    def _history(self):
        # MetaLLM owns the body's system prompt; the history carries the turns.
        history = MessageHistory()
        history.append_user("rates?")
        history.append_tool_turn(
            tool_turn([tool_call()]), [tool_result_message("call_7", '{"rate": 6.2}')]
        )
        return history

    def test_replayed_tool_turn_is_accepted_and_the_reply_continues(self):
        factory = _StrictVendorSessionFactory()
        llm = make_llm(factory)

        events = collect(llm, messages=list(self._history().request_messages()))

        self.assertEqual([event.text for event in events], ["ok"])
        self.assertEqual(
            [message["role"] for message in factory.posts[0]["json"]["messages"]],
            ["system", "user", "assistant", "tool"],
        )

    def test_omitting_the_assistant_message_is_the_vendor_400(self):
        factory = _StrictVendorSessionFactory()
        llm = make_llm(factory)
        messages = list(self._history().request_messages())
        broken = [messages[0], messages[2]]

        with self.assertRaises(MetaLLMTurnFailed) as caught:
            collect(llm, messages=broken)

        self.assertEqual(caught.exception.decision.verdict.code, 400)
        self.assertEqual(
            [message["role"] for message in factory.posts[0]["json"]["messages"]],
            ["system", "user", "tool"],
        )


class SystemPromptTests(unittest.TestCase):
    def test_the_compiled_prompt_is_sent_byte_for_byte_unchanged(self):
        prompt = (
            "\n  You are Voni.\n\n"
            "Never invent a payment.\n"
            "  {{tenant.name}} keeps its own words.  \n"
        )
        factory = _StrictVendorSessionFactory()
        llm = make_llm(factory, system_prompt=prompt)

        collect(llm, messages=[{"role": "user", "content": "hi"}])

        messages = factory.posts[0]["json"]["messages"]
        self.assertEqual(messages[0], {"role": "system", "content": prompt})
        self.assertEqual(
            [message["role"] for message in messages], ["system", "user"]
        )


class HiddenContextTests(unittest.TestCase):
    def test_hidden_context_is_one_uncaptioned_system_message_next_request(self):
        history = MessageHistory(system_prompt=SYSTEM_PROMPT)
        history.append_user("what rate?")
        hidden = "The caller already gave their budget: 40 thousand."
        history.add_hidden_context(hidden)

        messages = history.request_messages()

        self.assertEqual(messages[-1], {"role": "system", "content": hidden})
        self.assertEqual(
            [message["role"] for message in messages], ["system", "user", "system"]
        )
        self.assertFalse(
            any(
                marker in message["content"].lower()
                for message in messages
                if message["role"] == "system"
                for marker in ("hidden context", "additional context", "note:")
            )
        )

    def test_hidden_context_belongs_to_one_request_only(self):
        history = MessageHistory()
        history.append_user("what rate?")
        history.add_hidden_context("The caller already gave their budget.")

        history.request_messages()
        second = history.request_messages()

        self.assertEqual([message["role"] for message in second], ["user"])

    def test_hidden_context_never_enters_the_recorded_conversation(self):
        history = MessageHistory(system_prompt=SYSTEM_PROMPT)
        history.append_user("what rate?")
        hidden = "The caller already gave their budget: 40 thousand."
        history.add_hidden_context(hidden)

        history.request_messages()

        self.assertNotIn(hidden, json.dumps(history.messages))
        self.assertEqual(
            [message["role"] for message in history.messages], ["user"]
        )


class HistoryOrderTests(unittest.TestCase):
    def test_full_history_is_replayed_in_order_with_the_prompt_first(self):
        factory = _StrictVendorSessionFactory()
        llm = make_llm(factory)
        history = MessageHistory()
        history.append_user("rates?")
        turn = tool_turn([tool_call()])
        history.append_tool_turn(
            turn, [tool_result_message("call_7", '{"rate": 6.2}')]
        )
        history.append_reply(MetaLLMTurn(content_text="6.2 percent."))
        history.append_user("and fees?")

        collect(llm, messages=list(history.request_messages()))

        wire = factory.posts[0]["json"]["messages"]
        self.assertEqual(
            [message["role"] for message in wire],
            ["system", "user", "assistant", "tool", "assistant", "user"],
        )
        self.assertEqual(wire[1:], list(history.messages))
        self.assertEqual(
            [
                message.get("tool_call_id")
                for message in wire
                if message["role"] == "tool"
            ],
            ["call_7"],
        )


