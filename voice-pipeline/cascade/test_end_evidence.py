"""Every cascade call keeps its end document beside its trace (demo-verification 03).

Seam: :class:`cascade.call.CallLifecycle` runs to its end message; the test then
reads the trace JSONL and the sidecar the call wrote, so it asserts the
evidence a reader will find rather than an internal write call. The sidecar is
the exact document the client received, and the trace carries exactly one
``end`` row for the call, keyed by the same call id.

The failure paths are the point of the ticket: a refused, failed or dropped
call still leaves an end document naming ``endedBy`` and the error, and an
unwritable evidence directory is named on the end message instead of silently
skipping the record.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from cascade.assemblyai_tts import Billing
from cascade.call import CallLifecycle, OpenedLeg
from cascade.events import (
    CallEventLog,
    EventStream,
    EventWriter,
    OperationalEvents,
)
from cascade.meta_llm import TurnUsage
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    BrowserStop,
    FakeStream,
    FakeTransport,
    FakeVoice,
    MeteringStream,
    MeteringVoice,
    RecordingAudioSink,
    signed_message,
)
from cascade.testing import FakeClock, ScriptedSTT

SUBJECT = "demo:audrey"


class EndEvidenceTests(unittest.TestCase):
    """One call id, one trace, one end row and one final end document."""

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-end-")

    def events_for(self) -> OperationalEvents:
        log = CallEventLog(self.directory, call_id=CALL_ID)
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=CALL_ID),
            sink=log,
            subject_kind="demo",
        )
        return OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0)

    def run_call(
        self,
        events: OperationalEvents,
        *,
        inputs=(),
        message: dict | None = None,
        stream: FakeStream | None = None,
        voice: FakeVoice | None = None,
        metered: bool = False,
        characters: int = 40,
        speech_seconds: float = 3.7,
    ) -> tuple[dict, FakeTransport]:
        clock = FakeClock()
        speech = ScriptedSTT([], clock=clock)
        voice_session = voice if voice is not None else FakeVoice()
        turn_stream = stream if stream is not None else FakeStream()
        if metered:
            speech.usage = {"audio_duration_seconds": speech_seconds}
            voice_session = MeteringVoice(
                Billing(
                    characters=characters,
                    measured=True,
                    source="billed_characters",
                    audio_duration_seconds=2.5,
                    session_duration_seconds=4,
                )
            )
            turn_stream = MeteringStream(
                {
                    "t1": TurnUsage(
                        prompt_tokens=1000,
                        completion_tokens=100,
                        cached_tokens=200,
                        reasoning_tokens=0,
                        measured=True,
                    )
                }
            )

        async def open_speech(_body):
            return OpenedLeg(
                "stt",
                "meta",
                "primary",
                "speech leg",
                speech,
            )

        async def open_voice(_body):
            return OpenedLeg(
                "tts",
                "assemblyai",
                "primary",
                "voice leg",
                voice_session,
            )

        transport = FakeTransport(list(inputs))
        lifecycle = CallLifecycle(
            message=signed_message() if message is None else message,
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=turn_stream,
            send_audio=RecordingAudioSink(),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            operational_events=events,
        )
        asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
        return transport.sent[-1], transport

    def trace_rows(self) -> list[dict]:
        path = Path(self.directory) / f"{CALL_ID}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def sidecar(self) -> dict:
        path = Path(self.directory) / f"{CALL_ID}.end.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_a_completed_call_writes_one_end_row_and_one_sidecar_beside_the_trace(self):
        sent, _ = self.run_call(self.events_for(), inputs=[BrowserStop()])

        trace = Path(self.directory) / f"{CALL_ID}.jsonl"
        self.assertEqual(CALL_ID, trace.stem, "the trace is keyed by the call id")

        ends = [row for row in self.trace_rows() if row["type"] == "end"]
        self.assertEqual(1, len(ends), "a completed call has exactly one end row")
        row = ends[0]
        self.assertEqual(CALL_ID, row["callId"])
        self.assertEqual("end", row["phase"])
        self.assertEqual("stop", row["endedBy"])

        sidecar = Path(self.directory) / f"{CALL_ID}.end.json"
        self.assertTrue(sidecar.exists(), "the end document was not written beside the trace")
        document = self.sidecar()

        self.assertEqual(sent, document, "the sidecar is not the message the client received")
        for key in (
            "metrics",
            "providers",
            "cost",
            "eligibility",
            "turns",
            "endedBy",
            "drain",
            "bounds",
        ):
            self.assertIn(key, document)
        self.assertIn("greeting", document, "the greeting outcome is not in the evidence")
        self.assertIn("reconnect", document)
        self.assertEqual("end", self.trace_rows()[-1]["type"], "the end row is not last")
        self.assertEqual(str(sidecar), row["endPath"])

    def test_a_refused_call_persists_an_end_document_naming_the_refusal(self):
        message = signed_message()
        signature = message["envelope"]["signature"]
        message["envelope"]["signature"] = (
            "0" if signature[0] != "0" else "1"
        ) + signature[1:]

        sent, _ = self.run_call(self.events_for(), message=message)

        self.assertEqual("refused", sent["endedBy"])
        self.assertIn("error", sent, "a refusal without its error is not evidence")
        document = self.sidecar()
        self.assertEqual(sent, document)
        self.assertEqual("refused", document["endedBy"])
        self.assertEqual(sent["error"], document["error"])

        ends = [row for row in self.trace_rows() if row["type"] == "end"]
        self.assertEqual(1, len(ends))
        self.assertEqual("refused", ends[0]["endedBy"])

    def test_a_dropped_call_persists_an_end_document_naming_the_drop(self):
        sent, _ = self.run_call(self.events_for(), inputs=[])

        self.assertEqual("dropped", sent["endedBy"])
        document = self.sidecar()
        self.assertEqual(sent, document)
        self.assertEqual("dropped", document["endedBy"])
        self.assertEqual(
            1,
            len([row for row in self.trace_rows() if row["type"] == "end"]),
        )

    def test_a_failed_call_persists_an_end_document_naming_the_error(self):
        sent, _ = self.run_call(
            self.events_for(),
            inputs=[BrowserStop()],
            voice=FakeVoice(fail=RuntimeError("synthesis refused")),
        )

        self.assertEqual("error", sent["endedBy"])
        self.assertIn("error", sent)
        document = self.sidecar()
        self.assertEqual(sent, document)
        self.assertEqual("error", document["endedBy"])
        self.assertIn("synthesis refused", document["error"]["message"])
        self.assertEqual(
            1,
            len([row for row in self.trace_rows() if row["type"] == "end"]),
        )

    def test_a_greeting_only_call_records_zero_turns_and_one_end_row(self):
        sent, _ = self.run_call(self.events_for(), inputs=[BrowserStop()])

        self.assertEqual(0, sent["turns"], "a greeting-only call invented a turn")
        self.assertEqual(0, self.sidecar()["turns"])
        self.assertEqual(
            1,
            len([row for row in self.trace_rows() if row["type"] == "end"]),
        )

    def test_the_end_documents_cost_equals_the_calls_priced_row(self):
        self.run_call(
            self.events_for(),
            inputs=[BrowserStop()],
            metered=True,
            characters=40,
        )

        priced = [row for row in self.trace_rows() if row["type"] == "cost.priced"]
        self.assertEqual(1, len(priced), "the call wrote no single priced row")
        document = self.sidecar()
        self.assertTrue(document["cost"]["measured"])
        self.assertEqual(priced[0]["totalUsd"], document["cost"]["totalUsd"])
        self.assertEqual(priced[0]["legs"], document["cost"]["legs"])

    def test_a_hold_return_keeps_one_trace_one_end_row_and_one_final_end_document(self):
        first, _ = self.run_call(
            self.events_for(),
            inputs=[BrowserStop()],
            metered=True,
            characters=40,
        )
        second, _ = self.run_call(
            self.events_for(),  # the hold return mints again, same call id
            inputs=[BrowserStop()],
            metered=True,
            characters=10,
        )

        files = sorted(path.name for path in Path(self.directory).iterdir())
        self.assertEqual([f"{CALL_ID}.end.json", f"{CALL_ID}.jsonl"], files)

        ends = [row for row in self.trace_rows() if row["type"] == "end"]
        self.assertEqual(1, len(ends), "the hold return appended a second end row")
        document = self.sidecar()
        self.assertEqual(
            second,
            document,
            "the sidecar is not the resumed session's final end document",
        )
        self.assertNotEqual(first["cost"], second["cost"])

        priced = [row for row in self.trace_rows() if row["type"] == "cost.priced"]
        self.assertEqual(2, len(priced), "each completed session keeps its own row")
        self.assertEqual(priced[-1]["totalUsd"], document["cost"]["totalUsd"])

    def test_an_unwritable_evidence_directory_is_named_on_the_end_message(self):
        parent = Path(tempfile.mkdtemp(prefix="cascade-end-blocked-"))
        blocked = parent / "not-a-directory"
        blocked.write_text("a file, not a directory", encoding="utf-8")

        log = CallEventLog(blocked, call_id=CALL_ID)
        self.assertIsNone(log.path, "a failed trace still claimed a path")
        events = OperationalEvents(
            EventStream(
                EventWriter(pipeline="cascade", call_id=CALL_ID),
                sink=log,
                subject_kind="demo",
            ),
            subject=SUBJECT,
            now=lambda: 0.0,
        )

        sent, _ = self.run_call(events, inputs=[BrowserStop()])

        # The call still ends and the caller gets the end message.
        self.assertEqual("stop", sent["endedBy"])
        # The unpersisted evidence is named, never silently skipped.
        self.assertIn("endEvidenceError", sent)
        self.assertIn("not-a-directory", sent["endEvidenceError"])
        self.assertFalse(
            (blocked / f"{CALL_ID}.end.json").exists(),
            "a named failure claimed a sidecar",
        )


if __name__ == "__main__":
    unittest.main()
