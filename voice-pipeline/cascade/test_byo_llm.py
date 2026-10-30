"""A stored body's one LLM override runs the cascade (ticket 159).

Seam: ``cascade.body_map.adapt_body`` reads the body's one provider entry into
an ``LlmOverride``, and ``cascade.meta_llm.construct_byo_model`` builds the
OpenAI-compatible client server-side. The client reuses the Standard rung's
request/tool/stream/failure contract; only construction differs. The key is a
server-side credential: it reaches the authorization header and nothing else.

Expected values come from the stored body shape in
``voni/src/lib/agents/body.ts`` (``LlmOverride``: ``base_url``, ``model``,
``api_key``, optional ``reasoning_effort``; an array of at most one entry; ``[]``
reverts to the default model) and the spec amendment (tickets 159/160 close the
eligibility gaps; managed is the fallback, not the BYO home).
"""

from __future__ import annotations

import asyncio
import json
import unittest

from cascade.body_map import (
    LlmOverride,
    MissingLlmOverrideFieldError,
    MultipleLlmOverridesError,
    adapt_body,
)
from cascade.eligibility import evaluate_body
from cascade.events import EventWriter, LegAttribution, TurnAttribution, emit_attribution
from cascade.meta_llm import (
    ByoLlmError,
    MetaLLMTurnFailed,
    build_byo_client,
    byo_attribution,
    construct_byo_model,
)
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "sk-tenant-secret"

#: The smallest stored body that carries one provider entry.
BODY = {
    "system_prompt": "You are a helpful agent.",
    "voice": {"voice_id": "lola"},
    "input": {"language_codes": ["es"]},
    "llm": [
        {
            "base_url": "https://models.example/v1",
            "model": "gpt-4o-mini",
            "api_key": API_KEY,
        }
    ],
}

TOOL = {
    "type": "function",
    "function": {
        "name": "lookup_rate",
        "description": "Current rate",
        "parameters": {"type": "object", "properties": {}},
    },
}

#: One well-formed bare SSE frame: a complete stream with no content.
EMPTY_STREAM = Response(chunks=(b"",))


def body_with(**entry) -> dict:
    override = {"base_url": "https://models.example/v1", "model": "gpt-4o-mini"}
    override.update(entry)
    if "api_key" not in entry:
        override["api_key"] = API_KEY
    return {**BODY, "llm": [override]}


def collect(client, **kwargs):
    async def run():
        return [event async for event in client.complete(**kwargs)]

    return asyncio.run(run())


class BodyOverrideTests(unittest.TestCase):
    def test_one_entry_becomes_the_body_llm_override(self):
        config = adapt_body(BODY)

        self.assertIsInstance(config.llm, LlmOverride)
        self.assertEqual(config.llm.base_url, "https://models.example/v1")
        self.assertEqual(config.llm.model, "gpt-4o-mini")

    def test_an_empty_array_is_the_documented_revert_to_the_default_rung(self):
        config = adapt_body({**BODY, "llm": []})

        self.assertIsNone(config.llm)

    def test_more_than_one_entry_is_refused_by_name(self):
        second = {
            "base_url": "https://other.example/v1",
            "model": "second-model",
            "api_key": "sk-other",
        }

        with self.assertRaises(MultipleLlmOverridesError) as caught:
            adapt_body({**BODY, "llm": [BODY["llm"][0], second]})

        self.assertEqual(caught.exception.path, "llm")
        self.assertIn("gpt-4o-mini", str(caught.exception))
        self.assertIn("second-model", str(caught.exception))
        self.assertNotIn(API_KEY, str(caught.exception))

    def test_a_missing_key_is_refused_by_name_and_never_echoes_a_value(self):
        override = {"base_url": "https://models.example/v1", "model": "gpt-4o-mini"}

        with self.assertRaises(MissingLlmOverrideFieldError) as caught:
            adapt_body({**BODY, "llm": [override]})

        self.assertEqual(caught.exception.path, "llm[0].api_key")
        self.assertIn("api_key", str(caught.exception))


