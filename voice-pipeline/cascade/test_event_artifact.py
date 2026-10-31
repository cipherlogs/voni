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
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cascade.call import CallLifecycle, OpenedLeg
from cascade.events import (
    CallEventLog,
    EventEnvelopeError,
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


DEMO_CALL_ID = "5b0f5c9a-4e2a-4a2b-9c3d-1f2e3a4b5c6d"
DEMO_SUBJECT = "demo:audrey"


class DemoTraceArtifactTests(unittest.TestCase):
    """Ticket 17: a demo call's trace is keyed by call id and names its subject.

    The trace belongs to the demo call, not to the subject: the file stem is the
    call id the demo already has, so one call — including a hold return — has
    one artifact. Every line that carries a subject names ``demo:<voice>``; the
    stream refuses a tenant subject, a managed agent id and a bare voice id
    before anything is written, because a demo trace naming the wrong subject
    would be evidence of a call that never happened.
    """

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-demo-trace-")
        patched = mock.patch.dict(
            os.environ, {"VOICE_PIPELINE_EVENTS_DIR": self.directory}
        )
        patched.start()
        self.addCleanup(patched.stop)

    def demo_events(
        self, call_id: str = DEMO_CALL_ID, subject: str = DEMO_SUBJECT
    ) -> OperationalEvents:
        from server import operational_events_for

        return operational_events_for(call_id, subject, kind="demo")

    def lines(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def test_a_demo_call_writes_one_trace_keyed_by_call_id_and_naming_its_subject(self):
        events = self.demo_events()
        events.greeting("greeting.start", voice_id="audrey")
        events.greeting("greeting.done", voice_id="audrey", frames=1)

        path = Path(events.path)
        self.assertEqual(DEMO_CALL_ID, path.stem, "the trace is keyed by the call id")
        self.assertNotEqual(DEMO_SUBJECT, path.stem, "the subject is not the trace key")
        rows = self.lines(path)

        self.assertEqual(
            ["greeting.start", "greeting.done"], [row["type"] for row in rows]
        )
        self.assertTrue(all(row["callId"] == DEMO_CALL_ID for row in rows))
        self.assertEqual(
            [DEMO_SUBJECT, DEMO_SUBJECT], [row["subject"] for row in rows]
        )

    def test_every_demo_line_names_the_subject_even_an_operational_one(self):
        from cascade.breaker import BreakerTransition, BreakerTrigger

        events = self.demo_events()
        events.greeting("greeting.start", voice_id="audrey")
        events.breaker_transition(
            BreakerTransition(
                leg="llm",
                from_state="closed",
                to_state="open",
                trigger=BreakerTrigger(kind="failure", code=1013, phase="stream", turn=3),
                reason="closed -> open: abnormal socket close",
                at=4.0,
                record_version=2,
            )
        )
        events.deploy_drain(reason="deploy 2026.10.31")

        path = Path(events.path)
        rows = self.lines(path)
        self.assertEqual(
            ["greeting.start", "breaker.transition", "deploy.drain"],
            [row["type"] for row in rows],
        )
        self.assertEqual(
            [DEMO_SUBJECT, DEMO_SUBJECT, DEMO_SUBJECT],
            [row["subject"] for row in rows],
            "every demo line names demo:<voice>, operational lines included",
        )
        self.assertEqual("llm", rows[1]["leg"], "an operational line keeps its leg")
        self.assertNotIn("turn", rows[1])

    def test_a_demo_operational_line_without_a_subject_is_refused_at_the_boundary(self):
        log = CallEventLog(self.directory, call_id=DEMO_CALL_ID)
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=DEMO_CALL_ID),
            sink=log,
            subject_kind="demo",
        )

        with self.assertRaises(EventEnvelopeError) as raised:
            stream.operational(
                "breaker.transition", leg="llm", at_ms=4200, phase="turn"
            )

        self.assertEqual("subject", raised.exception.field)
        self.assertFalse(Path(log.path).exists(), "a refused line was written")

    def test_a_hold_return_with_the_same_call_id_appends_to_the_same_trace(self):
        self.demo_events().greeting("greeting.start", voice_id="audrey")
        resumed = self.demo_events()  # the hold return mints again, same call id
        resumed.greeting("greeting.done", voice_id="audrey", frames=1)

        files = list(Path(self.directory).glob("*.jsonl"))
        self.assertEqual(1, len(files), "a hold return opened a second artifact")
        self.assertEqual(DEMO_CALL_ID, files[0].stem)
        self.assertEqual(
            ["greeting.start", "greeting.done"],
            [row["type"] for row in self.lines(files[0])],
        )

    def test_a_demo_stream_refuses_a_tenant_subject_a_managed_agent_id_or_a_bare_voice_id(self):
        for refused in ("agent_transport_65", "demo anna (en, browser)", "audrey"):
            with self.subTest(subject=refused):
                directory = tempfile.mkdtemp(prefix="cascade-demo-trace-")
                log = CallEventLog(directory, call_id=DEMO_CALL_ID)
                stream = EventStream(
                    EventWriter(pipeline="cascade", call_id=DEMO_CALL_ID),
                    sink=log,
                    subject_kind="demo",
                )

                with self.assertRaises(EventEnvelopeError) as raised:
                    OperationalEvents(stream, subject=refused, now=lambda: 0.0)

                self.assertEqual("subject", raised.exception.field)
                self.assertFalse(
                    Path(log.path).exists(), "a refused subject wrote a line"
                )

    def test_a_tenant_stream_keeps_its_existing_subject_behaviour(self):
        log = CallEventLog(self.directory, call_id="call_tenant_17")
        events = OperationalEvents(
            EventStream(
                EventWriter(pipeline="cascade", call_id="call_tenant_17"),
                sink=log,
                subject_kind="tenant",
            ),
            subject="agent_transport_65",
            now=lambda: 0.0,
        )
        events.greeting("greeting.start", voice_id="lola")

        rows = self.lines(Path(log.path))
        self.assertEqual("call_tenant_17", Path(log.path).stem)
        self.assertEqual(["agent_transport_65"], [row["subject"] for row in rows])

    def test_a_demo_line_is_refused_at_the_write_boundary_too(self):
        log = CallEventLog(self.directory, call_id=DEMO_CALL_ID)
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=DEMO_CALL_ID),
            sink=log,
            subject_kind="demo",
        )

        with self.assertRaises(EventEnvelopeError) as raised:
            stream(
                {
                    "type": "greeting.start",
                    "callId": DEMO_CALL_ID,
                    "subject": "agent_transport_65",
                }
            )

        self.assertEqual("subject", raised.exception.field)
        self.assertFalse(Path(log.path).exists(), "a refused line was written")


if __name__ == "__main__":
    unittest.main()
