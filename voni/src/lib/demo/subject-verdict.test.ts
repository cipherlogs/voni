/**
 * Per-subject verdicts (meta-cascade M3/M13, ticket 117).
 *
 * A matrix row's verdict is a function of that subject's own artifact. There is
 * no parameter, field or neighbour through which another subject's verdict can
 * travel: a copied verdict fails, an ineligible run is blocked, a missing
 * artifact is unresolved with a named reason, and an artifact from older code is
 * historical evidence that cannot answer for the current matrix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATE_VOICE,
  buildSkeletonArtifact,
  resolveMatrixVoices,
  subjectGateVerdict as subjectGateVerdictFromScoreboard,
  type CodeFingerprint,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "./scoreboard";
import {
  formatMatrixTable,
  subjectGateVerdict,
  subjectRowKey,
  buildRegressionMatrix,
  type RegressionSubjectInput,
} from "./subject-verdict";
import {
  formatSubject,
  resolveCascadeSubject,
  resolveSubject,
  type SubjectRecord,
} from "./subject";

const CLEAN_CODE: CodeFingerprint = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: "0".repeat(64),
};
const MOVED_CODE: CodeFingerprint = {
  head: "b".repeat(40),
  dirty: false,
  dirtyHash: "1".repeat(64),
};

const PASS_GATES: ScoreboardGate[] = [
  { name: "plumbing", status: "PASS", detail: "eval runner finished" },
];

/** One subject's own run: the subject record, its gates and its code. */
function runFor(
  subject: SubjectRecord,
  options: {
    gates?: ScoreboardGate[];
    pipeline?: ScoreboardArtifact["pipeline"];
    code?: CodeFingerprint | null;
    eligibility?: ScoreboardArtifact["eligibility"];
    events?: ScoreboardArtifact["events"];
    runId?: string;
  } = {},
): ScoreboardArtifact {
  const voice = subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId;
  const artifact = buildSkeletonArtifact({
    voice,
    subject,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runId: options.runId ?? `run-${subjectRowKey(subject).replace(/[^a-zA-Z0-9]+/g, "-")}`,
    codeFingerprint: options.code === undefined ? CLEAN_CODE : options.code,
  });
  return {
    ...artifact,
    gates: options.gates ?? PASS_GATES,
    // Tag discipline is a matrix regression check; the row's own transcript
    // says the expected tag once so only the facts under test can decide it.
    transcripts: { ...artifact.transcripts, redacted: ["send it with Lime 42 in the subject"] },
    ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
    ...(options.eligibility !== undefined ? { eligibility: options.eligibility } : {}),
    ...(options.events !== undefined ? { events: options.events } : {}),
  };
}

/** The featured row opens the ordering gate; the rows under test follow it. */
function withFeatured(entries: RegressionSubjectInput[]): RegressionSubjectInput[] {
  const featured = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  return [{ subject: featured, artifact: runFor(featured) }, ...entries];
}

test("a managed and a cascade run of one voice are two subjects with their own verdicts", () => {
  const managed = resolveSubject({ voice: "lola" });
  const cascade = resolveCascadeSubject({ voice: "lola" });
  assert.equal(managed.pipeline, undefined);
  assert.equal(cascade.pipeline, "cascade");

  const matrix = buildRegressionMatrix({
    entries: withFeatured([
      { subject: managed, artifact: runFor(managed, { pipeline: "managed", runId: "run-managed" }) },
      { subject: cascade, artifact: runFor(cascade, { pipeline: "cascade", runId: "run-cascade" }) },
    ]),
  });

  const managedRow = matrix.results.find(
    (row) => row.subject.agent.kind === "demo" && row.subject.agent.voice === "lola" && row.subject.pipeline === undefined,
  );
  const cascadeRow = matrix.results.find((row) => row.subject.pipeline === "cascade");
  assert.ok(managedRow, "the managed subject keeps its own row");
  assert.ok(cascadeRow, "the cascade subject keeps its own row");
  assert.notEqual(managedRow.key, cascadeRow.key, "the pipeline axis is part of the subject key");
  assert.match(managedRow.key, /\/managed$/);
  assert.match(cascadeRow.key, /\/cascade$/);
  assert.equal(managedRow.verdict?.runId, "run-managed");
  assert.equal(cascadeRow.verdict?.runId, "run-cascade");
  assert.match(formatSubject(cascadeRow.subject), /cascade/);
  assert.equal(matrix.results.length, 3);
});

test("an ineligible run cannot be green even when every gate PASSes", () => {
  const anna = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  const matrix = buildRegressionMatrix({
    entries: [
      {
        subject: anna,
        artifact: runFor(anna, {
          eligibility: { eligible: false, reasons: ["a budget stop ended the call"] },
        }),
      },
    ],
  });
  const row = matrix.results[0];
  assert.equal(row.status, "BLOCKED", "eligibility outranks the numbers");
  assert.equal(row.verdict?.status, "BLOCKED");
  assert.equal(row.verdict?.eligible, false);
  assert.match(row.detail, /budget stop ended the call/);
  assert.equal(matrix.gates.find((gate) => gate.name === "matrix")?.status, "FAIL");

  // A recorded `eligible: true` and PASSing gates cannot hide a fallback fact.
  const contaminated = runFor(anna, {
    eligibility: { eligible: true },
    events: [{ type: "provider_fallback", leg: "llm", phase: "connect" }],
  });
  const fallbackRow = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: contaminated }],
  }).results[0];
  assert.equal(fallbackRow.status, "BLOCKED");
  assert.match(fallbackRow.detail, /fallback/);
  assert.doesNotMatch(formatMatrixTable({ ...matrix }), /BLOCK\s+demo anna.*\bPASS\b/);
});

