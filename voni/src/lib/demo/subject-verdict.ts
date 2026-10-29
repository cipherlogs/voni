/**
 * Per-subject verdicts and matrix aggregation (meta-cascade M3/M13, ticket 117).
 *
 * A **subject** is `{agent, Locale, transport, pipeline}`. Every row's status
 * comes from that subject's own artifact and nothing else: there is no gate
 * voice, no shared verdict and no neighbour to copy. A run that is ineligible
 * (contaminated, budget-stopped, capture-missing, harness-broken) is BLOCKED,
 * never green; a run from an older code fingerprint is historical evidence and
 * is blocked for the current matrix; a subject with no artifact is MISSING and
 * inherits nothing.
 *
 * This module reads the one eligibility seam in `artifact-reader.ts`; it lives
 * apart from `scoreboard.ts` so the per-subject verdict can compose the artifact
 * reader without a module cycle.
 */
import {
  SCOREBOARD_SCHEMA_VERSION,
  analyzeTagMentions,
  checkRegressionVoice,
  subjectOfArtifact,
  validateProbeCounts,
  type GateStatus,
  type ScoreboardArtifact,
  type ScoreboardGate,
  type SubScore,
  type TagDiscipline,
  type TimbreProbes,
} from "./scoreboard";
import { deriveRunEligibility, pipelineOfArtifact } from "./artifact-reader";
import { DEMO_VOICE_IDS } from "./voni-agent";
import {
  formatSubject,
  sameSubject,
  subjectForRunVoice,
  type SubjectRecord,
} from "./subject";

/**
 * One matrix row's input (voice-parity ticket 73): the subject and that
 * subject's own run. There is no gate-voice parameter and no carried verdict:
 * the row derives its status from the one artifact it is given.
 */
export type RegressionSubjectInput = {
  subject: SubjectRecord;
  /**
   * The subject's own run artifact. Absent means the run is missing; the row
   * reports MISSING and inherits nothing from another subject.
   */
  artifact?: ScoreboardArtifact;
  expectedTag?: string;
};

/**
 * A row's status: the artifact's own gate status, MISSING with no run, or
 * BLOCKED when the run cannot answer for this matrix (ineligible, historical
 * code) or the ordering rule has not let the subject be judged (ticket 78).
 */
export type RegressionSubjectStatus = GateStatus | "MISSING" | "BLOCKED";

export type RegressionSubjectResult = {
  subject: SubjectRecord;
  /** Stable row identity (`demo:lola@es/browser/managed`), unique across subjects. */
  key: string;
  /** The subject in one line (`demo lola (es, browser, cascade)`); the table's name. */
  label: string;
  /** The voice key the artifact carries; null when the run is missing. */
  voice: string | null;
  /**
   * The featured default subject carries report emphasis only. It never
   * supplies another row's verdict.
   */
  isFeatured: boolean;
  status: RegressionSubjectStatus;
  detail: string;
  /**
   * This subject's gate verdict, derived by `subjectGateVerdict` from the row's
   * own artifact. Null only when the run is missing or the ordering rule kept
   * the subject from being judged.
   */
  verdict: SubjectGateVerdict | null;
  /** Five sub-scores from this row's own artifact (empty when missing). */
  subScores: SubScore[];
  /** Probe counts from this row's own artifact; null when missing. */
  probes: TimbreProbes | null;
  /** Tag discipline from this row's own artifact; null when missing. */
  tag: TagDiscipline | null;
};

/**
 * A stable, human-readable key for one subject row. Provenance is not part of
 * identity, so a legacy artifact and a new run of the same subject share a key.
 * The pipeline is part of it: a managed run and a cascade run of one voice are
 * the two sides of the A/B, not the same subject measured twice.
 */
export function subjectRowKey(subject: SubjectRecord): string {
  const agent =
    subject.agent.kind === "demo"
      ? `demo:${subject.agent.voice}`
      : `tenant:${subject.agent.agentId}`;
  return `${agent}@${subject.locale}/${subject.transport}/${subject.pipeline ?? "managed"}`;
}

