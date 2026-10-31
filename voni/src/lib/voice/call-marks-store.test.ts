/**
 * The dev-only call-marks disk sink: one JSON artifact beside the delivered
 * WAV, named by the call id both artifacts share. A call id is never a path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CALL_MARKS_DIR } from "./call-marks";
import {
  callMarksFileName,
  callMarksFilePath,
  writeCallMarks,
} from "./call-marks-store";
import type { CallMarksArtifact } from "./call-marks";

const ARTIFACT: CallMarksArtifact = {
  schemaVersion: 1,
  callId: "2f1c9a1e-7d3b-4b5a-9c1e-0a6f5e4d3c2b",
  startedAt: "2026-10-31T15:10:00.000Z",
  endedAt: "2026-10-31T15:12:00.000Z",
  marks: [
    {
      name: "start_requested",
      at: "2026-10-31T15:10:00.000Z",
      epochMs: 1793459400000,
      tMs: 0,
    },
  ],
};

test("the marks artifact is named by the call id both artifacts carry", () => {
  assert.equal(
    callMarksFileName(ARTIFACT.callId),
    `call-marks-${ARTIFACT.callId}.json`,
  );
});

test("a call id that could escape the capture directory is refused", () => {
  for (const name of ["", "../escape", "a/b", "a\\b", ".hidden", "-dash"]) {
    assert.throws(() => callMarksFileName(name), /invalid call id/);
  }
});

test("the marks file lives in the gitignored capture directory, never the repo", () => {
  const root = "/tmp/voni-root";
  assert.equal(
    callMarksFilePath(ARTIFACT.callId, root),
    join(root, CALL_MARKS_DIR, `call-marks-${ARTIFACT.callId}.json`),
  );
});

test("one call writes one marks artifact with its complete shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "call-marks-"));
  try {
    const path = await writeCallMarks(ARTIFACT.callId, ARTIFACT, root);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(ARTIFACT, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the store refuses an artifact whose call id is not the requested one", async () => {
  const root = mkdtempSync(join(tmpdir(), "call-marks-"));
  try {
    await assert.rejects(
      () => writeCallMarks("another-call", ARTIFACT, root),
      /call id/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
