/**
 * All-subject readiness pack (meta-cascade M17, ticket 152).
 *
 * Before cutover, every eligible subject must carry two consecutive clean
 * cascade runs, one clean reference+delivered pair, a recorded W2 verdict and
 * two independent ballots. This module assembles and checks that from one
 * manifest and emits the pack with named blockers. It never decides
 * accept/withdraw, never writes audio, and never marks ticket 152 (or any human
 * gate) resolved.
 *
 * The manifest contract and its refusals live in `readiness-manifest.ts` (see
 * that header for the JSON shape and `--help` for the same contract). Each
 * subject supplies exactly one run-history source — a `runsDir` to scan or a
 * complete `runHistory` — and its two `artifacts` must be that history's last
 * two runs, oldest first. A manifest with no history is blocked as
 * `run history not supplied; last-two consecutive unverified`, never passed.
 *
 * The six demo voices are always required (the ticket's minimum). A demo voice
 * the vendor does not serve (German `juergen`) is not a cascade subject: it is
 * listed, and only a dated deferral keeps it from blocking. `--tenants <path>`
 * lists every subject eligible under `routing=all`; each entry is
 * `{subject, locale, transport?}`. A subject missing from the manifest and not
 * deferred is a block, one failed subject blocks all, and a tenant's Locale and
 * transport must match the roster row (evidence for another Locale/transport is
 * another subject). Deferrals are refused when they duplicate, are undated or
 * unexplained, name a subject with recorded evidence, or name a subject outside
 * `routing=all`.
 *
 * Enforcement reuses `readScoreboardArtifactFile` (the one reader),
 * `deriveRunEligibility` (ticket 116) and `assembleCascadeReauditionPack`
 * (ticket 133): cascade pipeline, subject match, no
 * `provider_fallback`/`budget.stopped`, two consecutive clean runs with a code
 * fingerprint, reference+delivered measured by the W0 table, transcript, two
 * distinct ballots on the delivered sha, and a present, non-unresolved verdict.
 * Missing files are blockers; no audio is ever written or fabricated.
 *
 * Exit contract of the CLI: 0 ready, 1 blocked, 2 bad input.
 */
import {
  ArtifactReadError,
  deriveRunEligibility,
  pipelineOfArtifact,
  readScoreboardArtifactFile,
} from "./artifact-reader";
import {
  assembleCascadeReauditionPack,
  CASCADE_REAUDITION_BALLOT_COUNT,
} from "./cascade-reaudition";
import {
  ballotsFor,
  nonEmptyString,
  parseLine,
  parseManifest,
  parseTenantRoster,
  resolveRunHistory,
  subjectRecordFor,
  uniqueBlockers,
  verdictFor,
  verifyLastTwo,
  type ReadinessDeferral,
  type ReadinessManifestSubject,
  type ReadinessRequest,
} from "./readiness-manifest";
import { isIsoDate } from "./reviewer-pack";
import {
  subjectOfArtifact,
  type CodeFingerprint,
  type ScoreboardArtifact,
} from "./scoreboard";
import {
  sameSubject,
  UNBOUND_VOICES,
  type SubjectRecord,
  type SubjectTransport,
} from "./subject";
import { DEMO_VOICE_IDS } from "./voni-agent";

// The manifest boundary is re-exported so the CLI and tests keep one import.
export {
  ReadinessManifestError,
  type ReadinessDeferral,
  type ReadinessManifest,
  type ReadinessManifestSubject,
  type ReadinessRequest,
  type ReadinessTenant,
  type ReadinessTenantRoster,
  type ReadinessVerdictInput,
} from "./readiness-manifest";

export const READINESS_PACK_SCHEMA_VERSION = 1;
export const READINESS_PACK_KIND = "all-subject-readiness-pack";

/** The rule the pack enforces; printed in the markdown so it cannot drift. */
export const READINESS_RULE =
  "every eligible subject needs two consecutive clean cascade runs, a measured " +
  "reference+delivered pair, a present non-unresolved owner verdict and two " +
  "independent ballots on the delivered sha; one failed or missing subject " +
  "blocks all, and a dated deferral covers only a subject with no evidence";

export type ReadinessKind = "demo" | "tenant";