/** The code the current matrix judges; `undefined` means no freshness check. */
export type MatrixExpectedCode = { readonly head: string; readonly dirtyHash?: string } | null;

export type SubjectVerdictOptions = {
  /** `undefined`: no freshness check. `null`: the current code is unreadable. */
  expectedCode?: MatrixExpectedCode;
  /** `clean` for one run's own verdict; `current` for the matrix. */
  fingerprintPolicy?: "clean" | "current";
};

/**
 * One subject's gate verdict, derived from that subject's own artifact.
 *
 * The function takes one artifact plus readability options; there is no
 * parameter through which another subject's verdict could be carried in. The
 * status is BLOCKED when the run is ineligible or historical, so a caller can
 * never read an ineligible run as green.
 */
export type SubjectGateVerdict = {
  subject: SubjectRecord;
  /** The run the verdict was derived from, so a reader can open that artifact. */
  runId: string;
  scenario: string;
  status: RegressionSubjectStatus;
  /** False when the run is ineligible or its artifact cannot answer here. */
  eligible: boolean;
  /** Every fact that blocked the verdict; empty for a judged run. */
  blockedReasons: readonly string[];
  failing: string[];
  detail: string;
  gates: ScoreboardGate[];
};

export function subjectGateVerdict(
  artifact: ScoreboardArtifact,
  options: SubjectVerdictOptions = {},
): SubjectGateVerdict {
  const subject = subjectOfArtifact(artifact);
  const failing = artifact.gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.name);
  const gateStatus: GateStatus =
    artifact.gates.length === 0 ? "INFO" : failing.length > 0 ? "FAIL" : "PASS";

  const blockedReasons: string[] = [];
  const artifactPipeline = pipelineOfArtifact(artifact, `artifact ${artifact.runId}`);
  const subjectPipeline = subject.pipeline ?? "managed";
  if (artifactPipeline !== subjectPipeline) {
    blockedReasons.push(
      `the artifact's pipeline ${artifactPipeline} does not match its subject's ${subjectPipeline}; ` +
        "a row's subject includes the engine it was measured on",
    );
  }
  const eligibility = deriveRunEligibility({
    artifact,
    expectedCode: options.expectedCode,
    fingerprintPolicy: options.fingerprintPolicy ?? "clean",
  });
  blockedReasons.push(...eligibility.reasons);

  const status: RegressionSubjectStatus = blockedReasons.length > 0 ? "BLOCKED" : gateStatus;
  const detail =
    `subject ${formatSubject(subject)} (${artifact.runId}, ${artifact.evalRunner.scenario}): ` +
    (status === "BLOCKED"
      ? `BLOCKED (${blockedReasons.join("; ")})`
      : status === "PASS"
        ? "PASS (no required gate failed in this run's own artifact)"
        : status === "FAIL"
          ? `FAIL (${failing.join(", ")})`
          : "INFO (this artifact reports no gates)");
  return {
    subject,
    runId: artifact.runId,
    scenario: artifact.evalRunner.scenario,
    status,
    eligible: blockedReasons.length === 0 && eligibility.eligible,
    blockedReasons,
    failing,
    detail,
    gates: artifact.gates,
  };
}

/** Fields that would let a verdict travel beside the artifact instead of in it. */
const CARRIED_VERDICT_FIELDS = ["verdict", "gate", "gateVoice", "gateStatus"] as const;

/**
 * Refuse a verdict travelling beside a row's own evidence. A pasted matrix row
 * or a stitched artifact is a carried verdict, named by the field it used.
 */
