/**
 * The W2 cascade owner verdict (meta-cascade M16, ticket 134).
 *
 * The pack (ticket 133) assembles the inputs and never decides. These tests
 * hold the recorder to the ticket's four rules: the owner's statement is a
 * named human on a named capture with a date and written reasons; it is
 * separate from the two ballots; accept and withdraw keep ADR 0008's meanings;
 * and an unresolved pack blocks the Locale and is never a pass.
 *
 * The fixture pack is synthetic, so no network or live call is involved. A
 * synthetic pack is a mechanism fixture; it is never evidence a gate resolves on.
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
  type CascadeBallot,
  type CascadeReauditionRequest,
} from "./cascade-reaudition";
import {
  applyCascadeVerdictToAdr,
  CASCADE_VERDICT_MARKER,
  CascadeVerdictError,
  formatCascadeVerdictSection,
  recordCascadeOwnerVerdict,
  type CascadeOwnerVerdictInput,
} from "./cascade-verdict";
import { VONI_GREETINGS } from "./voni-agent";
import type { SubjectRecord } from "./subject";
import type { ContentTurn } from "../voice/content-judge";

const SAMPLE_RATE = 24_000;

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
  const dir = mkdtempSync(join(tmpdir(), "cascade-verdict-"));
  const referencePath = join(dir, "lola-reference.wav");
  const deliveredPath = join(dir, "delivered-20261030.wav");
  const referenceBytes = wavFrom(tone(1, 1_000, 0.4));
  const deliveredBytes = wavFrom(tone(1, 1_000, 0.4));
  writeFileSync(referencePath, referenceBytes);
  writeFileSync(deliveredPath, deliveredBytes);

  const deliveredSha = sha256(deliveredBytes);
  const ballots: CascadeBallot[] = [
    {
      reviewer: "ana",
      reviewedOn: "2026-10-30",
      recordingSha256: deliveredSha,
      scores: { timbre: 5, accent: 5, languageNaturalness: 3 },
      reason: "Natural enough, but one phrase is calqued from English.",
      axisReasons: { languageNaturalness: "'Siento oír eso' reads as translationese." },
    },
    {
      reviewer: "marta",
      reviewedOn: "2026-10-30",
      recordingSha256: deliveredSha,
      scores: { timbre: 5, accent: 5, languageNaturalness: 3 },
      reason: "The line is clear; the ending trails off.",
      axisReasons: { languageNaturalness: "The last word is cut short." },
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
        startedAt: "2026-10-30T10:00:00.000Z",
        finishedAt: "2026-10-30T10:00:03.000Z",
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
    now: () => new Date("2026-10-30T12:00:00.000Z"),
    ...overrides,
  };
  return {
    request,
    pack: assembleCascadeReauditionPack(request),
    dir,
    referencePath,
    deliveredPath,
    deliveredSha,
    ballots,
    packPath: join(dir, "pack", "pack.json"),
  };
}

function input(deliveredSha: string, overrides: Partial<CascadeOwnerVerdictInput> = {}): CascadeOwnerVerdictInput {
  return {
    decision: "accept",
    decidedOn: "2026-10-30",
    reviewer: "Owner Name",
    capture: { path: "/captures/delivered-20261030.wav", sha256: deliveredSha },
    reasons: ["The Spanish line stumbles on the second sentence and ends mid-clause."],
    ...overrides,
  };
}

test("a complete pack accepts a named owner verdict with date and reasons", () => {
  const { pack, deliveredSha, packPath } = fixture();
  const record = recordCascadeOwnerVerdict(pack, input(deliveredSha), packPath);

  assert.equal(record.decision, "accept");
  assert.equal(record.justifiesRenderingLayer, true);
  assert.equal(record.reviewer, "Owner Name");
  assert.equal(record.decidedOn, "2026-10-30");
  assert.equal(record.capture.sha256, deliveredSha);
  assert.equal(record.subject.voice, "lola");
  assert.equal(record.subject.locale, "es");
  assert.equal(record.pack.readyForOwner, true);
  assert.match(record.artifact.path, /scoreboard\.json$/);
  assert.equal(record.artifact.eligible, true);
  assert.equal(record.blocksLocale, false);

  // The two ballots are carried, never substituted for the verdict.
  assert.equal(record.ballots.recorded, 2);
  assert.deepEqual(record.ballots.reviewers, ["ana", "marta"]);
  assert.equal(record.ballots.sharedRecordingSha256, deliveredSha);
});

test("accept and withdraw keep ADR 0008's meanings and never flip", () => {
  const { pack, deliveredSha, packPath } = fixture();

  const accept = recordCascadeOwnerVerdict(pack, input(deliveredSha), packPath);
  assert.equal(accept.justifiesRenderingLayer, true);
  assert.match(accept.sentence, /did not hold up/);
  assert.match(accept.sentence, /justified/);

  const withdraw = recordCascadeOwnerVerdict(
    pack,
    input(deliveredSha, { decision: "withdraw" }),
    packPath,
  );
  assert.equal(withdraw.justifiesRenderingLayer, false);
  assert.match(withdraw.sentence, /held up/);
  assert.match(withdraw.sentence, /not justified/);

  const unresolved = recordCascadeOwnerVerdict(
    pack,
    input(deliveredSha, { decision: "unresolved" }),
    packPath,
  );
  assert.equal(unresolved.justifiesRenderingLayer, null);
  assert.equal(unresolved.blocksLocale, true);
  assert.match(unresolved.sentence, /cannot decide/);

  assert.match(formatCascadeVerdictSection(accept), /Content did not hold up/);
  assert.match(formatCascadeVerdictSection(withdraw), /Content held up/);
  assert.match(formatCascadeVerdictSection(unresolved), /cannot decide/);
});

test("an unnamed human or an unnamed capture is not a verdict", () => {
  const { pack, deliveredSha, packPath } = fixture();

  assert.throws(
    () => recordCascadeOwnerVerdict(pack, input(deliveredSha, { reviewer: "   " }), packPath),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /name the human/.test(error.message),
  );

  assert.throws(
    () =>
      recordCascadeOwnerVerdict(
        pack,
        input(deliveredSha, { capture: { path: "  ", sha256: deliveredSha } }),
        packPath,
      ),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /name the delivered capture/.test(error.message),
  );

  // A capture that is not the pack's delivered recording is a different verdict.
  assert.throws(
    () =>
      recordCascadeOwnerVerdict(
        pack,
        input(deliveredSha, { capture: { path: "/captures/other.wav", sha256: "a".repeat(64) } }),
        packPath,
      ),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /different recording/.test(error.message),
  );
});

test("a verdict with no written reasons or no date is not a verdict", () => {
  const { pack, deliveredSha, packPath } = fixture();

  assert.throws(
    () => recordCascadeOwnerVerdict(pack, input(deliveredSha, { reasons: [] }), packPath),
    (error: unknown) => error instanceof CascadeVerdictError && /written reason/.test(error.message),
  );
  assert.throws(
    () => recordCascadeOwnerVerdict(pack, input(deliveredSha, { reasons: ["   "] }), packPath),
    (error: unknown) => error instanceof CascadeVerdictError && /written reason/.test(error.message),
  );
  assert.throws(
    () => recordCascadeOwnerVerdict(pack, input(deliveredSha, { decidedOn: "30.10.2026" }), packPath),
    (error: unknown) => error instanceof CascadeVerdictError && /YYYY-MM-DD/.test(error.message),
  );
});

test("an incomplete pack refuses accept and withdraw, and unresolved blocks the Locale", () => {
  const { request, deliveredSha, packPath } = fixture({ delivered: null });
  const incomplete = assembleCascadeReauditionPack(request);
  assert.equal(incomplete.status, "incomplete");

  for (const decision of ["accept", "withdraw"] as const) {
    assert.throws(
      () => recordCascadeOwnerVerdict(incomplete, input(deliveredSha, { decision }), packPath),
      (error: unknown) =>
        error instanceof CascadeVerdictError &&
        /not a pass/.test(error.message) &&
        /delivered capture missing/.test(error.message),
    );
  }

  const unresolved = recordCascadeOwnerVerdict(
    incomplete,
    input(deliveredSha, {
      decision: "unresolved",
      reasons: ["No delivered capture was written, so the line cannot be judged."],
      capture: { path: "  ", sha256: "" },
    }),
    packPath,
  );
  assert.equal(unresolved.decision, "unresolved");
  assert.equal(unresolved.blocksLocale, true);
  assert.match(unresolved.sentence, /blocks/);
});

test("a missing ballot blocks an accept even when the audio is present", () => {
  const { request, deliveredSha, packPath } = fixture();
  const oneBallot = assembleCascadeReauditionPack({
    ...request,
    ballots: request.ballots.slice(0, 1),
  });
  assert.equal(oneBallot.status, "incomplete");

  assert.throws(
    () => recordCascadeOwnerVerdict(oneBallot, input(deliveredSha), packPath),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /two independent ballots/.test(error.message),
  );
});

test("an unresolved verdict on a complete pack still names the capture", () => {
  const { pack, deliveredSha, packPath } = fixture();

  assert.throws(
    () =>
      recordCascadeOwnerVerdict(
        pack,
        input(deliveredSha, { decision: "unresolved", capture: { path: null, sha256: "" } }),
        packPath,
      ),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /still names the capture/.test(error.message),
  );

  // The same decision with the capture named is recordable.
  const named = recordCascadeOwnerVerdict(
    pack,
    input(deliveredSha, { decision: "unresolved" }),
    packPath,
  );
  assert.equal(named.blocksLocale, true);
});

test("a verdict cannot be dated in the future", () => {
  const { pack, deliveredSha, packPath } = fixture();
  assert.throws(
    () =>
      recordCascadeOwnerVerdict(
        pack,
        input(deliveredSha, { decidedOn: "2999-01-01" }),
        packPath,
        () => new Date("2026-10-30T12:00:00.000Z"),
      ),
    (error: unknown) => error instanceof CascadeVerdictError && /in the future/.test(error.message),
  );
});

test("a pack whose recorded delivered hash disagrees with its file is misdescribed", () => {
  const { pack, deliveredPath, packPath } = fixture();
  const tampered = {
    ...pack,
    captures: {
      ...pack.captures,
      delivered: { ...pack.captures.delivered, sha256: "b".repeat(64) },
    },
  };

  assert.throws(
    () =>
      recordCascadeOwnerVerdict(
        tampered,
        input("b".repeat(64), { capture: { path: deliveredPath, sha256: "b".repeat(64) } }),
        packPath,
      ),
    (error: unknown) =>
      error instanceof CascadeVerdictError && /misdescribed/.test(error.message),
  );
});

test("the ADR section is recorded beside the managed W2 gate and changes no status", () => {
  const { pack, deliveredSha, packPath } = fixture();
  const record = recordCascadeOwnerVerdict(pack, input(deliveredSha), packPath);

  const adr = [
    "# English is one rendering of six, not the source of meaning",
    "",
    "**Status: accepted.** The decision stands on its own.",
    "",
    "## Re-audition (W2 gate)",
    "",
    "**Verdict: accept** — 2026-10-29. Content did not hold up for lola (es).",
    "",
    "- Subject: `lola` (`es`).",
    "",
  ].join("\n");

  const updated = applyCascadeVerdictToAdr(adr, record);

  // The managed W2 section and the document status are untouched.
  assert.match(updated, /\*\*Status: accepted\.\*\*/);
  assert.match(updated, /## Re-audition \(W2 gate\)/);
  assert.match(updated, /2026-10-29/);

  // The cascade verdict is its own section, separated from the managed one.
  assert.match(updated, new RegExp(CASCADE_VERDICT_MARKER.replace(/[()]/g, "\\$&")));
  assert.match(updated, /\*\*Verdict: accept\*\* — 2026-10-30\./);
  assert.match(updated, /Owner Name/);
  assert.match(updated, /separate from the ballots/i);
  assert.match(updated, /no ADR status/);

  // Writing twice replaces the section instead of stacking a second copy.
  const twice = applyCascadeVerdictToAdr(updated, record);
  assert.equal(twice, updated);

  // A later section survives the replace: the walk stops at the next heading.
  const withTail = `${updated}\n## Later evidence\n\n- keep me.\n`;
  const regenerated = applyCascadeVerdictToAdr(withTail, record);
  assert.match(regenerated, /## Later evidence/);
  assert.match(regenerated, /keep me\./);
  assert.equal(regenerated.match(/W2 cascade re-audition/g)?.length, 1);
  assert.equal(regenerated.match(/Owner Name/g)?.length, 1);
});

test("an unresolved section names its blockers and blocks the Locale", () => {
  const { request, deliveredSha, packPath } = fixture({ delivered: null });
  const incomplete = assembleCascadeReauditionPack(request);
  const record = recordCascadeOwnerVerdict(
    incomplete,
    input(deliveredSha, {
      decision: "unresolved",
      reasons: ["No delivered capture was written."],
      capture: { path: "  ", sha256: "" },
    }),
    packPath,
  );

  const section = formatCascadeVerdictSection(record);
  assert.match(section, /blocks the Locale/);
  assert.match(section, /not a pass/);
  assert.match(section, /delivered capture missing/);
});
