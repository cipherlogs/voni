"""Only end-of-stream may follow the handshake (ticket 30).

The client can end the call's input but cannot force a turn: after the
handshake the only text frame is ``endStream``, at a deliberate call end or
drain, never at ``speechEnd``. There is no ``ForceEndpoint``, no
``UpdateConfiguration`` and no per-turn commit to import or call.

The negative test replays a full call, including a reconnect, and asserts the
text frames per session are exactly the handshake and the end-of-stream. A
deliberate end drains the audio lead, sends ``endStream`` and keeps reading
until the vendor closes.
"""

import asyncio
import json
import unittest

import cascade.meta_stt as meta_stt
from cascade.meta_stt import (
    END_STREAM_FRAME,
    MetaHandshakeError,
    MetaStreamingSTT,
    SpeechEnd,
)
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import (
    Frame,
    ScriptedSocketClosed,
    ScriptedSocketFactory,
)


def untyped_ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def full_turn_plan():
    return [
        untyped_ack(),
        event("speechStart", turnId="turn-1"),
        event("transcript", text="hello"),
        event("speechEnd", turnId="turn-1"),
        event("speechComplete", turnId="turn-1", text="hello"),
        Frame(close_code=1000, reason="done"),
    ]


def caller_pcm(seconds: float) -> bytes:
    return b"\x01\x00" * int(seconds * 24000)


def open_backend(plans, clock=None):
    factory = ScriptedSocketFactory(plans, clock=clock)
    backend = MetaStreamingSTT(
        call_id="call-123",
        api_key="test-key",
        socket_factory=factory,
        clock=clock or FakeClock(),
    )
    return backend, factory


def text_frames(factory, index: int):
    sent = factory.connections[index]["socket"].sent
    return [frame for frame in sent if isinstance(frame, str)]


class EndOfStreamOnlyTest(unittest.TestCase):
    def test_the_only_text_frame_after_the_handshake_is_end_stream(self):
        backend, factory = open_backend([full_turn_plan()])

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()

        asyncio.run(run())

        text = text_frames(factory, 0)
        self.assertEqual(len(text), 2)
        handshake = json.loads(text[0])
        self.assertIn("authorization", handshake)
        self.assertEqual(json.loads(text[1]), {"type": "endStream"})
        self.assertEqual(text[1], END_STREAM_FRAME)

    def test_no_text_frame_other_than_end_stream_ever_appears_on_reconnect(self):
        backend, factory = open_backend([full_turn_plan(), full_turn_plan()])

        async def run():
            for _ in range(2):
                await backend.open(language_codes=[], sample_rate=24000)
                async for _ in backend.events():
                    pass
                await backend.send_audio(caller_pcm(0.02))
                await backend.close()

        asyncio.run(run())

        self.assertEqual(len(factory.connections), 2)
        for index in (0, 1):
            text = text_frames(factory, index)
            self.assertEqual(len(text), 2, f"session {index} sent {text}")
            self.assertIn("authorization", json.loads(text[0]))
            self.assertEqual(text[1], END_STREAM_FRAME)
            for frame in factory.connections[index]["socket"].sent:
                if isinstance(frame, bytes):
                    self.assertEqual(len(frame) % 2, 0)
                else:
                    parsed = json.loads(frame)
                    self.assertIn(
                        parsed.get("type") if "type" in parsed else "handshake",
                        ("handshake", "endStream"),
                    )

    def test_speech_end_does_not_send_end_stream(self):
        backend, factory = open_backend([full_turn_plan()])

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            seen = []
            async for mapped in backend.events():
                seen.append(mapped)
                if isinstance(mapped, SpeechEnd):
                    break
            return seen

        asyncio.run(run())

        self.assertEqual(len(text_frames(factory, 0)), 1)

    def test_speech_complete_does_not_send_end_stream_either(self):
        backend, factory = open_backend([full_turn_plan()])

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass

        asyncio.run(run())
        self.assertEqual(len(text_frames(factory, 0)), 1)

    def test_close_is_idempotent_and_sends_end_stream_once(self):
        backend, factory = open_backend([full_turn_plan()])

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            await backend.close()
            await backend.close()

        asyncio.run(run())
        self.assertEqual(text_frames(factory, 0).count(END_STREAM_FRAME), 1)


class NoTurnForcingApiTest(unittest.TestCase):
    def test_there_is_no_force_endpoint_or_configuration_update(self):
        for name in (
            "force_endpoint",
            "update_configuration",
            "end_turn",
            "take_floor",
            "end_stream",
        ):
            self.assertFalse(
                hasattr(MetaStreamingSTT, name),
                f"per-turn control {name!r} must not exist",
            )

    def test_forcing_symbols_cannot_be_imported_by_name(self):
        def import_force_endpoint():
            from cascade.meta_stt import ForceEndpoint  # noqa: F401

        def import_update_configuration():
            from cascade.meta_stt import UpdateConfiguration  # noqa: F401

        with self.assertRaises(ImportError):
            import_force_endpoint()
        with self.assertRaises(ImportError):
            import_update_configuration()
        self.assertFalse(hasattr(meta_stt, "FORCE_ENDPOINT"))


class DeliberateEndTest(unittest.TestCase):
    def test_a_deliberate_end_drains_the_audio_lead_before_end_stream(self):
        clock = FakeClock()
        backend, factory = open_backend([full_turn_plan()], clock=clock)
        sent_at: list[tuple[str | bytes, float]] = []

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            original_send = factory.socket.send

            async def recording_send(message):
                sent_at.append((message, clock()))
                await original_send(message)

            factory.socket.send = recording_send
            await backend.send_audio(caller_pcm(1.0))
            await backend.close()

        asyncio.run(run())

        end_stream_at = [
            at for frame, at in sent_at if frame == END_STREAM_FRAME
        ]
        self.assertEqual(end_stream_at, [1.0])
        self.assertEqual(clock.elapsed, 1.0)

    def test_close_keeps_reading_until_the_vendor_closes(self):
        class RecordingSocket:
            def __init__(self) -> None:
                self.frames = [
                    untyped_ack(),
                    event("speechStart", turnId="turn-1"),
                    ScriptedSocketClosed(1000, "done"),
                ]
                self.sent: list[str | bytes] = []
                self.reads = 0
                self.closed = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                self.reads += 1
                frame = self.frames.pop(0)
                if isinstance(frame, BaseException):
                    raise frame
                return frame

            async def send(self, message):
                self.sent.append(message)

            async def close(self):
                self.closed = True

        socket = RecordingSocket()

        async def factory(url, headers):
            return socket

        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            clock=FakeClock(),
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            await backend.close()

        asyncio.run(run())

        self.assertEqual(socket.reads, 3)
        self.assertEqual(backend.last_close_code, 1000)
        self.assertEqual(socket.sent[-1], END_STREAM_FRAME)
        self.assertTrue(socket.closed)

    def test_a_socket_that_ends_without_a_close_code_finishes_cleanly(self):
        backend, factory = open_backend([[untyped_ack()]])

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            await backend.close()

        asyncio.run(run())

        self.assertIsNone(backend.last_close_code)
        self.assertEqual(text_frames(factory, 0)[-1], END_STREAM_FRAME)

    def test_close_before_the_ack_sends_no_end_stream(self):
        factory = ScriptedSocketFactory([])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeError):
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))
        asyncio.run(backend.close())

        self.assertEqual(len(factory.connections), 1)
        self.assertNotIn(END_STREAM_FRAME, factory.socket.sent)


if __name__ == "__main__":
    unittest.main()
