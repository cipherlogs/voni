"""Every completed demo call leaves one cost row keyed by its call id (ticket 18).

Seam: the per-call event artifact (:class:`cascade.events.CallEventLog`). The
test drives a real :class:`cascade.call.CallLifecycle` to its end message and
then reads the JSONL file, so it asserts the row a reader will find rather than
an internal function call. The price is recomputed from the pipeline's own rate
table (:data:`cascade.cost.RATE_TABLE`), never restated as a constant, so a
drift between the row and the table fails here.

The row is the cascade's durable cost form: a ``cost.priced`` event per
completed session, appended to the artifact keyed by the call id, alongside
``CallEnd.cost`` on the end message. It names the call id, the rate table that
priced it, every measured leg and unit, and the engine that produced it (the
envelope's ``pipeline`` field). An unpriceable call still writes the row, with
``measured: false`` and a named reason; it is never a zero and never absent.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from cascade.assemblyai_tts import Billing
from cascade.call import CallLifecycle, CostSummary, OpenedLeg
from cascade.cost import RATE_TABLE
from cascade.events import (
    CallEventLog,
    EventStream,
    EventWriter,
    OperationalEvents,
)
from cascade.meta_llm import TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
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
from metrics import TimingLedger

#: The demo subject the trace carries; the call id is the demo call's own id.
SUBJECT = "demo:audrey"

COST_TYPE = "cost.priced"


class CostRowTests(unittest.TestCase):
    """One call id, one artifact, one priced row the owner can compare."""

    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="cascade-cost-")
        self.clock = FakeClock()

    def ops_for(
        self, *, call_id: str = CALL_ID, subject: str = SUBJECT
    ) -> OperationalEvents:
        log = CallEventLog(self.directory, call_id=call_id)
        stream = EventStream(
            EventWriter(pipeline="cascade", call_id=call_id), sink=log
        )
        return OperationalEvents(stream, subject=subject, now=lambda: 0.0)

    def run_call(
        self,
        ops: OperationalEvents,
        *,
        measured: bool = True,
        call_id: str = CALL_ID,
        speech_seconds: float = 3.7,
        characters: int = 40,
        prompt_tokens: int = 1000,
    ):
        speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")],
            clock=self.clock,
        )
        voice = FakeVoice()
        stream: FakeStream = FakeStream()
        if measured:
            # The vendor bills speech in whole seconds: 3.7 s is 3 billed s.
            speech.usage = {"audio_duration_seconds": speech_seconds}
            voice = MeteringVoice(
                Billing(
                    characters=characters,
                    measured=True,
                    source="billed_characters",
                    audio_duration_seconds=2.5,
                    session_duration_seconds=4,
                )
            )
            stream = MeteringStream(
                {
                    "t1": TurnUsage(
                        prompt_tokens=prompt_tokens,
                        completion_tokens=100,
                        cached_tokens=200,
                        reasoning_tokens=0,
                        measured=True,
                    )
                }
            )

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg", speech)

        async def open_voice(_body):
            return OpenedLeg(
                "tts", "assemblyai", "primary", "voice leg", voice
            )

        transport = FakeTransport([BrowserStop()])
        lifecycle = CallLifecycle(
            message=signed_message(),
            secret=SECRET,
            call_id=call_id,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=RecordingAudioSink(),
            ledger=TimingLedger(now=self.clock),
            clock=self.clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
            operational_events=ops,
        )
        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=5.0))
        return end, transport

    def rows(self, call_id: str = CALL_ID) -> list[dict]:
        path = Path(self.directory) / f"{call_id}.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def cost_rows(self, call_id: str = CALL_ID) -> list[dict]:
        return [row for row in self.rows(call_id) if row["type"] == COST_TYPE]

    def test_a_completed_demo_call_writes_one_cost_row_from_the_rate_table(self):
        ops = self.ops_for()

        end, _ = self.run_call(ops)

        rows = self.cost_rows()
        self.assertEqual(
            1, len(rows), "a completed call must leave exactly one cost row"
        )
        row = rows[0]

        self.assertEqual(CALL_ID, row["callId"])
        self.assertEqual(SUBJECT, row["subject"])
        self.assertEqual("cascade", row["pipeline"])
        self.assertEqual("end", row["phase"])
        self.assertTrue(row["measured"])

        # The price comes from cascade/rates/v1.json, not from a constant: the
        # expected total is recomputed from the pipeline's own table. Prompt is
        # net of cached (1000-200) and completion net of reasoning (100-0).
        expected = (
            RATE_TABLE.price("stt.audio_seconds", 3)
            + RATE_TABLE.price("llm.prompt_tokens", 800)
            + RATE_TABLE.price("llm.cached_tokens", 200)
            + RATE_TABLE.price("llm.completion_tokens", 100)
            + RATE_TABLE.price("llm.reasoning_tokens", 0)
            + RATE_TABLE.price("tts.characters", 40)
            + RATE_TABLE.price("tts.audio_seconds", 2.5)
            + RATE_TABLE.price("tts.session_seconds", 4)
        )
        self.assertEqual(expected, Decimal(str(row["totalUsd"])))
        # The end message prices the same units with the same table.
        self.assertEqual(end.cost.total_usd, row["totalUsd"])

        # The producer of the measured value is named: the table and its
        # version, and each measured leg's unit and quantity.
        self.assertEqual("cascade.cost.cost_call", row["producer"])
        self.assertEqual(
            f"{RATE_TABLE.name} v{RATE_TABLE.version}", row["rateTableVersion"]
        )
        self.assertEqual({"audio_seconds": 3}, row["legs"]["stt"]["units"])
        self.assertEqual("audio_seconds", row["legs"]["stt"]["unit"])
        self.assertEqual(3, row["legs"]["stt"]["quantity"])
        self.assertTrue(row["legs"]["stt"]["source"])
        self.assertEqual(
            {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "cached_tokens": 200,
                "reasoning_tokens": 0,
            },
            row["legs"]["llm"]["units"],
        )
        self.assertEqual(
            {"characters": 40, "audio_seconds": 2.5, "session_seconds": 4},
            row["legs"]["tts"]["units"],
        )
        self.assertNotIn("unmeasuredReason", row)

    def test_an_unpriceable_call_writes_a_named_failure_row_never_a_zero(self):
        ops = self.ops_for()

        # No vendor units are reported: no speech frame and no Termination
        # billing. The call still ends and still leaves its row.
        end, _ = self.run_call(ops, measured=False)

        rows = self.cost_rows()
        self.assertEqual(
            1, len(rows), "an unpriceable call must not be a missing row"
        )
        row = rows[0]

        self.assertEqual(CALL_ID, row["callId"])
        self.assertFalse(row["measured"])
        self.assertIsNone(
            row["totalUsd"], "an unpriceable call must not claim a total"
        )
        self.assertNotEqual(0, row["totalUsd"], "a zero would claim a price")
        self.assertTrue(row["unmeasuredReason"].strip())
        self.assertIn("no speech usage frame", row["unmeasuredReason"])
        self.assertIn("no Termination summary", row["unmeasuredReason"])
        # The table is still named: it is what the call would have priced with.
        self.assertEqual(
            f"{RATE_TABLE.name} v{RATE_TABLE.version}", row["rateTableVersion"]
        )
        self.assertEqual("cascade.cost.cost_call", row["producer"])
        for leg in ("stt", "llm", "tts"):
            self.assertFalse(row["legs"][leg]["measured"])
            self.assertIsNone(row["legs"][leg]["amountUsd"])
            self.assertEqual({}, row["legs"][leg]["units"])
        # The end message carries the same named absence, not a fabricated zero.
        self.assertFalse(end.cost.measured)
        self.assertIsNone(end.cost.total_usd)

    def test_a_hold_return_appends_one_row_to_the_same_trace(self):
        # The hold return is a second measured session on the same call id: a
        # fresh socket and a fresh lifecycle, never a new call id and never a
        # new artifact file.
        self.run_call(self.ops_for(), speech_seconds=3.7, characters=40)
        after_hold = self.cost_rows()
        self.assertEqual(1, len(after_hold))

        self.run_call(self.ops_for(), speech_seconds=2.0, characters=10)
        rows = self.cost_rows()

        # The resumed session's row is on the same artifact, behind the first.
        self.assertEqual(1, len(list(Path(self.directory).glob("*.jsonl"))))
        self.assertEqual([CALL_ID, CALL_ID], [row["callId"] for row in rows])
        self.assertEqual(2, len(rows), "one row per completed session, no rewrite")

        first, resumed = rows
        # The first session's row is intact: neither rewritten nor dropped.
        self.assertEqual({"audio_seconds": 3}, first["legs"]["stt"]["units"])
        self.assertEqual(
            {"characters": 40, "audio_seconds": 2.5, "session_seconds": 4},
            first["legs"]["tts"]["units"],
        )
        # The resumed session measured its own units, so summing the call's
        # rows is the call's cost and neither session is billed twice.
        self.assertEqual({"audio_seconds": 2}, resumed["legs"]["stt"]["units"])
        self.assertEqual(10, resumed["legs"]["tts"]["units"]["characters"])
        self.assertEqual(
            f"{RATE_TABLE.name} v{RATE_TABLE.version}", resumed["rateTableVersion"]
        )
        self.assertLess(resumed["totalUsd"], first["totalUsd"])

    def test_the_engine_marker_distinguishes_cascade_from_managed(self):
        def row_for(pipeline: str) -> dict:
            lines: list[str] = []
            stream = EventStream(
                EventWriter(pipeline=pipeline, call_id=CALL_ID), sink=lines.append
            )
            OperationalEvents(stream, subject=SUBJECT, now=lambda: 0.0).cost_priced(
                CostSummary.unmeasured("no meter ran on this call")
            )
            return json.loads(lines[0])

        cascade_row = row_for("cascade")
        managed_row = row_for("managed")

        # The envelope's pipeline is the one engine marker: the row's payload is
        # identical, so a reader can tell the cascade's price from the managed
        # path's with no second field and no inference from the subject.
        self.assertEqual("cascade", cascade_row["pipeline"])
        self.assertEqual("managed", managed_row["pipeline"])
        self.assertEqual(
            {key: value for key, value in cascade_row.items() if key != "pipeline"},
            {key: value for key, value in managed_row.items() if key != "pipeline"},
        )


if __name__ == "__main__":
    unittest.main()
