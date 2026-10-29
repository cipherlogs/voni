"""Proof tests for the shared determinism kit (ticket 01).

This module is the kit's own contract. Every later provider, orchestrator,
breaker and money test imports ``cascade.testing`` instead of sleeping,
touching the network, or reading the wall clock.
"""

import asyncio
import base64
import json
import time
import unittest
from collections.abc import AsyncIterator

from backends.assemblyai_stt import AssemblyAIStreamingSTT
from backends.cartesia_tts import CartesiaTTS
from backends.gateway_llm import GatewayLLM
from orchestrator import TurnOrchestrator
from providers import (
    FinalTranscript,
    LLMStream,
    PartialTranscript,
    SentenceAudio,
    StreamingSTT,
    StreamingTTS,
    TokenDelta,
)

from cascade.testing.clock import (
    FakeClock,
    FrozenClock,
    RealClock,
    VirtualTimeout,
    run_with_deadline,
)
from cascade.testing.scripted import ScriptedLLM, ScriptedSTT, ScriptedTTS, Step
from cascade.testing.socket_factory import (
    Frame,
    Response,
    ScriptedSessionFactory,
    ScriptedSocketClosed,
    ScriptedSocketFactory,
)


def frames(*chunks: bytes) -> AsyncIterator[bytes]:
    async def generate() -> AsyncIterator[bytes]:
        for chunk in chunks:
            yield chunk

    return generate()


class FakeClockTests(unittest.TestCase):
    def test_clock_advances_only_when_the_test_advances_it(self):
        clock = FakeClock()

        async def idle():
            await clock.sleep(0.0)
            await clock.sleep(0.0)

        start = clock()
        asyncio.run(idle())
        self.assertEqual(clock(), start)
        self.assertEqual(clock.now(), start)
        clock.advance(2.5)
        self.assertAlmostEqual(clock.elapsed, 2.5)
        clock.advance_ms(250)
        self.assertAlmostEqual(clock.elapsed, 2.75)

    def test_clock_refuses_to_move_backwards(self):
        clock = FakeClock()
        with self.assertRaises(ValueError):
            clock.advance(-0.001)

    def test_deadline_fires_when_virtual_time_crosses_it(self):
        clock = FakeClock()

        async def slow():
            await clock.sleep(30.0)
            return "done"

        with self.assertRaises(VirtualTimeout):
            asyncio.run(run_with_deadline(slow(), clock=clock, timeout_s=5.0))

    def test_frozen_clock_never_fires_the_deadline(self):
        """AC4's red case: the deadline is driven by the injected clock.

        A timeout wrapped *around* the code path (asyncio.wait_for, a wall
        clock read) would still fire here. The kit's deadline only fires when
        the injected clock advances, so the same timeout expectation under a
        non-advancing clock fails.
        """
        clock = FrozenClock()

        async def slow():
            await clock.sleep(30.0)
            return "done"

        result = asyncio.run(run_with_deadline(slow(), clock=clock, timeout_s=5.0))
        self.assertEqual(result, "done")

    def test_real_clock_is_a_monotonic_adapter_that_cannot_be_advanced(self):
        clock = RealClock()
        self.assertGreaterEqual(clock.now(), 0.0)
        with self.assertRaises(RuntimeError):
            clock.advance(1.0)


