/**
 * Browser call marks: the dev-only record of what the visitor experienced.
 *
 * The stream is the external contract here, so these tests assert the artifact
 * shape (wall clock and call-relative time on every mark), the one flag that
 * turns it on, and that a writer which is failing or hanging never reaches the
 * call path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CALL_MARKS_PRODUCTION_REFUSAL,
  CALL_MARKS_SCHEMA_VERSION,
  CallMarks,
  callMarksRequested,
  createCallMarks,
  isCallMarksArtifact,
  type CallMarksArtifact,
} from "./call-marks";

const T0 = Date.UTC(2026, 9, 31, 15, 10, 0);

test("a mark carries both wall-clock and call-relative time", () => {
  let clock = T0;
  const marks = new CallMarks({
    callId: "call-05",
    now: () => clock,
    post: async () => undefined,
  });
  marks.mark("start_requested");
  clock += 157;
  marks.mark("mint_done", { voiceId: "audrey" });
  clock += 43;
  marks.mark("microphone_acquired");

  const artifact = marks.artifact();
  assert.equal(artifact.schemaVersion, CALL_MARKS_SCHEMA_VERSION);
  assert.equal(artifact.callId, "call-05");
  assert.equal(artifact.startedAt, new Date(T0).toISOString());
  assert.equal(artifact.endedAt, null, "a live call has no end yet");
  assert.deepEqual(artifact.marks, [
    {
      name: "start_requested",
      at: new Date(T0).toISOString(),
      epochMs: T0,
      tMs: 0,
    },
    {
      name: "mint_done",
      at: new Date(T0 + 157).toISOString(),
      epochMs: T0 + 157,
      tMs: 157,
      detail: { voiceId: "audrey" },
    },
    {
      name: "microphone_acquired",
      at: new Date(T0 + 200).toISOString(),
      epochMs: T0 + 200,
      tMs: 200,
    },
  ]);
});

test("the chime is one mark per chime; a second chime is never folded away", () => {
  let clock = T0;
  const marks = new CallMarks({
    callId: "call-chime",
    now: () => clock,
    post: async () => undefined,
  });
  marks.mark("chime");
  clock += 40;
  marks.mark("chime");

  const chimes = marks.artifact().marks.filter((mark) => mark.name === "chime");
  assert.equal(chimes.length, 2, "a second chime is visible as a second mark");
  assert.deepEqual(
    chimes.map((mark) => mark.tMs),
    [0, 40],
  );
});

test("marks are requested only by the capture flag, never by ordinary production", () => {
  assert.equal(callMarksRequested("?delivercapture=1", false, false), true);
  assert.equal(callMarksRequested("?delivercapture=1", true, true), true);
  assert.equal(callMarksRequested("?delivercapture=1", false), true);

  assert.equal(callMarksRequested("", false, false), false);
  assert.equal(callMarksRequested("?delivercapture=0", false, false), false);
  assert.equal(
    callMarksRequested("?delivercapture=1", true, false),
    false,
    "an ordinary production build writes no marks",
  );
});

test("no flag and no test build means no recorder at all", () => {
  assert.equal(createCallMarks("", false, false), null);
  assert.equal(createCallMarks("?delivercapture=1", true, false), null);
  assert.ok(createCallMarks("?delivercapture=1", false, false) instanceof CallMarks);
  assert.ok(createCallMarks("?delivercapture=1", true, true) instanceof CallMarks);
});

test("a failing writer warns and never throws or changes the call", async () => {
  const warnings: string[] = [];
  const marks = new CallMarks({
    callId: "call-writer",
    now: () => T0,
    post: () => {
      throw new Error("sink is down");
    },
    warn: (line) => warnings.push(line),
  });
  marks.mark("start_requested");

  await marks.finish();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\[call-marks\]/);
  assert.match(warnings[0]!, /sink is down/);
  assert.equal(marks.artifact().endedAt, new Date(T0).toISOString());
});

test("a rejected writer warns and never rejects the finish", async () => {
  const warnings: string[] = [];
  const marks = new CallMarks({
    callId: "call-reject",
    now: () => T0,
    post: async () => {
      throw new Error("capture upload failed: 500");
    },
    warn: (line) => warnings.push(line),
  });
  marks.mark("start_requested");

  await marks.finish();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /capture upload failed: 500/);
});

test("finishing writes one artifact, and no late mark lands after it", async () => {
  let writes = 0;
  let posted: CallMarksArtifact | null = null;
  const marks = new CallMarks({
    callId: "call-once",
    now: () => T0,
    post: async (artifact) => {
      writes += 1;
      posted = artifact;
    },
  });
  marks.mark("start_requested");
  await marks.finish();
  await marks.finish();
  marks.mark("teardown");

  assert.equal(writes, 1, "one marks artifact per call");
  assert.deepEqual(posted!.marks.map((mark) => mark.name), ["start_requested"]);
});

test("the artifact validator is the one shape check the sink uses", () => {
  const valid: CallMarksArtifact = {
    schemaVersion: CALL_MARKS_SCHEMA_VERSION,
    callId: "call-valid",
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 10).toISOString(),
    marks: [
      { name: "start_requested", at: new Date(T0).toISOString(), epochMs: T0, tMs: 0 },
    ],
  };
  assert.equal(isCallMarksArtifact(valid), true);
  assert.equal(isCallMarksArtifact({ ...valid, schemaVersion: 2 }), false);
  assert.equal(isCallMarksArtifact({ ...valid, callId: "" }), false);
  assert.equal(isCallMarksArtifact({ ...valid, marks: [] }), false);
  assert.equal(
    isCallMarksArtifact({
      ...valid,
      marks: [{ name: "start_requested", at: "not-a-date", epochMs: T0, tMs: 0 }],
    }),
    false,
  );
  assert.equal(
    isCallMarksArtifact({
      ...valid,
      marks: [{ name: "start_requested", at: new Date(T0).toISOString(), epochMs: T0 }],
    }),
    false,
    "a mark without call-relative time is refused",
  );
  assert.equal(isCallMarksArtifact(null), false);
});

test("the production refusal is a named dev-only refusal", () => {
  assert.equal(CALL_MARKS_PRODUCTION_REFUSAL.code, "dev-only");
  assert.match(CALL_MARKS_PRODUCTION_REFUSAL.error, /dev-only/);
});
