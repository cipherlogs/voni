/**
 * All-subject readiness pack (meta-cascade M17, ticket 152).
 *
 * Before cutover, every eligible subject must carry two consecutive clean
 * cascade runs, one clean reference+delivered pair, a recorded W2 verdict and
 * two independent ballots. This module verifies exactly that from one manifest
 * and emits the pack with named blockers. It assembles and checks; it never
 * decides accept/withdraw, never writes audio, and never marks ticket 152 (or
 * any human gate) resolved.
 *
 * ── Manifest contract (`--manifest <path>`, JSON) ───────────────────────────
 *
 * ```json
 * {
 *   "subjects": [
 *     {
 *       "subject": "lola",                 // demo voice id, or tenant agent id
 *       "kind": "demo",                    // "demo" | "tenant"
 *       "locale": "es",                    // optional for demo (derived from the
 *                                          //   binding); required for a tenant
 *       "transport": "browser",            // optional; defaults to "browser"
 *       "artifacts": ["run-1.json", "run-2.json"],
 *                                          // EXACTLY the last two consecutive
 *                                          //   clean cascade artifact paths, in
 *                                          //   any order; both are read through
 *                                          //   the one artifact reader
 *       "reference": "lola-reference.wav",
 *       "delivered": "delivered-20261029.wav",
 *       "line": { "kind": "greeting", "text": "Hola, soy Lola." },
 *                                          // the W0 line marker; without it the
 *                                          //   comparison is unresolved
 *       "transcript": [                    // text, or ordered {speaker,text}
 *         { "speaker": "agent", "text": "Hola, soy Lola." },
 *         { "speaker": "caller", "text": "Sí, claro." }
 *       ],
 *       "verdict": {                       // the OWNER's recorded statement
 *         "decision": "accept",            // "accept" | "withdraw" | "unresolved"
 *         "decidedOn": "2026-10-29",
 *         "reasons": "Why the content did or did not hold up."
 *       },
 *       "ballots": [                       // exactly two distinct raters on the
 *         {                                //   delivered sha256, each with a
 *           "reviewer": "ana",             //   written reason
 *           "reviewedOn": "2026-10-29",
 *           "recordingSha256": "<delivered sha256>",
 *           "scores": { "timbre": 5, "accent": 5, "languageNaturalness": 5 },
 *           "reason": "Clear, natural Spanish."
 *         }
 *       ]
 *     }
 *   ],
 *   "deferrals": [                         // explicit, dated, for a subject that
 *     { "subject": "juergen",              //   has NO recorded evidence; never a
 *       "date": "2026-10-29",              //   waiver for a failed subject
 *       "reason": "German stays open: 422 voice_not_found (ticket 130)." }
 *   ]
 * }
 * ```
 *
 * The six demo voices are always required (the ticket's minimum). A demo voice
 * the vendor does not serve (German `juergen`) is not a cascade subject: it is
 * listed, and only a dated deferral keeps it from blocking. `--tenants <path>`
 * optionally lists every subject eligible under `routing=all`; each entry is
 * `{subject, locale, transport?}` (or `{subjects: [...]}`). Any eligible subject
 * missing from the manifest and not deferred is a block. A missing subject is a
 * block, never an omission; one failed subject blocks all.
 *
 * Enforcement reuses `parseScoreboardArtifact`/`readScoreboardArtifactFile`
 * (the one reader), `deriveRunEligibility` (ticket 116) and
 * `assembleCascadeReauditionPack` (ticket 133): cascade pipeline, subject match,
 * no `provider_fallback`/`budget.stopped`, two consecutive clean runs with a
 * code fingerprint, reference+delivered measured by the W0 table, transcript,
 * two distinct ballots on the delivered sha, and a present, non-unresolved
 * verdict. Missing files are blockers; no audio is ever written or fabricated.
 *
 * The manifest is the claim that the two supplied artifacts are the subject's
 * last two runs. The pack verifies they are distinct, ordered by `recordedAt`,
 * the same cascade subject and clean; it does not scan the directory for a
 * newer run, so an omitted third run is a manifest error the operator owns.
 *
 * Exit contract of the CLI: 0 ready, 1 blocked, 2 bad input.
 */