class ScriptedProviderTests(unittest.TestCase):
    def test_scripted_trace_runs_a_full_turn_without_wall_time(self):
        async def run():
            clock = FakeClock()
            stt = ScriptedSTT(
                [
                    Step(PartialTranscript(text="what"), delay_ms=4000),
                    Step(FinalTranscript(text="what time is it"), delay_ms=4000),
                ],
                clock=clock,
            )
            llm = ScriptedLLM(
                [
                    [
                        Step(TokenDelta(text="It is "), delay_ms=3000),
                        Step(TokenDelta(text="noon."), delay_ms=1000),
                    ]
                ],
                clock=clock,
            )
            tts = ScriptedTTS(clock=clock)
            audio: list[SentenceAudio] = []

            async def on_audio(chunk: SentenceAudio) -> None:
                audio.append(chunk)

            orch = TurnOrchestrator(
                stt=stt,
                llm=llm,
                tts=tts,
                on_audio=on_audio,
                clock=clock,
                scorer=lambda text, ms: 0.0,
                tool_gate=lambda name: (True, 0.5),
            )
            wall_start = time.monotonic()
            results = await orch.run(frames(b"\x00" * 320))
            wall = time.monotonic() - wall_start
            return clock, results, audio, orch.ledger.summary()["gaps_ms"], wall

        clock, results, audio, gaps, wall = asyncio.run(run())
        self.assertEqual([r.reply_text for r in results], ["It is noon."])
        self.assertEqual(b"".join(chunk.pcm for chunk in audio), b"It is noon.")
        # Twelve seconds of scripted call happened; none of it was waited on.
        self.assertAlmostEqual(clock.elapsed, 12.0, places=6)
        self.assertLess(wall, 2.0)
        # The ledger reads the same injected clock, so the gaps are the
        # scripted delays, not a scheduling accident.
        self.assertAlmostEqual(gaps["final_to_first_token"], 3000.0, places=6)
        # The reply is one sentence, so the producer only queues it once the
        # final token lands: both scripted token delays show up here.
        self.assertAlmostEqual(gaps["final_to_first_playout"], 4000.0, places=6)

    def test_scripted_fakes_implement_the_provider_contracts(self):
        self.assertIsInstance(ScriptedSTT(), StreamingSTT)
        self.assertIsInstance(ScriptedLLM([]), LLMStream)
        self.assertIsInstance(ScriptedTTS(), StreamingTTS)

    def test_scripted_delay_drives_the_deadline(self):
        clock = FakeClock()
        llm = ScriptedLLM(
            [[Step(TokenDelta(text="late"), delay_ms=30_000)]], clock=clock
        )

        async def consume():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}]
                )
            ]

        with self.assertRaises(VirtualTimeout):
            asyncio.run(run_with_deadline(consume(), clock=clock, timeout_s=5.0))

    def test_frozen_clock_keeps_the_scripted_timeout_from_firing(self):
        # AC4: the same scripted timeout, on a clock that never advances.
        # Nothing raises, so a test expecting a timeout fails here.
        clock = FrozenClock()
        llm = ScriptedLLM(
            [[Step(TokenDelta(text="late"), delay_ms=30_000)]], clock=clock
        )

        async def consume():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}]
                )
            ]

        events = asyncio.run(run_with_deadline(consume(), clock=clock, timeout_s=5.0))
        self.assertEqual([event.text for event in events], ["late"])

    def test_scripted_failure_step_raises_at_its_position(self):
        stt = ScriptedSTT(
            [
                Step(PartialTranscript(text="hi")),
                Step(exc=RuntimeError("provider 500")),
            ]
        )

        async def consume():
            seen = []
            with self.assertRaises(RuntimeError):
                async for event in stt.events():
                    seen.append(event)
            return seen

        self.assertEqual(asyncio.run(consume()), [PartialTranscript(text="hi")])

    def test_scripted_llm_records_requests_and_prefetch_cancellation(self):
        llm = ScriptedLLM([[TokenDelta(text="ok")]])

        async def consume():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}],
                    tools=[{"name": "end_call"}],
                )
            ]

        events = asyncio.run(consume())
        self.assertEqual([event.text for event in events], ["ok"])
        self.assertEqual(llm.requests[0]["tools"], [{"name": "end_call"}])

        handle = llm.prefetch(messages=[{"role": "user", "content": "hi"}])
        handle.cancel()
        self.assertTrue(handle.cancelled)
        self.assertEqual(len(llm.prefetches), 1)

    def test_scripted_tts_defaults_one_chunk_per_sentence_and_records_text(self):
        tts = ScriptedTTS()

        async def consume():
            return [chunk async for chunk in tts.speak("Hello there.")]

        chunks = asyncio.run(consume())
        self.assertEqual([chunk.text for chunk in chunks], ["Hello there."])
        self.assertEqual(tts.spoken, ["Hello there."])