class RequestContractTests(unittest.TestCase):
    def test_the_byo_client_posts_the_stored_provider_and_model_with_bearer_auth(self):
        override = adapt_body(BODY).llm
        factory = ScriptedSessionFactory([EMPTY_STREAM])
        model = construct_byo_model(
            override, session_factory=factory, system_prompt="You are a helpful agent."
        )

        collect(model.client, messages=[{"role": "user", "content": "hola"}])

        post = factory.posts[0]
        self.assertEqual(post["url"], "https://models.example/v1/chat/completions")
        self.assertEqual(post["headers"]["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(post["json"]["model"], "gpt-4o-mini")
        self.assertIs(post["json"]["stream"], True)
        self.assertEqual(post["json"]["stream_options"], {"include_usage": True})
        self.assertEqual(
            post["json"]["messages"],
            [
                {"role": "system", "content": "You are a helpful agent."},
                {"role": "user", "content": "hola"},
            ],
        )

    def test_the_byo_client_sends_tools_in_the_shared_chat_completions_shape(self):
        factory = ScriptedSessionFactory([EMPTY_STREAM])
        model = construct_byo_model(
            adapt_body(BODY).llm, session_factory=factory
        )

        collect(model.client, messages=[{"role": "user", "content": "rate?"}], tools=[TOOL])

        payload = factory.posts[0]["json"]
        self.assertEqual(payload["tools"], [TOOL])
        self.assertEqual(payload["tool_choice"], "auto")

    def test_an_undeclared_reasoning_effort_is_omitted_rather_than_invented(self):
        factory = ScriptedSessionFactory([EMPTY_STREAM])
        model = construct_byo_model(adapt_body(BODY).llm, session_factory=factory)

        collect(model.client, messages=[{"role": "user", "content": "hi"}])

        self.assertNotIn("reasoning_effort", factory.posts[0]["json"])

    def test_a_declared_reasoning_effort_is_sent_verbatim(self):
        factory = ScriptedSessionFactory([EMPTY_STREAM])
        model = construct_byo_model(
            adapt_body(body_with(reasoning_effort="low")).llm,
            session_factory=factory,
        )

        collect(model.client, messages=[{"role": "user", "content": "hi"}])

        self.assertEqual(factory.posts[0]["json"]["reasoning_effort"], "low")

    def test_the_standard_only_guard_is_not_applied_to_the_tenant_model(self):
        # ``resolve_model`` would refuse this id for the Spark rung; a tenant's
        # chosen model is theirs, so the BYO client must build and send it.
        factory = ScriptedSessionFactory([EMPTY_STREAM])
        model = construct_byo_model(
            adapt_body(body_with(model="tenant-enterprise-v2")).llm,
            session_factory=factory,
        )

        collect(model.client, messages=[{"role": "user", "content": "hi"}])

        payload = factory.posts[0]["json"]
        self.assertEqual(payload["model"], "tenant-enterprise-v2")
        self.assertNotIn("muse-spark-1.3", json.dumps(payload))

    def test_the_byo_client_honours_the_shared_failure_policy(self):
        factory = ScriptedSessionFactory([Response(status=400)])
        model = construct_byo_model(adapt_body(BODY).llm, session_factory=factory)

        with self.assertRaises(MetaLLMTurnFailed):
            collect(model.client, messages=[{"role": "user", "content": "hi"}])


class ConstructorFailureTests(unittest.TestCase):
    def test_a_client_that_cannot_be_constructed_fails_by_name_before_a_post(self):
        broken = LlmOverride(base_url="", model="gpt-4o-mini", api_key=API_KEY)
        factory = ScriptedSessionFactory([EMPTY_STREAM])

        with self.assertRaises(ByoLlmError) as caught:
            construct_byo_model(broken, session_factory=factory)

        self.assertIn("base_url", str(caught.exception))
        self.assertEqual(factory.posts, [])

    def test_build_byo_client_refuses_a_missing_key_without_reading_the_meta_key_env(self):
        broken = LlmOverride(
            base_url="https://models.example/v1", model="gpt-4o-mini", api_key=""
        )

        with self.assertRaises(ByoLlmError) as caught:
            build_byo_client(broken)

        self.assertIn("api_key", str(caught.exception))
        self.assertNotIn("META_API_KEY", str(caught.exception))


class KeySecrecyTests(unittest.TestCase):
    def test_the_key_is_absent_from_the_override_repr_and_document(self):
        override = adapt_body(BODY).llm

        self.assertNotIn(API_KEY, repr(override))
        self.assertNotIn(API_KEY, str(override))
        self.assertEqual(
            set(override.to_document()), {"base_url", "model", "reasoning_effort"}
        )
        self.assertNotIn(API_KEY, json.dumps(override.to_document()))

    def test_the_key_never_appears_in_a_serialized_event(self):
        override = adapt_body(BODY).llm
        attribution = byo_attribution(override)
        turn = TurnAttribution(
            turn="0:turn-1",
            llm=LegAttribution(
                leg="llm",
                provider=attribution.provider,
                rung="primary",
                reason=attribution.reason,
            ),
        )
        written: list[dict] = []
        writer = EventWriter(pipeline="cascade", call_id="call-1")

        event = emit_attribution(writer, turn, subject="tenant", at_ms=1, sink=written.append)

        serialized = json.dumps(event)
        self.assertNotIn(API_KEY, serialized)
        self.assertNotIn("api_key", serialized)


class AttributionTests(unittest.TestCase):
    def test_attribution_names_the_byo_provider_and_model_not_the_standard_rung(self):
        attribution = byo_attribution(adapt_body(BODY).llm)

        self.assertEqual(attribution.leg, "llm")
        self.assertEqual(attribution.provider, "models.example/gpt-4o-mini")
        self.assertNotIn("muse-spark-1.3", attribution.provider)
        self.assertIn("override", attribution.reason)


class EligibilityTests(unittest.TestCase):
    def test_a_non_empty_override_is_no_longer_refused(self):
        decision = evaluate_body(BODY, keyterm_limit=10)

        self.assertEqual(decision.disposition, "cascade")
        self.assertIsNotNone(decision.body.llm)

    def test_an_unconstructible_override_is_refused_by_name_not_routed_to_managed_silently(self):
        body = {**BODY, "llm": [{"model": "gpt-4o-mini"}]}

        decision = evaluate_body(body, keyterm_limit=10)

        self.assertEqual(decision.disposition, "managed")
        self.assertEqual(decision.predicates, ("llm",))
        self.assertIn("api_key", decision.reason)
        self.assertNotIn(API_KEY, decision.reason)
