"""The phone bridge's polled goodbye drain, held to the browser's behaviour.

Each test here mirrors one in `voni/src/lib/voice/session-lifecycle.test.ts`
("hangup waits through flapping playback…", "a jittery goodbye…", "hangup
waits out fresh audio…") so the two implementations are pinned to one product
(ADR 0007: the bridge stays a second implementation, pinned by behaviour).
"""

import asyncio
import base64
import importlib
import json
import os
import pathlib
import re
import time
import unittest
from unittest import mock

from goodbye_drain import (
    GOODBYE_AUDIO_GRACE_MS,
    GOODBYE_DRAIN_TIMEOUT_MS,
    GOODBYE_POLL_MS,
    GOODBYE_SETTLE_POLLS,
    GoodbyeDrain,
    playout_settled,
)


class FakeClock:
    """A monotonic clock whose sleeps the test releases, one poll at a time.

    The Python analogue of the browser tests' mock timers: `tick()` lets one
    drain poll run and advances the clock by one poll interval, so a test
    asserts on what the caller hears at each 250 ms poll, not on wall time.
    """

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.now = start
        self._poll = asyncio.Event()

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        await self._poll.wait()
        self._poll.clear()
        self.now += seconds

    async def tick(self, times: int = 1) -> None:
        for _ in range(times):
            self._poll.set()
            await asyncio.sleep(0)