import type { TwoCaptureLine } from "../audio/comparison";
import type { ContentTurn } from "../voice/content-judge";
import {
  ArtifactReadError,
  deriveRunEligibility,
  pipelineOfArtifact,
  readScoreboardArtifactFile,
} from "./artifact-reader";
import {
  assembleCascadeReauditionPack,
  type CascadeBallot,
} from "./cascade-reaudition";
import {
  CASCADE_REAUDITION_BALLOT_COUNT,
} from "./cascade-reaudition";
import {
  BALLOT_AXES,
  isIsoDate,
  type BallotAxis,
} from "./reviewer-pack";
import {
  subjectOfArtifact,
  type CodeFingerprint,
  type ScoreboardArtifact,
} from "./scoreboard";
import {
  bindCascadeVoice,
  sameSubject,
  UNBOUND_VOICES,
  type SubjectRecord,
  type SubjectTransport,
  SUBJECT_TRANSPORTS,
} from "./subject";
import { DEMO_VOICE_IDS } from "./voni-agent";

export const READINESS_PACK_SCHEMA_VERSION = 1;
export const READINESS_PACK_KIND = "all-subject-readiness-pack";

/** The rule the pack enforces; printed in the markdown so it cannot drift. */
export const READINESS_RULE =
  "every eligible subject needs two consecutive clean cascade runs, a measured " +
  "reference+delivered pair, a present non-unresolved owner verdict and two " +
  "independent ballots on the delivered sha; one failed or missing subject " +
  "blocks all, and a dated deferral covers only a subject with no evidence";

export type ReadinessKind = "demo" | "tenant";
const READINESS_KINDS: readonly ReadinessKind[] = ["demo", "tenant"];

/** The owner's recorded W2 statement, read from the manifest, never decided here. */
export type ReadinessVerdictInput = {
  /** `accept` | `withdraw` | `unresolved`; validated at read time. */
  decision: string;
  /** ISO `YYYY-MM-DD`: the date the owner recorded the statement. */
  decidedOn: string;
  /** The owner's written reasons; a string or an array of lines. */
  reasons: string | readonly string[];
};

export type ReadinessManifestSubject = {
  subject: string;
  kind: ReadinessKind;
  /** Optional for a demo voice (derived from its binding); required for a tenant. */
  locale?: string;
  /** Optional; defaults to `browser` (the cascade has no phone instrument). */
  transport?: string;
  /** Exactly two cascade artifact paths: the last two consecutive clean runs. */
  artifacts: readonly string[];
  reference: string;
  delivered: string;
  /** The W0 line marker; a missing marker leaves the comparison unresolved. */
  line?: TwoCaptureLine | null;
  transcript: string | readonly ContentTurn[];
  verdict: ReadinessVerdictInput;
  ballots: readonly CascadeBallot[];
};

export type ReadinessDeferral = {
  subject: string;
  date: string;
  reason: string;
};

export type ReadinessManifest = {
  subjects: readonly ReadinessManifestSubject[];
  deferrals?: readonly ReadinessDeferral[];
};

export type ReadinessTenant = {
  subject: string;
  locale: string;
  transport?: string;
};

export type ReadinessTenantRoster =
  | { subjects: readonly ReadinessTenant[] }
  | readonly ReadinessTenant[];

export type ReadinessRequest = {
  /** Parsed manifest JSON (the CLI owns the file read). */
  manifest: unknown;
  /** Parsed `--tenants` JSON; omitted means no eligible-tenant roster is known. */
  tenants?: unknown;
  /** Clock seam; tests pin the date. */
  now?: () => Date;
};

/** The manifest itself is unusable; the CLI exits 2. */
export class ReadinessManifestError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ReadinessManifestError";
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseManifest(raw: unknown): ReadinessManifest {
  if (!isRecord(raw)) {
    throw new ReadinessManifestError("manifest is not a JSON object (see --help)");
  }
  if (!Array.isArray(raw.subjects)) {
    throw new ReadinessManifestError("manifest.subjects must be an array (see --help)");
  }
  const subjects = raw.subjects.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ReadinessManifestError(`manifest.subjects[${index}] is not an object`);
    }
    const subject = nonEmpty(entry.subject);
    if (subject === null) {
      throw new ReadinessManifestError(
        `manifest.subjects[${index}].subject is missing; every row must name its subject`,
      );
    }
    const kind = entry.kind;
    if (typeof kind !== "string" || !(READINESS_KINDS as readonly string[]).includes(kind)) {
      throw new ReadinessManifestError(
        `manifest.subjects[${index}] (${subject}): kind must be one of ${READINESS_KINDS.join(", ")}`,
      );
    }
    return entry as unknown as ReadinessManifestSubject;
  });

  const deferrals: ReadinessDeferral[] = [];
  if (raw.deferrals !== undefined) {
    if (!Array.isArray(raw.deferrals)) {
      throw new ReadinessManifestError("manifest.deferrals must be an array when present");
    }
    raw.deferrals.forEach((entry, index) => {
      if (!isRecord(entry)) {
        throw new ReadinessManifestError(`manifest.deferrals[${index}] is not an object`);
      }
      const subject = typeof entry.subject === "string" ? entry.subject.trim() : null;
      const date = typeof entry.date === "string" ? entry.date.trim() : null;
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : null;
      if (subject === null || date === null || reason === null) {
        throw new ReadinessManifestError(
          `manifest.deferrals[${index}] needs subject, date and reason; a deferral without all three is not a record`,
        );
      }
      deferrals.push({ subject, date, reason });
    });
  }

  return { subjects, deferrals };
}

