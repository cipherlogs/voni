"""Speech session lifetime, idle close and deliberate end (ticket 32).

A Meta realtime session runs up to 60 minutes and has no resume token. The
adapter therefore reconnects *before* the registry's ``stt.session_max_ms``
limit, at a turn boundary (``speechComplete``), and the rows it produces are a
planned reconnect: no failure, no trigger, no retry budget. A new socket is a
new session with a new epoch; the application joins the transcripts.

The margin is not invented: the replacement handshake is bounded by
``stt.handshake_ms``, so a session is replaced as soon as the time left could
no longer cover a bounded handshake. A limit that arrives mid-turn is not
pre-empted here — the vendor's max-duration close is the failure path (ticket
31), which also opens a new session.

The ledger these tests read is the adapter's append-only speech-session ledger:
one entry per session end with the kind, the close code and whether
end-of-stream was sent. It is what makes a planned reconnect, an idle close, a
dropped socket and our deliberate end distinguishable after the fact.
"""

import asyncio
import json
import unittest

from cascade.meta_stt import (
    MetaStreamingSTT,
    SessionEndKind,
    SpeechComplete,
    SpeechEnd,
    SpeechStart,
    is_idle_close,
)
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.thresholds import require_bound
from metrics import TimingLedger

SESSION_MAX_MS = 3_600_000