function assertNoCarriedVerdict(input: RegressionSubjectInput, label: string): void {
  const entry = input as unknown as Record<string, unknown>;
  const carried = CARRIED_VERDICT_FIELDS.filter((field) => entry[field] !== undefined);
  if (carried.length > 0) {
    throw new Error(
      `matrix entry ${label} carries ${carried.join("/")} (a carried verdict); ` +
        "a row's verdict comes only from its own artifact",
    );
  }
  const artifact = input.artifact as unknown as Record<string, unknown> | undefined;
  if (artifact !== undefined && artifact.verdict !== undefined) {
    throw new Error(
      `matrix artifact ${label} carries a verdict (a carried verdict); ` +
        "an artifact's gates are its only verdict input",
    );
  }
}

/** Derive one row from its own artifact. Missing means missing, never copied. */
function regressionSubjectRow(
  input: RegressionSubjectInput,
  featured: SubjectRecord,
  expectedTag: string,
  options: SubjectVerdictOptions,
): RegressionSubjectResult {
  const label = formatSubject(input.subject);
  assertNoCarriedVerdict(input, label);
  const artifact = input.artifact;
  if (!artifact) {
    return {
      subject: input.subject,
      key: subjectRowKey(input.subject),
      label,
      voice: null,
      isFeatured: sameSubject(input.subject, featured),
      status: "MISSING",
      detail: `MISSING (no run artifact for this subject; unresolved, no verdict copied)`,
      verdict: null,
      subScores: [],
      probes: null,
      tag: null,
    };
  }
  // A row reads only its own subject's run. A mismatched pair is a harness
  // error, never a way to give one subject another subject's verdict.
  const artifactSubject = subjectOfArtifact(artifact);
  if (!sameSubject(artifactSubject, input.subject)) {
    throw new Error(
      `matrix row ${label} was handed the artifact of ${formatSubject(artifactSubject)} ` +
        `(a row only reads its own subject's run)`,
    );
  }
  const verdict = subjectGateVerdict(artifact, {
    expectedCode: options.expectedCode,
    fingerprintPolicy: options.fingerprintPolicy ?? "current",
  });
  const probes = validateProbeCounts(
    artifact.probes as unknown as Record<string, unknown>,
    `matrix cannot read ${label}`,
  );
  const tag = analyzeTagMentions(artifact.transcripts.redacted, input.expectedTag ?? expectedTag);
  const regression = checkRegressionVoice({
    voice: artifact.voice,
    isGate: sameSubject(input.subject, featured),
    probes,
    tag,
  });
  const status: RegressionSubjectStatus =
    verdict.status === "BLOCKED"
      ? "BLOCKED"
      : verdict.status === "FAIL" || regression.status === "FAIL"
        ? "FAIL"
        : verdict.status === "INFO"
          ? "INFO"
          : "PASS";
  const gateDetail =
    verdict.status === "BLOCKED"
      ? `blocked: ${verdict.detail}`
      : verdict.status === "FAIL"
        ? `FAIL in ${verdict.runId} (${verdict.failing.join(", ")})`
        : verdict.status === "INFO"
          ? `INFO in ${verdict.runId} (this run reports no gates)`
          : `PASS in ${verdict.runId} (no required gate failed)`;
  return {
    subject: input.subject,
    key: subjectRowKey(input.subject),
    label,
    voice: artifact.voice,
    isFeatured: sameSubject(input.subject, featured),
    status,
    detail: `${gateDetail}; ${
      verdict.status === "BLOCKED"
        ? "run not judged"
        : regression.status === "PASS"
          ? "regression clean"
          : regression.detail
    }`,
    verdict,
    subScores: artifact.subScores ?? [],
    probes,
    tag,
  };
}

// ── Ordering: the featured subject is proved on the instrument first (78) ────

/**
 * The ordering rule the matrix enforces (voice-parity ticket 78, spec W5):
 * the featured subject is judged first, and every other subject — English and
 * non-English alike — is judged only when the featured subject's own current
 * run in this matrix passes. Until then those rows are BLOCKED, so a refactor
 * bug on the new instrument can never be attributed to a Locale.
 */
export const MATRIX_ORDERING_RULE = "featured-first" as const;