export type ReadinessArtifactRow = {
  path: string;
  runId: string | null;
  /** The run's own code fingerprint; null when the artifact records none. */
  codeFingerprint: CodeFingerprint | null;
  /** `deriveRunEligibility`'s verdict; null when the artifact was unreadable. */
  eligible: boolean | null;
};

export type ReadinessRowStatus = "complete" | "incomplete" | "deferred" | "missing";

export type ReadinessRow = {
  subject: string;
  kind: ReadinessKind;
  locale: string | null;
  transport: SubjectTransport;
  status: ReadinessRowStatus;
  /** The supplied runs, chronological; both paths and fingerprints are named. */
  artifacts: ReadinessArtifactRow[];
  verdict: {
    decision: string;
    decidedOn: string | null;
    reasons: string[];
  } | null;
  ballots: {
    required: number;
    recorded: number;
    complete: boolean;
    reviewers: string[];
    sharedRecordingSha256: string | null;
  };
  deferral: { date: string; reason: string } | null;
  blockers: string[];
};

export type ReadinessPack = {
  schemaVersion: typeof READINESS_PACK_SCHEMA_VERSION;
  kind: typeof READINESS_PACK_KIND;
  status: "ready" | "blocked";
  ready: boolean;
  recordedAt: string;
  required: {
    demoVoices: string[];
    tenants: string[];
  };
  rule: string;
  subjects: ReadinessRow[];
  /** Every reason cutover is blocked; empty only when `ready` is true. */
  blockers: string[];
};

function readRun(
  path: string,
  expected: SubjectRecord,
): { row: ReadinessArtifactRow; artifact: ScoreboardArtifact | null; blockers: string[] } {
  const blockers: string[] = [];
  let artifact: ScoreboardArtifact;
  try {
    artifact = readScoreboardArtifactFile(path);
  } catch (error) {
    blockers.push(
      error instanceof ArtifactReadError
        ? `artifact unreadable: ${error.message}`
        : `artifact unreadable: ${path}: ${(error as Error).message}`,
    );
    return {
      row: { path, runId: null, codeFingerprint: null, eligible: null },
      artifact: null,
      blockers,
    };
  }

  try {
    const pipeline = pipelineOfArtifact(artifact, path);
    if (pipeline !== "cascade") {
      blockers.push(
        `artifact ${path} is ${pipeline}, not cascade; a readiness row needs the cascade engine (a managed verdict does not carry over)`,
      );
    }
  } catch (error) {
    blockers.push(`artifact ${path}: ${(error as Error).message}`);
  }

  const artifactSubject = subjectOfArtifact(artifact);
  if (!sameSubject(artifactSubject, expected)) {
    blockers.push(
      `artifact ${path} subject does not match: artifact is ${
        artifactSubject.agent.kind === "demo"
          ? `demo ${artifactSubject.agent.voice}`
          : `tenant ${artifactSubject.agent.agentId}`
      } (${artifactSubject.locale}, ${artifactSubject.transport}), row is ${
        expected.agent.kind === "demo"
          ? `demo ${expected.agent.voice}`
          : `tenant ${expected.agent.agentId}`
      } (${expected.locale}, ${expected.transport})`,
    );
  }

  const eligibility = deriveRunEligibility({ artifact });
  if (!eligibility.eligible) {
    blockers.push(
      `artifact ${path} is not a clean run: ${eligibility.reasons.join("; ")}`,
    );
  }

  return {
    row: {
      path,
      runId: artifact.runId ?? null,
      codeFingerprint: artifact.codeFingerprint ?? null,
      eligible: eligibility.eligible,
    },
    artifact,
    blockers,
  };
}

/** Two runs are consecutive only when they are distinct and ordered. */
function consecutiveBlockers(
  runs: readonly { artifact: ScoreboardArtifact; path: string }[],
): string[] {
  if (runs.length !== 2) return [];
  const [first, second] = runs as [
    { artifact: ScoreboardArtifact; path: string },
    { artifact: ScoreboardArtifact; path: string },
  ];
  const blockers: string[] = [];
  if (first.path === second.path) {
    blockers.push("the two run paths are the same file; two consecutive runs need two distinct artifacts");
    return blockers;
  }
  if (first.artifact.runId === second.artifact.runId) {
    blockers.push(
      `the two artifacts name the same run (${first.artifact.runId}); two consecutive runs need two run ids`,
    );
  }
  const firstAt = Date.parse(first.artifact.recordedAt);
  const secondAt = Date.parse(second.artifact.recordedAt);
  if (Number.isNaN(firstAt) || Number.isNaN(secondAt) || firstAt === secondAt) {
    blockers.push(
      `the two artifacts are not ordered by recordedAt (${first.artifact.recordedAt} vs ${second.artifact.recordedAt}); consecutive runs need distinct, ordered timestamps`,
    );
  }
  return blockers;
}