class Playout:
    """What the drain can observe of Telnyx's playout, as the bridge reports it."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.settled = False
        self.last_audio_at: float | None = None

    def audio_arrived(self) -> None:
        """A reply.audio chunk landed: buffered, so not settled, grace restarts."""
        self.last_audio_at = self.clock()
        self.settled = False

    def played_out(self) -> None:
        """Telnyx has played everything pushed so far (a momentary dry gap too)."""
        self.settled = True

    def settled_now(self) -> bool:
        return self.settled

    def last_audio(self) -> float | None:
        return self.last_audio_at


def make_drain(clock: FakeClock) -> GoodbyeDrain:
    return GoodbyeDrain(clock=clock, sleep=clock.sleep)


class GoodbyeDrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_goodbye_that_already_played_hangs_up_at_once(self):
        clock = FakeClock()
        playout = Playout(clock)
        playout.audio_arrived()
        playout.played_out()
        clock.now += 5.0  # the line finished sounding a while ago

        outcome = await make_drain(clock).drain(
            playback_settled=playout.settled_now,
            last_audio_at=playout.last_audio,
        )

        self.assertEqual(outcome.waited_ms, 0)
        self.assertEqual(outcome.polls, 0)

    async def test_a_goodbye_still_sounding_is_never_cut(self):
        # Browser parity: "hangup waits through flapping playback instead of
        # one settled poll". The fixed playout estimate this replaces slept a
        # computed tail and closed whether or not the last word had played.
        clock = FakeClock()
        playout = Playout(clock)
        playout.audio_arrived()
        playout.settled = False
        drain = make_drain(clock)
        task = asyncio.create_task(
            drain.drain(
                playback_settled=playout.settled_now,
                last_audio_at=playout.last_audio,
            )
        )

        await clock.tick(4)  # 1s of goodbye still playing
        self.assertFalse(task.done(), "hung up while the goodbye was sounding")

        playout.played_out()  # the last chunk has played
        drained_at = clock.now
        await clock.tick(4)  # three settled polls plus the audio grace
        self.assertTrue(task.done(), "the call never closed after the goodbye drained")
        outcome = task.result()
        self.assertEqual(outcome.reason, "drained")
        # The browser's goodbye-drain budget, measured from the last audio:
        # ~750ms (three polls of grace-passed silence) and never past 1500ms.
        closed_after_ms = int((clock.now - drained_at) * 1000)
        self.assertGreaterEqual(closed_after_ms, 750)
        self.assertLessEqual(closed_after_ms, 1500)

    async def test_a_jittery_link_never_chops_the_last_word(self):
        # Browser parity: "a jittery goodbye: late audio restarts the drain
        # streak, and the call still closes inside the budget". A jittery link
        # reports settled between chunks while the last word is still
        # travelling, and a late chunk can land after reply.done.
        clock = FakeClock()
        playout = Playout(clock)
        playout.audio_arrived()
        drain = make_drain(clock)
        task = asyncio.create_task(
            drain.drain(
                playback_settled=playout.settled_now,
                last_audio_at=playout.last_audio,
            )
        )

        await clock.tick()  # 250ms: still sounding
        playout.played_out()  # a dry gap between chunks at 250ms
        await clock.tick(2)  # 500ms and 750ms: two settled polls, one short
        self.assertFalse(task.done(), "two settled polls never chop the goodbye")

        # A late chunk lands after reply.done: the grace and the streak restart.
        playout.audio_arrived()
        late_audio_at = clock.now
        await clock.tick()  # 1000ms: still sounding
        playout.played_out()
        await clock.tick(2)  # 1250ms and 1500ms: two settled polls since
        self.assertFalse(task.done(), "the late chunk restarted the streak")

        await clock.tick()  # 1750ms: third settled poll after the last audio
        self.assertTrue(task.done(), "the call never closed once it drained")
        closed_after_ms = int((clock.now - late_audio_at) * 1000)
        self.assertGreaterEqual(closed_after_ms, 750)
        self.assertLessEqual(closed_after_ms, 1500, "inside the drain budget")

    async def test_fresh_audio_resets_the_streak_even_when_playback_reads_settled(self):
        # Browser parity: "hangup waits out fresh audio even when playback
        # reports settled". Audio still travelling to the carrier sounds after
        # the settled report; stop too early and the last word is cut.
        clock = FakeClock()
        playout = Playout(clock)
        playout.audio_arrived()
        drain = make_drain(clock)
        task = asyncio.create_task(
            drain.drain(
                playback_settled=playout.settled_now,
                last_audio_at=playout.last_audio,
            )
        )

        playout.played_out()  # the buffer reads empty throughout
        await clock.tick()  # 250ms: one settled poll
        self.assertFalse(task.done())

        playout.audio_arrived()  # a fresh chunk lands at 250ms
        playout.played_out()  # and the buffer reads empty again at once
        await clock.tick()  # 500ms: too soon after that audio
        self.assertFalse(task.done(), "closed inside the audio grace")
        await clock.tick(3)  # 750ms, 1000ms, 1250ms: three settled polls
        self.assertTrue(task.done(), "the call never closed after the streak")
        self.assertEqual(task.result().reason, "drained")

    async def test_a_goodbye_that_never_started_hangs_up_at_once(self):
        # The browser's other fail-safe: nothing to wait for when no audio was
        # ever pushed. A missing goodbye must not hold the line for 10s.
        clock = FakeClock()
        playout = Playout(clock)
        playout.played_out()

        outcome = await make_drain(clock).drain(
            playback_settled=playout.settled_now,
            last_audio_at=playout.last_audio,
        )

        self.assertEqual(outcome.waited_ms, 0)
        self.assertEqual(outcome.polls, 0)

    async def test_a_playout_that_never_drains_hits_the_bounded_timeout(self):
        # The fail-safe: END_CALL_DRAIN_TIMEOUT_MS, never the line held open.
        clock = FakeClock()
        playout = Playout(clock)
        playout.audio_arrived()
        drain = make_drain(clock)
        task = asyncio.create_task(
            drain.drain(
                playback_settled=playout.settled_now,  # never settles
                last_audio_at=playout.last_audio,
            )
        )

        await clock.tick(40)  # 10s: still polling, never closed early
        self.assertFalse(task.done())
        await clock.tick(2)  # the poll after the timeout fires it
        self.assertTrue(task.done(), "a stuck playout held the line forever")
        outcome = task.result()
        self.assertEqual(outcome.reason, "timeout")
        self.assertGreaterEqual(outcome.waited_ms, GOODBYE_DRAIN_TIMEOUT_MS)
        self.assertLessEqual(
            outcome.waited_ms, GOODBYE_DRAIN_TIMEOUT_MS + GOODBYE_POLL_MS
        )


class PlayoutProbeTests(unittest.TestCase):
    """The phone's "nothing left to play" reading: Telnyx buffers what we push."""

    def stats(self, **overrides):
        stats = {
            "pending": bytearray(),
            "first_audio_at": None,
            "reply_bytes": 0,
            "last_audio_at": None,
        }
        stats.update(overrides)
        return stats

    def test_pushed_audio_is_not_played_audio(self):
        # 2s of goodbye handed to Telnyx: at 1s it is still sounding.
        stats = self.stats(first_audio_at=100.0, reply_bytes=2 * 8000)
        self.assertFalse(playout_settled(stats, 101.0))
        self.assertTrue(playout_settled(stats, 102.0))
        self.assertTrue(playout_settled(stats, 103.0))

    def test_a_held_partial_frame_is_still_going_to_play(self):
        stats = self.stats(
            first_audio_at=100.0,
            reply_bytes=8000,
            pending=bytearray(b"\xff" * 40),
        )
        self.assertFalse(playout_settled(stats, 105.0))

    def test_a_reply_with_no_audio_at_all_is_already_played(self):
        self.assertTrue(playout_settled(self.stats(), 100.0))


