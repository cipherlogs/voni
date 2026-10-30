"""Operational events reach a per-call artifact (ticket 110's persisted stream).

Seam: :class:`cascade.events.CallEventLog` is the one file sink; every line
still goes through :class:`cascade.events.EventStream`, so the shared sanitizer
runs before anything is written. One JSONL file per call under
``voice-pipeline/.events/`` (gitignored), and the end message names its path.

The refusal test is the anti-lie one: a line carrying caller text or audio is
refused by name and writes nothing, so the artifact can never become a second
transcript store.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from cascade.call import CallLifecycle, OpenedLeg
from cascade.events import (
    CallEventLog,
    EventStream,
    EventWriter,
    ForbiddenEventKey,
    OperationalEvents,
)
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    BrowserStop,
    FakeStream,
    FakeTransport,
    FakeVoice,
    RecordingAudioSink,
    signed_message,
)
from cascade.testing import FakeClock, ScriptedSTT
from cascade.sanitizer import FORBIDDEN_EVENT_KEYS


class EventLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-events-")
        self.log = CallEventLog(self.directory, call_id=CALL_ID)
        self.stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID), sink=self.log
        )
        self.events = OperationalEvents(
            self.stream, subject="demo anna (en, browser)", now=lambda: 0.0
        )

    def lines(self) -> list[dict]:
        return [
            json.loads(line)
            for line in Path(self.log.path).read_text().splitlines()
            if line
        ]

    def test_one_jsonl_file_per_call_parses_and_carries_no_audio_or_text(self):
        self.events.greeting("greeting.start", voice_id="lola")
        self.events.deploy_drain(reason="deploy 2026.10.30: readiness failed")

        self.assertTrue(Path(self.log.path).exists())
        self.assertEqual(CALL_ID, Path(self.log.path).stem)
        rows = self.lines()

        self.assertEqual(
            ["greeting.start", "deploy.drain"], [row["type"] for row in rows]
        )
        self.assertTrue(all(row["callId"] == CALL_ID for row in rows))
        for row in rows:
            self.assertFalse(
                FORBIDDEN_EVENT_KEYS & {key.lower() for key in row},
                f"the artifact carried a forbidden key: {sorted(row)}",
            )

    def test_a_forbidden_key_is_refused_by_name_and_writes_nothing(self):
        self.events.greeting("greeting.start", voice_id="lola")
        before = len(self.lines())

        with self.assertRaises(ForbiddenEventKey) as raised:
            self.stream({"type": "greeting.start", "text": "the caller's words"})

        self.assertEqual("text", raised.exception.keys[0])
        self.assertEqual(before, len(self.lines()), "a refused line was written")


class EndMessagePathTests(unittest.TestCase):
    def test_the_end_message_names_the_calls_event_file(self):
        directory = tempfile.mkdtemp(prefix="cascade-events-")
        log = CallEventLog(directory, call_id=CALL_ID)
        ops = OperationalEvents(
            EventStream(EventWriter(pipeline="cascade", call_id=CALL_ID), sink=log),
            subject="demo anna (en, browser)",
            now=lambda: 0.0,
        )
        clock = FakeClock()

        async def open_speech(_body):
            return OpenedLeg(
                "stt",
                "meta",
                "primary",
                "speech leg",
                ScriptedSTT([], clock=clock),
            )

        async def open_voice(_body):
            return OpenedLeg("tts", "assemblyai", "primary", "voice leg", FakeVoice())

        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=FakeTransport([BrowserStop()]),
            open_speech=open_speech,
            open_voice=open_voice,
            stream=FakeStream(),
            send_audio=RecordingAudioSink(),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            operational_events=ops,
            events_path=log.path,
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
        document = end.to_document()

        self.assertEqual(str(log.path), document["eventsPath"])
        self.assertTrue(Path(document["eventsPath"]).exists())
        self.assertTrue(
            any(row["type"] == "greeting.start" for row in map(json.loads, Path(log.path).read_text().splitlines()))
        )


if __name__ == "__main__":
    unittest.main()
