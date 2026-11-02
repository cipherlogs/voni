/**
 * The four artifacts must name one call: the delivered WAV the worklet
 * rendered, the marks the visitor's client posted, the trace the pipeline wrote
 * and the end document beside it. A missing, truncated or differently-bound
 * artifact is a named refusal, never a short-but-valid run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

    assert.equal(assembled.bundle.ledger.end?.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.ledger.marks?.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.wav?.channels, 1);
    assert.equal(assembled.bundle.wav?.bitsPerSample, 16);
    assert.ok((assembled.bundle.wav?.durationMs ?? 0) > 0);
    assert.equal(assembled.bundle.browser.marks?.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.browser.syntheticMic.method, "getUserMedia");
    assert.equal(record.sameCallId, true);
    assert.equal(record.files.marks, join(root, "call", "call-marks.json"));
    assert.equal(record.files.deliveredWav, join(root, "call", "delivered.wav"));

    const copied = readFileSync(record.files.marks, "utf8");
    assert.equal(copied, readFileSync(call.marksPath as string, "utf8"));
    assert.deepEqual(
      record.evidenceGaps.filter((gap) => !/visitor transcript/.test(gap)),
      [],
      "the priced row is present; only the named no-caption gap remains",
    );
  } finally {
    removeTree(root);
  }
});

test("the visitor's captions become the evidence transcript, timed by the turn marks", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = {
      ...fakeBrowserCall({
        scenario,
        eventsDir,
        capturesDir,
        runDir: root,
        turnMarks: [
          { atMs: 1_800, role: "caller" },
          { atMs: 2_600, role: "agent" },
        ],
      }),
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
    assert.deepEqual(assembled.bundle.trace.transcript, [
      { role: "caller", text: "Hi, is this Voni?", atMs: 1_800, final: true, turn: null },
      { role: "agent", text: "Speaking.", atMs: 2_600, final: true, turn: null },
    ]);
    assert.equal(assembled.bundle.trace.transcriptGap, null);
  } finally {
    removeTree(root);
  }
});

test("a call with no rendered caption withholds the transcript and names the gap", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({ scenario, eventsDir, capturesDir, runDir: root });
    const { assembled } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });
    assert.equal(assembled.bundle.trace.transcript, null);
    assert.match(assembled.bundle.trace.transcriptGap ?? "", /no visitor transcript/);
  } finally {
    removeTree(root);
  }
});

test("a caption count that disagrees with the turn marks is withheld, never guessed", async () => {
  const root = tempRoot();
  try {
    const scenario = await scenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = {
      ...fakeBrowserCall({
        scenario,
        eventsDir,
        capturesDir,
        runDir: root,
        turnMarks: [{ atMs: 1_800, role: "caller" }],
      }),
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
    assert.equal(assembled.bundle.trace.transcript, null);
    assert.match(assembled.bundle.trace.transcriptGap ?? "", /without guessing a time/);
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

test("a lost marks artifact still names the call it lost", async () => {
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
      omitMarks: true,
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "marks-missing");
        assert.match((error as Error).message, new RegExp(BROWSER_CALL_ID));
        return true;
      },
    );
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

// ── A denied microphone is a named refusal, not a missing capture ───────────

async function micDeniedScenarioAt(root: string): Promise<LoadedScenario> {
  writeCorpus(join(root, "corpus"), [
    {
      name: "resilience-mic-denied",
      expectedProperties: ["R5"],
      edge: [{ kind: "mic-denied", atMs: 0 }],
    },
  ]);
  const corpus = await loadCorpus({
    dir: join(root, "corpus"),
    knownProperties: ["R5"],
  });
  return corpus.scenarios[0]!;
}

const NAMED_DENIAL = {
  conditions: [
    {
      kind: "mic-denied",
      atMs: 0,
      applied: true,
      observed: "the denial named the microphone state (ended)",
    },
  ],
  hold: null,
  micDenied: {
    namedState: "Call didn't connect",
    errorText: "Voni needs your microphone for the call.",
    socketOpenAfterMs: 8_000,
    openSockets: 0,
    teardownObserved: true,
  },
  deviceSwitch: null,
  drain: null,
} as const;

test("a mic-denied call assembles its refusal evidence with no invented capture", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const marks = marksArtifact(BROWSER_CALL_ID, "");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      edge: NAMED_DENIAL,
      marksOverride: {
        marks: marks.marks.filter((mark) => mark.name !== "delivered_capture"),
      },
    });
    const { assembled, record } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });

    assert.equal(assembled.bundle.wav, null, "a denied call delivered no WAV");
    assert.equal(assembled.bundle.browser.capture, null);
    assert.equal(record.files.deliveredWav, null);
    assert.equal(
      existsSync(join(root, "call", "delivered.wav")),
      false,
      "the adapter never invents a delivered capture",
    );
    assert.equal(
      assembled.bundle.browser.edge?.micDenied?.namedState,
      "Call didn't connect",
      "the harness's named refusal reaches R5",
    );
    assert.equal(assembled.bundle.ledger.marks?.callId, BROWSER_CALL_ID);
    assert.ok(
      assembled.gaps.some((gap) => /no delivered capture/.test(gap)),
      "the absent audio is named, not hidden",
    );
    assert.equal(record.sameCallId, true);
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call keeps the trace and end document it did write", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      edge: NAMED_DENIAL,
    });
    const { assembled } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });
    assert.ok(assembled.bundle.trace.rows.length > 0);
    assert.equal(assembled.bundle.ledger.end?.callId, BROWSER_CALL_ID);
    assert.equal(assembled.bundle.wav, null);
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call with no trace or end document names both, and never invents them", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      omitEnd: true,
      omitTrace: true,
      edge: NAMED_DENIAL,
    });
    const { assembled } = await assembleBrowserEvidence({
      call,
      scenario,
      target: "local",
      eventsDir,
      callDir: join(root, "call"),
    });
    assert.deepEqual(assembled.bundle.trace.rows, []);
    assert.equal(assembled.bundle.ledger.end, null);
    assert.equal(assembled.bundle.wav, null);
    assert.ok(assembled.gaps.some((gap) => /no trace/.test(gap)));
    assert.ok(assembled.gaps.some((gap) => /no end document/.test(gap)));
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call with no named refusal is refused by name, never passed on absence", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      edge: {
        ...NAMED_DENIAL,
        micDenied: {
          ...NAMED_DENIAL.micDenied,
          namedState: "",
          errorText: "NotAllowedError",
        },
      },
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "mic-refusal-missing");
        assert.match((error as Error).message, /not named|named the microphone/i);
        return true;
      },
    );
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call with no denial observation at all is refused by name", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      edge: null,
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "mic-refusal-missing");
        assert.match((error as Error).message, /no mic-denial observation|denied microphone/i);
        return true;
      },
    );
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call with a zombie socket and no teardown is refused by name", async () => {
  const root = tempRoot();
  try {
    const scenario = await micDeniedScenarioAt(root);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const call = fakeBrowserCall({
      scenario,
      eventsDir,
      capturesDir,
      runDir: root,
      omitCapture: true,
      edge: {
        ...NAMED_DENIAL,
        micDenied: {
          ...NAMED_DENIAL.micDenied,
          openSockets: 1,
          teardownObserved: false,
        },
      },
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "mic-refusal-missing");
        assert.match((error as Error).message, /socket|teardown/i);
        return true;
      },
    );
  } finally {
    removeTree(root);
  }
});

test("every other scenario keeps the hard capture-missing refusal", async () => {
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
      omitCapture: true,
      edge: NAMED_DENIAL,
    });
    await assert.rejects(
      assembleBrowserEvidence({
        call,
        scenario,
        target: "local",
        eventsDir,
        callDir: join(root, "call"),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "capture-missing");
        return true;
      },
    );
  } finally {
    removeTree(root);
  }
});