class SocketFactoryTests(unittest.TestCase):
    """One factory, two plans: a recorded fixture and a fault script."""

    def _replay(self, app):
        async def run():
            await app.open(language_codes=["en"], sample_rate=24000)
            seen = [event async for event in app.events()]
            await app.close()
            return seen

        return asyncio.run(run())

    def test_replayed_fixture_drives_the_real_stt_client(self):
        clock = FakeClock()
        begin = json.dumps({"type": "Begin", "id": "s1"})
        partial = json.dumps(
            {"type": "Turn", "transcript": "what", "end_of_turn": False}
        )
        final = json.dumps(
            {"type": "Turn", "transcript": "what time is it", "end_of_turn": True}
        )
        termination = json.dumps({"type": "Termination"})
        factory = ScriptedSocketFactory(
            [Frame(begin), Frame(partial), Frame(final), Frame(termination)],
            clock=clock,
        )
        app = AssemblyAIStreamingSTT(api_key="k", socket_factory=factory)

        events = self._replay(app)

        self.assertEqual(
            events,
            [
                PartialTranscript(text="what"),
                FinalTranscript(text="what time is it"),
            ],
        )
        record = factory.connections[0]
        self.assertIn("streaming.assemblyai.com", record["url"])
        self.assertEqual(record["headers"], {"Authorization": "k"})
        self.assertIn('"Terminate"', factory.socket.sent[-1])
        self.assertTrue(factory.socket.closed)
        self.assertEqual(clock.elapsed, 0.0)

    def test_fault_script_adds_delay_duplication_and_close_code(self):
        clock = FakeClock()
        begin = json.dumps({"type": "Begin", "id": "s1"})
        partial = json.dumps(
            {"type": "Turn", "transcript": "what", "end_of_turn": False}
        )
        factory = ScriptedSocketFactory(
            [
                Frame(begin),
                Frame(partial, delay_ms=2500),
                Frame(partial, repeat=2),
                Frame(close_code=1011, reason="internal"),
            ],
            clock=clock,
        )
        app = AssemblyAIStreamingSTT(api_key="k", socket_factory=factory)

        async def run():
            await app.open(language_codes=["en"], sample_rate=24000)
            seen = []
            with self.assertRaises(ScriptedSocketClosed) as caught:
                async for event in app.events():
                    seen.append(event)
            await app.close()
            return seen, caught.exception

        seen, error = asyncio.run(run())
        # Duplicate frames reach the client unchanged: de-duplication is the
        # consumer's decision, not the transport's.
        self.assertEqual(seen, [PartialTranscript(text="what")] * 3)
        self.assertEqual(error.code, 1011)
        self.assertAlmostEqual(clock.elapsed, 2.5)

    def test_frame_requires_exactly_one_payload_or_fault(self):
        with self.assertRaises(ValueError):
            Frame()
        with self.assertRaises(ValueError):
            Frame(b"x", close_code=1011)
        with self.assertRaises(ValueError):
            Frame(b"x", repeat=0)

    def test_delay_without_an_injected_clock_fails_by_name(self):
        factory = ScriptedSocketFactory([Frame(b"x", delay_ms=10)])

        async def run():
            socket = await factory("wss://example.invalid", {})
            return [frame async for frame in socket]

        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(run())
        self.assertIn("injected clock", str(caught.exception))


class SessionFactoryTests(unittest.TestCase):
    def test_replayed_sse_completes_through_the_real_llm_client(self):
        factory = ScriptedSessionFactory(
            [
                Response(
                    chunks=(
                        b'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
                        b'data: {"choices":[{"delta":{"content":"there."}}]}\n\n',
                        b"data: [DONE]\n\n",
                    )
                )
            ]
        )
        llm = GatewayLLM(api_key="k", model="m", session_factory=factory)

        async def run():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}]
                )
            ]

        events = asyncio.run(run())
        self.assertEqual("".join(event.text for event in events), "Hi there.")
        self.assertEqual(factory.posts[0]["headers"]["authorization"], "Bearer k")
        self.assertGreater(factory.sessions[0]["timeout_s"], 0)

    def test_error_status_and_body_are_scriptable(self):
        factory = ScriptedSessionFactory([Response(status=429, body=b"slow down")])
        llm = GatewayLLM(api_key="k", model="m", session_factory=factory)

        async def run():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}]
                )
            ]

        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(run())
        self.assertIn("429", str(caught.exception))

    def test_delayed_response_trips_the_injected_deadline(self):
        clock = FakeClock()
        factory = ScriptedSessionFactory(
            [Response(chunks=(b"data: [DONE]\n\n",), delay_ms=30_000)], clock=clock
        )
        llm = GatewayLLM(api_key="k", model="m", session_factory=factory)

        async def run():
            return [
                event
                async for event in llm.complete(
                    messages=[{"role": "user", "content": "hi"}]
                )
            ]

        with self.assertRaises(VirtualTimeout):
            asyncio.run(run_with_deadline(run(), clock=clock, timeout_s=5.0))
        self.assertAlmostEqual(clock.elapsed, 30.0)

    def test_one_factory_serves_concurrent_tts_sentences_in_order(self):
        audio_a = base64.b64encode(b"\x01" * 32).decode()
        audio_b = base64.b64encode(b"\x02" * 32).decode()
        factory = ScriptedSessionFactory(
            [
                Response(
                    chunks=(
                        (
                            "data: "
                            + json.dumps({"type": "chunk", "data": audio_a})
                            + "\n\n"
                        ).encode(),
                        b"data: [DONE]\n\n",
                    )
                ),
                Response(
                    chunks=(
                        (
                            "data: "
                            + json.dumps({"type": "chunk", "data": audio_b})
                            + "\n\n"
                        ).encode(),
                        b"data: [DONE]\n\n",
                    )
                ),
            ]
        )
        tts = CartesiaTTS(
            api_key="k", voice_id="v", model_id="m", session_factory=factory
        )

        async def run():
            return [chunk async for chunk in tts.speak("One. Two.")]

        chunks = asyncio.run(run())
        self.assertEqual([chunk.pcm for chunk in chunks], [b"\x01" * 32, b"\x02" * 32])
        self.assertEqual(len(factory.posts), 2)
