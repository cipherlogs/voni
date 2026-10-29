"""Unheard-tail barge-in recovery on the phone bridge (voice-parity 70).

The browser owns the design (docs/adr/0003-barge-in-recovery.md): after a
barge-in the session re-says exactly the unheard rest of the cut line, and a
filler resumes instead of restarting. The phone bridge keeps its own
implementation (ADR 0007) but is pinned to the same behaviour, and the case
table below is shared with the browser's test:
`voni/src/lib/voice/barge-in-recovery.cases.json`.

The seam is the bridge's own event loop, `agent_to_telnyx`, over fake sockets:
what the caller heard is what it sends to Telnyx, and what the agent is told to
do next is the `reply.create` it sends back.
"""

import asyncio
import base64
import json
import time
import unittest
from pathlib import Path
from unittest import mock

import barge_in_recovery as recovery
import server

CASES_PATH = (
    Path(__file__).resolve().parents[1]
    / "voni"
    / "src"
    / "lib"
    / "voice"
    / "barge-in-recovery.cases.json"
)

LINE = "I'd handle booking and reminders for you"
# The browser cut the line at 14 caption characters: the caller heard through
# "booking" (see session-lifecycle.test.ts, playMs(14 * CAPTION_MS_PER_CHAR)).
PLAYED_MS = 812


def cases():
    return json.loads(CASES_PATH.read_text())["cases"]


def case(name):
    return next(entry for entry in cases() if name in entry["name"])


def audio(payload: bytes = b"\xff" * 320) -> str:
    return base64.b64encode(payload).decode()


class FakeTelnyxSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, raw):
        self.sent.append(json.loads(raw))

    def named(self, name):
        return [message for message in self.sent if message.get("event") == name]


class ListAgentSocket:
    """The agent leg as a fixed event stream (the test controls the clock)."""

    def __init__(self, events):
        self._events = events
        self.sent = []

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for event in self._events:
            yield json.dumps(event)

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def reply_creates(self):
        return [message for message in self.sent if message.get("type") == "reply.create"]


class QueueAgentSocket:
    """The agent leg as a queue, for the timer paths: the test can wait."""

    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []

    def push(self, event):
        self.queue.put_nowait(event)

    def end(self):
        self.queue.put_nowait(None)

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        while True:
            event = await self.queue.get()
            if event is None:
                return
            yield json.dumps(event)

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def reply_creates(self):
        return [message for message in self.sent if message.get("type") == "reply.create"]


class StubTools:
    async def handle_event(self, event):
        return None

    def take_hangup_request(self):
        return False


def cut_events(played_ms: float = PLAYED_MS, line: str = LINE):
    """The reply up to the barge-in, the cut, and the caller's words.

    `transcript.agent` is the platform's full line (generation finished before
    the audio had played out), and `speech_at` is moved back so the bridge sees
    `played_ms` of it in the caller's ear — the same estimate the bridge already
    trusts for its goodbye drain.
    """

    def events(stats):
        yield {"type": "reply.started", "reply_id": "r1"}
        yield {"type": "transcript.agent", "reply_id": "r1", "text": line}
        stats["speech_at"] = time.monotonic() - played_ms / 1000.0
        yield {"type": "reply.done", "reply_id": "r1", "status": "interrupted"}

    return events


async def run(events, stats):
    agent = ListAgentSocket(events)
    telnyx = FakeTelnyxSocket()
    await asyncio.wait_for(
        server.agent_to_telnyx(agent, telnyx, stats, StubTools()), timeout=2
    )
    return agent, telnyx


class BargeInTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_barge_in_marks_the_unheard_tail_instead_of_dropping_it(self):
        stats = server.call_stats("cc-test")

        _, telnyx = await run(cut_events()(stats), stats)

        self.assertEqual(stats["barge_in"]["heard"], "I'd handle booking")
        self.assertEqual(
            stats["barge_in"]["rest"], "booking and reminders for you"
        )
        self.assertEqual(stats["unheard_tails"], 1)
        # The stale audio is still dropped (the caller talked over it)…
        self.assertEqual(len(telnyx.named("clear")), 1)
        # …and the tail is kept, not lost with the buffer.
        self.assertIsNotNone(stats["barge_in"])

    async def test_a_filler_barge_in_resumes_the_exact_unheard_tail(self):
        expected = case("filler barge-in resumes")["instruction"]
        stats = server.call_stats("cc-test")

        def events():
            yield from cut_events()(stats)
            yield {"type": "transcript.user", "item_id": "u1", "text": "Okaay so"}
            # The platform answers the back-channel as a turn; the bridge
            # supersedes it before any of it plays.
            yield {"type": "reply.started", "reply_id": "r2"}
            yield {"type": "reply.audio", "reply_id": "r2", "data": audio()}

        agent, telnyx = await run(events(), stats)

        creates = agent.reply_creates()
        self.assertEqual(len(creates), 1, agent.sent)
        self.assertEqual(creates[0]["instructions"], expected)
        self.assertNotIn("I'd handle", creates[0]["instructions"])
        self.assertIn('word for word: "booking and reminders for you"', creates[0]["instructions"])
        # The answer to a filler is never heard: its audio is suppressed and
        # the bridge tells Telnyx to drop what it queued.
        self.assertEqual(telnyx.named("media"), [])
        self.assertEqual(len(telnyx.named("clear")), 2)
        self.assertEqual(stats["resumes"], 1)
        self.assertEqual(stats["suppressed_audio"], 1)
        self.assertIsNone(stats["barge_in"])


class BargeInVerdictTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_real_barge_in_is_answered_not_resumed(self):
        stats = server.call_stats("cc-test")

        def events():
            yield from cut_events()(stats)
            yield {"type": "transcript.user", "item_id": "u1", "text": "Wait, stop."}
            # A real point: the platform answers it as a normal turn.
            yield {"type": "reply.started", "reply_id": "r2"}
            yield {"type": "reply.audio", "reply_id": "r2", "data": audio()}

        agent, telnyx = await run(events(), stats)

        self.assertEqual(agent.reply_creates(), [], "steering is never resumed")
        self.assertEqual(stats["barge_in_yields"], 1)
        self.assertEqual(stats["resumes"], 0)
        self.assertEqual(stats["suppressed_audio"], 0)
        # The answer is heard: two whole 20 ms frames.
        self.assertEqual(len(telnyx.named("media")), 2)

    async def test_a_short_tail_after_a_cut_says_nothing_more(self):
        stats = server.call_stats("cc-test")

        def events():
            yield from cut_events(played_ms=232, line="Let me check now.")(stats)
            yield {"type": "transcript.user", "item_id": "u1", "text": "okay"}
            yield {"type": "reply.started", "reply_id": "r2"}

        agent, _ = await run(events(), stats)

        self.assertEqual(agent.reply_creates(), [], "the caller got the point")
        self.assertEqual(stats["short_tails"], 1)
        # The tail is still marked: it was heard-word short, not lost.
        self.assertEqual(stats["unheard_tails"], 1)

    async def test_a_line_that_played_out_is_not_resumed(self):
        stats = server.call_stats("cc-test")

        def events():
            yield from cut_events(played_ms=60000, line="Ready?")(stats)
            yield {"type": "transcript.user", "item_id": "u1", "text": "mm-hmm"}
            yield {"type": "reply.started", "reply_id": "r2"}

        agent, _ = await run(events(), stats)

        self.assertEqual(agent.reply_creates(), [])
        self.assertEqual(stats["unheard_tails"], 0)
        self.assertEqual(stats["short_tails"], 1)


class NoWordsTests(unittest.IsolatedAsyncioTestCase):
    async def _drive(self, follow_up=(), wait_s=0.02):
        stats = server.call_stats("cc-test")
        agent = QueueAgentSocket()
        telnyx = FakeTelnyxSocket()
        with mock.patch.object(server, "NO_WORDS_RESUME_S", wait_s):
            task = asyncio.create_task(
                server.agent_to_telnyx(agent, telnyx, stats, StubTools())
            )
            # Start the reply and let the bridge see its full line before the
            # clock moves: `reply.started` clears the played-time anchor.
            agent.push({"type": "reply.started", "reply_id": "r1"})
            agent.push({"type": "transcript.agent", "reply_id": "r1", "text": LINE})
            await asyncio.sleep(0.01)
            stats["speech_at"] = time.monotonic() - PLAYED_MS / 1000.0
            agent.push({"type": "reply.done", "reply_id": "r1", "status": "interrupted"})
            for event in follow_up:
                agent.push(event)
            await asyncio.sleep(0.06)
            agent.end()
            await asyncio.wait_for(task, timeout=2)
        return agent, telnyx, stats

    async def test_a_noise_with_no_words_still_resumes_the_tail(self):
        expected = case("noise with no caller words")["instruction"]

        agent, telnyx, stats = await self._drive()

        creates = agent.reply_creates()
        self.assertEqual(len(creates), 1, agent.sent)
        self.assertEqual(creates[0]["instructions"], expected)
        self.assertEqual(stats["resumes"], 1)
        self.assertEqual(len(telnyx.named("clear")), 2)

    async def test_the_caller_words_supersede_the_noise_resume_once(self):
        expected = case("filler barge-in resumes")["instruction"]

        agent, _, stats = await self._drive(
            follow_up=(
                {"type": "transcript.user", "item_id": "u1", "text": "Okaay so"},
                {"type": "reply.started", "reply_id": "r2"},
            )
        )

        creates = agent.reply_creates()
        self.assertEqual(len(creates), 1, "the tail is said exactly once")
        self.assertEqual(creates[0]["instructions"], expected)
        self.assertEqual(stats["resumes"], 1)
        self.assertEqual(stats["short_tails"], 0)


class SharedCaseTests(unittest.TestCase):
    def test_the_table_is_the_one_the_browser_pins(self):
        fixture = json.loads(CASES_PATH.read_text())
        self.assertEqual(fixture["contract"], recovery.CONTRACT)
        self.assertGreaterEqual(len(fixture["cases"]), 6)

    def test_every_recorded_case_matches_the_phone_bridge(self):
        for entry in cases():
            with self.subTest(entry["name"]):
                self.assertEqual(
                    recovery.heard_words(entry["line"], entry["playedMs"]),
                    entry["heard"],
                )
                self.assertEqual(
                    recovery.unheard_rest(entry["line"], entry["heard"]),
                    entry["rest"],
                )
                self.assertEqual(
                    recovery.resume_for_barge_in(entry["callerText"], entry["rest"]),
                    entry["instruction"],
                )


class TailTests(unittest.TestCase):
    def test_a_cut_marks_the_tail_and_never_the_heard_part(self):
        cut = recovery.cut_tail("I'd handle booking and reminders for you", 812)
        self.assertEqual(cut["heard"], "I'd handle booking")
        self.assertEqual(cut["rest"], "booking and reminders for you")
        self.assertTrue(cut["resumable"])
        self.assertNotIn(cut["heard"], cut["rest"])

    def test_a_cut_with_nothing_heard_resumes_the_whole_line(self):
        cut = recovery.cut_tail("Let me check that for you", 0)
        self.assertEqual(cut["heard"], "Let")
        self.assertEqual(cut["rest"], "Let me check that for you")

    def test_an_empty_line_leaves_nothing_to_resume(self):
        cut = recovery.cut_tail("", 5000)
        self.assertEqual(cut, {"heard": "", "rest": "", "resumable": False})