export type MatrixOrdering = {
  rule: typeof MATRIX_ORDERING_RULE;
  featuredSubject: SubjectRecord;
  /**
   * The featured subject's own row status in this matrix; null when the matrix
   * contains no featured row, which leaves the gate shut.
   */
  featuredStatus: RegressionSubjectStatus | null;
  /** Named reason: what opened the gate, or what it is waiting for. */
  detail: string;
  /** Row keys of subjects that were not judged because the gate is shut. */
  blocked: string[];
};

/**
 * Why a featured subject does not open the gate, in the words the report uses.
 * Only PASS opens it: INFO (a run that reports no gates) is not a proof, a
 * blocked run cannot answer, and a missing run is not a pass.
 */
function featuredGateReason(
  row: RegressionSubjectResult | null,
  featured: SubjectRecord,
): string {
  const label = row ? row.label : formatSubject(featured);
  const why = row ? row.detail : "no run artifact for the featured subject in this matrix";
  return `featured subject ${label} has not passed (${why})`;
}

/**
 * Apply the featured-first rule to already-built rows: order the featured row
 * first and replace every other judged row with a BLOCKED row carrying a named
 * reason when the featured subject has not passed. A MISSING row stays MISSING
 * (there was never a run to judge); an already-blocked row keeps its own named
 * reason (its run could not answer regardless of ordering).
 *
 * The blocked row keeps its own run's raw measurements but carries no verdict,
 * so nothing about it can be read as a judgement — least of all another
 * subject's.
 */
function applyFeaturedFirst(input: {
  results: RegressionSubjectResult[];
  featured: SubjectRecord;
}): { results: RegressionSubjectResult[]; ordering: MatrixOrdering } {
  const featuredRows = input.results.filter((row) => row.isFeatured);
  const otherRows = input.results.filter((row) => !row.isFeatured);
  const featuredRow = featuredRows[0] ?? null;
  const featuredStatus = featuredRow?.status ?? null;
  const open = featuredStatus === "PASS";
  const reason = open ? "" : featuredGateReason(featuredRow, input.featured);
  const blocked: string[] = [];
  const ordered = [...featuredRows, ...otherRows].map((row) => {
    if (row.isFeatured || open || row.status === "MISSING" || row.status === "BLOCKED") return row;
    blocked.push(row.key);
    return {
      ...row,
      status: "BLOCKED" as const,
      detail: `blocked: ${reason}; this subject is not judged until it does`,
      verdict: null,
    };
  });
  const detail = open
    ? `${featuredRow ? `featured subject ${featuredRow.label}` : "featured subject"} passed; ` +
      `${otherRows.length} other subject${otherRows.length === 1 ? "" : "s"} judged after it`
    : input.results.length === 0
      ? `no subjects to order`
      : `blocked: ${reason}; ${blocked.length} subject${blocked.length === 1 ? "" : "s"} not judged`;
  return {
    results: ordered,
    ordering: {
      rule: MATRIX_ORDERING_RULE,
      featuredSubject: input.featured,
      featuredStatus,
      detail,
      blocked,
    },
  };
}

export type RegressionMatrix = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  expectedTag: string;
  /** The featured default subject: named for report emphasis, never a verdict source. */
  featuredSubject: SubjectRecord;
  /**
   * The ordering the harness enforced: featured first, everything else only
   * after it passes. Recorded so the artifact says which rule produced its rows.
   */
  ordering: MatrixOrdering;
  /** Every subject measured, in row order (featured first). */
  subjects: SubjectRecord[];
  results: RegressionSubjectResult[];
  gates: ScoreboardGate[];
};

/**
 * Full matrix verdict: one row per subject, each derived from that subject's
 * own artifact. There is deliberately no `gateVoice` or carried `gate` field —
 * there is no value through which the featured voice's verdict could travel.
 *
 * `expectedCode` is the code under judgement: `undefined` performs no freshness
 * check (unit seams), `null` means the current code is unreadable and blocks
 * every run, and a fingerprint makes an older artifact historical.
 */
