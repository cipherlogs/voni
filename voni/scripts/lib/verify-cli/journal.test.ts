/**
 * The certification journal's own contract: one JSONL file per run, a header
 * that proves which run it is, one entry per call, and a reader that refuses
 * everything it cannot prove.
 *
 * A process death can leave the last append half-written. That tail is dropped
 * and truncated, never guessed at, and a completed call before it is never
 * discarded. A torn line before the tail is a refusal, because it may hide a
 * call the run already paid for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VerifyCliError } from "./errors";
import {
  JOURNAL_SCHEMA_VERSION,
  assertEvidencePresent,
  assertResumable,
  journalPath,
  readJournal,
  writeJournal,
  type JournalCallRecord,
  type JournalHeader,
} from "./journal";

const RUN_ID = "verify-journal-01";

const HEADER: JournalHeader = {
  type: "header",
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  runId: RUN_ID,
  startedAt: "2026-11-02T09:00:00.000Z",
  target: "local",
  mode: "full",
  codeFingerprint: { head: "abc123", dirty: false, dirtyHash: "clean" },
  corpus: { version: 2, sha256: "a".repeat(64) },
  vendorBuilds: [
    { leg: "stt", vendor: "assemblyai", model: "universal", buildId: "stt-1" },
    { leg: "tts", vendor: "assemblyai", model: "tts-1", buildId: "tts-1" },
    { leg: "llm", vendor: "meta", model: "llm-1", buildId: "llm-1" },
  ],
  plan: {
    mode: "full",
    repetitions: 3,
    calls: 6,
    scenarios: [
      { name: "en-one", locale: "en", heldOut: false },
      { name: "es-one", locale: "es", heldOut: false },
    ],
  },
};

function call(scenario: string, repetition: number): JournalCallRecord {
  return {
    type: "call",
    scenario,
    repetition,
    locale: "en",
    callId: `${scenario}#${repetition}`,
    outcome: "completed",
    attempt: {
      scenario,
      repetition,
      locale: "en",
      target: "local",
      evidence: { cost: { measured: true, totalUsd: 0.1 } },
    },
    eligibility: { callId: `${scenario}#${repetition}`, scenario },
    cost: { measured: true, totalUsd: 0.1 },
    pipelineImage: "pipeline-1",
    evidenceRefs: [],
    refusal: null,
    at: "2026-11-02T09:00:01.000Z",
  };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "dv-journal-"));
}

function refusal(run: () => unknown): VerifyCliError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof VerifyCliError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.exitCode, 2);
    return error;
  }
  assert.fail("expected a refusal");
}

test("the journal lives beside the run's evidence, under its run id", () => {
  assert.equal(journalPath("/tmp/runs", RUN_ID), `/tmp/runs/${RUN_ID}/journal.jsonl`);
  assert.equal(journalPath(undefined, RUN_ID), join(".demo-runs", RUN_ID, "journal.jsonl"));
  assert.match(refusal(() => journalPath("/tmp/runs", "../escape")).message, /not a safe run id/);
});

test("a completed journal round-trips its header and calls", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, HEADER);
    const loaded = readJournal(path);
    assert.deepEqual(loaded.header, HEADER);
    assert.equal(loaded.calls.size, 0);
    assert.equal(loaded.tailDropped, false);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a half-written tail is dropped and truncated; completed calls survive", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, HEADER);
    const complete = JSON.stringify(call("en-one", 1));
    writeFileSync(path, `${readFileSync(path, "utf8")}${complete}\n{"type":"call","scenario":"en`, "utf8");

    const loaded = readJournal(path);
    assert.equal(loaded.tailDropped, true);
    assert.equal(loaded.calls.size, 1, "the completed call before the torn tail is kept");
    assert.ok(loaded.calls.has("en-one#1"));
    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"), "the truncated journal ends at a complete entry");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2, "the header and the one completed call remain");
    assert.doesNotThrow(() => JSON.parse(lines[1] as string), "the half-written tail is gone");
    assert.equal(readJournal(path).tailDropped, false, "a second read sees a clean journal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn line before the tail is a refusal, not a dropped call", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, HEADER);
    const good = JSON.stringify(call("en-one", 1));
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}{"type":"call",\n${good}\n`,
      "utf8",
    );
    const error = refusal(() => readJournal(path));
    assert.match(error.message, /line 2/);
    assert.match(error.message, /torn|not JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing journal and an unknown schema are named refusals", () => {
  const dir = root();
  try {
    const missing = journalPath(dir, RUN_ID);
    assert.match(refusal(() => readJournal(missing)).message, /no journal at .*verify-journal-01/);

    const path = journalPath(dir, RUN_ID);
    writeJournal(path, { ...HEADER, schemaVersion: 99 } as unknown as JournalHeader);
    const error = refusal(() => readJournal(path));
    assert.match(error.message, /schema version 99/);
    assert.match(error.message, new RegExp(String(JOURNAL_SCHEMA_VERSION)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a header that claims calls the plan cannot hold is malformed", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, {
      ...HEADER,
      plan: { ...HEADER.plan, calls: 999 },
    });
    assert.match(refusal(() => readJournal(path)).message, /plan\.calls/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume refuses when the code, corpus, builds, plan or target moved", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, HEADER);
    const loaded = readJournal(path);
    const expected = {
      runId: RUN_ID,
      target: "local" as const,
      codeFingerprint: HEADER.codeFingerprint,
      corpus: HEADER.corpus,
      vendorBuilds: [...HEADER.vendorBuilds],
      plan: {
        mode: "full" as const,
        target: "local" as const,
        locale: null,
        scenario: null,
        repetitions: 3,
        calls: 6,
        scenarios: [...HEADER.plan.scenarios],
        gaps: [],
      },
    };

    assert.deepEqual(assertResumable(loaded, expected), undefined);

    assert.match(
      refusal(() =>
        assertResumable(loaded, {
          ...expected,
          codeFingerprint: { ...HEADER.codeFingerprint, head: "def456" },
        }),
      ).message,
      /code fingerprint/,
    );
    assert.match(
      refusal(() =>
        assertResumable(loaded, {
          ...expected,
          corpus: { version: 3, sha256: "b".repeat(64) },
        }),
      ).message,
      /corpus/,
    );
    assert.match(
      refusal(() =>
        assertResumable(loaded, {
          ...expected,
          vendorBuilds: expected.vendorBuilds.map((build) =>
            build.leg === "tts" ? { ...build, buildId: "tts-moved" } : build,
          ),
        }),
      ).message,
      /vendor build/,
    );
    assert.match(
      refusal(() =>
        assertResumable(loaded, {
          ...expected,
          plan: { ...expected.plan, repetitions: 1, calls: 2 },
        }),
      ).message,
      /plan/,
    );
    assert.match(
      refusal(() => assertResumable(loaded, { ...expected, target: "staging" })).message,
      /target/,
    );
    assert.match(
      refusal(() => assertResumable(loaded, { ...expected, runId: "verify-other" })).message,
      /run id|run "verify-journal-01"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a journal claim whose evidence file is gone is refused by path", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    const evidence = join(dir, "call-1.wav");
    writeFileSync(evidence, "wav", "utf8");
    writeJournal(path, HEADER);
    const loaded = readJournal(path);
    // A completed call that cites an artifact which does not exist.
    const record = { ...call("en-one", 1), evidenceRefs: [evidence, join(dir, "gone.wav")] };
    const withClaim = {
      ...loaded,
      calls: new Map([[`${record.scenario}#${record.repetition}`, record]]),
    };
    const error = refusal(() => assertEvidencePresent(withClaim));
    assert.match(error.message, /gone\.wav/);
    assert.match(error.message, /en-one#1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-made call with no result in the journal stays interrupted", () => {
  const dir = root();
  try {
    const path = journalPath(dir, RUN_ID);
    writeJournal(path, HEADER);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}` +
        `${JSON.stringify({
          type: "retry",
          scenario: "es-one",
          repetition: 2,
          code: "marks-missing",
          message: "no marks",
          at: "2026-11-02T09:00:02.000Z",
        })}\n`,
      "utf8",
    );
    const loaded = readJournal(path);
    assert.equal(loaded.retries.size, 1);
    assert.ok(loaded.interrupted.has("es-one#2"));
    assert.equal(loaded.calls.has("es-one#2"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
