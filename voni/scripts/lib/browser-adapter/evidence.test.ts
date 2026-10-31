/**
 * The four artifacts must name one call: the delivered WAV the worklet
 * rendered, the marks the visitor's client posted, the trace the pipeline wrote
 * and the end document beside it. A missing, truncated or differently-bound
 * artifact is a named refusal, never a short-but-valid run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_CALL_ID,
  fakeBrowserCall,
  marksArtifact,
  removeTree,
  wavBytes,
} from "./fixtures";
import { assembleBrowserEvidence, readWavFacts } from "./evidence";
import type { LoadedScenario } from "@/lib/demo/verification/scenarios";
import { loadCorpus } from "@/lib/demo/verification/scenarios";
import { writeCorpus } from "./fixtures";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv17-evidence-"));
}

async function scenarioAt(root: string): Promise<LoadedScenario> {
  writeCorpus(join(root, "corpus"), [{ name: "golden-flow-smoke" }]);
  const corpus = await loadCorpus({
    dir: join(root, "corpus"),
    knownProperties: ["G1", "E1"],
  });
  return corpus.scenarios[0]!;
}

test("the assembled bundle carries the delivered WAV, marks, trace and end document", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({ scenario, eventsDir, capturesDir, runDir: root });
    const { assembled, record } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });

    assert.equal(assembled.bundle.ledger.end.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.ledger.marks.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.wav.channels, 1);
    assert.equal(assembled.bundle.wav.bitsPerSample, 16);
    assert.ok(assembled.bundle.wav.durationMs > 0);
    assert.equal(assembled.bundle.browser.marks.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.browser.syntheticMic.method, "getUserMedia");
    assert.equal(record.sameCallId, true);
    assert.equal(record.files.marks, join(root, "call", "call-marks.json"));
    assert.equal(record.files.deliveredWav, join(root, "call", "delivered.wav"));

    const copied = readFileSync(record.files.marks, "utf8");
    assert.equal(copied, readFileSync(call.marksPath as string, "utf8"));
    assert.ok(record.evidenceGaps.length === 0, "the priced row is present");
  } finally {
    removeTree(root);
  }
});

test("the visitor's captions travel in the browser evidence", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = {
      ...fakeBrowserCall({ scenario, eventsDir, capturesDir, runDir: root }),
      captions: [
        { role: "caller" as const, text: "Hi, is this Voni?" },
        { role: "agent" as const, text: "Speaking." },
      ],
    };
    const { assembled } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });
    assert.deepEqual(assembled.bundle.browser.captions, call.captions);
  } finally {
    removeTree(root);
  }
});

test("a WAV that is not mono 16-bit PCM is refused by name", () => {
  const root = tempRoot();
  try {
    const file = join(root, "stereo.wav");
    const pcm = wavBytes(100);
    // 2 channels in the fmt chunk; the payload stays as-is for the header check.
    const copy = Buffer.from(pcm);
    copy.writeUInt16LE(2, 22);
    writeFileSync(file, copy);
    assert.throws(() => readWavFacts(file), /mono 16-bit PCM/);
  } finally {
    removeTree(root);
  }
});

test("a truncated WAV is refused, never measured as a shorter capture", () => {
  const root = tempRoot();
  try {
    const file = join(root, "truncated.wav");
    const bytes = wavBytes(100);
    writeFileSync(file, bytes.subarray(0, bytes.length - 20));
    assert.throws(() => readWavFacts(file), /truncated capture is not evidence/);
  } finally {
    removeTree(root);
  }
});

test("a missing end document refuses: the browser adapter certifies from the persisted end message", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitEnd: true,
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      /no end document/,
    );
  } finally {
    removeTree(root);
  }
});

test("a capture whose name does not name the call refuses", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      captureCallIdInName: "another-call",
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      /does not name call/,
    );
  } finally {
    removeTree(root);
  }
});

test("a capture mark that names another file refuses", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
    });
    const artifact = marksArtifact(BROWSER_CALL_ID, "delivered-other.wav");
    writeFileSync(call.marksPath as string, `${JSON.stringify(artifact, null, 2)}\n`);
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      /delivered_capture mark names/,
    );
  } finally {
    removeTree(root);
  }
});

test("a trace row bound to another call refuses", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({ scenario, eventsDir, capturesDir, runDir: root });
    const tracePath = join(eventsDir, `${BROWSER_CALL_ID}.jsonl`);
    const rows = readFileSync(tracePath, "utf8").trim().split("\n");
    const parsed = JSON.parse(rows[0] as string) as Record<string, unknown>;
    parsed.callId = "33333333-3333-4333-8333-333333333333";
    rows[0] = JSON.stringify(parsed);
    writeFileSync(tracePath, `${rows.join("\n")}\n`);
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      /different call id/,
    );
  } finally {
    removeTree(root);
  }
});
