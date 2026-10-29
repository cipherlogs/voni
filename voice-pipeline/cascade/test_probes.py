"""Cheap probes per leg (ticket 20).

A probe proves a leg works while spending nothing meaningful:

* speech: open (the handshake is what ``open`` does), send one silence frame,
  send ``endStream`` and require a normal close (``1000``);
* model: one minimal completion, no tools, bounded by an explicitly supplied
  ``max_completion_tokens`` — there is no default and no invented cap;
* synthesis: open, empty ``Generate`` + ``Flush`` + ``Terminate``, and require
  ``FlushDone`` with ``audio_duration_ms: 0`` then ``Termination``.

Each probe records its latency and its result on the leg's durable record
through ticket 17's transitions, so the breaker's evidence is the same record
every instance reads. Time is the injected ``FakeClock``; no test sleeps and no
vendor exists.
"""

import asyncio
import unittest
from typing import Any

from providers import TokenDelta

from cascade.breaker import (
    Breaker,
    BreakerTransitions,
    BreakerTrigger,
    ProviderBreakerRecord,
    breaker_key,
)
from cascade.probes import (
    MODEL_PROBE_PROMPT,
    ProbeRequest,
    model_probe,
    model_probe_cap,
    probe_model,
    probe_speech,
    probe_voice,
    silence_frame,
    speech_probe,
    voice_probe,
)
from cascade.store import MemoryStore, StoredDocument
from cascade.testing.clock import FakeClock
from cascade.thresholds import UnsetBoundError, require_bound

INTERVAL_S = 30.0
CAP = 64


def run(coro):
    return asyncio.run(coro)


class FakeSpeechTarget:
    """A speech session that records what the probe sent and how it closed."""

    def __init__(
        self,
        clock: FakeClock,
        *,
        open_ms: float = 120.0,
        close_ms: float = 40.0,
        close_code: int | None = 1000,
        open_error: BaseException | None = None,
    ) -> None:
        self.clock = clock
        self.open_ms = open_ms
        self.close_ms = close_ms
        self.close_code = close_code
        self.open_error = open_error
        self.ops: list[tuple[Any, ...]] = []

    async def open(self, *, language_codes, sample_rate) -> None:
        self.ops.append(("open", tuple(language_codes), sample_rate))
        self.clock.advance_ms(self.open_ms)
        if self.open_error is not None:
            raise self.open_error

    async def send_audio(self, pcm: bytes) -> None:
        self.ops.append(("send_audio", pcm))

    async def end_stream(self) -> int | None:
        self.ops.append(("end_stream",))
        self.clock.advance_ms(self.close_ms)
        return self.close_code

    async def close(self) -> None:
        self.ops.append(("close",))


class FakeModelTarget:
    """A chat target that records each probe request and streams a reply."""

    def __init__(
        self,
        clock: FakeClock,
        *,
        deltas: tuple[str, ...] = ("ok",),
        latency_ms: float = 300.0,
        error: BaseException | None = None,
    ) -> None:
        self.clock = clock
        self.deltas = deltas
        self.latency_ms = latency_ms
        self.error = error
        self.requests: list[ProbeRequest] = []

    async def probe(self, request: ProbeRequest):
        self.requests.append(request)
        self.clock.advance_ms(self.latency_ms)
        if self.error is not None:
            raise self.error
        for text in self.deltas:
            yield TokenDelta(text=text)


class FakeVoiceTarget:
    """A synthesis session that records frames and replays the closing frames."""

    def __init__(
        self,
        clock: FakeClock,
        *,
        frames: tuple[dict[str, Any], ...] = (
            {"type": "FlushDone", "audio_duration_ms": 0},
            {"type": "Termination", "total_input_char_length": 0},
        ),
        latency_ms: float = 80.0,
        error: BaseException | None = None,
    ) -> None:
        self.clock = clock
        self.frames = frames
        self.latency_ms = latency_ms
        self.error = error
        self.ops: list[tuple[Any, ...]] = []

    async def open(self) -> None:
        self.ops.append(("open",))
        self.clock.advance_ms(self.latency_ms)

    async def generate(self, text: str) -> None:
        self.ops.append(("generate", text))

    async def flush(self) -> None:
        self.ops.append(("flush",))

    async def terminate(self) -> None:
        self.ops.append(("terminate",))

    def events(self):
        async def replay():
            if self.error is not None:
                raise self.error
            for frame in self.frames:
                yield frame

        return replay()


def half_open(leg: str, provider: str, **changes) -> ProviderBreakerRecord:
    fields = {
        "leg": leg,
        "provider": provider,
        "state": "half_open",
        "opened_at": 0.0,
        "last_failure_at": 0.0,
        "trigger": BreakerTrigger(kind="failure", code=1013, phase="stream"),
        "reason": f"{leg} failure opened the leg",
    }
    fields.update(changes)
    return ProviderBreakerRecord(**fields)


