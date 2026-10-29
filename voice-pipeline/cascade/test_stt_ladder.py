"""The speech ladder: Meta, then AssemblyAI, then fail visibly (ticket 22).

The durable record selects the speech rung before the first frame. A speech
failure never changes the model rung, and the rung actually used is carried
into turn attribution. The provider factories are the only place a socket can
be created, so "zero requests to Meta" is proved by the Meta factory never
being called.
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
    STT_LADDER,
    CallRungs,
    Ladder,
    LegFailed,
    open_speech,
    read_choices,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock

INTERVAL_S = 30.0
MODEL_LADDER = Ladder(leg="llm", primary="spark", fallback="gateway")


def run(coro):
    return asyncio.run(coro)


class FakeSTT:
    """A StreamingSTT stand-in; the ladder only constructs it."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.opened = False

    async def open(self, *, language_codes, sample_rate) -> None:
        self.opened = True

    async def send_audio(self, pcm: bytes) -> None:
        return None

    async def events(self):
        return
        yield  # pragma: no cover - keeps this an async generator

    async def close(self) -> None:
        return None


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
        "trigger": BreakerTrigger(kind="failure", code=1013, phase="stream"),
        "reason": f"{leg} 1013 rate limited",
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
    def __init__(self, providers=("meta", "assemblyai")):
        self.calls: list[str] = []
        self.sessions: dict[str, FakeSTT] = {}
        self.providers = providers

    def factories(self):
        return {provider: self._factory(provider) for provider in self.providers}

    def _factory(self, provider):
        def make() -> FakeSTT:
            self.calls.append(provider)
            session = FakeSTT(provider)
            self.sessions[provider] = session
            return session

        return make


class SpeechLadderTest(unittest.TestCase):
    def test_an_open_speech_leg_makes_zero_meta_requests_and_uses_assemblyai(self):
        _, breaker, _, _ = harness(
            open_leg("stt", "assemblyai"), closed("llm", "spark")
        )
        factories = CountingFactories()

        session = run(open_speech(breaker, factories=factories.factories()))

        self.assertEqual(factories.calls, ["assemblyai"])
        self.assertNotIn("meta", factories.sessions)
        self.assertEqual(session.stt.provider, "assemblyai")
        self.assertEqual(session.attribution.provider, "assemblyai")
        self.assertEqual(session.attribution.rung, "fallback")
        self.assertEqual(session.attribution.leg, "stt")
        self.assertIn("open", session.attribution.reason)

    def test_a_closed_speech_leg_uses_meta(self):
        _, breaker, _, _ = harness(closed("stt", "meta"), closed("llm", "spark"))
        factories = CountingFactories()

        session = run(open_speech(breaker, factories=factories.factories()))

        self.assertEqual(factories.calls, ["meta"])
        self.assertEqual(session.attribution.provider, "meta")
        self.assertEqual(session.attribution.rung, "primary")

    def test_the_record_decides_every_call_and_there_is_no_cache(self):
        transitions, breaker, _, _ = harness(
            closed("stt", "meta"), closed("llm", "spark")
        )
        first = CountingFactories()
        self.assertEqual(
            run(open_speech(breaker, factories=first.factories())).attribution.provider,
            "meta",
        )

        run(
            transitions.record_failure(
                "stt", verdict=classify("stt", 1013), phase="stream"
            )
        )

        second = CountingFactories()
        self.assertEqual(
            run(open_speech(breaker, factories=second.factories())).attribution.provider,
            "assemblyai",
        )
        self.assertEqual(second.calls, ["assemblyai"])

    def test_a_fallback_rung_that_cannot_be_built_fails_the_call_visibly(self):
        _, breaker, _, _ = harness(open_leg("stt", "assemblyai"), closed("llm", "spark"))
        factories = CountingFactories(providers=("meta",))

        with self.assertRaises(LegFailed) as failed:
            run(open_speech(breaker, factories=factories.factories()))

        self.assertEqual(failed.exception.leg, "stt")
        self.assertIn("assemblyai", str(failed.exception))
        self.assertIn("no factory", str(failed.exception))

    def test_a_factory_that_raises_fails_the_call_visibly_and_never_tries_the_other(self):
        _, breaker, _, _ = harness(open_leg("stt", "assemblyai"), closed("llm", "spark"))
        calls = []

        def broken() -> FakeSTT:
            calls.append("assemblyai")
            raise RuntimeError("assemblyai handshake refused")

        meta_calls = []

        def meta() -> FakeSTT:
            meta_calls.append("meta")
            return FakeSTT("meta")

        with self.assertRaises(LegFailed) as failed:
            run(open_speech(breaker, factories={"assemblyai": broken, "meta": meta}))

        self.assertEqual(calls, ["assemblyai"])
        self.assertEqual(meta_calls, [])  # never a mid-call handover
        self.assertIn("assemblyai handshake refused", str(failed.exception))

    def test_an_unreadable_speech_record_refuses_the_call(self):
        _, breaker, store, _ = harness(closed("stt", "meta"), closed("llm", "spark"))
        store.fail_reads = True
        factories = CountingFactories()

        with self.assertRaises(Exception) as refused:
            run(open_speech(breaker, factories=factories.factories()))

        self.assertEqual(factories.calls, [])
        self.assertIn("stt", str(refused.exception))

    def test_the_attribution_document_names_the_rung_actually_used(self):
        _, breaker, _, _ = harness(open_leg("stt", "assemblyai"), closed("llm", "spark"))

        session = run(open_speech(breaker, factories=CountingFactories().factories()))

        self.assertEqual(
            set(session.attribution.to_document()),
            {"leg", "provider", "rung", "reason"},
        )
        self.assertEqual(session.attribution.to_document()["provider"], "assemblyai")


class LegDecouplingTest(unittest.TestCase):
    def test_a_speech_failure_never_changes_the_model_rung(self):
        transitions, breaker, store, _ = harness(
            closed("stt", "meta"), closed("llm", "spark")
        )
        call = CallRungs(
            run(read_choices(breaker, ladders=(STT_LADDER, MODEL_LADDER))),
            transitions=transitions,
        )
        self.assertEqual(call.rung("llm").provider, "spark")

        run(
            call.failed("stt", verdict=classify("stt", 1013), phase="stream", turn=1)
        )

        self.assertEqual(call.rung("llm").provider, "spark")
        llm_record = run(breaker.read("llm"))
        self.assertEqual(llm_record.state, "closed")
        self.assertEqual(llm_record.record_version, 1)
        next_call = run(read_choices(breaker, ladders=(STT_LADDER, MODEL_LADDER)))
        self.assertEqual(next_call["llm"].rung, "primary")
        self.assertEqual(next_call["stt"].rung, "fallback")

    def test_the_speech_ladder_is_meta_then_assemblyai(self):
        self.assertEqual(STT_LADDER.primary, "meta")
        self.assertEqual(STT_LADDER.fallback, "assemblyai")
        self.assertEqual(STT_LADDER.leg, "stt")


if __name__ == "__main__":
    unittest.main()
