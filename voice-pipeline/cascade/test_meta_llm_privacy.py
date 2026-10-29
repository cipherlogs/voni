"""Ticket 44: no caller identity in model identifiers.

Spec: `.scratch/meta-cascade/spec.md` "Meta LLM backend" — "No caller-identifying
value is sent as ``user`` or ``safety_identifier``; if either is used it is a
salted hash of an internal id, never a phone number, email or name. Prompt
caching is a latency/cost decision and is reviewed with the ZDR question before
cutover."

The seam is the built request body the vendor would receive. The fixture names a
caller (name, phone, email) and an internal call id: none of those may appear on
the wire, and the call id may appear only as a salted digest.
"""

import asyncio
import hashlib
import json
import os
import unittest
from unittest import mock

from cascade.meta_llm import (
    MetaLLM,
    MetaLLMConfigError,
    MetaLLMTurn,
    build_chat_request,
    privacy_identifier,
)
from cascade.testing import Response, ScriptedSessionFactory

API_KEY = "test-meta-key"
CALL_ID = "call-123"
SALT = "pepper"
CALLER_NAME = "Dana Whitfield"
CALLER_PHONE = "+15550100200"
CALLER_EMAIL = "dana.whitfield@example.test"

#: Known-good digest for sha256("pepper" + NUL + "call-123"), computed
#: independently; the NUL keeps salt and id unambiguous.
PINNED_IDENTIFIER = (
    "48129c29f8666f1af302c0138bcf067f64e7abcb41e744cdfad1b47fa8b014f6"
)
#: The unsalted digest, which a dictionary attack would reproduce.
UNSALTED_DIGEST = (
    "6c25371237b71c93cf9ddbfc64f1f15f31b53f4eb905bbfd5cd79260f44a37f4"
)


def make_llm(factory, **overrides):
    options = {
        "api_key": API_KEY,
        "reasoning_effort": "low",
        "session_factory": factory,
    }
    options.update(overrides)
    return MetaLLM(**options)


def drain(llm, *, turn=None):
    """Run one completion to exhaustion; return its turn record."""

    async def scenario():
        record = turn or MetaLLMTurn()
        async for _ in llm.complete(
            turn=record, messages=[{"role": "user", "content": "hi"}]
        ):
            pass
        return record

    return asyncio.run(scenario())


class SaltedIdentifierTests(unittest.TestCase):
    def test_the_identifier_is_a_pinned_salted_digest_of_the_internal_id(self):
        self.assertEqual(privacy_identifier(CALL_ID, SALT), PINNED_IDENTIFIER)

    def test_it_is_salted_and_not_the_unsalted_dictionary_hash(self):
        identifier = privacy_identifier(CALL_ID, SALT)

        self.assertNotEqual(identifier, UNSALTED_DIGEST)
        self.assertEqual(
            hashlib.sha256(CALL_ID.encode()).hexdigest(), UNSALTED_DIGEST
        )
        self.assertNotIn(CALL_ID, identifier)

    def test_the_digest_is_stable_for_the_same_id_and_salt(self):
        self.assertEqual(
            privacy_identifier(CALL_ID, SALT), privacy_identifier(CALL_ID, SALT)
        )

    def test_a_different_salt_or_id_produces_a_different_digest(self):
        baseline = privacy_identifier(CALL_ID, SALT)
        self.assertNotEqual(baseline, privacy_identifier(CALL_ID, "other-pepper"))
        self.assertNotEqual(baseline, privacy_identifier("call-456", SALT))

    def test_a_missing_salt_refuses_at_construction_with_no_request(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])

        with self.assertRaises(MetaLLMConfigError) as caught:
            make_llm(factory, internal_id=CALL_ID, identifier_salt=None)

        self.assertIn("salt", str(caught.exception).lower())
        self.assertEqual(factory.posts, [])

    def test_an_empty_internal_id_is_refused_not_hashed(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])

        with self.assertRaises(MetaLLMConfigError):
            make_llm(factory, internal_id="  ", identifier_salt=SALT)

        self.assertEqual(factory.posts, [])


class RequestPrivacyTests(unittest.TestCase):
    def test_no_caller_value_or_raw_internal_id_reaches_the_request(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory, internal_id=CALL_ID, identifier_salt=SALT)

        drain(llm)

        wire = factory.posts[0]
        artifact = json.dumps(wire["json"]) + json.dumps(wire["headers"])
        for identifying in (CALLER_NAME, CALLER_PHONE, CALLER_EMAIL, CALL_ID, SALT):
            self.assertNotIn(identifying, artifact)
        self.assertNotIn("user", wire["json"])
        self.assertNotIn("user", wire["headers"])

    def test_the_only_identifier_field_is_the_salted_hash(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory, internal_id=CALL_ID, identifier_salt=SALT)

        drain(llm)

        payload = factory.posts[0]["json"]
        self.assertEqual(payload["safety_identifier"], PINNED_IDENTIFIER)
        self.assertNotIn("user", payload)
        self.assertNotEqual(payload["safety_identifier"], CALL_ID)

    def test_the_identifier_is_stable_across_turns_and_retries(self):
        factory = ScriptedSessionFactory(
            [Response(chunks=(b"",)), Response(chunks=(b"",))]
        )
        llm = make_llm(factory, internal_id=CALL_ID, identifier_salt=SALT)

        drain(llm)
        drain(llm)

        self.assertEqual(
            factory.posts[0]["json"]["safety_identifier"],
            factory.posts[1]["json"]["safety_identifier"],
        )
        self.assertEqual(
            factory.posts[0]["json"]["safety_identifier"], PINNED_IDENTIFIER
        )

    def test_the_salt_comes_from_the_environment_when_not_passed(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        with mock.patch.dict(os.environ, {"META_IDENTIFIER_SALT": SALT}):
            llm = make_llm(factory, internal_id=CALL_ID)

        drain(llm)

        self.assertEqual(
            factory.posts[0]["json"]["safety_identifier"], PINNED_IDENTIFIER
        )

    def test_no_identifier_field_exists_without_an_internal_id(self):
        factory = ScriptedSessionFactory([Response(chunks=(b"",))])
        llm = make_llm(factory, identifier_salt=SALT)

        drain(llm)

        payload = factory.posts[0]["json"]
        self.assertNotIn("safety_identifier", payload)
        self.assertNotIn("user", payload)

class PromptCachingTests(unittest.TestCase):
    def test_prompt_caching_is_not_enabled_as_a_latency_default(self):
        payload = build_chat_request(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": "hi"}],
            reasoning_effort="low",
        )

        for key in ("prompt_cache_key", "prompt_cache_retention", "cache", "store"):
            self.assertNotIn(key, payload)

    def test_there_is_no_switch_to_enable_prompt_caching(self):
        """Caching stays a reviewed decision; an unreviewed flag must not exist."""
        with self.assertRaises(TypeError):
            MetaLLM(
                api_key=API_KEY,
                reasoning_effort="low",
                prompt_cache_key="agent-1",
            )


if __name__ == "__main__":
    unittest.main()
