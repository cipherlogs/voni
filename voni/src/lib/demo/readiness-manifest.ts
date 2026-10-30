/**
 * The all-subject readiness manifest: its contract, its refusals and its run
 * history check (meta-cascade M17, ticket 152).
 *
 * This module is the manifest boundary only. It parses one JSON object, names
 * every refusal, and verifies that the two supplied artifacts really are the
 * subject's last two runs in the supplied history. Assembly, roll-up and render
 * stay in `readiness-pack.ts`.
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
 *                                          // the last two consecutive clean
 *                                          //   runs, oldest first
 *       "runsDir": "runs/lola",            // OR a directory to scan
 *       "runHistory": ["run-1.json", "run-2.json"],
 *                                          // OR the complete ordered history
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
 * Exactly one of `runsDir` / `runHistory` is required per subject. The supplied
 * `artifacts` must be the last two entries of that history, in order; a clean
 * run after them, an ineligible run after them, or a run between them blocks.
 * A manifest with neither history source is blocked as
 * `run history not supplied; last-two consecutive unverified` — the claim alone
 * is never a pass.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { TwoCaptureLine } from "../audio/comparison";
import type { ContentTurn } from "../voice/content-judge";
import {
  deriveRunEligibility,
  readScoreboardArtifactFile,
} from "./artifact-reader";
import type { CascadeBallot } from "./cascade-reaudition";
import {
  BALLOT_AXES,
  isIsoDate,
  type BallotAxis,
} from "./reviewer-pack";
import { subjectOfArtifact, type ScoreboardArtifact } from "./scoreboard";
import { objectOf } from "./shape";
import {
  bindCascadeVoice,
  sameSubject,
  UNBOUND_VOICES,
  type SubjectRecord,
  type SubjectTransport,
  SUBJECT_TRANSPORTS,
} from "./subject";

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
  /** Exactly two cascade artifact paths: the last two runs, oldest first. */
  artifacts: readonly string[];
  /** A directory of the subject's run artifacts, scanned for history. */
  runsDir?: string;
  /** The complete ordered run history; exactly one history source is used. */
  runHistory?: readonly string[];
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

/** One run in the verified history: its path, its recorded time and eligibility. */
export type ReadinessHistoryRun = {
  path: string;
  recordedAt: string | null;
  eligible: boolean | null;
};

export type ReadinessRunHistory = {
  paths: string[];
  runs: ReadinessHistoryRun[];
};

/**
 * The manifest field as an object, worded by the field that failed. This is the
 * same shape guard the artifact and event readers use (`objectOf`), so a second
 * copy of the null/array/primitive check cannot drift.
 */
function asRecord(raw: unknown, field: string): Record<string, unknown> {
  return objectOf(raw, `${field} is not a JSON object`, (reason) => {
    throw new ReadinessManifestError(`${field}: ${reason}`);
  });
}

/**
 * A record-shaped value the caller judges field by field. A non-object ballot
 * or verdict is a row-level blocker (its fields are missing), not bad input, so
 * this is deliberately non-throwing.
 */
function maybeRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** A trimmed, non-empty string, or null; the manifest's one text guard. */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One Set for every blocker roll-up, so the pack has one de-duplication rule. */
export function uniqueBlockers(blockers: readonly string[]): string[] {
  return [...new Set(blockers)];
}