def harness(record: ProviderBreakerRecord):
    clock = FakeClock(0.0)
    store = MemoryStore(
        {
            breaker_key(record.leg): StoredDocument(
                version=record.record_version, document=record.to_document()
            )
        }
    )
    breaker = Breaker(store, probe_interval_s=INTERVAL_S, now=clock)
    return BreakerTransitions(breaker), breaker, store, clock


class SpeechProbeTest(unittest.TestCase):
    def test_the_probe_opens_sends_silence_end_stream_and_requires_a_normal_close(self):
        clock = FakeClock()
        target = FakeSpeechTarget(clock)

        result = run(
            speech_probe(target, clock=clock, language_codes=["es"], sample_rate=24000)
        )

        kinds = [op[0] for op in target.ops]
        self.assertEqual(kinds, ["open", "send_audio", "end_stream", "close"])
        self.assertEqual(target.ops[0][1], ("es",))
        self.assertEqual(target.ops[0][2], 24000)
        pcm = target.ops[1][1]
        self.assertEqual(pcm, silence_frame(24000))
        self.assertGreater(len(pcm), 0)
        self.assertEqual(set(pcm), {0})
        self.assertTrue(result.ok)
        self.assertEqual(result.close_code, 1000)
        self.assertEqual(result.latency_ms, 160.0)

    def test_an_abnormal_close_fails_the_probe_and_classifies_the_code(self):
        clock = FakeClock()
        target = FakeSpeechTarget(clock, close_code=1011)

        result = run(speech_probe(target, clock=clock, language_codes=["en"]))

        self.assertFalse(result.ok)
        self.assertIn("1011", result.detail)
        self.assertEqual(result.verdict.code, 1011)
        self.assertTrue(result.verdict.opens_breaker)

    def test_a_probe_that_cannot_open_names_the_failure(self):
        clock = FakeClock()
        target = FakeSpeechTarget(clock, open_error=TimeoutError("handshake timed out"))

        result = run(speech_probe(target, clock=clock, language_codes=["en"]))

        self.assertFalse(result.ok)
        self.assertIn("handshake timed out", result.detail)
        self.assertTrue(result.verdict.opens_breaker)


class ModelProbeTest(unittest.TestCase):
    def test_the_probe_is_one_completion_with_no_tools_and_the_supplied_cap(self):
        clock = FakeClock()
        target = FakeModelTarget(clock, deltas=("k", "ing"))

        result = run(model_probe(target, clock=clock, max_completion_tokens=CAP))

        self.assertEqual(len(target.requests), 1)
        request = target.requests[0]
        self.assertIsNone(request.tools)
        self.assertNotIn("tools", request.to_document())
        self.assertEqual(request.max_completion_tokens, CAP)
        self.assertEqual(len(request.messages), 1)
        self.assertEqual(request.messages[0]["content"], MODEL_PROBE_PROMPT)
        self.assertTrue(result.ok)
        self.assertEqual(result.latency_ms, 300.0)
        self.assertEqual(result.max_tokens, CAP)
        self.assertEqual(result.tokens, 2)
        self.assertLessEqual(len(MODEL_PROBE_PROMPT), CAP)

    def test_the_cap_has_no_default_and_an_unset_bound_raises_by_name(self):
        from dataclasses import replace

        from cascade import thresholds

        declared = thresholds.bound("probe.model_max_completion_tokens")
        self.assertEqual(declared.ticket, "20")
        original = thresholds.REGISTRY
        try:
            thresholds.REGISTRY = thresholds.Registry(
                {
                    entry.name: (
                        replace(entry, value=None, source="", date="")
                        if entry.name == "probe.model_max_completion_tokens"
                        else entry
                    )
                    for entry in original.bounds()
                }
            )
            with self.assertRaises(UnsetBoundError) as unset:
                model_probe_cap()
        finally:
            thresholds.REGISTRY = original
        self.assertIn("probe.model_max_completion_tokens", str(unset.exception))
        with self.assertRaises(TypeError):
            run(model_probe(FakeModelTarget(FakeClock()), clock=FakeClock()))  # type: ignore[call-arg]

    def test_a_status_failure_classifies_the_status_and_fails_the_probe(self):
        clock = FakeClock()
        error = RuntimeError("rate limited")
        error.status = 429  # type: ignore[attr-defined]
        target = FakeModelTarget(clock, error=error)

        result = run(model_probe(target, clock=clock, max_completion_tokens=CAP))

        self.assertFalse(result.ok)
        self.assertEqual(result.verdict.code, 429)
        self.assertTrue(result.verdict.opens_breaker)

    def test_a_completion_that_returns_nothing_has_not_proved_the_leg(self):
        clock = FakeClock()
        target = FakeModelTarget(clock, deltas=())

        result = run(model_probe(target, clock=clock, max_completion_tokens=CAP))

        self.assertFalse(result.ok)
        self.assertIn("no content", result.detail)