class BrowserParityTests(unittest.TestCase):
    """ADR 0007: the two implementations are pinned to one set of numbers."""

    def test_the_drain_constants_match_the_browser_budget_record(self):
        # The browser's live handshake (session.ts) and this bridge's copy are
        # independently implemented, so the record is the only place the
        # numbers can be read as one. Drift fails here instead of on a call.
        budgets = (
            pathlib.Path(__file__).resolve().parent.parent
            / "voni/src/lib/demo/scoreboard-budgets.ts"
        )
        source = budgets.read_text()
        for key, ours in (
            ("endCallPollMs", GOODBYE_POLL_MS),
            ("endCallSettlePolls", GOODBYE_SETTLE_POLLS),
            ("endCallAudioGraceMs", GOODBYE_AUDIO_GRACE_MS),
            ("endCallDrainTimeoutMs", GOODBYE_DRAIN_TIMEOUT_MS),
        ):
            match = re.search(
                rf"{key}:\s*\{{\s*value:\s*([0-9_]+)", source
            )
            self.assertIsNotNone(match, f"{key} missing from the budget record")
            self.assertEqual(
                int(match.group(1).replace("_", "")),
                ours,
                f"{key} drifted from the browser's end-call drain",
            )


class FakeAgentStream:
    """Scripted agent events, delivered one `async for` step at a time."""

    def __init__(self, events):
        self.events = list(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.events:
            raise StopAsyncIteration
        return json.dumps(self.events.pop(0))


class FakeTelnyxSocket:
    def __init__(self):
        self.frames = []

    async def send_text(self, raw):
        message = json.loads(raw)
        if message.get("event") == "media":
            self.frames.append(base64.b64decode(message["media"]["payload"]))


class StubTools:
    """The coordinator as `agent_to_telnyx` sees it: hangup armed on reply.done."""

    async def handle_event(self, event):
        return False

    def take_hangup_request(self):
        return True


def bridge_stats():
    """The frame counters `agent_to_telnyx` expects (see media_stream)."""
    return {
        "call_control_id": "call-1",
        "to_agent": 0, "to_caller": 0, "skipped_track": 0,
        "speech_started": 0, "cleared": 0,
        "backchannels": 0, "user_yields": 0, "overheard": 0, "speaking": False,
        "reply_started_at": None, "first_audio_at": None, "speech_at": None,
        "last_audio_at": None, "reply_bytes": 0, "ttfa_seen": [],
        "stalls": 0, "worst_stall": 0.0,
        "pending": bytearray(),
        "first_in": None, "last_in": None,
    }


class BridgeHangupTests(unittest.IsolatedAsyncioTestCase):
    """The hang-up path itself, not just the handshake it calls."""

    async def test_the_phone_path_plays_the_goodbye_out_before_it_closes(self):
        # The estimate this replaced slept `pushed - played` and closed. At
        # reply.done that tail is nearly zero (the agent generates at 1x), so
        # the closing word was still travelling when the legs went down.
        with mock.patch.dict(os.environ, {"PUBLIC_HOST": "bridge.test"}):
            server = importlib.import_module("server")
        goodbye = b"\x00" * 1600  # 0.2s of G.711 at 8 kHz
        events = [
            {"type": "reply.started", "reply_id": "bye"},
            {
                "type": "reply.audio",
                "reply_id": "bye",
                "data": base64.b64encode(goodbye).decode(),
            },
            {"type": "reply.done", "reply_id": "bye", "status": "completed"},
        ]
        telnyx = FakeTelnyxSocket()
        started = time.monotonic()
        task = asyncio.create_task(
            server.agent_to_telnyx(
                FakeAgentStream(events), telnyx, bridge_stats(), StubTools()
            )
        )

        await asyncio.sleep(0.42)
        self.assertFalse(
            task.done(),
            "tore the call down inside the drain (the old tail estimate did)",
        )
        await asyncio.wait_for(task, timeout=3)
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(
            elapsed, 0.75, "closed before the settled streak and the audio grace"
        )
        # The caller got every byte we pushed: the goodbye plays in full.
        self.assertGreaterEqual(sum(len(frame) for frame in telnyx.frames), len(goodbye))


if __name__ == "__main__":
    unittest.main()
