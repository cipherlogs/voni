"""Conformance tests for the cascade provider contracts.

Any STT/LLM/TTS backend (AssemblyAI, Deepgram, Cartesia, gateway models) must
satisfy these interfaces; the fakes below prove the contracts are drivable
before any vendor SDK is wired in P1.
"""

import asyncio
import unittest
from collections.abc import AsyncIterator

from providers import (
    FinalTranscript,
    LLMStream,
    PartialTranscript,
    SentenceAudio,
    StreamingSTT,
    StreamingTTS,
    ToolCallRequest,
    TokenDelta,
)


class FakeSTT(StreamingSTT):
    def __init__(self) -> None:
        self.opened_with: dict | None = None
        self.audio_bytes = 0
        self.closed = False

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        self.opened_with = {"language_codes": language_codes, "sample_rate": sample_rate}

    async def send_audio(self, pcm: bytes) -> None:
        self.audio_bytes += len(pcm)

    async def events(self) -> AsyncIterator[PartialTranscript | FinalTranscript]:
        yield PartialTranscript(text="hi")
        yield PartialTranscript(text="hi there")
        yield FinalTranscript(text="hi there", turn_duration_ms=1200)

    async def close(self) -> None:
        self.closed = True


class FakeLLM(LLMStream):
    def __init__(self) -> None:
        self.seen_messages: list | None = None
        self.prefetches = 0
        self.cancels = 0

    async def complete(
        self, *, messages: list[dict], tools: list[dict] | None = None
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        self.seen_messages = messages
        yield TokenDelta(text="Hey")
        yield TokenDelta(text=" there!")
        yield ToolCallRequest(name="lookupLead", arguments={"q": "x"}, call_id="c1")

    def prefetch(self, *, messages: list[dict]) -> object:
        self.prefetches += 1

        class Handle:
            cancelled = False

            def cancel(inner_self) -> None:
                inner_self.cancelled = True

        handle = Handle()
        original_cancel = handle.cancel

        def counting_cancel() -> None:
            self.cancels += 1
            original_cancel()

        handle.cancel = counting_cancel  # type: ignore[method-assign]
        return handle


class FakeTTS(StreamingTTS):
    async def speak(self, text: str) -> AsyncIterator[SentenceAudio]:
        for sentence in [s for s in text.split(". ") if s]:
            yield SentenceAudio(pcm=b"\x00\xff" * 160, sample_rate=24000, text=sentence)


class ProviderContractTests(unittest.TestCase):
    def test_stt_drives_partial_to_final(self):
        async def run() -> list:
            stt = FakeSTT()
            await stt.open(language_codes=["en"], sample_rate=24000)
            await stt.send_audio(b"\x00" * 320)
            out = [e async for e in stt.events()]
            await stt.close()
            return stt, out

        stt, out = asyncio.run(run())
        assert isinstance(stt, FakeSTT)
        self.assertEqual(stt.opened_with, {"language_codes": ["en"], "sample_rate": 24000})
        self.assertEqual(stt.audio_bytes, 320)
        self.assertTrue(stt.closed)
        self.assertIsInstance(out[0], PartialTranscript)
        self.assertIsInstance(out[-1], FinalTranscript)
        self.assertEqual(out[-1].text, "hi there")

    def test_llm_streams_tokens_then_tool_call(self):
        async def run() -> list:
            llm = FakeLLM()
            return [e async for e in llm.complete(messages=[{"role": "user", "content": "hi"}])]

        out = asyncio.run(run())
        self.assertEqual([type(e) for e in out], [TokenDelta, TokenDelta, ToolCallRequest])
        assert isinstance(out[-1], ToolCallRequest)
        self.assertEqual(out[-1].name, "lookupLead")

    def test_prefetch_handle_cancels(self):
        llm = FakeLLM()
        handle = llm.prefetch(messages=[])
        self.assertEqual(llm.prefetches, 1)
        handle.cancel()  # type: ignore[attr-defined]
        self.assertEqual(llm.cancels, 1)

    def test_tts_chunks_per_sentence(self):
        async def run() -> list:
            tts = FakeTTS()
            return [e async for e in tts.speak("Hello there. How can I help?")]

        out = asyncio.run(run())
        self.assertEqual(len(out), 2)
        for chunk in out:
            self.assertEqual(chunk.sample_rate, 24000)
            self.assertTrue(chunk.pcm)

    def test_abstracts_cannot_instantiate(self):
        for cls in (StreamingSTT, LLMStream, StreamingTTS):
            with self.assertRaises(TypeError):
                cls()  # type: ignore[abstract]


if __name__ == "__main__":
    unittest.main()
