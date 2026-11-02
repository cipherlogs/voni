/**
 * The Rate store: the one persistence boundary behind the blind session.
 *
 * The tests create a real temporary evidence directory and drive the store the
 * way the HTTP surface does: create a session from a certificate and call
 * evidence, read its blind projection, serve a side, file a rating, reopen it.
 * The hash is checked on the way in and on the way out, so a changed file is a
 * named refusal rather than a different recording under the same session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Certificate } from "../../src/lib/demo/verification/certificate/types";
import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";
import { RATING_AXES, type RatingCallInput } from "./rate";
import { RatingStoreError, openRatingStore } from "./rating-store";

function wav(samples: number): Buffer {
  const data = Buffer.alloc(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CALL_WAV = wav(8);
const BASELINE_WAV = wav(24);

function certificate(calls: readonly string[], failing: readonly string[] = []): Certificate {
  const rows = [
    {
      locale: "en" as const,
      scenario: "booking",
      class: "golden-flow" as const,
      heldOut: false,
      requiredRepetitions: 1,
      measuredRepetitions: calls.length,
      status: "measured" as const,
      gap: null,
      calls,
    },
  ];
  return {
    schemaVersion: 3,
    scope: {
      locales: ["en"],
      decidedBy: "owner",
      decidedOn: "2026-11-02",
      reason: "English-only launch",
    },
    resume: null,
    runId: "run-rating-store",
    target: "local",
    code: {
      fingerprint: { head: "abc123", dirty: false, dirtyHash: "clean" },
      appBuild: "app-build-1",
      pipelineImage: "pipeline-image-1",
    },
    corpus: { version: 1, sha256: "c".repeat(64) },
    vendorBuilds: [
      { leg: "stt", vendor: "vendor-a", model: "model-a", buildId: "build-a" },
      { leg: "tts", vendor: "vendor-b", model: "model-b", buildId: "build-b" },
      { leg: "llm", vendor: "vendor-c", model: "model-c", buildId: "build-c" },
    ],
    plan: { mode: "nightly", repetitions: 1 },
    coverage: {
      expectedScenarios: rows.length,
      gapRows: 0,
      rows,
      byLocale: [
        {
          locale: "en",
          expectedScenarios: 1,
          measuredScenarios: 1,
          gapRows: 0,
          status: "measured",
          gap: null,
        },
      ],
    },
    properties: [
      {
        propertyId: "T1",
        family: "turn-taking",
        status: failing.length > 0 ? "FAIL" : "PASS",
        reason: failing.length > 0 ? "below-bar" : "pass",
        sampleCount: 1,
        citations: ["turn-taking"],
        gaps: [],
        scenarios:
          failing.length === 0
            ? []
            : [
                {
                  scenario: "booking",
                  locale: "en",
                  status: "FAIL",
                  reason: "below-bar",
                  sampleCount: 1,
                  citations: ["booking#1"],
                },
              ],
      },
    ],
    eligibility: { eligible: true, reasons: [] },
    runFailures: [],
    cost: { usd: 0.1, callCount: calls.length },
    residualRiskIds: ["RR-01"],
    panel: null,
    verdict: failing.length > 0 ? "not-demo-ready" : "pending-human",
    pass: false,
  };
}

function callInput(callId: string, callHash: string, baselineHash?: string): RatingCallInput {
  return {
    callId,
    scenario: "booking",
    locale: "en",
    transcript: [
      { speaker: "caller", text: "Hi", atMs: 0 },
      { speaker: "agent", text: "Hello", atMs: 400 },
    ],
    timeline: [
      { atMs: 0, type: "call-open" },
      { atMs: 400, type: "agent-speech-start" },
      { atMs: 1600, type: "call-end" },
    ],
    audio: { path: `calls/${callId}.wav`, sha256: callHash },
    ...(baselineHash === undefined ? {} : { baseline: { path: `baseline/${callId}.wav`, sha256: baselineHash } }),
  };
}

async function withStore(
  run: (store: Awaited<ReturnType<typeof openRatingStore>>, evidenceRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voni-rating-store-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "voni-rating-evidence-"));
  try {
    await mkdir(join(evidenceRoot, "calls"), { recursive: true });
    await mkdir(join(evidenceRoot, "baseline"), { recursive: true });
    await writeFile(join(evidenceRoot, "calls", "call-1.wav"), CALL_WAV);
    await writeFile(join(evidenceRoot, "baseline", "call-1.wav"), BASELINE_WAV);
    await run(
      await openRatingStore({
        root,
        evidenceRoot,
        now: () => new Date("2026-10-31T10:00:00.000Z"),
      }),
      evidenceRoot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

function storeRefusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RatingStoreError, `expected RatingStoreError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

test("a session is created once, persisted, and its blind view names no call, hash or side", async () => {
  await withStore(async (store) => {
    const call = callInput("call-1", sha256Hex(CALL_WAV), sha256Hex(BASELINE_WAV));
    const { session, blind } = await store.create({
      certificate: certificate(["call-1"]),
      calls: [call],
      reviewer: "owner",
      seed: 5,
    });

    assert.match(session.sessionId, /^rating-[0-9a-f]{64}$/);
    assert.equal(session.reviewer, "owner");
    assert.equal(session.date, "2026-10-31");
    assert.equal(blind.queue.length, 1);
    assert.doesNotMatch(JSON.stringify(blind), /sha256|call-1|booking|baseline|FAIL|PASS/);

    const loaded = await store.get(session.sessionId);
    assert.deepEqual(loaded, session, "a session reads back exactly as it was created");
    assert.deepEqual(await store.blind(session.sessionId), blind);
    assert.deepEqual((await store.list()).map((entry) => entry.sessionId), [session.sessionId]);

    await assert.rejects(
      store.create({
        certificate: certificate(["call-1"]),
        calls: [call],
        reviewer: "owner",
        seed: 5,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
      storeRefusal("session-exists", /already exists/),
    );
  });
});

test("a call audio file is hash-checked on creation and on every serving", async () => {
  await withStore(async (store, evidenceRoot) => {
    await assert.rejects(
      store.create({
        certificate: certificate(["call-1"]),
        calls: [callInput("call-1", "d".repeat(64))],
        reviewer: "owner",
        seed: 1,
      }),
      storeRefusal("audio-drift", /sha256/),
    );

    const { session } = await store.create({
      certificate: certificate(["call-1"]),
      calls: [callInput("call-1", sha256Hex(CALL_WAV))],
      reviewer: "owner",
      seed: 1,
    });
    const audio = await store.audio(session.sessionId, session.queue[0]!.itemId, "call");
    assert.equal(sha256Hex(audio.bytes), sha256Hex(CALL_WAV));
    assert.equal(audio.contentType, "audio/wav");

    await writeFile(join(evidenceRoot, "calls", "call-1.wav"), wav(40));
    await assert.rejects(
      store.audio(session.sessionId, session.queue[0]!.itemId, "call"),
      storeRefusal("audio-drift", /changed/),
    );
  });
});

test("the A/B sides are served by opaque label, and the private key alone maps them", async () => {
  await withStore(async (store) => {
    const { session } = await store.create({
      certificate: certificate(["call-1"]),
      calls: [callInput("call-1", sha256Hex(CALL_WAV), sha256Hex(BASELINE_WAV))],
      reviewer: "owner",
      seed: 9,
    });
    const item = session.queue[0]!;
    assert.ok(item.ab);
    const a = await store.audio(session.sessionId, item.itemId, "A");
    const b = await store.audio(session.sessionId, item.itemId, "B");
    const hashes = { A: sha256Hex(a.bytes), B: sha256Hex(b.bytes) };
    assert.equal(hashes[item.ab.agentSide], sha256Hex(CALL_WAV));
    assert.equal(hashes[item.ab.baselineSide], sha256Hex(BASELINE_WAV));
    await assert.rejects(
      store.audio(session.sessionId, item.itemId, "C" as never),
      storeRefusal("unknown-side", /A or B/),
    );
  });
});

test("a rating is written once, attributed to the session and reviewer, and survives a reopen", async () => {
  await withStore(async (store, evidenceRoot) => {
    const { session } = await store.create({
      certificate: certificate(["call-1"]),
      calls: [callInput("call-1", sha256Hex(CALL_WAV), sha256Hex(BASELINE_WAV))],
      reviewer: "owner",
      seed: 3,
    });
    const item = session.queue[0]!;
    const axes = Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 5]));
    const rated = await store.fileRating(session.sessionId, {
      itemId: item.itemId,
      axes,
      freeText: "Sounded like a person.",
      defectTags: ["late-greeting"],
      humanSide: item.ab!.baselineSide,
      preferredSide: item.ab!.agentSide,
    });

    assert.equal(rated.sessionId, session.sessionId);
    assert.equal(rated.reviewer, "owner");
    assert.equal(rated.callId, "call-1");
    assert.equal(rated.humanDetected, true);
    assert.equal(rated.preference, "agent");
    assert.deepEqual(await store.ratings(session.sessionId), [rated]);

    await assert.rejects(
      store.fileRating(session.sessionId, {
        itemId: item.itemId,
        axes,
        humanSide: item.ab!.baselineSide,
        preferredSide: item.ab!.agentSide,
      }),
      storeRefusal("rating-already-filed", /already filed/),
    );

    const reopened = await openRatingStore({
      root: store.root,
      evidenceRoot,
      now: () => new Date("2026-10-31T10:10:00.000Z"),
    });
    assert.deepEqual(await reopened.get(session.sessionId), session);
    assert.deepEqual(await reopened.ratings(session.sessionId), [rated]);
  });
});

test("the gold-label export names the session, reviewer and date, but not the blind view", async () => {
  await withStore(async (store) => {
    const { session } = await store.create({
      certificate: certificate(["call-1"]),
      calls: [callInput("call-1", sha256Hex(CALL_WAV))],
      reviewer: "owner",
      seed: 3,
    });
    const item = session.queue[0]!;
    await store.fileRating(session.sessionId, {
      itemId: item.itemId,
      axes: Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 4])),
      freeText: "Clear, but the greeting was long.",
      defectTags: ["long-greeting"],
    });

    const labels = await store.goldLabels(session.sessionId);
    assert.equal(labels.sessionId, session.sessionId);
    assert.equal(labels.reviewer, "owner");
    assert.equal(labels.signedAt, "2026-10-31");
    assert.equal(labels.ratings.length, 1);
    assert.equal(labels.ratings[0]!.callId, "call-1");
    assert.equal(labels.ratings[0]!.freeText, "Clear, but the greeting was long.");
    assert.doesNotMatch(JSON.stringify(labels), /sha256/);
  });
});

test("an A/B pair with two containers is refused, because the format would name the agent side", async () => {
  await withStore(async (store, evidenceRoot) => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("baseline")]);
    await writeFile(join(evidenceRoot, "baseline", "call-1.webm"), webm);
    await assert.rejects(
      store.create({
        certificate: certificate(["call-1"]),
        calls: [
          {
            ...callInput("call-1", sha256Hex(CALL_WAV)),
            baseline: { path: "baseline/call-1.webm", sha256: sha256Hex(webm) },
          },
        ],
        reviewer: "owner",
        seed: 1,
      }),
      storeRefusal("ab-format-mismatch", /container|tells the rater/),
    );
  });
});

test("a missing file and a path outside the evidence root are refused by name", async () => {
  await withStore(async (store) => {    await assert.rejects(
      store.create({
        certificate: certificate(["call-1"]),
        calls: [callInput("call-1", sha256Hex(CALL_WAV))].map((call) => ({
          ...call,
          audio: { ...call.audio, path: "../outside.wav" },
        })),
        reviewer: "owner",
        seed: 1,
      }),
      storeRefusal("evidence-outside-root", /outside/),
    );
    await assert.rejects(
      store.create({
        certificate: certificate(["call-1"]),
        calls: [callInput("call-1", sha256Hex(CALL_WAV))].map((call) => ({
          ...call,
          audio: { ...call.audio, path: "calls/missing.wav" },
        })),
        reviewer: "owner",
        seed: 1,
      }),
      storeRefusal("missing-audio", /missing\.wav/),
    );
    await assert.rejects(store.get("rating-" + "0".repeat(64)), storeRefusal("unknown-session", /not a Studio rating session/));
  });
});