function emptyRow(input: {
  subject: string;
  kind: ReadinessKind;
  locale: string | null;
  transport: SubjectTransport;
  status: ReadinessRowStatus;
}): ReadinessRow {
  return {
    subject: input.subject,
    kind: input.kind,
    locale: input.locale,
    transport: input.transport,
    status: input.status,
    artifacts: [],
    verdict: null,
    ballots: {
      required: CASCADE_REAUDITION_BALLOT_COUNT,
      recorded: 0,
      complete: false,
      reviewers: [],
      sharedRecordingSha256: null,
    },
    deferral: null,
    blockers: [],
  };
}

function prefix(subject: string, blockers: readonly string[]): string[] {
  return blockers.map((blocker) => `${subject}: ${blocker}`);
}

function assembleRow(
  entry: ReadinessManifestSubject,
  now: Date,
): ReadinessRow {
  const identity = subjectRecordFor(entry);
  const blockers: string[] = [...identity.blockers];
  const paths = Array.isArray(entry.artifacts) ? entry.artifacts : [];
  if (paths.length !== 2) {
    blockers.push(
      `exactly two consecutive clean cascade artifact paths are required; got ${paths.length}`,
    );
  }

  const suppliedPaths: string[] = [];
  const runs = paths.map((path, index) => {
    const pathValue = nonEmptyString(path);
    if (pathValue === null) {
      blockers.push(`artifact ${index + 1} has no path`);
      return {
        row: { path: "", runId: null, codeFingerprint: null, eligible: null },
        artifact: null,
        blockers: [],
      };
    }
    suppliedPaths.push(pathValue);
    return readRun(pathValue, identity.subject);
  });
  for (const run of runs) blockers.push(...run.blockers);

  // The manifest's pair is only accepted when the supplied history ends at it.
  const historyRead = resolveRunHistory(entry, identity.subject);
  blockers.push(...historyRead.blockers);
  if (historyRead.history !== null) {
    blockers.push(...verifyLastTwo(suppliedPaths, historyRead.history));
  }

  const parsed = runs
    .filter((run): run is { row: ReadinessArtifactRow; artifact: ScoreboardArtifact; blockers: string[] } =>
      run.artifact !== null,
    )
    .sort((left, right) => Date.parse(left.artifact.recordedAt) - Date.parse(right.artifact.recordedAt));
  blockers.push(...consecutiveBlockers(parsed.map((run) => ({ artifact: run.artifact, path: run.row.path }))));

  const ballotRead = ballotsFor(entry.ballots);
  blockers.push(...ballotRead.blockers);
  const verdictRead = verdictFor(entry.verdict);
  blockers.push(...verdictRead.blockers);

  const lineRead = parseLine(entry.line);
  if (lineRead.error !== null) blockers.push(lineRead.error);

  const last = parsed.at(-1) ?? null;
  const pack = assembleCascadeReauditionPack({
    subject: identity.subject,
    artifact: last?.artifact ?? null,
    artifactPath: last?.row.path ?? nonEmptyString(paths.at(-1)) ?? "",
    reference: nonEmptyString(entry.reference),
    delivered: nonEmptyString(entry.delivered),
    transcript: entry.transcript ?? "",
    line: lineRead.line,
    ballots: ballotRead.ballots,
    allowTenantSubject: true,
    now: () => now,
  });
  blockers.push(...pack.blockers);

  const rowBlockers = uniqueBlockers(blockers);
  return {
    subject: entry.subject,
    kind: entry.kind,
    locale: identity.locale,
    transport: identity.subject.transport,
    status: rowBlockers.length === 0 ? "complete" : "incomplete",
    artifacts: runs.map((run) => run.row),
    verdict: verdictRead.verdict,
    ballots: {
      required: pack.ballots.required,
      recorded: pack.ballots.recorded,
      complete: pack.ballots.complete,
      reviewers: pack.ballots.reviewers,
      sharedRecordingSha256: pack.ballots.sharedRecordingSha256,
    },
    deferral: null,
    blockers: prefix(entry.subject, rowBlockers),
  };
}

