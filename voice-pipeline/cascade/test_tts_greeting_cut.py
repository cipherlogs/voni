"""A greeting cut must not cost the first reply its synthesis session.

Spec: the greeting is cut with ``Cancel`` the moment the caller takes the floor
(ticket 79), and the reply to that first final is the caller's first reply. The
cut cancels the greeting's read on the synthesis socket. A read that is
cancelled must leave the session usable: if it finalizes the frame reader
instead, the next reply is told the socket closed, and the call's one failure
reconnect — a close and a fresh handshake — sits in front of its first audio.

The scripted socket is shaped like the vendor client here (``iterator=
"generator"``, exactly what ``websockets`` exposes) so cancelling a read is the
real hazard, and a second plan is ready for the reconnect the defect would take.

The live evidence that located this seam: on run ``verify-20261102T163036`` the
greeting's own first audio was 164 ms after its start, 892 of 895 synthesis
reconnects happened on calls whose greeting was cut, and the reply that
followed a cut greeting took 11.4 s to first audio while the next one took 2.4 s.
"""

import asyncio
import unittest
from unittest import mock

from cascade.assemblyai_tts import CLOSE_TIMEOUT_S, _default_socket_factory
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.tts_support import (
    audio,
    audio_ms,
    begin,
    cancelled,
    flush_done,
    make_session,
    pcm_ms,
)

GREETING = "Hi, I'm Voni. Let me show you something."
REPLY = "Sure."


class GreetingCutTests(unittest.TestCase):
    def test_the_reply_after_a_cut_greeting_starts_on_the_same_session(self):
        gate = asyncio.Event()
        reply_audio = pcm_ms(300, sample=7)
        greeting_plan = [
            begin(),
            audio_ms(100, flush_id=0),  # the opening's first word, heard
            # The vendor still owes this frame when the caller takes the floor.
            Frame(audio_ms(100, flush_id=0), gate=gate),
            cancelled(audio_duration_seconds=0.1),
            audio(reply_audio, flush_id=1),
            flush_done(flush_id=1, audio_duration_ms=300),
        ]
        # Only a reconnect opens this plan: the first reply must never see it.
        reconnect_plan = [
            begin(),
            audio(reply_audio, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=300),
        ]

        async def scenario():
            factory = ScriptedSocketFactory(
                [greeting_plan, reconnect_plan], iterator="generator"
            )
            tts, factory = make_session([], socket_factory=factory)
            await tts.open()

            heard = asyncio.Event()

            async def speak_greeting():
                async for _ in tts.speak_greeting(GREETING):
                    heard.set()

            greeting = asyncio.ensure_future(speak_greeting())
            await heard.wait()
            # The greeting is now suspended in its next read of the socket.
            await asyncio.sleep(0)
            await tts.cancel()
            greeting.cancel()
            await asyncio.gather(greeting, return_exceptions=True)
            gate.set()

            reply = tts.speak(REPLY).__aiter__()
            first = await reply.__anext__()
            connections = len(factory.connections)
            await reply.aclose()
            return connections, tts.reconnects, tts.failures, first

        connections, reconnects, failures, first = asyncio.run(scenario())

        self.assertEqual(
            1,
            connections,
            "the first reply opened a second synthesis socket before its "
            "first audio: the greeting's cancelled read was mistaken for a "
            "closed session",
        )
        self.assertEqual(0, reconnects)
        self.assertEqual([], failures)
        self.assertEqual(reply_audio, first.pcm)

    def test_the_fake_recv_loses_no_frame_when_a_read_is_cancelled(self):
        """The reader contract the adapter depends on, pinned on the seam."""
        gate = asyncio.Event()

        async def scenario():
            factory = ScriptedSocketFactory(
                [[Frame("first"), Frame("second", gate=gate)]], iterator="generator"
            )
            connection = await factory("wss://example.invalid", {})
            pending = asyncio.ensure_future(connection.recv())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            gate.set()
            return await connection.recv()

        self.assertEqual("second", asyncio.run(scenario()))

    def test_a_replaced_socket_is_closed_within_the_named_bound(self):
        """The connect carries the registry's close bound, not the vendor's 10 s."""
        with mock.patch("websockets.connect") as connect:
            connect.return_value = object()
            _default_socket_factory("wss://example.invalid", {})

        self.assertEqual(
            CLOSE_TIMEOUT_S, connect.call_args.kwargs["close_timeout"]
        )
        self.assertLess(
            CLOSE_TIMEOUT_S,
            2.5,
            "a close in front of the first reply must fit inside the "
            "first-audio bound",
        )


if __name__ == "__main__":
    unittest.main()
