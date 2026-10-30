"""KeepAlive, the idle close and session expiry (ticket 53).

Spec: `.scratch/meta-cascade/spec.md`, M1 "AssemblyAI speech synthesis
backend", "KeepAlive and idle": a session closes after 120 s with no frame in
either direction. A ``KeepAlive`` at the registry's named interval keeps the
socket open through a long caller pause, is sent only while the session is
idle, and is spent from the session's own control-frame budget — a keepalive
that would exceed that budget is shed rather than sent blindly. A missed
keepalive is a voice failure, not a silent gap. A session that reaches
``Begin.expires_at`` drops every frame, so the adapter drains the reply in
flight and opens a new session between turns, never mid-sentence.

Two clocks are injected: ``clock`` is the session's virtual time (pacing,
interval, expiry deadline) and ``wall_clock`` interprets the vendor's epoch
``expires_at``. No test sleeps, reads the wall clock or opens a socket.
"""

import asyncio
import json
import unittest

from cascade.assemblyai_tts import (
    CONTROL_WINDOW_S,
    IDLE_TIMEOUT_S,
    KEEPALIVE_INTERVAL_S,
    AssemblyAIStreamingTTS,
    ControlFramePacingError,
    KeepaliveAction,
    SynthesisCallFailure,
)
from cascade.failures import FailureClass
from cascade.tts_support import (
    API_KEY,
    BEGIN_EXPIRES_AT,
    VENDOR_LIMITS,
    audio_ms,
    begin,
    flush_done,
    sent_types,
)
from cascade.testing import FakeClock, Frame, ScriptedSocketFactory
from cascade.thresholds import require_bound


def session(plans, *, clock=None, wall=None):
    """A session over one scripted plan (or one plan per connection)."""
    clock = clock if clock is not None else FakeClock()
    wall = wall if wall is not None else FakeClock()
    factory = ScriptedSocketFactory(plans, clock=clock)
    tts = AssemblyAIStreamingTTS(
        voice_id="anna",
        transport="browser",
        api_key=API_KEY,
        socket_factory=factory,
        clock=clock,
        wall_clock=wall,
    )
    return tts, factory, clock, wall


def frame_types(factory, index=0):
    """The frame types the client sent on connection ``index``."""
    return [
        json.loads(message)["type"]
        for message in factory.connections[index]["socket"].sent
    ]


def frame_texts(factory, index=0):
    """The ``Generate`` texts the client sent on connection ``index``."""
    return [
        json.loads(message)["text"]
        for message in factory.connections[index]["socket"].sent
        if json.loads(message)["type"] == "Generate"
    ]


def pause(tts, clock, seconds):
    """Tick the idle seam across a caller pause; one action per interval."""

    async def drive():
        actions = []
        elapsed = 0.0
        while elapsed + KEEPALIVE_INTERVAL_S <= seconds:
            clock.advance(KEEPALIVE_INTERVAL_S)
            elapsed += KEEPALIVE_INTERVAL_S
            actions.append(await tts.keepalive_if_idle())
        return actions

    return asyncio.run(drive())


async def drain(tts, text):
    return [chunk async for chunk in tts.speak(text)]


class RegisteredIntervalTests(unittest.TestCase):
    def test_the_interval_is_the_registry_value_below_the_idle_close(self):
        self.assertEqual(
            KEEPALIVE_INTERVAL_S,
            float(require_bound("tts.keepalive_interval_ms")) / 1000.0,
        )
        self.assertEqual(
            IDLE_TIMEOUT_S, float(require_bound("tts.idle_timeout_ms")) / 1000.0
        )
        self.assertLess(KEEPALIVE_INTERVAL_S, IDLE_TIMEOUT_S)

    def test_the_interval_fits_inside_the_sessions_control_frame_budget(self):
        tts, _, _, _ = session([begin()])
        asyncio.run(tts.open())

        budget = tts.limits["max_control_frames_per_sec"]
        frames_per_window = CONTROL_WINDOW_S / KEEPALIVE_INTERVAL_S

        self.assertLess(frames_per_window, budget)