class VoiceProbeTest(unittest.TestCase):
    def test_the_probe_sends_empty_generate_flush_terminate_and_requires_flush_and_end(self):
        clock = FakeClock()
        target = FakeVoiceTarget(clock)

        result = run(voice_probe(target, clock=clock))

        self.assertEqual(
            target.ops,
            [("open",), ("generate", ""), ("flush",), ("terminate",)],
        )
        self.assertTrue(result.ok)
        self.assertEqual(result.chars, 0)
        self.assertLessEqual(result.chars, int(require_bound("tts.generate_char_cap")))
        self.assertEqual(result.latency_ms, 80.0)

    def test_a_non_zero_flush_duration_fails_the_probe(self):
        clock = FakeClock()
        target = FakeVoiceTarget(
            clock,
            frames=(
                {"type": "FlushDone", "audio_duration_ms": 40},
                {"type": "Termination", "total_input_char_length": 0},
            ),
        )

        result = run(voice_probe(target, clock=clock))

        self.assertFalse(result.ok)
        self.assertIn("audio_duration_ms", result.detail)

    def test_a_missing_flush_done_or_termination_fails_the_probe(self):
        for frames in (
            ({"type": "Termination"},),
            ({"type": "FlushDone", "audio_duration_ms": 0},),
        ):
            clock = FakeClock()
            result = run(voice_probe(FakeVoiceTarget(clock, frames=frames), clock=clock))
            self.assertFalse(result.ok, frames)
            self.assertTrue(result.verdict.opens_breaker, frames)


class ProbeRecordsOnTheLegTest(unittest.TestCase):
    def test_a_speech_probe_success_records_its_latency_on_the_stt_record(self):
        transitions, breaker, _, clock = harness(half_open("stt", "assemblyai"))
        target = FakeSpeechTarget(clock)

        outcome = run(
            probe_speech(transitions, target=target, clock=clock, language_codes=["en"])
        )

        self.assertTrue(outcome.written)
        record = run(breaker.read("stt"))
        self.assertEqual(len(record.probe_successes), 1)
        self.assertEqual(record.probe_successes[0].latency_ms, 160.0)
        self.assertEqual(record.probe_successes[0].at, clock())
        self.assertEqual(record.trigger.kind, "probe_success")
        self.assertEqual(record.state, "half_open")

    def test_a_speech_probe_failure_reopens_the_leg_with_the_probe_trigger(self):
        transitions, breaker, _, clock = harness(half_open("stt", "assemblyai"))
        target = FakeSpeechTarget(clock, close_code=1013)

        outcome = run(
            probe_speech(transitions, target=target, clock=clock, language_codes=["en"])
        )

        self.assertTrue(outcome.written)
        record = run(breaker.read("stt"))
        self.assertEqual(record.state, "open")
        self.assertEqual(record.trigger.kind, "probe_failure")
        self.assertEqual(record.trigger.code, 1013)

    def test_a_model_probe_records_on_the_llm_record_only(self):
        transitions, breaker, store, clock = harness(half_open("llm", "spark"))
        target = FakeModelTarget(clock)

        outcome = run(
            probe_model(transitions, target=target, clock=clock, max_completion_tokens=CAP)
        )

        self.assertTrue(outcome.written)
        record = run(breaker.read("llm"))
        self.assertEqual(record.probe_successes[-1].latency_ms, 300.0)
        self.assertNotIn(breaker_key("stt"), store.rows)

    def test_a_voice_probe_records_on_the_tts_record_only(self):
        transitions, breaker, store, clock = harness(half_open("tts", "assemblyai"))
        target = FakeVoiceTarget(clock)

        outcome = run(probe_voice(transitions, target=target, clock=clock))

        self.assertTrue(outcome.written)
        record = run(breaker.read("tts"))
        self.assertEqual(record.probe_successes[-1].latency_ms, 80.0)
        self.assertNotIn(breaker_key("llm"), store.rows)

    def test_a_failed_write_still_reports_the_probe_result(self):
        transitions, breaker, store, clock = harness(half_open("stt", "assemblyai"))
        store.fail_writes = True
        target = FakeSpeechTarget(clock)

        outcome = run(
            probe_speech(transitions, target=target, clock=clock, language_codes=["en"])
        )

        self.assertFalse(outcome.written)
        self.assertTrue(outcome.result.ok)
        self.assertIn("write failed", outcome.error)
        self.assertEqual(run(breaker.read("stt")).probe_successes, ())


if __name__ == "__main__":
    unittest.main()