function subjectKey(kind: ReadinessKind, subject: string): string {
  return `${kind}:${subject}`;
}

export function assembleReadinessPack(request: ReadinessRequest): ReadinessPack {
  const now = request.now?.() ?? new Date();
  const manifest = parseManifest(request.manifest);
  const tenants = parseTenantRoster(request.tenants);
  const blockers: string[] = [];

  // A duplicate manifest row is ambiguous: two records for one subject would
  // let a failing row hide behind a passing one, so it blocks by name.
  const entries = new Map<string, ReadinessManifestSubject>();
  for (const entry of manifest.subjects) {
    const key = subjectKey(entry.kind, entry.subject);
    if (entries.has(key)) {
      blockers.push(
        `${entry.subject}: duplicate manifest entry; one subject has one readiness row`,
      );
      continue;
    }
    entries.set(key, entry);
  }

  const rosterKeys = new Set(tenants.map((tenant) => subjectKey("tenant", tenant.subject)));
  const rosterBySubject = new Map(tenants.map((tenant) => [tenant.subject, tenant]));

  // Deferrals are records about subjects with no evidence. Duplicates are
  // ambiguous, and a deferral can never waive a subject whose evidence exists.
  const deferrals = new Map<string, ReadinessDeferral>();
  for (const deferral of manifest.deferrals ?? []) {
    if (deferrals.has(deferral.subject)) {
      blockers.push(
        `${deferral.subject}: duplicate deferral; one subject has one dated deferral`,
      );
      continue;
    }
    deferrals.set(deferral.subject, deferral);
    if (!isIsoDate(deferral.date)) {
      blockers.push(
        `${deferral.subject}: deferral date "${deferral.date}" is not an ISO date (YYYY-MM-DD)`,
      );
    }
    if (deferral.reason.trim() === "") {
      blockers.push(`${deferral.subject}: deferral has no written reason`);
    }
  }

  const rowsByKey = new Map<string, ReadinessRow>();
  for (const [key, entry] of entries) {
    rowsByKey.set(key, assembleRow(entry, now));
  }

  for (const subject of deferrals.keys()) {
    const matching = [...entries.keys()].filter(
      (key) => key.endsWith(`:${subject}`),
    );
    if (matching.length > 0) {
      blockers.push(
        `${subject}: deferral names a subject with recorded evidence; a deferral cannot waive recorded evidence`,
      );
    } else if (
      !(DEMO_VOICE_IDS as readonly string[]).includes(subject) &&
      !rosterKeys.has(subjectKey("tenant", subject))
    ) {
      blockers.push(
        `${subject}: deferral names a subject that is not eligible under routing=all`,
      );
    }
  }

  const requiredDemos = DEMO_VOICE_IDS.map((voice) => subjectKey("demo", voice));
  const requiredTenants = tenants.map((tenant) => subjectKey("tenant", tenant.subject));

  const orderedRows: ReadinessRow[] = [];
  const requiredKeys = [...requiredDemos, ...requiredTenants];
  for (const key of requiredKeys) {
    const existing = rowsByKey.get(key);
    if (existing !== undefined) {
      orderedRows.push(existing);
      continue;
    }
    const subject = key.slice(key.indexOf(":") + 1);
    const kind: ReadinessKind = key.startsWith("demo:") ? "demo" : "tenant";
    const deferral = deferrals.get(subject);
    const tenant = kind === "tenant" ? rosterBySubject.get(subject) : undefined;
    const row = emptyRow({
      subject,
      kind,
      locale:
        kind === "demo"
          ? (UNBOUND_VOICES[subject]?.locale ?? null)
          : (tenant?.locale ?? null),
      transport: tenant?.transport === "phone" ? "phone" : "browser",
      status: deferral === undefined ? "missing" : "deferred",
    });
    if (deferral !== undefined) {
      row.deferral = { date: deferral.date, reason: deferral.reason };
    } else {
      row.blockers = prefix(subject, [
        "no readiness evidence and no dated deferral; a missing subject is a block, not an omission",
      ]);
    }
    orderedRows.push(row);
  }

  for (const [key, row] of rowsByKey) {
    if (requiredKeys.includes(key)) continue;
    if (row.kind === "tenant" && tenants.length > 0 && !rosterKeys.has(key)) {
      row.blockers.push(
        `${row.subject}: tenant subject is not eligible under routing=all; the roster does not list it`,
      );
      row.status = "incomplete";
    }
    orderedRows.push(row);
  }

  // A tenant roster names the eligible subject, including its Locale and
  // transport. Evidence for another Locale/transport is another subject, so it
  // blocks rather than answering for the roster's row.
  for (const tenant of tenants) {
    const row = rowsByKey.get(subjectKey("tenant", tenant.subject));
    if (row === undefined) continue;
    if (row.locale !== tenant.locale || row.transport !== tenant.transport) {
      row.blockers.push(
        `${row.subject}: tenant subject differs from the routing=all roster: roster is ${tenant.locale}/${tenant.transport}, evidence is ${row.locale ?? "unstated"}/${row.transport}`,
      );
      row.status = "incomplete";
    }
  }

  for (const row of orderedRows) blockers.push(...row.blockers);
  const packBlockers = uniqueBlockers(blockers);
  const ready = packBlockers.length === 0;

  return {
    schemaVersion: READINESS_PACK_SCHEMA_VERSION,
    kind: READINESS_PACK_KIND,
    status: ready ? "ready" : "blocked",
    ready,
    recordedAt: now.toISOString(),
    required: {
      demoVoices: [...DEMO_VOICE_IDS],
      tenants: tenants.map((tenant) => tenant.subject),
    },
    rule: READINESS_RULE,
    subjects: orderedRows,
    blockers: packBlockers,
  };
}