export function parseManifest(raw: unknown): ReadinessManifest {
  const record = asRecord(raw, "manifest");
  if (!Array.isArray(record.subjects)) {
    throw new ReadinessManifestError(
      "manifest.subjects must be an array (see --help)",
    );
  }
  const subjects = record.subjects.map((entry, index) => {
    const subjectRecord = asRecord(entry, `manifest.subjects[${index}]`);
    const subject = nonEmptyString(subjectRecord.subject);
    if (subject === null) {
      throw new ReadinessManifestError(
        `manifest.subjects[${index}].subject is missing; every row must name its subject`,
      );
    }
    const kind = subjectRecord.kind;
    if (typeof kind !== "string" || !(READINESS_KINDS as readonly string[]).includes(kind)) {
      throw new ReadinessManifestError(
        `manifest.subjects[${index}] (${subject}): kind must be one of ${READINESS_KINDS.join(", ")}`,
      );
    }
    return entry as ReadinessManifestSubject;
  });

  const deferrals: ReadinessDeferral[] = [];
  if (record.deferrals !== undefined) {
    if (!Array.isArray(record.deferrals)) {
      throw new ReadinessManifestError(
        "manifest.deferrals must be an array when present",
      );
    }
    record.deferrals.forEach((entry, index) => {
      const deferral = asRecord(entry, `manifest.deferrals[${index}]`);
      const subject = typeof deferral.subject === "string" ? deferral.subject.trim() : null;
      const date = typeof deferral.date === "string" ? deferral.date.trim() : null;
      const reason = typeof deferral.reason === "string" ? deferral.reason.trim() : null;
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

export function parseTenantRoster(raw: unknown): ReadinessTenant[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : maybeRecord(raw) !== null && Array.isArray((raw as Record<string, unknown>).subjects)
      ? ((raw as Record<string, unknown>).subjects as unknown[])
      : null;
  if (list === null) {
    throw new ReadinessManifestError(
      "--tenants must be an array of {subject, locale} or an object with a subjects array",
    );
  }
  const seen = new Set<string>();
  return list.map((entry, index) => {
    const tenant = asRecord(entry, `--tenants[${index}]`);
    const subject = nonEmptyString(tenant.subject);
    const locale = nonEmptyString(tenant.locale);
    if (subject === null || locale === null) {
      throw new ReadinessManifestError(
        `--tenants[${index}] needs subject and locale; a tenant has no voice to derive its Locale from`,
      );
    }
    if (seen.has(subject)) {
      throw new ReadinessManifestError(
        `--tenants names "${subject}" more than once; the roster has one row per subject`,
      );
    }
    seen.add(subject);
    const transport = nonEmptyString(tenant.transport) ?? "browser";
    if (!(SUBJECT_TRANSPORTS as readonly string[]).includes(transport)) {
      throw new ReadinessManifestError(
        `--tenants[${index}] (${subject}): unknown transport "${transport}"; expected one of ${SUBJECT_TRANSPORTS.join(", ")}`,
      );
    }
    return { subject, locale, transport };
  });
}

export function resolveTransport(raw: unknown): {
  transport: SubjectTransport;
  error: string | null;
} {
  const value = nonEmptyString(raw) ?? "browser";
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
export function parseLine(raw: unknown): {
  line: TwoCaptureLine | null;
  error: string | null;
} {
  if (raw === undefined || raw === null) return { line: null, error: null };
  const record = maybeRecord(raw);
  if (record === null) {
    return { line: null, error: "line marker must be an object ({kind, text})" };
  }
  const text = nonEmptyString(record.text);
  if (record.kind === "greeting" && text !== null) {
    return { line: { kind: "greeting", text }, error: null };
  }
  if (record.kind === "segment" && text !== null) {
    const start = record.startSeconds;
    const end = record.endSeconds;
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
export function subjectRecordFor(entry: ReadinessManifestSubject): {
  subject: SubjectRecord;
  locale: string | null;
  blockers: string[];
} {
  const blockers: string[] = [];
  const { transport, error: transportError } = resolveTransport(entry.transport);
  if (transportError !== null) blockers.push(transportError);
  const declaredLocale = nonEmptyString(entry.locale);

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

export function ballotsFor(
  raw: unknown,
): { ballots: CascadeBallot[]; blockers: string[] } {
  if (!Array.isArray(raw)) {
    return {
      ballots: [],
      blockers: ["ballots must be an array of two ballots"],
    };
  }
  const ballots = raw.map((entry) => {
    const record = maybeRecord(entry) ?? {};
    const scores = maybeRecord(record.scores) ?? {};
    const reasons = maybeRecord(record.axisReasons);
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

export type ReadinessRowVerdict = {
  decision: string;
  decidedOn: string | null;
  reasons: string[];
};

export function verdictFor(
  raw: unknown,
): { verdict: ReadinessRowVerdict | null; blockers: string[] } {
  const blockers: string[] = [];
  const record = maybeRecord(raw);
  if (record === null) {
    return {
      verdict: null,
      blockers: [
        "verdict missing: the owner's accept/withdraw is a separate recorded statement (ticket 134)",
      ],
    };
  }
  const decision = nonEmptyString(record.decision) ?? "";
  const decidedOn = nonEmptyString(record.decidedOn);
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter(
        (reason): reason is string => typeof reason === "string" && reason.trim() !== "",
      )
    : typeof record.reasons === "string" && record.reasons.trim() !== ""
      ? [record.reasons.trim()]
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

function readHistoryRun(
  path: string,
  expected: SubjectRecord,
): { run: ReadinessHistoryRun; blockers: string[] } {
  let artifact: ScoreboardArtifact;
  try {
    artifact = readScoreboardArtifactFile(path);
  } catch (error) {
    return {
      run: { path, recordedAt: null, eligible: null },
      blockers: [`run history entry ${path} is unreadable: ${(error as Error).message}`],
    };
  }
  const blockers: string[] = [];
  const artifactSubject = subjectOfArtifact(artifact);
  if (!sameSubject(artifactSubject, expected)) {
    blockers.push(
      `run history entry ${path} is another subject (${artifactSubject.locale}, ${artifactSubject.transport}); the history must be this row's runs`,
    );
  }
  return {
    run: {
      path,
      recordedAt: artifact.recordedAt ?? null,
      eligible: deriveRunEligibility({ artifact }).eligible,
    },
    blockers,
  };
}

function checkOrder(
  runs: readonly ReadinessHistoryRun[],
  label: string,
): string[] {
  const blockers: string[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]!;
    const current = runs[index]!;
    const previousAt = previous.recordedAt === null ? Number.NaN : Date.parse(previous.recordedAt);
    const currentAt = current.recordedAt === null ? Number.NaN : Date.parse(current.recordedAt);
    if (
      Number.isNaN(previousAt) ||
      Number.isNaN(currentAt) ||
      currentAt <= previousAt
    ) {
      blockers.push(
        `${label} is not ordered by recordedAt (${previous.path}: ${previous.recordedAt ?? "missing"} then ${current.path}: ${current.recordedAt ?? "missing"}); the history is oldest first with distinct timestamps`,
      );
    }
  }
  return blockers;
}

/**
 * The history from `runHistory` (verbatim, verified oldest-first) or from a
 * `runsDir` scan (the subject's artifacts, sorted by recordedAt). A manifest
 * with neither source returns no history and one named blocker.
 */
export function resolveRunHistory(
  entry: ReadinessManifestSubject,
  expected: SubjectRecord,
): { history: ReadinessRunHistory | null; blockers: string[] } {
  const hasList = entry.runHistory !== undefined;
  const runsDir = nonEmptyString(entry.runsDir);
  if (hasList && runsDir !== null) {
    return {
      history: null,
      blockers: ["run history is ambiguous: supply runHistory or runsDir, not both"],
    };
  }
  if (!hasList && runsDir === null) {
    return {
      history: null,
      blockers: ["run history not supplied; last-two consecutive unverified"],
    };
  }

  if (hasList) {
    if (!Array.isArray(entry.runHistory)) {
      return {
        history: null,
        blockers: ["runHistory must be an array of artifact paths"],
      };
    }
    const paths: string[] = [];
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const rawPath of entry.runHistory) {
      const path = nonEmptyString(rawPath);
      if (path === null) {
        blockers.push("runHistory contains a blank path");
        continue;
      }
      if (seen.has(path)) {
        blockers.push(`runHistory names ${path} more than once`);
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
    const runs: ReadinessHistoryRun[] = [];
    for (const path of paths) {
      const read = readHistoryRun(path, expected);
      blockers.push(...read.blockers);
      runs.push(read.run);
    }
    blockers.push(...checkOrder(runs, "runHistory"));
    return { history: { paths, runs }, blockers };
  }

  const directory = runsDir!;
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    return {
      history: null,
      blockers: [`runsDir ${directory} cannot be read: ${(error as Error).message}`],
    };
  }
  const blockers: string[] = [];
  const runs: ReadinessHistoryRun[] = [];
  for (const name of names) {
    const path = join(directory, name);
    let artifact: ScoreboardArtifact;
    try {
      artifact = readScoreboardArtifactFile(path);
    } catch (error) {
      blockers.push(`runsDir contains an unreadable artifact ${path}: ${(error as Error).message}`);
      continue;
    }
    if (!sameSubject(subjectOfArtifact(artifact), expected)) continue;
    runs.push({
      path,
      recordedAt: artifact.recordedAt ?? null,
      eligible: deriveRunEligibility({ artifact }).eligible,
    });
  }
  if (runs.length === 0) {
    return {
      history: null,
      blockers: [`runsDir ${directory} contains no runs for this subject`],
    };
  }
  runs.sort((left, right) => {
    const leftAt = left.recordedAt === null ? Number.NaN : Date.parse(left.recordedAt);
    const rightAt = right.recordedAt === null ? Number.NaN : Date.parse(right.recordedAt);
    return leftAt - rightAt;
  });
  blockers.push(...checkOrder(runs, `runsDir ${directory}`));
  return {
    history: { paths: runs.map((run) => run.path), runs },
    blockers,
  };
}

/**
 * The two supplied artifacts must be the last two history entries, in order.
 * A run after or between them blocks even when that run is clean; an
 * ineligible trailing run is named as such.
 */
export function verifyLastTwo(
  paths: readonly string[],
  history: ReadinessRunHistory,
): string[] {
  if (paths.length !== 2) return [];
  const blockers: string[] = [];
  const indexOf = new Map(history.paths.map((path, index) => [path, index]));
  const missing = paths.filter((path) => !indexOf.has(path));
  if (missing.length > 0) {
    for (const path of missing) {
      blockers.push(
        `artifact ${path} is not in the subject's run history; the supplied history must contain the pair`,
      );
    }
    return blockers;
  }
  if (history.paths.length < 2) {
    blockers.push("run history has fewer than two runs; last-two consecutive unverified");
    return blockers;
  }
  const indices = paths.map((path) => indexOf.get(path)!);
  if (indices[0] === indices[1]) {
    blockers.push(
      "the two supplied artifacts are the same run in history; two consecutive runs need two runs",
    );
    return blockers;
  }
  const lastTwoStart = history.paths.length - 2;
  if (indices[0] > indices[1]) {
    blockers.push(
      `the supplied artifacts are not in order; runHistory order is ${paths[1]} then ${paths[0]}`,
    );
  }
  const between = history.runs.slice(
    Math.min(...indices) + 1,
    Math.max(...indices),
  );
  const after = history.runs.slice(Math.max(...indices) + 1);
  const isLastTwo =
    indices[0] === lastTwoStart && indices[1] === lastTwoStart + 1;
  if (isLastTwo) return blockers;

  if (between.length > 0) {
    blockers.push(
      `run history has ${between.length} run(s) between the supplied artifacts (${between
        .map((run) => run.path)
        .join(", ")}); the pair must be consecutive`,
    );
  }
  if (after.length > 0) {
    const ineligible = after.filter((run) => run.eligible !== true);
    if (ineligible.length > 0) {
      blockers.push(
        `run history has an ineligible run after the supplied pair (${ineligible
          .map((run) => run.path)
          .join(", ")}); the pair is not the last two`,
      );
    } else {
      blockers.push(
        `run history has ${after.length} run(s) after the supplied pair (${after
          .map((run) => run.path)
          .join(", ")}); the pair is not the last two`,
      );
    }
  }
  if (between.length === 0 && after.length === 0) {
    blockers.push(
      `the supplied artifacts are not the last two runs in order; the last two are ${history.paths
        .slice(lastTwoStart)
        .join(", ")}`,
    );
  }
  return blockers;
}
