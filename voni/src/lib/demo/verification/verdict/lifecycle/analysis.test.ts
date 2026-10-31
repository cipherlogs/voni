import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALL_MARKS_SCHEMA_VERSION,
  type CallMark,
  type CallMarksArtifact,
} from "@/lib/voice/call-marks";

import { FIRST_AUDIBLE_AGREEMENT_MS, audioAnswer } from "./analysis";
import { LifecycleEvidenceError } from "./evidence";
import type { WavAnalysis } from "./wav";

/**
 * The lifecycle anchor's agreement window is an evidence-integrity tolerance,
 * not a verdict bar. This file pins its value and both edges of its behaviour:
 * a hand edit to 250 ms alone, or to the comparison it feeds, fails here.
 */

const CAPTURE_START_MS = 100;
const FIRST_SPEECH_MS = 1_340;

const ANALYSIS: WavAnalysis = {
  sampleRate: 48_000,
  durationMs: 4_000,
  segments: [{ startMs: FIRST_SPEECH_MS, endMs: 4_000 }],
  firstSpeechMs: FIRST_SPEECH_MS,
  lastSpeechEndMs: 4_000,
  trailingSilenceMs: 0,
};

function mark(name: CallMark["name"], tMs: number): CallMark {
  return { name, at: new Date(tMs).toISOString(), epochMs: tMs, tMs };
}

function marks(firstAudibleMs: number): CallMarksArtifact {
  return {
    schemaVersion: CALL_MARKS_SCHEMA_VERSION,
    callId: "analysis-test",
    startedAt: "2026-10-31T10:00:00.000Z",
    endedAt: "2026-10-31T10:00:05.000Z",
    marks: [mark("microphone_acquired", CAPTURE_START_MS), mark("first_audible", firstAudibleMs)],
  };
}

test("FIRST_AUDIBLE_AGREEMENT_MS is pinned at 250 ms", () => {
  assert.equal(FIRST_AUDIBLE_AGREEMENT_MS, 250);
});

test("a first_audible mark exactly one tolerance from the WAV is still the same event", () => {
  const answerMs = CAPTURE_START_MS + FIRST_SPEECH_MS;
  const answer = audioAnswer(marks(answerMs + FIRST_AUDIBLE_AGREEMENT_MS), ANALYSIS);
  assert.equal(answer.answerMs, answerMs);
  assert.equal(answer.firstVoicedMs, FIRST_SPEECH_MS);
  assert.match(answer.detail, /agrees within 250ms/);
});

test("a first_audible mark one millisecond past the tolerance names a different event", () => {
  const answerMs = CAPTURE_START_MS + FIRST_SPEECH_MS;
  assert.throws(
    () => audioAnswer(marks(answerMs + FIRST_AUDIBLE_AGREEMENT_MS + 1), ANALYSIS),
    (error: unknown) => {
      assert.ok(error instanceof LifecycleEvidenceError);
      assert.equal(error.code, "mark-audio-disagree");
      return true;
    },
  );
});