function parseTenantRoster(raw: unknown): ReadinessTenant[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.subjects)
      ? raw.subjects
      : null;
  if (list === null) {
    throw new ReadinessManifestError(
      "--tenants must be an array of {subject, locale} or an object with a subjects array",
    );
  }
  const seen = new Set<string>();
  return list.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ReadinessManifestError(`--tenants[${index}] is not an object`);
    }
    const subject = nonEmpty(entry.subject);
    const locale = nonEmpty(entry.locale);
    if (subject === null || locale === null) {
      throw new ReadinessManifestError(
        `--tenants[${index}] needs subject and locale; a tenant has no voice to derive its Locale from`,
      );
    }
    if (seen.has(subject)) {
      throw new ReadinessManifestError(`--tenants names "${subject}" more than once; the roster has one row per subject`);
    }
    seen.add(subject);
    const transport = nonEmpty(entry.transport) ?? "browser";
    if (!(SUBJECT_TRANSPORTS as readonly string[]).includes(transport)) {
      throw new ReadinessManifestError(
        `--tenants[${index}] (${subject}): unknown transport "${transport}"; expected one of ${SUBJECT_TRANSPORTS.join(", ")}`,
      );
    }
    return { subject, locale, transport };
  });
}

function resolveTransport(raw: unknown): { transport: SubjectTransport; error: string | null } {
  const value = nonEmpty(raw) ?? "browser";
  if ((SUBJECT_TRANSPORTS as readonly string[]).includes(value)) {
    return { transport: value as SubjectTransport, error: null };
  }
  return {
    transport: "browser",
    error: `unknown transport "${value}"; a subject's transport is one of ${SUBJECT_TRANSPORTS.join(", ")}`,
  };
}

/**
 * The W0 line marker. A malformed marker is a named blocker, never a crash and
 * never a silent `null` that would read as "the owner did not mark a line".
 */
function parseLine(raw: unknown): { line: TwoCaptureLine | null; error: string | null } {
  if (raw === undefined || raw === null) return { line: null, error: null };
  if (!isRecord(raw)) {
    return { line: null, error: "line marker must be an object ({kind, text})" };
  }
  const text = nonEmpty(raw.text);
  if (raw.kind === "greeting" && text !== null) {
    return { line: { kind: "greeting", text }, error: null };
  }
  if (raw.kind === "segment" && text !== null) {
    const start = raw.startSeconds;
    const end = raw.endSeconds;
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start
    ) {
      return { line: { kind: "segment", text, startSeconds: start, endSeconds: end }, error: null };
    }
    return {
      line: null,
      error: "line marker segment needs startSeconds/endSeconds with 0 <= start < end",
    };
  }
  return {
    line: null,
    error: 'line marker must be {kind: "greeting", text} or {kind: "segment", text, startSeconds, endSeconds}',
  };
}

/** Build the subject identity the artifacts must match; never invent a Locale. */
function subjectRecordFor(entry: ReadinessManifestSubject): {
  subject: SubjectRecord;
  locale: string | null;
  blockers: string[];
} {
  const blockers: string[] = [];
  const { transport, error: transportError } = resolveTransport(entry.transport);
  if (transportError !== null) blockers.push(transportError);
  const declaredLocale = nonEmpty(entry.locale);

  if (entry.kind === "demo") {
    let locale: string | null = null;
    try {
      const binding = bindCascadeVoice(entry.subject);
      locale = binding.locale;
      if (declaredLocale !== null && declaredLocale !== binding.locale) {
        blockers.push(
          `locale mismatch: voice "${entry.subject}" speaks ${binding.locale}, not ${declaredLocale}`,
        );
      }
    } catch (error) {
      blockers.push((error as Error).message);
      locale = UNBOUND_VOICES[entry.subject]?.locale ?? declaredLocale;
    }
    return {
      subject: {
        agent: { kind: "demo", voice: entry.subject, agentId: null },
        locale: locale ?? declaredLocale ?? "unknown",
        transport,
        source: "flag",
        pipeline: "cascade",
      },
      locale,
      blockers,
    };
  }

  if (declaredLocale === null) {
    blockers.push(
      "tenant subject needs a locale: a tenant agent has no demo voice to derive it from, and English is not assumed",
    );
  }
  return {
    subject: {
      agent: { kind: "tenant", agentId: entry.subject },
      locale: declaredLocale ?? "unknown",
      transport,
      source: "flag",
      pipeline: "cascade",
    },
    locale: declaredLocale,
    blockers,
  };
}

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