class IdleKeepaliveTests(unittest.TestCase):
    def test_a_session_that_just_spoke_is_not_due_a_keepalive(self):
        tts, factory, clock, _ = session([begin()])
        asyncio.run(tts.open())

        clock.advance(KEEPALIVE_INTERVAL_S / 2)

        action = asyncio.run(tts.keepalive_if_idle())

        self.assertIs(action, KeepaliveAction.NOT_DUE)
        self.assertEqual(sent_types(factory), [])
        self.assertEqual(tts.keepalives_sent, 0)

    def test_one_keepalive_is_sent_at_the_named_interval_then_not_again(self):
        tts, factory, clock, _ = session([begin()])
        asyncio.run(tts.open())

        clock.advance(KEEPALIVE_INTERVAL_S)
        first = asyncio.run(tts.keepalive_if_idle())
        second = asyncio.run(tts.keepalive_if_idle())

        self.assertIs(first, KeepaliveAction.SENT)
        self.assertIs(second, KeepaliveAction.NOT_DUE)
        self.assertEqual(sent_types(factory), ["KeepAlive"])
        self.assertEqual(tts.keepalives_sent, 1)

    def test_an_idle_session_stays_open_through_a_pause_past_the_idle_close(self):
        tts, factory, clock, _ = session([begin()])
        asyncio.run(tts.open())

        # Five minutes: a pause longer than the 120 s idle close, at a cadence
        # that only the keepalive can bridge.
        actions = pause(tts, clock, seconds=5 * IDLE_TIMEOUT_S)

        self.assertGreater(5 * IDLE_TIMEOUT_S, IDLE_TIMEOUT_S)
        self.assertTrue(all(action is KeepaliveAction.SENT for action in actions))
        self.assertEqual(len(actions), 20)
        self.assertEqual(tts.keepalives_sent, len(actions))
        self.assertEqual(sent_types(factory), ["KeepAlive"] * len(actions))
        self.assertFalse(factory.connections[0]["socket"].closed)
        self.assertFalse(tts.needs_reconnect)
        self.assertEqual(tts.failures, [])
        self.assertEqual(len(factory.connections), 1)
        # The tick cadence is the registry interval itself, so no gap between
        # sent frames can reach the idle close.
        self.assertLess(KEEPALIVE_INTERVAL_S, IDLE_TIMEOUT_S)


class NoKeepaliveDuringAudioTests(unittest.TestCase):
    def test_no_keepalive_is_sent_while_a_reply_is_in_flight(self):
        plan = [
            begin(),
            audio_ms(800, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=800),
            audio_ms(800, flush_id=1),
            flush_done(flush_id=1, audio_duration_ms=800),
        ]
        tts, factory, clock, _ = session([plan])
        asyncio.run(tts.open())

        async def scenario():
            reply = tts.speak("First one. Second one.")
            first = await reply.__anext__()
            # Mid-sentence: the session is not idle even if the loop stalls.
            clock.advance(IDLE_TIMEOUT_S + 1)
            action = await tts.keepalive_if_idle()
            rest = [chunk async for chunk in reply]
            return first, action, rest

        first, action, rest = asyncio.run(scenario())

        self.assertIs(action, KeepaliveAction.BUSY)
        self.assertNotIn("KeepAlive", frame_types(factory))
        self.assertEqual(len([first, *rest]), 2)
        self.assertEqual(tts.failures, [])
        self.assertEqual(len(factory.connections), 1)