export function buildRegressionMatrix(input: {
  featuredSubject?: SubjectRecord;
  entries: RegressionSubjectInput[];
  expectedTag?: string;
  expectedCode?: MatrixExpectedCode;
}): RegressionMatrix {
  const featured = input.featuredSubject ?? subjectForRunVoice(DEMO_VOICE_IDS[0]);
  const expectedTag = input.expectedTag ?? "Lime 42";
  const options: SubjectVerdictOptions = {
    expectedCode: input.expectedCode,
    fingerprintPolicy: input.expectedCode === undefined ? "clean" : "current",
  };
  const judged = input.entries.map((entry) =>
    regressionSubjectRow(entry, featured, expectedTag, options),
  );
  const seen = new Set<string>();
  for (const row of judged) {
    if (seen.has(row.key)) throw new Error(`matrix has two rows for subject ${row.label}`);
    seen.add(row.key);
  }
  // The ordering rule decides what may be judged and in which order (78).
  const { results, ordering } = applyFeaturedFirst({ results: judged, featured });
  const clean = results.filter((result) => result.status === "PASS").length;
  const missing = results.filter((result) => result.status === "MISSING").length;
  const blocked = results.filter((result) => result.status === "BLOCKED").length;
  const gates: ScoreboardGate[] = results.map((row) => ({
    name: `subject:${row.key}`,
    // A missing run is never clean: the matrix cannot claim a subject it did
    // not measure. A blocked subject was not judged, so it is INFO with the
    // reason in the detail; the matrix gate still refuses to call it clean.
    status:
      row.status === "MISSING" ? "FAIL" : row.status === "BLOCKED" ? "INFO" : row.status,
    detail: `${row.label}: ${row.detail}`,
  }));
  gates.push({
    name: `ordering:${MATRIX_ORDERING_RULE}`,
    status: results.length === 0 ? "INFO" : ordering.featuredStatus === "PASS" ? "PASS" : "FAIL",
    detail: ordering.detail,
  });
  gates.push({
    name: "matrix",
    status: results.length === 0 ? "INFO" : clean === results.length ? "PASS" : "FAIL",
    detail:
      `${clean}/${results.length} subjects clean` +
      `${missing > 0 ? `, ${missing} missing` : ""}` +
      `${blocked > 0 ? `, ${blocked} blocked` : ""}` +
      ` (each verdict derived from its own run)`,
  });
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    expectedTag,
    featuredSubject: featured,
    ordering,
    subjects: results.map((result) => result.subject),
    results,
    gates,
  };
}

/**
 * Console table: one named subject per row plus the summary. The ordering rule
 * and its reason are printed beside the header and on every blocked row, so a
 * subject that was not judged is never silent (ticket 78).
 */
export function formatMatrixTable(matrix: RegressionMatrix): string {
  const clean = matrix.results.filter((result) => result.status === "PASS").length;
  const missing = matrix.results.filter((result) => result.status === "MISSING").length;
  const blocked = matrix.results.filter((result) => result.status === "BLOCKED").length;
  const summary = [`${clean}/${matrix.results.length} clean`];
  if (missing > 0) summary.push(`${missing} missing`);
  if (blocked > 0) summary.push(`${blocked} blocked`);
  const width = Math.max(12, ...matrix.results.map((row) => row.label.length));
  const rows = matrix.results.map((row) => {
    const status =
      row.status === "MISSING" ? "MISS" : row.status === "BLOCKED" ? "BLOCK" : row.status;
    const subScores =
      row.isFeatured && row.subScores.length > 0
        ? `; sub-scores ${row.subScores.map((sub) => `${sub.name} ${sub.status}`).join(", ")}`
        : "";
    return `${status.padEnd(6)} ${row.label.padEnd(width)} ${row.detail}${subScores}`;
  });
  return [
    `subject matrix (featured ${formatSubject(matrix.featuredSubject)}, ordering ${matrix.ordering.rule}, ${matrix.results.length} subjects, ${summary.join(", ")})`,
    `ordering: ${matrix.ordering.detail}`,
    ...rows,
  ].join("\n");
}