class NoCodeClose(ConnectionError):
    """A close frame with no code but a vendor reason (websockets-shaped)."""

    code = None

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def ack(epoch: int = 0) -> str:
    return json.dumps({"sessionId": f"call-123:{epoch}", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def backend_over(plans, *, clock=None, **kwargs):
    clock = clock or FakeClock()
    factory = ScriptedSocketFactory(plans, clock=clock)
    backend = MetaStreamingSTT(
        call_id="call-123",
        api_key="test-key",
        socket_factory=factory,
        clock=clock,
        **kwargs,
    )
    return backend, factory


def drain(backend) -> list:
    async def run():
        await backend.open(language_codes=[], sample_rate=24000)
        return [mapped async for mapped in backend.events()]

    return asyncio.run(run())


def text_frames(factory, index: int) -> list[str]:
    sent = factory.connections[index]["socket"].sent
    return [frame for frame in sent if isinstance(frame, str)]


class SessionLimitTest(unittest.TestCase):
    def test_the_limit_is_read_from_the_registry_in_seconds(self):
        backend, _ = backend_over([[]])

        self.assertEqual(SESSION_MAX_MS, require_bound("stt.session_max_ms"))
        self.assertEqual(backend.session_limit_s, SESSION_MAX_MS / 1000.0)

    def test_a_session_reconnects_before_the_limit_at_a_turn_boundary(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        # Elapsed at the turn's boundary: limit - 5 s, i.e. inside the bounded
        # handshake margin, so the turn completes and the session is replaced.
        boundary_ms = SESSION_MAX_MS - 5_000
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    Frame(event("speechStart", turnId="turn-1"), delay_ms=boundary_ms),
                    event("speechEnd", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="hello"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="world"),
                    Frame(close_code=1000, reason="done"),
                ],
            ],
            clock=clock,
            ledger=ledger,
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            stream = backend.events()
            first = await anext(stream)
            ended = await anext(stream)
            completed = await anext(stream)
            connections_at_boundary = len(factory.connections)
            replayed_start = await anext(stream)
            rest = [mapped async for mapped in stream]
            return (
                first,
                ended,
                completed,
                connections_at_boundary,
                replayed_start,
                rest,
            )

        (
            first,
            ended,
            completed,
            connections_at_boundary,
            replayed_start,
            rest,
        ) = asyncio.run(run())

        self.assertIsInstance(first, SpeechStart)
        self.assertIsInstance(ended, SpeechEnd)
        self.assertIsInstance(completed, SpeechComplete)
        self.assertEqual(completed.text, "hello")
        self.assertEqual(
            connections_at_boundary, 1, "speechEnd is not the reconnect boundary"
        )
        self.assertIsInstance(replayed_start, SpeechStart)
        self.assertEqual(replayed_start.session_epoch, 1)
        self.assertEqual([mapped.text for mapped in rest], ["world"])
        self.assertEqual(rest[0].session_epoch, 1)

        self.assertEqual(len(factory.connections), 2)
        self.assertIn("call-123%3A0", factory.connections[0]["url"])
        self.assertIn("call-123%3A1", factory.connections[1]["url"])
        self.assertEqual(
            len(text_frames(factory, 0)),
            1,
            "a planned reconnect closes the old session, it does not endStream",
        )
        self.assertEqual(backend.reconnects, 1)
        self.assertEqual(backend.failures, ())
        self.assertEqual(backend.breaker_opens, ())
        self.assertEqual(backend.alerts, ())
        self.assertFalse(backend.retry_used, "a planned reconnect spends no retry")
        self.assertIn(
            "reconnect",
            ledger.summary()["marks"],
            "the call ledger sees the planned reconnect",
        )

        endings = backend.session_ledger
        self.assertEqual(
            [ending.kind for ending in endings],
            [SessionEndKind.LIFETIME, SessionEndKind.NORMAL],
        )
        lifetime = endings[0]
        self.assertEqual(lifetime.epoch, 0)
        self.assertEqual(lifetime.code, "session_limit")
        self.assertTrue(lifetime.planned)
        self.assertFalse(lifetime.end_stream_sent)

    def test_an_overlapping_turn_defers_the_planned_reconnect(self):
        # Turn 2 opens before turn 1 completes. Replacing the session when
        # turn 1's final arrives would cut turn 2 mid-speech, so the planned
        # reconnect waits until no turn is in flight.
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    Frame(
                        event("speechStart", turnId="turn-1"),
                        delay_ms=SESSION_MAX_MS - 5_000,
                    ),
                    event("speechStart", turnId="turn-2"),
                    event("speechComplete", turnId="turn-1", text="one"),
                    event("speechComplete", turnId="turn-2", text="two"),
                ],
                [ack(1), Frame(close_code=1000)],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            stream = backend.events()
            first_final = await anext(stream)
            while not isinstance(first_final, SpeechComplete):
                first_final = await anext(stream)
            connections_after_first = len(factory.connections)
            rest = [mapped async for mapped in stream]
            return first_final, connections_after_first, rest

        first_final, connections_after_first, rest = asyncio.run(run())

        self.assertEqual(first_final.text, "one")
        self.assertEqual(
            connections_after_first,
            1,
            "turn 2 is still in flight; do not replace the session yet",
        )
        self.assertEqual(
            [mapped.text for mapped in rest if isinstance(mapped, SpeechComplete)],
            ["two"],
        )
        self.assertEqual(rest[0].session_epoch, 0, "turn 2 stayed on the old session")
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.failures, ())

    def test_the_reconnect_margin_is_the_bounded_handshake(self):
        margin_s = require_bound("stt.handshake_ms") / 1000.0

        def reconnect_at(remaining_s: float) -> bool:
            clock = FakeClock()
            backend, factory = backend_over(
                [
                    [
                        ack(0),
                        Frame(
                            event("speechStart", turnId="turn-1"),
                            delay_ms=(SESSION_MAX_MS - int(remaining_s * 1000)),
                        ),
                        event("speechComplete", turnId="turn-1", text="hi"),
                    ],
                    [ack(1), Frame(close_code=1000)],
                ],
                clock=clock,
            )

            async def run():
                await backend.open(language_codes=[], sample_rate=24000)
                return [mapped async for mapped in backend.events()]

            asyncio.run(run())
            return len(factory.connections) == 2

        self.assertFalse(
            reconnect_at(margin_s + 1.0),
            "a full bounded handshake still fits; no planned reconnect yet",
        )
        self.assertTrue(
            reconnect_at(margin_s - 1.0),
            "less than a bounded handshake is left; replace the session",
        )

    def test_a_turn_that_completes_well_before_the_limit_keeps_its_session(self):
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    Frame(
                        event("speechStart", turnId="turn-1"), delay_ms=60_000
                    ),
                    event("speechComplete", turnId="turn-1", text="hello"),
                    Frame(close_code=1000),
                ]
            ]
        )

        events = drain(backend)
        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]

        self.assertEqual([final.text for final in finals], ["hello"])
        self.assertEqual(len(factory.connections), 1)
        self.assertEqual(backend.reconnects, 0)
        self.assertEqual(
            [ending.kind for ending in backend.session_ledger],
            [SessionEndKind.NORMAL],
        )

    def test_the_session_clock_is_the_injected_clock(self):
        clock = FakeClock()
        backend, _ = backend_over([[ack(0)]], clock=clock)

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)

        asyncio.run(run())
        clock.advance(125.0)

        self.assertEqual(backend.session_elapsed_s, 125.0)
        self.assertEqual(
            backend.session_remaining_s, backend.session_limit_s - 125.0
        )
        self.assertFalse(backend.reconnect_due)

    def test_a_limit_that_arrives_mid_turn_uses_the_vendor_close_path(self):
        # No speechComplete before the limit: the adapter must not cut a turn
        # at speechEnd. The vendor's max-duration close opens the new session.
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    Frame(
                        event("speechStart", turnId="turn-1"),
                        delay_ms=SESSION_MAX_MS - 2_000,
                    ),
                    event("speechEnd", turnId="turn-1"),
                    Frame(close_code=1011, reason="max session duration reached"),
                ],
                [ack(1), Frame(close_code=1000)],
            ]
        )

        events = drain(backend)

        self.assertEqual(
            [mapped for mapped in events if isinstance(mapped, SpeechComplete)],
            [],
            "speechEnd is not finalised into a turn",
        )
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.failures, (), "the limit is not a failure")
        self.assertEqual(backend.breaker_opens, ())
        self.assertFalse(backend.retry_used)
        self.assertIs(
            backend.session_ledger[0].kind, SessionEndKind.LIFETIME
        )
        self.assertTrue(backend.session_ledger[0].planned)

    def test_transcripts_are_joined_across_sessions_with_no_resume_token(self):
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    Frame(
                        event("speechStart", turnId="turn-1"),
                        delay_ms=SESSION_MAX_MS - 5_000,
                    ),
                    event("speechComplete", turnId="turn-1", text="first"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-2"),
                    event("speechComplete", turnId="turn-2", text="second"),
                    Frame(close_code=1000),
                ],
            ]
        )

        events = drain(backend)
        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]

        self.assertEqual([final.text for final in finals], ["first", "second"])
        self.assertEqual([final.session_epoch for final in finals], [0, 1])

        for index in (0, 1):
            handshake = json.loads(text_frames(factory, index)[0])
            self.assertNotIn("resumeToken", handshake)
            self.assertNotIn("resume", handshake)
            self.assertNotIn("sessionResume", handshake)