class ControlFrameBudgetTests(unittest.TestCase):
    def test_a_keepalive_is_spent_from_the_control_frame_budget(self):
        limits = dict(VENDOR_LIMITS, max_control_frames_per_sec=4)
        plan = [
            begin(limits=limits),
            audio_ms(800, flush_id=0),
            flush_done(flush_id=0, audio_duration_ms=800),
            audio_ms(800, flush_id=1),
            flush_done(flush_id=1, audio_duration_ms=800),
        ]
        tts, factory, clock, _ = session([plan])
        asyncio.run(tts.open())

        clock.advance(KEEPALIVE_INTERVAL_S)
        self.assertIs(
            asyncio.run(tts.keepalive_if_idle()), KeepaliveAction.SENT
        )

        # Two sentences are Generate+Flush twice: four frames, exactly this
        # session's budget. With the keepalive counted, the second Flush would
        # be the fifth frame of the window, so the session refuses it.
        with self.assertRaises(ControlFramePacingError):
            asyncio.run(drain(tts, "First one. Second one."))

        self.assertEqual(tts.control_frames_sent, 4)
        self.assertEqual(
            frame_types(factory), ["KeepAlive", "Generate", "Flush", "Generate"]
        )

    def test_a_keepalive_that_would_exceed_the_budget_is_shed(self):
        # A session whose one-second window cannot carry even one housekeeping
        # frame: sending any control frame would trip its 3010 pacing close.
        limits = dict(VENDOR_LIMITS, max_control_frames_per_sec=0.5)
        tts, factory, clock, _ = session([begin(limits=limits)])
        asyncio.run(tts.open())

        clock.advance(KEEPALIVE_INTERVAL_S)
        action = asyncio.run(tts.keepalive_if_idle())

        self.assertIs(action, KeepaliveAction.SHED)
        self.assertEqual(tts.keepalives_sent, 0)
        self.assertEqual(sent_types(factory), [])
        self.assertEqual(tts.failures, [])
        self.assertEqual(tts.alerts, [])

    def test_a_shed_keepalive_becomes_a_voice_failure_not_a_silent_gap(self):
        limits = dict(VENDOR_LIMITS, max_control_frames_per_sec=0.5)
        tts, factory, clock, _ = session(
            [[begin(limits=limits)], [begin(limits=limits)]]
        )
        asyncio.run(tts.open())

        actions = pause(tts, clock, seconds=IDLE_TIMEOUT_S)

        self.assertEqual(
            actions,
            [
                KeepaliveAction.SHED,
                KeepaliveAction.SHED,
                KeepaliveAction.SHED,
                KeepaliveAction.MISSED,
            ],
        )
        self.assertIs(tts.failures[-1].failure_class, FailureClass.TRIGGER)
        self.assertEqual(len(factory.connections), 2)


class MissedKeepaliveTests(unittest.TestCase):
    def test_a_missed_keepalive_reconnects_once_and_keeps_the_turn_speaking(self):
        tts, factory, clock, _ = session(
            [
                [begin()],
                [
                    begin(),
                    audio_ms(800, flush_id=0),
                    flush_done(flush_id=0, audio_duration_ms=800),
                ],
            ]
        )
        asyncio.run(tts.open())

        clock.advance(IDLE_TIMEOUT_S + 1)
        action = asyncio.run(tts.keepalive_if_idle())

        self.assertIs(action, KeepaliveAction.MISSED)
        self.assertEqual(len(tts.failures), 1)
        self.assertIs(tts.failures[0].failure_class, FailureClass.TRIGGER)
        self.assertEqual(len(factory.connections), 2)
        self.assertFalse(tts.needs_reconnect)

        # The failure is visible and the next turn is spoken on the new
        # session rather than into the silent gap.
        chunks = asyncio.run(drain(tts, "Hello there."))

        self.assertEqual(len(chunks), 1)
        self.assertEqual(len(factory.connections), 2)

    def test_a_second_missed_keepalive_ends_the_call_visibly(self):
        tts, factory, clock, _ = session([[begin()], [begin()]])
        asyncio.run(tts.open())

        clock.advance(IDLE_TIMEOUT_S + 1)
        asyncio.run(tts.keepalive_if_idle())
        clock.advance(IDLE_TIMEOUT_S + 1)

        with self.assertRaises(SynthesisCallFailure) as raised:
            asyncio.run(tts.keepalive_if_idle())

        failure = raised.exception
        self.assertEqual(failure.verdict.code, 1006)
        self.assertEqual(tts.breaker_opens, [failure.verdict])
        self.assertTrue(failure.visible)
        self.assertTrue(failure.call_ended)