test("an artifact from older code is historical only and blocked for the current matrix", () => {
  const anna = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  const stale = runFor(anna, { code: CLEAN_CODE, runId: "run-old-code" });

  const blocked = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: stale }],
    expectedCode: MOVED_CODE,
  });
  const row = blocked.results[0];
  assert.equal(row.status, "BLOCKED");
  assert.match(row.detail, /historical/);
  assert.match(row.detail, new RegExp(CLEAN_CODE.head.slice(0, 12)));
  assert.match(row.detail, new RegExp(MOVED_CODE.head.slice(0, 12)));
  assert.equal(blocked.gates.find((gate) => gate.name === "matrix")?.status, "FAIL");

  const current = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: stale }],
    expectedCode: CLEAN_CODE,
  });
  assert.equal(current.results[0].status, "PASS", "the run is current for this tree");

  // A dirty tree is the current tree: the matrix judges it by its own
  // fingerprint, not against a pristine HEAD.
  const dirtyCode = { head: CLEAN_CODE.head, dirty: true, dirtyHash: "2".repeat(64) };
  const dirty = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: runFor(anna, { code: dirtyCode }) }],
    expectedCode: dirtyCode,
  });
  assert.equal(dirty.results[0].status, "PASS");

  const unknown = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: stale }],
    expectedCode: null,
  });
  assert.equal(unknown.results[0].status, "BLOCKED");
  assert.match(unknown.results[0].detail, /code under judgement/);
});

test("a subject with no artifact is unresolved with a named reason, never a pass", () => {
  const anna = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  const lola = resolveSubject({ voice: "lola" });
  const missingFeatured = buildRegressionMatrix({
    entries: [{ subject: anna }, { subject: lola, artifact: runFor(lola) }],
    expectedCode: CLEAN_CODE,
  });
  const annaRow = missingFeatured.results.find((row) => row.subject.locale === "en");
  assert.equal(annaRow?.status, "MISSING");
  assert.match(annaRow?.detail ?? "", /no run artifact/);
  const blockedRow = missingFeatured.results.find((row) => row.subject.locale === "es");
  assert.equal(blockedRow?.status, "BLOCKED", "a missing featured run leaves the gate shut");
  assert.equal(blockedRow?.verdict, null);
  assert.match(blockedRow?.detail ?? "", /featured subject demo anna \(en, browser\) has not passed/);

  const missing = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: runFor(anna) },
      { subject: lola },
    ],
    expectedCode: CLEAN_CODE,
  });
  const missingRow = missing.results.find((entry) => entry.subject.locale === "es");
  assert.equal(missingRow?.status, "MISSING");
  assert.equal(missingRow?.verdict, null);
  assert.match(missingRow?.detail ?? "", /no run artifact/);
  assert.notEqual(missingRow?.status, "PASS");
});

test("a carried verdict is constructed and observed to fail", () => {
  const anna = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  const lola = resolveSubject({ voice: "lola" });
  const annaRun = runFor(anna, { runId: "run-anna" });
  const lolaRun = runFor(lola, { runId: "run-lola" });

  // A copied verdict attached to the entry (a pasted matrix row) is refused.
  assert.throws(
    () =>
      buildRegressionMatrix({
        entries: [
          {
            subject: lola,
            artifact: lolaRun,
            verdict: subjectGateVerdict(annaRun),
          } as unknown as RegressionSubjectInput,
        ],
      }),
    /carried verdict/,
    "a row cannot carry another subject's verdict",
  );

  // A copied verdict attached to the artifact (a stitched artifact) is refused.
  assert.throws(
    () =>
      buildRegressionMatrix({
        entries: [
          {
            subject: lola,
            artifact: { ...lolaRun, verdict: subjectGateVerdict(annaRun) } as ScoreboardArtifact,
          },
        ],
      }),
    /carried verdict/,
    "an artifact cannot smuggle a verdict past its own gates",
  );

  // And the artifact of another subject is never accepted as this row's run.
  assert.throws(
    () => buildRegressionMatrix({ entries: [{ subject: lola, artifact: annaRun }] }),
    /only reads its own subject's run/,
  );
});

test("an artifact whose pipeline disagrees with its subject is blocked by name", () => {
  const managed = resolveSubject({ voice: "lola" });
  const explicitManaged = { ...managed, pipeline: "managed" as const };
  const mismatched = runFor(explicitManaged, { pipeline: "cascade", runId: "run-mismatch" });
  const verdict = subjectGateVerdict(mismatched);
  assert.equal(verdict.status, "BLOCKED");
  assert.match(verdict.detail, /pipeline/);
  assert.match(verdict.detail, /cascade/);
  assert.match(verdict.detail, /managed/);

  // Through the matrix the contradiction is a blocked row, not a carried
  // verdict: the pipeline is part of subject identity (ticket 117).
  const row = buildRegressionMatrix({
    entries: [{ subject: managed, artifact: mismatched }],
  }).results[0];
  assert.equal(row.status, "BLOCKED");
  assert.match(row.detail, /pipeline/);
});

test("the matrix voice list stays a registry parameter", () => {
  assert.deepEqual(resolveMatrixVoices(""), resolveMatrixVoices(""));
  assert.throws(() => resolveMatrixVoices("lola,not-a-voice"), /unknown gate voice/);
});

test("the scoreboard keeps the per-subject verdict on its public surface", () => {
  assert.equal(
    subjectGateVerdictFromScoreboard,
    subjectGateVerdict,
    "existing readers can import the verdict from scoreboard without a second implementation",
  );
});