function fingerprintLabel(fingerprint: CodeFingerprint | null): string {
  if (fingerprint === null) return "—";
  return `${fingerprint.head.slice(0, 12)}${fingerprint.dirty ? "+dirty" : ""}`;
}

function cell(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : value;
}

/** Human summary; `--json` prints the pack itself. */
export function formatReadinessPack(pack: ReadinessPack): string {
  const rows = pack.subjects.map((row) => {
    const runs = [0, 1].map((index) => {
      const artifact = row.artifacts[index];
      return artifact === undefined
        ? "—"
        : `\`${artifact.path}\`<br>code ${fingerprintLabel(artifact.codeFingerprint)}`;
    });
    const verdict =
      row.verdict === null
        ? "—"
        : `${row.verdict.decision}${row.verdict.decidedOn ? ` (${row.verdict.decidedOn})` : ""}`;
    const ballots = `${row.ballots.recorded}/${row.ballots.required}${
      row.ballots.reviewers.length > 0 ? `: ${row.ballots.reviewers.join(", ")}` : ""
    }`;
    return `| ${row.subject} | ${row.kind} | ${cell(row.locale)} / ${row.transport} | ${row.status} | ${runs[0]} | ${runs[1]} | ${verdict} | ${ballots} |`;
  });

  const deferred = pack.subjects.filter((row) => row.deferral !== null);
  return [
    "# All-subject readiness pack (ticket 152)",
    "",
    `- Status: **${pack.status.toUpperCase()}**`,
    `- Recorded: ${pack.recordedAt}`,
    `- Required: ${pack.required.demoVoices.length} demo voices, ${pack.required.tenants.length} eligible tenant subjects`,
    `- Rule: ${pack.rule}`,
    "",
    "| subject | kind | locale / transport | status | run 1 | run 2 | W2 verdict | ballots |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...(deferred.length === 0
      ? []
      : [
          "## Deferrals",
          "",
          ...deferred.map(
            (row) =>
              `- ${row.subject}: ${row.deferral?.date ?? "—"} — ${row.deferral?.reason ?? "—"}`,
          ),
          "",
        ]),
    "## Blockers",
    "",
    ...(pack.blockers.length === 0
      ? ["None."]
      : pack.blockers.map((blocker) => `- ${blocker}`)),
    "",
  ].join("\n");
}