class ExpiryBetweenTurnsTests(unittest.TestCase):
    def test_expiry_opens_a_new_session_between_turns(self):
        plans = [
            [begin(expires_at=int(IDLE_TIMEOUT_S))],
            [
                begin(expires_at=int(2 * IDLE_TIMEOUT_S)),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
            ],
        ]
        tts, factory, clock, _ = session(plans)
        asyncio.run(tts.open())

        # Keepalives hold the idle session open up to its expiry.
        actions = pause(tts, clock, seconds=IDLE_TIMEOUT_S)
        self.assertTrue(all(action is KeepaliveAction.SENT for action in actions[:-1]))
        self.assertIs(actions[-1], KeepaliveAction.EXPIRED)

        self.assertTrue(tts.needs_reconnect)
        self.assertTrue(factory.connections[0]["socket"].closed)
        self.assertEqual(tts.failures, [])
        self.assertEqual(tts.breaker_opens, [])
        self.assertEqual(len(factory.connections), 1)

        chunks = asyncio.run(drain(tts, "Hello there."))

        self.assertEqual(len(chunks), 1)
        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(frame_texts(factory, 1), ["Hello there."])
        self.assertFalse(tts.needs_reconnect)

    def test_expiry_is_planned_and_never_spends_the_failure_reconnect(self):
        plans = [
            [begin(expires_at=int(IDLE_TIMEOUT_S))],
            [
                begin(expires_at=int(4 * IDLE_TIMEOUT_S)),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
            ],
        ]
        tts, factory, clock, _ = session(plans)
        asyncio.run(tts.open())

        pause(tts, clock, seconds=IDLE_TIMEOUT_S)
        asyncio.run(drain(tts, "Hello there."))

        counters = tts.reconnect_budget.counters("tts")

        self.assertEqual(counters.planned_reconnects, 1)
        self.assertEqual(counters.failure_reconnects, 0)
        self.assertEqual(counters.budget_left, 1)
        self.assertEqual(tts.failures, [])


class ExpiryMidReplyTests(unittest.TestCase):
    def test_expiry_mid_reply_finishes_the_sentence_then_hands_over(self):
        plans = [
            [
                begin(expires_at=40),
                # The first sentence's audio arrives 25 s after the Begin and
                # its FlushDone 25 s later: the session expires between the two
                # sentences, never inside either one.
                Frame(audio_ms(800, flush_id=0), delay_ms=25_000),
                Frame(flush_done(flush_id=0, audio_duration_ms=800), delay_ms=25_000),
            ],
            [
                begin(expires_at=40),
                audio_ms(800, flush_id=0),
                flush_done(flush_id=0, audio_duration_ms=800),
            ],
        ]
        tts, factory, clock, _ = session(plans)
        asyncio.run(tts.open())

        chunks = asyncio.run(drain(tts, "First one. Second one."))

        self.assertEqual(len(chunks), 2)
        # Every frame of the first sentence came from the first session, and
        # the second sentence from the new one: no sentence is cut in half.
        self.assertEqual(frame_types(factory, 0), ["Generate", "Flush"])
        self.assertEqual(frame_texts(factory, 0), ["First one. "])
        self.assertEqual(frame_types(factory, 1), ["Generate", "Flush"])
        self.assertEqual(frame_texts(factory, 1), ["Second one."])
        self.assertEqual(tts.failures, [])
        self.assertEqual(tts.breaker_opens, [])


class AlreadyExpiredBeginTests(unittest.TestCase):
    def test_an_expires_at_already_past_is_left_to_the_vendors_close(self):
        # A stale timestamp cannot be scheduled as a future deadline; the
        # adapter never invents an immediate drain of a session the vendor may
        # still be serving. The wire close (3008) is the signal then.
        tts, factory, _, _ = session([begin(expires_at=BEGIN_EXPIRES_AT - 10_000_000)])
        asyncio.run(tts.open())

        self.assertEqual(tts.expires_at, BEGIN_EXPIRES_AT - 10_000_000)
        self.assertFalse(tts.expired)
        self.assertFalse(tts.needs_reconnect)
        self.assertEqual(len(factory.connections), 1)


if __name__ == "__main__":
    unittest.main()
