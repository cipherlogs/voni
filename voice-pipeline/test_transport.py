"""Tests for the browser transport (WebSocket <-> orchestrator).

The socket is faked (send_json recorded, receive_json scripted); backends are
faked per call. No network, no credentials, no server required.
"""

import asyncio
import base64
import unittest

from providers import FinalTranscript, PartialTranscript, SentenceAudio, TokenDelta
from transport import handle_browser_call


class FakeDisconnect(Exception):
    pass


class FakeWebSocket:
    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        # A real socket always yields on recv; without this the orchestrator
        # task starves and the test proves nothing about concurrency.
        await asyncio.sleep(0)
        if not self._inbound:
            raise FakeDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, message: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(message)


class FakeSTT:
    def __init__(self, events: list) -> None:
        self._events = events

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        pass

    async def send_audio(self, pcm: bytes) -> None:
        pass

    async def events(self):
        for event in self._events:
            yield event

    async def close(self) -> None:
        pass


class FakeLLM:
    async def complete(self, *, messages, tools=None):
        yield TokenDelta(text="Hey there.")

    def prefetch(self, *, messages, tools=None):
        class Handle:
            def cancel(self) -> None:
                pass

        return Handle()


class FakeTTS:
    async def speak(self, text: str):
        yield SentenceAudio(pcm=text.encode(), sample_rate=24000, text=text)


def cascade_config(**overrides):
    config = {
        "llm_model": "m",
        "tts_model": "t",
        "fallback_mode": "cascade",
    }
    config.update(overrides)
    return {
        "type": "config",
        "pipeline": config,
        "system_prompt": "Be brief.",
        "tools": [],
        "agent_name": "Test",
    }


def audio_message() -> dict:
    return {"type": "audio", "data": base64.b64encode(b"\x00" * 320).decode()}


def run_call(inbound, stt_events):
    async def run():
        ws = FakeWebSocket(inbound)

        def backend_factory(config):
            return (
                FakeSTT(stt_events),
                FakeLLM(),
                FakeTTS(),
            )

        await handle_browser_call(
            ws,
            config_message=inbound[0] if inbound and inbound[0].get("type") == "config" else None,
            backend_factory=backend_factory,
        )
        return ws

    return asyncio.run(run())


class BrowserCallTests(unittest.TestCase):
    def test_full_call_streams_captions_audio_metrics(self):
        # Plenty of audio frames: the socket must stay open (real calls do)
        # long enough for the turn to complete — disconnect means hangup and
        # cancels the turn, by design.
        inbound = [cascade_config()] + [audio_message() for _ in range(40)]
        ws = run_call(
            inbound,
            [PartialTranscript(text="hi"), FinalTranscript(text="hi there")],
        )
        by_type: dict[str, list[dict]] = {}
        for message in ws.sent:
            by_type.setdefault(message["type"], []).append(message)

        captions = by_type.get("caption", [])
        self.assertTrue(
            any(c["role"] == "user" and c["final"] is False for c in captions),
            "live user partial caption",
        )
        self.assertTrue(
            any(c["role"] == "user" and c["final"] is True for c in captions),
            "user final caption",
        )
        self.assertTrue(
            any(c["role"] == "agent" and c["final"] is True for c in captions),
            "agent final caption",
        )
        audio = by_type.get("audio", [])
        self.assertTrue(audio, "expected playout audio")
        for chunk in audio:
            base64.b64decode(chunk["data"])
            self.assertEqual(chunk["sample_rate"], 24000)
        end = by_type.get("end", [])
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["turns"], 1)
        gaps = end[0]["metrics"]["gaps_ms"]
        self.assertIsNotNone(gaps["audio_in_to_first_partial"])
        self.assertIsNotNone(gaps["final_to_first_playout"])
        # Ordering: partial caption streams before the reply audio lands.
        types = [m["type"] for m in ws.sent]
        first_caption = types.index("caption")
        first_audio = types.index("audio")
        self.assertLess(first_caption, first_audio)

    def test_stop_mid_turn_ends_call_with_end_message(self):
        ws = run_call(
            [cascade_config(), audio_message(), {"type": "stop"}],
            [PartialTranscript(text="hi"), FinalTranscript(text="hi there")],
        )
        end = [m for m in ws.sent if m["type"] == "end"]
        self.assertEqual(len(end), 1)
        self.assertIn("metrics", end[0])

    def test_backend_failure_surfaces_in_end_message(self):
        async def run():
            ws = FakeWebSocket([audio_message() for _ in range(40)])

            class BrokenLLM:
                async def complete(self, *, messages, tools=None):
                    raise RuntimeError("gateway exploded")
                    yield

                def prefetch(self, *, messages, tools=None):
                    class Handle:
                        def cancel(self) -> None:
                            pass

                    return Handle()

            def factory(config):
                return (
                    FakeSTT([FinalTranscript(text="hi")]),
                    BrokenLLM(),
                    FakeTTS(),
                )

            await handle_browser_call(
                ws, config_message=cascade_config(), backend_factory=factory
            )
            return ws

        ws = asyncio.run(run())
        end = [m for m in ws.sent if m["type"] == "end"]
        self.assertEqual(len(end), 1)
        self.assertIn("gateway exploded", end[0].get("error", ""))

    def test_managed_fallback_rejected_with_error(self):
        ws = run_call(
            [cascade_config(fallback_mode="managed"), {"type": "stop"}],
            [],
        )
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("managed", errors[0]["message"])

    def test_deepgram_rejected_as_not_implemented(self):
        async def run():
            ws = FakeWebSocket([{"type": "stop"}])
            await handle_browser_call(
                ws,
                config_message=cascade_config(stt_provider="deepgram"),
                backend_factory=None,
            )
            return ws

        ws = asyncio.run(run())
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("deepgram", errors[0]["message"].lower())

    def test_bad_config_rejected(self):
        ws = run_call(
            [{"type": "config", "pipeline": {"telepathy": True}}, {"type": "stop"}],
            [],
        )
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)

    def test_first_message_must_be_config(self):
        ws = run_call([audio_message()], [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)


if __name__ == "__main__":
    unittest.main()
