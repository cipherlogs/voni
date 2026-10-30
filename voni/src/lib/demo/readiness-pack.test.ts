/**
 * The all-subject readiness pack (ticket 152): verify a manifest of subject
 * evidence and emit the cutover pack with named blockers. The pack assembles
 * and checks; it never decides accept/withdraw and never marks a human ticket
 * resolved.
 *
 * Fixtures build their own WAVs and real cascade artifacts, so no network,
 * provider or live call is involved. A synthetic pack is a fixture for the
 * mechanism; it is never evidence a gate can resolve on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSkeletonArtifact, CASCADE_PLATFORM_CAPTURE_ABSENCE } from "./scoreboard";
import type { SubjectRecord } from "./subject";
import type { ContentTurn } from "../voice/content-judge";
import {
  assembleReadinessPack,
  formatReadinessPack,
  type ReadinessManifest,
  type ReadinessManifestSubject,
} from "./readiness-pack";

const SAMPLE_RATE = 24_000;
const CLEAN_CODE = { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) };

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

type SubjectSpec = {
  subject: string;
  kind: "demo" | "tenant";
  locale: string;
  greeting: string;
};

const BOUND_SUBJECTS: SubjectSpec[] = [
  { subject: "anna", kind: "demo", locale: "en", greeting: "Hi, this is Anna." },
  { subject: "lola", kind: "demo", locale: "es", greeting: "Hola, soy Lola." },
  { subject: "estelle", kind: "demo", locale: "fr", greeting: "Bonjour, je suis Estelle." },
  { subject: "jorg", kind: "demo", locale: "de", greeting: "Hallo, hier ist Jorg." },
  { subject: "giovanni", kind: "demo", locale: "it", greeting: "Ciao, sono Giovanni." },
  { subject: "rafael", kind: "demo", locale: "pt", greeting: "Olá, sou o Rafael." },
  { subject: "agent_tenant_1", kind: "tenant", locale: "es", greeting: "Hola, soy el agente." },
];

function subjectRecord(spec: SubjectSpec): SubjectRecord {
  return spec.kind === "demo"
    ? {
        agent: { kind: "demo", voice: spec.subject, agentId: null },
        locale: spec.locale,
        transport: "browser",
        source: "flag",
        pipeline: "cascade",
      }
    : {
        agent: { kind: "tenant", agentId: spec.subject },
        locale: spec.locale,
        transport: "browser",
        source: "flag",
        pipeline: "cascade",
      };
}

function writeArtifact(input: {
  dir: string;
  spec: SubjectSpec;
  runId: string;
  recordedAt: string;
  referencePath: string;
  deliveredPath: string;
  referenceSha: string;
  deliveredSha: string;
  overrides?: Record<string, unknown>;
}): string {
  const subject = subjectRecord(input.spec);
  const artifact = buildSkeletonArtifact({
    voice: input.spec.kind === "demo" ? input.spec.subject : "anna",
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId: input.runId,
    codeFingerprint: CLEAN_CODE,
    subject,
    engine: {
      pipeline: "cascade",
      run: {
        runId: input.runId,
        variant: `cascade-${input.spec.subject}`,
        startedAt: input.recordedAt,
        finishedAt: input.recordedAt,
      },
      captures: {
        reference: { path: input.referencePath, sha256: input.referenceSha },
        delivered: { path: input.deliveredPath, sha256: input.deliveredSha },
        platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
      },
      eligibility: { eligible: true },
    },
  });
  const path = join(input.dir, `${input.runId}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ ...artifact, recordedAt: input.recordedAt, ...input.overrides }, null, 2)}\n`,
  );
  return path;
}

function writeManagedArtifact(input: {
  dir: string;
  spec: SubjectSpec;
  runId: string;
  recordedAt: string;
  referencePath: string;
  deliveredPath: string;
}): string {
  const artifact = buildSkeletonArtifact({
    voice: input.spec.subject,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId: input.runId,
    codeFingerprint: CLEAN_CODE,
    subject: { ...subjectRecord(input.spec), pipeline: "managed" },
    engine: {
      pipeline: "managed",
      run: {
        runId: input.runId,
        variant: "managed",
        startedAt: input.recordedAt,
        finishedAt: input.recordedAt,
      },
      captures: {
        reference: {
          path: input.referencePath,
          sha256: sha256(readFileSync(input.referencePath)),
        },
        platform: {
          path: input.deliveredPath,
          sha256: sha256(readFileSync(input.deliveredPath)),
        },
        delivered: {
          path: input.deliveredPath,
          sha256: sha256(readFileSync(input.deliveredPath)),
        },
      },
      eligibility: { eligible: true },
    },
  });
  const path = join(input.dir, `${input.runId}.json`);
  writeFileSync(path, `${JSON.stringify({ ...artifact, recordedAt: input.recordedAt }, null, 2)}\n`);
  return path;
}

function subjectEntry(spec: SubjectSpec, dir: string): ReadinessManifestSubject {
  const referencePath = join(dir, `${spec.subject}-reference.wav`);
  const deliveredPath = join(dir, `${spec.subject}-delivered.wav`);
  const referenceBytes = wavFrom(tone(0.6, 1_000, 0.4));
  const deliveredBytes = wavFrom(tone(0.6, 1_000, 0.4));
  writeFileSync(referencePath, referenceBytes);
  writeFileSync(deliveredPath, deliveredBytes);
  const referenceSha = sha256(referenceBytes);
  const deliveredSha = sha256(deliveredBytes);

  const first = writeArtifact({
    dir,
    spec,
    runId: `${spec.subject}-run-1`,
    recordedAt: "2026-10-28T10:00:00.000Z",
    referencePath,
    deliveredPath,
    referenceSha,
    deliveredSha,
  });
  const second = writeArtifact({
    dir,
    spec,
    runId: `${spec.subject}-run-2`,
    recordedAt: "2026-10-29T10:00:00.000Z",
    referencePath,
    deliveredPath,
    referenceSha,
    deliveredSha,
  });

  const transcript: ContentTurn[] = [
    { speaker: "agent", text: spec.greeting },
    { speaker: "caller", text: "Sí, claro." },
  ];
  return {
    subject: spec.subject,
    kind: spec.kind,
    locale: spec.locale,
    artifacts: [first, second],
    runHistory: [first, second],
    reference: referencePath,
    delivered: deliveredPath,
    line: { kind: "greeting", text: spec.greeting },
    transcript,
    verdict: {
      decision: "withdraw",
      decidedOn: "2026-10-29",
      reasons: "The content held up; the rendering layer is not needed for quality.",
    },
    ballots: [
      {
        reviewer: "ana",
        reviewedOn: "2026-10-29",
        recordingSha256: deliveredSha,
        scores: { timbre: 5, accent: 5, languageNaturalness: 5 },
        reason: "Clear, natural delivery; nothing to fix in this line.",
      },
      {
        reviewer: "marta",
        reviewedOn: "2026-10-29",
        recordingSha256: deliveredSha,
        scores: { timbre: 5, accent: 5, languageNaturalness: 5 },
        reason: "Sounds native; the line is clean.",
      },
    ],
  };
}

function completeManifest(): { manifest: ReadinessManifest; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "readiness-pack-"));
  return {
    dir,
    manifest: {
      subjects: BOUND_SUBJECTS.map((spec) => subjectEntry(spec, dir)),
      deferrals: [],
    },
  };
}

test("a complete manifest of the bound demo voices and one eligible tenant is ready", () => {
  const { manifest } = completeManifest();
  const pack = assembleReadinessPack({
    manifest,
    tenants: { subjects: [{ subject: "agent_tenant_1", locale: "es" }] },
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });

  assert.equal(pack.status, "ready", pack.blockers.join("; "));
  assert.equal(pack.ready, true);
  assert.deepEqual(pack.blockers, []);
  assert.equal(pack.recordedAt, "2026-10-30T12:00:00.000Z");

  const bySubject = new Map(pack.subjects.map((row) => [row.subject, row]));
  for (const spec of BOUND_SUBJECTS) {
    const row = bySubject.get(spec.subject)!;
    assert.equal(row.status, "complete", `${spec.subject}: ${row.blockers.join("; ")}`);
    assert.equal(row.artifacts.length, 2);
    assert.equal(row.artifacts[0]!.path.endsWith("-run-1.json"), true);
    assert.equal(row.artifacts[1]!.path.endsWith("-run-2.json"), true);
    for (const artifact of row.artifacts) {
      assert.equal(artifact.codeFingerprint?.head, CLEAN_CODE.head);
    }
    assert.equal(row.verdict?.decision, "withdraw");
    assert.equal(row.ballots.recorded, 2);
    assert.equal(row.ballots.complete, true);
  }

  const german = bySubject.get("jorg")!;
  assert.equal(german.status, "complete", german.blockers.join("; "));
  assert.equal(german.locale, "de");
  assert.equal(german.deferral, null, "German is bound: it needs evidence, not a deferral");

  const markdown = formatReadinessPack(pack);
  assert.match(markdown, /READY/);
  assert.match(markdown, /jorg/);
  assert.match(markdown, /agent_tenant_1/);
  assert.match(markdown, /aaaaaaaaaaaa/);
});

function rewriteArtifact(path: string, mutate: (artifact: Record<string, unknown>) => unknown): void {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(mutate(artifact), null, 2)}\n`);
}

function entryOf(manifest: ReadinessManifest, subject: string): ReadinessManifestSubject {
  const entry = manifest.subjects.find((candidate) => candidate.subject === subject);
  assert.ok(entry, `fixture has no subject ${subject}`);
  return entry;
}

function withEntry(
  manifest: ReadinessManifest,
  subject: string,
  mutate: (entry: ReadinessManifestSubject) => ReadinessManifestSubject,
): ReadinessManifest {
  return {
    ...manifest,
    subjects: manifest.subjects.map((entry) => (entry.subject === subject ? mutate(entry) : entry)),
  };
}

const TENANTS = { subjects: [{ subject: "agent_tenant_1", locale: "es" }] };

test("one failed or missing subject blocks the whole pack", () => {
  const { manifest } = completeManifest();

  const failed = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      artifacts: entry.artifacts.slice(0, 1),
    })),
    tenants: TENANTS,
  });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.ready, false);
  assert.match(failed.blockers.join(" "), /anna:.*exactly two consecutive clean cascade artifact paths/i);
  assert.equal(failed.subjects.find((row) => row.subject === "anna")!.status, "incomplete");
  // One failure does not hide the subjects that are complete.
  assert.equal(failed.subjects.find((row) => row.subject === "lola")!.status, "complete");

  const missing = assembleReadinessPack({
    manifest: { ...manifest, subjects: manifest.subjects.filter((entry) => entry.subject !== "anna") },
    tenants: TENANTS,
  });
  assert.equal(missing.status, "blocked");
  assert.match(missing.blockers.join(" "), /anna: no readiness evidence and no dated deferral/);
  assert.equal(missing.subjects.find((row) => row.subject === "anna")!.status, "missing");

  // A deferral cannot waive a subject whose evidence exists and failed.
  const waived = assembleReadinessPack({
    manifest: {
      ...manifest,
      subjects: manifest.subjects.map((entry) =>
        entry.subject === "anna" ? { ...entry, artifacts: entry.artifacts.slice(0, 1) } : entry,
      ),
      deferrals: [
        ...(manifest.deferrals ?? []),
        { subject: "anna", date: "2026-10-29", reason: "See if this quiet deferral hides the failure." },
      ],
    },
    tenants: TENANTS,
  });
  assert.equal(waived.status, "blocked");
  assert.match(waived.blockers.join(" "), /anna: deferral names a subject with recorded evidence/);
});

test("a fallback or a budget stop makes a run ineligible", () => {
  const { manifest } = completeManifest();
  rewriteArtifact(entryOf(manifest, "anna").artifacts[0]!, (artifact) => ({
    ...artifact,
    events: [{ type: "provider_fallback", leg: "llm", phase: "turn", turn: "turn-3" }],
    eligibility: { eligible: false, reasons: ["provider_fallback: llm at turn-3"] },
  }));
  rewriteArtifact(entryOf(manifest, "lola").artifacts[1]!, (artifact) => ({
    ...artifact,
    events: [{ type: "budget.stopped", phase: "drain" }],
    eligibility: { eligible: false, reasons: ["budget.stopped: daily cap"] },
  }));

  const pack = assembleReadinessPack({ manifest, tenants: TENANTS });
  assert.equal(pack.status, "blocked");
  const anna = pack.subjects.find((row) => row.subject === "anna")!;
  assert.match(anna.blockers.join(" "), /fallback/);
  assert.match(anna.blockers.join(" "), /not a clean run/);
  const lola = pack.subjects.find((row) => row.subject === "lola")!;
  assert.match(lola.blockers.join(" "), /budget stop|budget\.stopped|ineligible/i);
  assert.equal(lola.artifacts[1]!.eligible, false);
});

test("missing and duplicate ballots, an unresolved verdict and a missing fingerprint each block", () => {
  const { manifest } = completeManifest();
  const rafael = entryOf(manifest, "rafael");
  rewriteArtifact(rafael.artifacts[1]!, (artifact) => ({ ...artifact, codeFingerprint: null }));

  const pack = assembleReadinessPack({
    manifest: withEntry(
      withEntry(
        withEntry(manifest, "lola", (entry) => ({ ...entry, ballots: entry.ballots.slice(0, 1) })),
        "estelle",
        (entry) => ({
          ...entry,
          ballots: [
            entry.ballots[0]!,
            { ...entry.ballots[1]!, reviewer: entry.ballots[0]!.reviewer },
          ],
        }),
      ),
      "giovanni",
      (entry) => ({
        ...entry,
        verdict: { ...entry.verdict, decision: "unresolved" },
      }),
    ),
    tenants: TENANTS,
  });

  assert.equal(pack.status, "blocked");
  const blockersFor = (subject: string) =>
    pack.subjects.find((row) => row.subject === subject)!.blockers.join(" ");
  assert.match(blockersFor("lola"), /two independent ballots/i);
  assert.match(blockersFor("estelle"), /independent|one per rater/i);
  assert.match(blockersFor("giovanni"), /unresolved/);
  assert.match(blockersFor("rafael"), /code fingerprint/i);
  assert.equal(pack.subjects.find((row) => row.subject === "rafael")!.artifacts[1]!.codeFingerprint, null);
});

test("a tenant omission blocks unless it has a dated deferral", () => {
  const { manifest } = completeManifest();
  const roster = {
    subjects: [
      { subject: "agent_tenant_1", locale: "es" },
      { subject: "agent_tenant_2", locale: "fr" },
    ],
  };

  const omitted = assembleReadinessPack({ manifest, tenants: roster });
  assert.equal(omitted.status, "blocked");
  assert.match(omitted.blockers.join(" "), /agent_tenant_2: no readiness evidence and no dated deferral/);
  assert.equal(omitted.subjects.find((row) => row.subject === "agent_tenant_2")!.status, "missing");

  const deferred = assembleReadinessPack({
    manifest: {
      ...manifest,
      deferrals: [
        ...(manifest.deferrals ?? []),
        {
          subject: "agent_tenant_2",
          date: "2026-10-30",
          reason: "Tenant onboarding completes after cutover; dated deferral recorded by the owner.",
        },
      ],
    },
    tenants: roster,
  });
  assert.equal(deferred.status, "ready", deferred.blockers.join("; "));
  const row = deferred.subjects.find((candidate) => candidate.subject === "agent_tenant_2")!;
  assert.equal(row.status, "deferred");
  assert.equal(row.deferral?.date, "2026-10-30");

  // Evidence for another Locale is another subject, not the roster's row.
  const wrongLocale = assembleReadinessPack({
    manifest: {
      ...manifest,
      deferrals: [
        ...(manifest.deferrals ?? []),
        { subject: "agent_tenant_2", date: "2026-10-30", reason: "Onboarding after cutover." },
      ],
    },
    tenants: {
      subjects: [
        { subject: "agent_tenant_1", locale: "fr" },
        { subject: "agent_tenant_2", locale: "fr" },
      ],
    },
  });
  assert.equal(wrongLocale.status, "blocked");
  assert.match(
    wrongLocale.blockers.join(" "),
    /agent_tenant_1: tenant subject differs from the routing=all roster/,
  );

  // A tenant that is not on the routing=all roster is not eligible, and an
  // undated/unexplained deferral is not a record.
  const notEligible = assembleReadinessPack({
    manifest: {
      ...manifest,
      subjects: [
        ...manifest.subjects,
        {
          ...entryOf(manifest, "agent_tenant_1"),
          subject: "agent_tenant_3",
        },
      ],
    },
    tenants: roster,
  });
  assert.equal(notEligible.status, "blocked");
  assert.match(notEligible.blockers.join(" "), /agent_tenant_3: tenant subject is not eligible under routing=all/);

  const badDeferral = assembleReadinessPack({
    manifest: {
      ...manifest,
      deferrals: [
        ...(manifest.deferrals ?? []),
        { subject: "agent_tenant_2", date: "not-a-date", reason: "" },
      ],
    },
    tenants: roster,
  });
  assert.equal(badDeferral.status, "blocked");
  assert.match(badDeferral.blockers.join(" "), /agent_tenant_2: deferral date .* is not an ISO date/);
  assert.match(badDeferral.blockers.join(" "), /agent_tenant_2: deferral has no written reason/);
});

test("a managed artifact, another subject's artifact or a non-consecutive pair is refused", () => {
  const { manifest, dir } = completeManifest();

  const anna = entryOf(manifest, "anna");
  const annaManaged = writeManagedArtifact({
    dir,
    spec: BOUND_SUBJECTS[0]!,
    runId: "anna-managed",
    recordedAt: "2026-10-28T09:00:00.000Z",
    referencePath: anna.reference,
    deliveredPath: anna.delivered,
  });
  rewriteArtifact(entryOf(manifest, "lola").artifacts[0]!, (artifact) => ({
    ...artifact,
    voice: "giovanni",
    subject: {
      agent: { kind: "demo", voice: "giovanni", agentId: null },
      locale: "it",
      transport: "browser",
      source: "flag",
      pipeline: "cascade",
    },
  }));
  rewriteArtifact(entryOf(manifest, "giovanni").artifacts[1]!, (artifact) => ({
    ...artifact,
    recordedAt: artifact.recordedAt === "2026-10-29T10:00:00.000Z"
      ? "2026-10-28T10:00:00.000Z"
      : artifact.recordedAt,
  }));

  const pack = assembleReadinessPack({
    manifest: withEntry(
      withEntry(
        withEntry(manifest, "anna", (entry) => ({
          ...entry,
          artifacts: [annaManaged, entry.artifacts[1]!],
        })),
        "estelle",
        (entry) => ({
          ...entry,
          artifacts: [entry.artifacts[0]!, entry.artifacts[0]!],
        }),
      ),
      "rafael",
      (entry) => ({ ...entry, reference: join(dir, "missing-reference.wav") }),
    ),
    tenants: TENANTS,
  });

  assert.equal(pack.status, "blocked");
  const blockersFor = (subject: string) =>
    pack.subjects.find((row) => row.subject === subject)!.blockers.join(" ");
  assert.match(blockersFor("anna"), /managed, not cascade|managed artifact/i);
  assert.match(blockersFor("lola"), /subject does not match/);
  assert.match(blockersFor("estelle"), /two run paths are the same file/i);
  assert.match(blockersFor("giovanni"), /not ordered by recordedAt|consecutive runs need distinct/i);
  assert.match(blockersFor("rafael"), /reference capture missing/);
});

test("a malformed ballot is a named blocker, not a crash", () => {
  const { manifest } = completeManifest();
  const pack = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      ballots: [
        {
          reviewer: "ana",
          reviewedOn: "2026-10-29",
          recordingSha256: "a".repeat(64),
          scores: { timbre: "five" },
          reason: "A malformed score and a numeric axis reason must not crash the check.",
          axisReasons: { timbre: 3 },
        },
      ] as unknown as ReadinessManifestSubject["ballots"],
    })),
    tenants: TENANTS,
  });
  assert.equal(pack.status, "blocked");
  assert.match(
    pack.subjects.find((row) => row.subject === "anna")!.blockers.join(" "),
    /two independent ballots|score must be an int/i,
  );
});

test("a missing or malformed line marker blocks the comparison", () => {
  const { manifest } = completeManifest();
  const noLine = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({ ...entry, line: null })),
    tenants: TENANTS,
  });
  assert.match(
    noLine.subjects.find((row) => row.subject === "anna")!.blockers.join(" "),
    /no line marker/,
  );

  const badLine = assembleReadinessPack({
    manifest: withEntry(manifest, "lola", (entry) => ({
      ...entry,
      line: { kind: "greeting" } as unknown as ReadinessManifestSubject["line"],
    })),
    tenants: TENANTS,
  });
  assert.match(
    badLine.subjects.find((row) => row.subject === "lola")!.blockers.join(" "),
    /line marker must be/,
  );
});

function withoutHistory(
  entry: ReadinessManifestSubject,
  runsDir?: string,
): ReadinessManifestSubject {
  const copy = { ...entry };
  delete copy.runHistory;
  if (runsDir !== undefined) copy.runsDir = runsDir;
  return copy;
}

function thirdRun(
  dir: string,
  spec: SubjectSpec,
  entry: ReadinessManifestSubject,
  recordedAt = "2026-10-30T10:00:00.000Z",
): string {
  return writeArtifact({
    dir,
    spec,
    runId: `${spec.subject}-run-3`,
    recordedAt,
    referencePath: entry.reference,
    deliveredPath: entry.delivered,
    referenceSha: sha256(readFileSync(entry.reference)),
    deliveredSha: sha256(readFileSync(entry.delivered)),
  });
}

test("run history must be supplied and must end at the two chosen artifacts", () => {
  const { manifest, dir } = completeManifest();
  const anna = entryOf(manifest, "anna");
  const third = thirdRun(dir, BOUND_SUBJECTS[0]!, anna);
  const blockersFor = (pack: ReturnType<typeof assembleReadinessPack>) =>
    pack.subjects.find((row) => row.subject === "anna")!.blockers.join(" ");

  const noHistory = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => withoutHistory(entry)),
    tenants: TENANTS,
  });
  assert.equal(noHistory.status, "blocked");
  assert.match(
    blockersFor(noHistory),
    /run history not supplied; last-two consecutive unverified/,
  );

  const after = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      runHistory: [...entry.runHistory!, third],
    })),
    tenants: TENANTS,
  });
  assert.equal(after.status, "blocked");
  assert.match(blockersFor(after), /run history has 1 run\(s\) after the supplied pair/);

  const between = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      artifacts: [entry.artifacts[0]!, third],
      runHistory: [...entry.runHistory!, third],
    })),
    tenants: TENANTS,
  });
  assert.equal(between.status, "blocked");
  assert.match(blockersFor(between), /1 run\(s\) between the supplied artifacts/);

  const reversed = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      artifacts: [entry.artifacts[1]!, entry.artifacts[0]!],
    })),
    tenants: TENANTS,
  });
  assert.equal(reversed.status, "blocked");
  assert.match(blockersFor(reversed), /not in order/);
});

test("runsDir verifies the pair by scanning the subject's run files", () => {
  const { manifest, dir } = completeManifest();

  const ready = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => withoutHistory(entry, dir)),
    tenants: TENANTS,
  });
  assert.equal(ready.status, "ready", ready.blockers.join("; "));

  const anna = entryOf(manifest, "anna");
  thirdRun(dir, BOUND_SUBJECTS[0]!, anna);
  const blocked = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => withoutHistory(entry, dir)),
    tenants: TENANTS,
  });
  assert.equal(blocked.status, "blocked");
  assert.match(
    blocked.subjects.find((row) => row.subject === "anna")!.blockers.join(" "),
    /after the supplied pair|ineligible run after/,
  );
});

test("a history that is not oldest-first, or is doubly supplied, is refused", () => {
  const { manifest, dir } = completeManifest();
  const blockersFor = (pack: ReturnType<typeof assembleReadinessPack>) =>
    pack.subjects.find((row) => row.subject === "anna")!.blockers.join(" ");

  const unordered = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      runHistory: [entry.artifacts[1]!, entry.artifacts[0]!],
    })),
    tenants: TENANTS,
  });
  assert.equal(unordered.status, "blocked");
  assert.match(blockersFor(unordered), /not ordered by recordedAt/);

  const both = assembleReadinessPack({
    manifest: withEntry(manifest, "anna", (entry) => ({
      ...entry,
      runsDir: dir,
    })),
    tenants: TENANTS,
  });
  assert.equal(both.status, "blocked");
  assert.match(blockersFor(both), /runHistory or runsDir, not both/);
});

test("an unusable manifest is bad input, not a blocked pack", () => {  assert.throws(
    () => assembleReadinessPack({ manifest: null }),
    /manifest is not a JSON object/,
  );
  assert.throws(
    () => assembleReadinessPack({ manifest: { subjects: "nope" } }),
    /manifest\.subjects must be an array/,
  );
  assert.throws(
    () => assembleReadinessPack({ manifest: { subjects: [{ kind: "demo" }] } }),
    /subject is missing/,
  );
  assert.throws(
    () => assembleReadinessPack({ manifest: { subjects: [] }, tenants: { subjects: [{ subject: "t" }] } }),
    /--tenants\[0\] needs subject and locale/,
  );
});
