/**
 * The W2 cascade re-audition pack: one real cascade call becomes one pack with
 * the subject's own clean cascade artifact, a reference and a delivered
 * capture, the W0 comparison, the verdict-rule inputs and two independent
 * ballots on the one shared recording. There is no platform leg, and a missing
 * capture or ballot is unresolved, never a pass.
 *
 * The tests build their own WAVs and a real cascade artifact, so no network,
 * provider or live call is involved. A synthetic pack is a fixture for the
 * mechanism; it is never evidence a gate can resolve on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSkeletonArtifact, CASCADE_PLATFORM_CAPTURE_ABSENCE } from "./scoreboard";
import {
  assembleCascadeReauditionPack,
  cascadeReauditionRoster,
  type CascadeBallot,
  type CascadeReauditionRequest,
} from "./cascade-reaudition";
import { VONI_GREETINGS } from "./voni-agent";
import type { SubjectRecord } from "./subject";
import type { ContentTurn } from "../voice/content-judge";

const SAMPLE_RATE = 24_000;

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
function wavFrom(samples: number[], sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => {
    const scaled = Math.max(-1, Math.min(1, value)) * 32_767;
    out.writeInt16LE(Math.round(scaled), 44 + index * 2);
  });
  return out;
}

function tone(seconds: number, hz = 440, amplitude = 0.4): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const LOLA: SubjectRecord = {
  agent: { kind: "demo", voice: "lola", agentId: null },
  locale: "es",
  transport: "browser",
  source: "flag",
  pipeline: "cascade",
};

const TRANSCRIPT: ContentTurn[] = [
  { speaker: "agent", text: VONI_GREETINGS.es! },
  { speaker: "caller", text: "Sí, claro." },
];

function fixture(overrides: Partial<CascadeReauditionRequest> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cascade-reaudition-"));
  const referencePath = join(dir, "lola-reference.wav");
  const deliveredPath = join(dir, "delivered-20261029.wav");
  const referenceBytes = wavFrom(tone(1, 1_000, 0.4));
  const deliveredBytes = wavFrom(tone(1, 1_000, 0.4));
  writeFileSync(referencePath, referenceBytes);
  writeFileSync(deliveredPath, deliveredBytes);

  const deliveredSha = sha256(deliveredBytes);
  const ballots: CascadeBallot[] = [
    {
      reviewer: "ana",
      reviewedOn: "2026-10-29",
      recordingSha256: deliveredSha,
      scores: { timbre: 5, accent: 5, languageNaturalness: 5 },
      reason: "Clear, natural Spanish; nothing to fix in this line.",
    },
    {
      reviewer: "marta",
      reviewedOn: "2026-10-29",
      recordingSha256: deliveredSha,
      scores: { timbre: 5, accent: 5, languageNaturalness: 5 },
      reason: "Sounds like a native speaker; the greeting is clean.",
    },
  ];

  const runId = "run-lola-1";
  const artifact = buildSkeletonArtifact({
    voice: "lola",
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId,
    subject: LOLA,
    engine: {
      pipeline: "cascade",
      run: {
        runId,
        variant: "cascade-lola-1",
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      captures: {
        reference: { path: referencePath, sha256: sha256(referenceBytes) },
        delivered: { path: deliveredPath, sha256: deliveredSha },
        platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
      },
      eligibility: { eligible: true },
    },
  });

  const request: CascadeReauditionRequest = {
    subject: LOLA,
    artifact,
    artifactPath: join(dir, "scoreboard.json"),
    reference: referencePath,
    delivered: deliveredPath,
    transcript: TRANSCRIPT,
    line: { kind: "greeting", text: VONI_GREETINGS.es! },
    ballots,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    ...overrides,
  };
  return { request, artifact, dir, referencePath, deliveredPath, deliveredSha, ballots };
}

test("a clean cascade call assembles a complete two-capture pack", () => {
  const { request, deliveredSha } = fixture();
  const pack = assembleCascadeReauditionPack(request);

  assert.equal(pack.status, "complete", pack.blockers.join("; "));
  assert.equal(pack.kind, "cascade-reaudition-pack");
  assert.equal(pack.subject.voice, "lola");
  assert.equal(pack.subject.locale, "es");
  assert.equal(pack.subject.pipeline, "cascade");

  // There is no platform leg: the pack has two captures and a named N/A.
  assert.equal(pack.captures.reference.present, true);
  assert.equal(pack.captures.delivered.present, true);
  assert.equal(pack.captures.delivered.sha256, deliveredSha);
  assert.equal(pack.captures.platform.path, null);
  assert.match(pack.captures.platform.absent ?? "", /no platform capture on the cascade/);
  assert.doesNotMatch(pack.comparison.table, /platform\s+\//);

  assert.equal(pack.comparison.status, "measured", pack.comparison.unresolvedReasons.join("; "));
  assert.deepEqual(
    pack.comparison.captures.map((capture) => capture.role),
    ["reference", "delivered"],
  );
  assert.match(pack.comparison.table, /W0 two-capture comparison/);
  assert.match(pack.comparison.table, /level-facts\.analyseLevel/);

  assert.equal(pack.ballots.required, 2);
  assert.equal(pack.ballots.recorded, 2);
  assert.equal(pack.ballots.complete, true);
  assert.equal(pack.ballots.sharedRecordingSha256, deliveredSha);
  assert.deepEqual(pack.ballots.reviewers, ["ana", "marta"]);

  assert.equal(pack.verdictInputs.ready, true);
  assert.equal(pack.verdictInputs.inputs.artifactClean, true);
  assert.equal(pack.verdictInputs.inputs.comparisonMeasured, true);
  assert.equal(pack.verdictInputs.inputs.ballotsComplete, true);
  assert.equal(pack.verdictInputs.inputs.noPlatformLeg, true);
  assert.match(pack.verdictInputs.rule.accept, /did not hold up/);
  assert.match(pack.verdictInputs.rule.withdraw, /held up/);
  assert.match(pack.verdictInputs.rule.unresolved, /cannot decide/);

  // The pack itself cannot decide: the owner's verdict is a separate statement
  // (ticket 134), and the pack records the inputs that verdict must rest on.
  assert.equal(pack.verdict.decision, "unresolved");
  assert.equal(pack.verdict.readyForOwner, true);
  assert.equal(pack.verdict.ownerVerdictRequired, true);
  assert.equal(pack.verdict.justifiesRenderingLayer, null);
});

test("a missing delivered capture leaves the pack incomplete and unresolved", () => {
  const { request } = fixture({ delivered: null });
  const pack = assembleCascadeReauditionPack(request);

  assert.equal(pack.status, "incomplete");
  assert.equal(pack.captures.delivered.present, false);
  assert.equal(pack.verdict.decision, "unresolved");
  assert.equal(pack.verdict.readyForOwner, false);
  assert.equal(pack.verdictInputs.ready, false);
  assert.match(pack.blockers.join(" "), /delivered capture missing/);
  assert.match(pack.verdict.basis.join(" "), /delivered capture missing/);
});

test("a missing ballot leaves the pack incomplete and unresolved", () => {
  const { request, ballots, deliveredSha } = fixture();
  const one = assembleCascadeReauditionPack({ ...request, ballots: ballots.slice(0, 1) });
  assert.equal(one.status, "incomplete");
  assert.equal(one.ballots.recorded, 1);
  assert.equal(one.ballots.complete, false);
  assert.match(one.blockers.join(" "), /two independent ballots/i);
  assert.equal(one.verdict.decision, "unresolved");

  const none = assembleCascadeReauditionPack({ ...request, ballots: [] });
  assert.equal(none.status, "incomplete");
  assert.equal(none.ballots.recorded, 0);
  assert.match(none.blockers.join(" "), /two independent ballots/i);

  // Two ballots from the same reviewer are one ear, not two.
  const duplicate = assembleCascadeReauditionPack({
    ...request,
    ballots: [ballots[0]!, { ...ballots[1]!, reviewer: ballots[0]!.reviewer }],
  });
  assert.equal(duplicate.status, "incomplete");
  assert.equal(duplicate.ballots.recorded, 1);
  assert.match(duplicate.blockers.join(" "), /independent|one per rater/i);

  // A ballot that judges other bytes is not a ballot on this recording.
  const otherRecording = assembleCascadeReauditionPack({
    ...request,
    ballots: [ballots[0]!, { ...ballots[1]!, recordingSha256: "b".repeat(64) }],
  });
  assert.equal(otherRecording.status, "incomplete");
  assert.match(otherRecording.blockers.join(" "), /different recording|shared recording/i);
  assert.notEqual(deliveredSha, "b".repeat(64));
});

test("a fallback or a budget stop makes the pack ineligible", () => {
  const { request, artifact } = fixture();
  const fallback = assembleCascadeReauditionPack({
    ...request,
    artifact: { ...artifact, events: [{ type: "provider_fallback" }] },
  });
  assert.equal(fallback.status, "incomplete");
  assert.match(fallback.blockers.join(" "), /provider_fallback/);
  assert.equal(fallback.verdictInputs.inputs.artifactClean, false);

  const budgetStop = assembleCascadeReauditionPack({
    ...request,
    artifact: {
      ...artifact,
      events: [{ type: "budget.stopped" }],
      eligibility: { eligible: false, reasons: ["budget.stopped: daily cap"] },
    },
  });
  assert.equal(budgetStop.status, "incomplete");
  assert.match(budgetStop.blockers.join(" "), /budget.stopped|ineligible/);
});

test("a managed artifact or another subject's artifact does not carry over", () => {
  const { request, artifact, deliveredPath, deliveredSha } = fixture();
  // A well-formed managed artifact carries all three capture legs, so the
  // reader accepts it and the pack must refuse it for the right reason: a
  // managed-path verdict does not carry over to the cascade.
  const managedArtifact = {
    ...artifact,
    pipeline: "managed",
    captures: {
      ...artifact.captures,
      platform: { path: deliveredPath, sha256: deliveredSha },
    },
  };
  const managed = assembleCascadeReauditionPack({
    ...request,
    artifact: managedArtifact,
  });
  assert.equal(managed.status, "incomplete");
  assert.match(managed.blockers.join(" "), /managed artifact/i);
  assert.match(managed.blockers.join(" "), /no carry-over|cascade artifact/i);

  const otherSubject = assembleCascadeReauditionPack({
    ...request,
    artifact: {
      ...artifact,
      voice: "giovanni",
      subject: {
        agent: { kind: "demo", voice: "giovanni", agentId: null },
        locale: "it",
        transport: "browser",
        source: "flag",
        pipeline: "cascade",
      },
    },
  });
  assert.equal(otherSubject.status, "incomplete");
  assert.match(otherSubject.blockers.join(" "), /subject/i);
  assert.match(otherSubject.blockers.join(" "), /giovanni|it/);
});

test("a missing artifact or a misdescribed capture blocks the pack", () => {
  const { request, artifact } = fixture();

  const noArtifact = assembleCascadeReauditionPack({ ...request, artifact: null });
  assert.equal(noArtifact.status, "incomplete");
  assert.match(noArtifact.blockers.join(" "), /artifact unreadable/);
  assert.equal(noArtifact.verdictInputs.inputs.artifactClean, false);

  const wrongHash = assembleCascadeReauditionPack({
    ...request,
    artifact: {
      ...artifact,
      captures: {
        ...artifact.captures,
        delivered: { path: request.delivered!, sha256: "c".repeat(64) },
      },
    },
  });
  assert.equal(wrongHash.status, "incomplete");
  assert.match(wrongHash.blockers.join(" "), /delivered capture hash mismatch/);
  assert.match(wrongHash.blockers.join(" "), /misdescribed capture/);
});

test("a transcript line different from the reference is unresolved", () => {
  const { request } = fixture({
    transcript: [
      { speaker: "agent", text: "Hola, soy otra frase completamente distinta." },
      { speaker: "caller", text: "Vale." },
    ],
  });
  const pack = assembleCascadeReauditionPack(request);
  assert.equal(pack.status, "incomplete");
  assert.match(pack.blockers.join(" "), /different line/);
  assert.equal(pack.verdictInputs.inputs.comparisonMeasured, false);
});

test("the roster lists six subjects and keeps German open, never fabricated", () => {
  const { request } = fixture();
  const pack = assembleCascadeReauditionPack(request);
  const roster = cascadeReauditionRoster([pack]);

  assert.equal(roster.subjects.length, 6);
  assert.deepEqual(
    roster.subjects.map((row) => row.voice),
    ["anna", "lola", "estelle", "juergen", "giovanni", "rafael"],
  );
  const german = roster.subjects.find((row) => row.voice === "juergen")!;
  assert.equal(german.locale, "de");
  assert.equal(german.status, "open");
  assert.match(german.openReason ?? "", /German stays open|voice_not_found/);
  assert.equal(german.packStatus, null);
  assert.equal(german.ballots, 0);

  const lola = roster.subjects.find((row) => row.voice === "lola")!;
  assert.equal(lola.status, "complete");
  assert.equal(lola.ballots, 2);

  const anna = roster.subjects.find((row) => row.voice === "anna")!;
  assert.equal(anna.status, "missing");
  assert.match(anna.openReason ?? "", /no pack supplied/);

  assert.equal(roster.ready, false);
  assert.match(roster.blockers.join(" "), /anna/);
  assert.match(roster.blockers.join(" "), /juergen|de/);
});
