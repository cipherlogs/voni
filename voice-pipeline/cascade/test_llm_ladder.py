"""The model ladder: Spark, then the gateway, then fail visibly (ticket 23).

The durable record selects the model rung before the first frame. An open Spark
leg costs zero Spark requests and the gateway model answers; a speech failure
never demotes a healthy model; and the rung actually used is carried into turn
attribution.
"""

import asyncio
import unittest

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.failures import classify
from cascade.ladders import (
    LLM_LADDER,
    STT_LADDER,
    CallRungs,
    LegFailed,
    open_model,
    read_choices,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock

INTERVAL_S = 30.0


def run(coro):
    return asyncio.run(coro)


class FakeLLM:
    """An LLMStream stand-in; the ladder only constructs it."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.requests = 0

    def prefetch(self, *, messages):
        raise AssertionError("a ladder never prefetches")

    async def complete(self, *, messages, tools=None):
        self.requests += 1
        return
        yield  # pragma: no cover - keeps this an async generator


def closed(leg, provider, **changes):
    fields = {"leg": leg, "provider": provider, "state": "closed"}
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def open_leg(leg, provider, **changes):
    fields = {
        "leg": leg,
        "provider": provider,
        "state": "open",
        "opened_at": 0.0,
        "last_failure_at": 0.0,
        "trigger": BreakerTrigger(kind="failure", code=503, phase="turn"),
        "reason": f"{leg} 503 server error",
    }
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def harness(*records):
    clock = FakeClock(0.0)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
            for record in records
        }
    )
    breaker = Breaker(store, probe_interval_s=INTERVAL_S, now=clock)
    return BreakerTransitions(breaker), breaker, store, clock


class CountingFactories:
    def __init__(self, providers=("spark", "gateway")):
        self.calls: list[str] = []
        self.sessions: dict[str, FakeLLM] = {}
        self.providers = providers

    def factories(self):
        return {provider: self._factory(provider) for provider in self.providers}

    def _factory(self, provider):
        def make() -> FakeLLM:
            self.calls.append(provider)
            session = FakeLLM(provider)
            self.sessions[provider] = session
            return session

        return make


class ModelLadderTest(unittest.TestCase):
    def test_an_open_spark_leg_makes_zero_spark_requests_and_uses_the_gateway(self):
        _, breaker, _, _ = harness(open_leg("llm", "gateway"), closed("stt", "meta"))
        factories = CountingFactories()

        session = run(open_model(breaker, factories=factories.factories()))

        self.assertEqual(factories.calls, ["gateway"])
        self.assertNotIn("spark", factories.sessions)
        self.assertEqual(session.llm.provider, "gateway")
        self.assertEqual(session.llm.requests, 0)  # built, not called
        self.assertEqual(session.attribution.provider, "gateway")
        self.assertEqual(session.attribution.rung, "fallback")
        self.assertEqual(session.attribution.leg, "llm")

    def test_a_closed_model_leg_uses_spark(self):
        _, breaker, _, _ = harness(closed("llm", "spark"), closed("stt", "meta"))
        factories = CountingFactories()

        session = run(open_model(breaker, factories=factories.factories()))

        self.assertEqual(factories.calls, ["spark"])
        self.assertEqual(session.attribution.provider, "spark")
        self.assertEqual(session.attribution.rung, "primary")

    def test_the_record_decides_every_call_and_there_is_no_cache(self):
        transitions, breaker, _, _ = harness(
            closed("llm", "spark"), closed("stt", "meta")
        )
        self.assertEqual(
            run(open_model(breaker, factories=CountingFactories().factories()))
            .attribution.provider,
            "spark",
        )

        run(
            transitions.record_failure(
                "llm", verdict=classify("llm", 503), phase="turn"
            )
        )

        second = CountingFactories()
        self.assertEqual(
            run(open_model(breaker, factories=second.factories())).attribution.provider,
            "gateway",
        )
        self.assertEqual(second.calls, ["gateway"])

    def test_a_gateway_that_cannot_be_built_fails_the_call_visibly(self):
        _, breaker, _, _ = harness(open_leg("llm", "gateway"), closed("stt", "meta"))

        with self.assertRaises(LegFailed) as failed:
            run(open_model(breaker, factories=CountingFactories(providers=("spark",)).factories()))

        self.assertEqual(failed.exception.leg, "llm")
        self.assertIn("gateway", str(failed.exception))
        self.assertIn("no factory", str(failed.exception))

    def test_the_attribution_document_names_the_rung_actually_used(self):
        _, breaker, _, _ = harness(open_leg("llm", "gateway"), closed("stt", "meta"))

        session = run(open_model(breaker, factories=CountingFactories().factories()))

        self.assertEqual(
            session.attribution.to_document()["provider"], "gateway"
        )
        self.assertEqual(session.attribution.to_document()["leg"], "llm")
        self.assertEqual(session.attribution.to_document()["rung"], "fallback")


class ModelLegDecouplingTest(unittest.TestCase):
    def test_a_speech_failure_never_demotes_a_healthy_model(self):
        transitions, breaker, _, _ = harness(
            closed("llm", "spark"), closed("stt", "meta")
        )
        call = CallRungs(
            run(read_choices(breaker, ladders=(STT_LADDER, LLM_LADDER))),
            transitions=transitions,
        )

        run(call.failed("stt", verdict=classify("stt", 1013), phase="stream", turn=2))

        self.assertEqual(call.rung("llm").provider, "spark")
        self.assertEqual(run(breaker.read("llm")).state, "closed")
        next_call = CountingFactories()
        self.assertEqual(
            run(open_model(breaker, factories=next_call.factories())).attribution.provider,
            "spark",
        )

    def test_a_model_failure_never_demotes_the_speech_leg(self):
        transitions, breaker, _, _ = harness(
            closed("llm", "spark"), closed("stt", "meta")
        )
        call = CallRungs(
            run(read_choices(breaker, ladders=(STT_LADDER, LLM_LADDER))),
            transitions=transitions,
        )

        run(call.failed("llm", verdict=classify("llm", 429), phase="turn", turn=3))

        self.assertEqual(run(breaker.read("stt")).state, "closed")
        self.assertEqual(call.rung("stt").rung, "primary")

    def test_the_model_ladder_is_spark_then_the_gateway(self):
        self.assertEqual(LLM_LADDER.primary, "spark")
        self.assertEqual(LLM_LADDER.fallback, "gateway")
        self.assertEqual(LLM_LADDER.leg, "llm")


if __name__ == "__main__":
    unittest.main()
