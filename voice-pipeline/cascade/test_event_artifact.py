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
from unittest import mock

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

    def test_a_write_failure_disables_the_artifact_and_never_raises(self):
        line = json.dumps({"type": "greeting.start"})

        with mock.patch.object(
            Path, "open", side_effect=PermissionError(13, "Permission denied")
        ):
            self.log(line)

        self.assertIn("cannot write the events artifact", self.log.unavailable or "")
        self.assertIsNone(self.log.path)
        # Once disabled, the sink makes no further attempt and still returns.
        self.log(line)
        self.assertIn("cannot write the events artifact", self.log.unavailable or "")


class EndMessagePathTests(unittest.TestCase):
    def _run(self, events) -> tuple[dict, FakeTransport]:
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

        transport = FakeTransport([BrowserStop()])
        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=FakeStream(),
            send_audio=RecordingAudioSink(),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            operational_events=events,
        )
        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
        return end.to_document(), transport

    def test_the_end_message_names_the_calls_event_file(self):
        directory = tempfile.mkdtemp(prefix="cascade-events-")
        log = CallEventLog(directory, call_id=CALL_ID)
        ops = OperationalEvents(
            EventStream(EventWriter(pipeline="cascade", call_id=CALL_ID), sink=log),
            subject="demo anna (en, browser)",
            now=lambda: 0.0,
        )

        document, _ = self._run(ops)

        self.assertEqual(str(log.path), document["eventsPath"])
        self.assertTrue(Path(document["eventsPath"]).exists())
        self.assertNotIn("eventsError", document)
        self.assertTrue(
            any(row["type"] == "greeting.start" for row in map(json.loads, Path(log.path).read_text().splitlines()))
        )

    def test_an_unwritable_events_directory_never_fails_the_call(self):
        parent = Path(tempfile.mkdtemp(prefix="cascade-events-"))
        blocked = parent / "not-a-directory"
        blocked.write_text("a file, not a directory", encoding="utf-8")
        log = CallEventLog(blocked, call_id=CALL_ID)
        self.assertIsNone(log.path, "a failed artifact still claimed a path")

        ops = OperationalEvents(
            EventStream(EventWriter(pipeline="cascade", call_id=CALL_ID), sink=log),
            subject="demo anna (en, browser)",
            now=lambda: 0.0,
        )

        document, transport = self._run(ops)

        # The call ran to its own end and the caller got the end message.
        self.assertEqual("stop", document["endedBy"])
        self.assertEqual("end", transport.sent[-1]["type"])
        # The unavailable artifact is named by reason, not claimed as a file.
        self.assertNotIn("eventsPath", document)
        self.assertIn("cannot create the events directory", document["eventsError"])
        self.assertIn("not-a-directory", document["eventsError"])


if __name__ == "__main__":
    unittest.main()