class IdleCloseTest(unittest.TestCase):
    """Idle input ends the session; it is never an audio-path error."""

    def test_an_idle_close_ends_the_session_and_opens_a_new_one(self):
        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        backend, factory = backend_over(
            [
                [ack(0), Frame(exc=NoCodeClose("idle: no audio received"))],
                [ack(1), Frame(close_code=1000)],
            ],
            clock=clock,
            ledger=ledger,
        )

        events = drain(backend)

        self.assertEqual(events, [])
        self.assertIn("reconnect", ledger.summary()["marks"])
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.reconnects, 1)
        self.assertEqual(backend.failures, (), "an idle close is not a trigger")
        self.assertEqual(backend.breaker_opens, ())
        self.assertEqual(backend.alerts, ())
        self.assertFalse(backend.retry_used, "an idle close spends no retry budget")
        self.assertEqual(
            [ending.kind for ending in backend.session_ledger],
            [SessionEndKind.IDLE, SessionEndKind.NORMAL],
        )
        idle = backend.session_ledger[0]
        self.assertTrue(idle.planned)
        self.assertEqual(idle.epoch, 0)

    def test_an_idle_reason_is_a_session_end_even_on_a_normal_close_code(self):
        backend, factory = backend_over(
            [
                [ack(0), Frame(close_code=1000, reason="idle timeout")],
                [ack(1), Frame(close_code=1000)],
            ]
        )

        drain(backend)

        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.failures, ())
        self.assertEqual(backend.reconnects, 1)

    def test_an_idle_reason_is_not_reclassified_as_an_audio_bug(self):
        # 1008 is a pacing bug when we caused it; a close whose reason names
        # idle input is the vendor ending the session, not our audio error.
        backend, factory = backend_over(
            [
                [ack(0), Frame(close_code=1008, reason="no input received")],
                [ack(1), Frame(close_code=1000)],
            ]
        )

        drain(backend)

        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(backend.failures, ())
        self.assertEqual(backend.alerts, ())
        self.assertEqual(backend.breaker_opens, ())

    def test_input_continues_on_the_new_session_after_an_idle_close(self):
        backend, factory = backend_over(
            [
                [ack(0), Frame(exc=NoCodeClose("stream idle"))],
                [ack(1)],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.send_silence(0.04)

        asyncio.run(run())

        audio = [
            frame
            for frame in factory.connections[1]["socket"].sent
            if isinstance(frame, bytes)
        ]
        self.assertEqual(len(audio), 2)
        self.assertTrue(all(frame == b"\x00" * 960 for frame in audio))

    def test_a_quiet_gap_is_filled_with_pcm_silence_not_a_text_frame(self):
        clock = FakeClock()
        backend, factory = backend_over(
            [[ack(0), Frame(close_code=1000)]], clock=clock
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            clock.advance(0.1)
            await backend.send_audio(b"\x01\x00" * 480)  # one 20 ms frame

        asyncio.run(run())

        sent = factory.connections[0]["socket"].sent
        audio = [frame for frame in sent if isinstance(frame, bytes)]
        self.assertEqual(len(audio), 6)
        self.assertTrue(all(frame == b"\x00" * 960 for frame in audio[:5]))
        self.assertEqual(audio[-1], b"\x01\x00" * 480)
        self.assertEqual(
            [frame for frame in sent if isinstance(frame, str)][1:], []
        )

    def test_idle_is_read_from_the_close_reason_by_name(self):
        self.assertTrue(is_idle_close("idle: no audio received"))
        self.assertTrue(is_idle_close("No input received"))
        self.assertTrue(is_idle_close("stream inactivity timeout"))
        self.assertFalse(is_idle_close("internal/backend failure"))
        self.assertFalse(is_idle_close(""))


class DeliberateEndTest(unittest.TestCase):
    """Our end drains, sends endStream, and reads to the vendor's 1000."""

    def test_a_deliberate_end_drains_and_reads_until_the_normal_close(self):
        clock = FakeClock()
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="hello"),
                    Frame(close_code=1000, reason="done"),
                ]
            ],
            clock=clock,
        )
        sent_at: list[tuple[str | bytes, float]] = []

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            original_send = factory.socket.send

            async def recording_send(message):
                sent_at.append((message, clock()))
                await original_send(message)

            factory.socket.send = recording_send
            await backend.send_audio(b"\x01\x00" * 24000)  # one second
            await backend.close()

        asyncio.run(run())

        end_stream_at = [
            at for frame, at in sent_at if frame == '{"type": "endStream"}'
        ]
        self.assertEqual(end_stream_at, [1.0], "the lead is drained first")
        self.assertEqual(backend.last_close_code, 1000)
        self.assertFalse(
            factory.socket.connected,
            "the queued events were read up to the vendor's close",
        )
        ending = backend.session_ledger[-1]
        self.assertIs(ending.kind, SessionEndKind.DELIBERATE)
        self.assertTrue(ending.end_stream_sent)
        self.assertEqual(ending.code, 1000)
        self.assertFalse(ending.planned)

    def test_a_dropped_socket_ends_input_but_the_deliberate_end_uses_end_stream(self):
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-0"),
                    Frame(exc=ConnectionError("socket vanished")),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="after"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()

        asyncio.run(run())

        self.assertEqual(len(factory.connections), 2)
        self.assertNotIn(
            '{"type": "endStream"}', text_frames(factory, 0), "a dead socket gets none"
        )
        self.assertEqual(
            text_frames(factory, 1)[-1], '{"type": "endStream"}'
        )
        self.assertIsNone(backend.last_close_code)

        kinds = [ending.kind for ending in backend.session_ledger]
        self.assertEqual(
            kinds, [SessionEndKind.DROPPED, SessionEndKind.DELIBERATE]
        )
        dropped, deliberate = backend.session_ledger
        self.assertFalse(dropped.planned)
        self.assertIsNone(dropped.code)
        self.assertFalse(dropped.end_stream_sent)
        self.assertTrue(deliberate.end_stream_sent)
        self.assertEqual(deliberate.epoch, 1)

    def test_a_failure_is_never_recorded_as_a_planned_reconnect(self):
        from cascade.meta_stt import SpeechCallFailure

        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        backend, _ = backend_over(
            [[ack(0), Frame(close_code=1008, reason="invalid pacing")]],
            clock=clock,
            ledger=ledger,
        )

        with self.assertRaises(SpeechCallFailure):
            drain(backend)

        self.assertNotIn(
            "reconnect",
            ledger.summary()["marks"],
            "a failure never marks a planned reconnect",
        )
        ending = backend.session_ledger[-1]
        self.assertIs(ending.kind, SessionEndKind.FAILED)
        self.assertFalse(ending.planned)
        self.assertEqual(ending.code, 1008)
        self.assertNotIn(
            SessionEndKind.LIFETIME,
            [entry.kind for entry in backend.session_ledger],
        )


if __name__ == "__main__":
    unittest.main()