function ballotsFor(
  raw: unknown,
): { ballots: CascadeBallot[]; blockers: string[] } {
  if (!Array.isArray(raw)) {
    return {
      ballots: [],
      blockers: ["ballots must be an array of two ballots"],
    };
  }
  const ballots = raw.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const scores = isRecord(record.scores) ? record.scores : {};
    const reasons = isRecord(record.axisReasons) ? record.axisReasons : null;
    const axisReasons =
      reasons === null
        ? undefined
        : (Object.fromEntries(
            BALLOT_AXES.map((axis) => [
              axis,
              typeof reasons[axis] === "string" ? (reasons[axis] as string) : "",
            ]),
          ) as Partial<Record<BallotAxis, string>>);
    return {
      reviewer: typeof record.reviewer === "string" ? record.reviewer : "",
      reviewedOn: typeof record.reviewedOn === "string" ? record.reviewedOn : "",
      recordingSha256:
        typeof record.recordingSha256 === "string" ? record.recordingSha256 : "",
      scores: Object.fromEntries(
        BALLOT_AXES.map((axis) => [axis, scores[axis]]),
      ) as Record<BallotAxis, number>,
      reason: typeof record.reason === "string" ? record.reason : "",
      ...(axisReasons === undefined ? {} : { axisReasons }),
    } satisfies CascadeBallot;
  });
  return { ballots, blockers: [] };
}

function verdictFor(
  raw: unknown,
): { verdict: ReadinessRow["verdict"]; blockers: string[] } {
  const blockers: string[] = [];
  if (!isRecord(raw)) {
    return {
      verdict: null,
      blockers: [
        "verdict missing: the owner's accept/withdraw is a separate recorded statement (ticket 134)",
      ],
    };
  }
  const decision = nonEmpty(raw.decision) ?? "";
  const decidedOn = nonEmpty(raw.decidedOn);
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim() !== "")
    : typeof raw.reasons === "string" && raw.reasons.trim() !== ""
      ? [raw.reasons.trim()]
      : [];

  if (!["accept", "withdraw", "unresolved"].includes(decision)) {
    blockers.push(
      `verdict decision "${decision}" is not accept, withdraw or unresolved`,
    );
  }
  if (decision === "unresolved") {
    blockers.push(
      "verdict is unresolved: the subject stays blocked and an unresolved verdict is not a pass",
    );
  }
  if (decidedOn === null || !isIsoDate(decidedOn)) {
    blockers.push(
      `verdict date "${decidedOn ?? ""}" is not an ISO date (YYYY-MM-DD)`,
    );
  }
  if (reasons.length === 0) {
    blockers.push("verdict has no written reasons; a date and reasons are required");
  }

  return {
    verdict: { decision, decidedOn, reasons },
    blockers,
  };
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

  const runs = paths.map((path, index) => {
    const pathValue = nonEmpty(path);
    if (pathValue === null) {
      blockers.push(`artifact ${index + 1} has no path`);
      return {
        row: { path: "", runId: null, codeFingerprint: null, eligible: null },
        artifact: null,
        blockers: [],
      };
    }
    return readRun(pathValue, identity.subject);
  });
  for (const run of runs) blockers.push(...run.blockers);

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
    artifactPath: last?.row.path ?? nonEmpty(paths.at(-1)) ?? "",
    reference: nonEmpty(entry.reference),
    delivered: nonEmpty(entry.delivered),
    transcript: entry.transcript ?? "",
    line: lineRead.line,
    ballots: ballotRead.ballots,
    allowTenantSubject: true,
    now: () => now,
  });
  blockers.push(...pack.blockers);

  const uniqueBlockers = [...new Set(blockers)];
  return {
    subject: entry.subject,
    kind: entry.kind,
    locale: identity.locale,
    transport: identity.subject.transport,
    status: uniqueBlockers.length === 0 ? "complete" : "incomplete",
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
    blockers: prefix(entry.subject, uniqueBlockers),
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
  const uniqueBlockers = [...new Set(blockers)];
  const ready = uniqueBlockers.length === 0;

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
    blockers: uniqueBlockers,
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
