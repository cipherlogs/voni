/**
 * Small samples, measured rounds and the kill criterion (meta-cascade M13,
 * ticket 119).
 *
 * Three rules, each read off the spec rather than tuned here:
 *
 * 1. **Small samples.** A scope with fewer than `MIN_SAMPLES_FOR_P50` samples
 *    has no meaningful median, so it is judged against the frozen p95 tail
 *    budget, never its own p50. A one-sample scope is a tail sample, not a
 *    median. `MIN_SAMPLES_FOR_P50` is the same floor the artifact's reply-gap
 *    gate already applies (`scoreboard.ts`, ticket 09); the parity test in
 *    `kill-criterion.test.ts` fails if the two ever disagree.
 * 2. **A measured round** is `MEASURED_ROUND_SUBJECTS` (two) subjects with
 *    `CLEAN_RUNS_PER_SUBJECT` (two) consecutive clean runs each. A run is clean
 *    when the eligibility seam (`deriveRunEligibility`, ticket 116) finds no
 *    fallback, no budget stop, no missing capture it feeds, no harness failure
 *    and a matching clean code fingerprint. A contaminated round is re-run; it
 *    is not a measured round and does not count.
 * 3. **The kill criterion.** Three measured rounds failing the frozen
 *    `replyGapP50Ms` stop the automatic cutover and leave `routing` off. A round
 *    that passes the reply gap but fails another required gate blocks the
 *    cutover without killing the work. The owner may record a dated risk
 *    acceptance with the evidence attached; that is a decision record, never a
 *    `PASS`.
 *
 * Every threshold is read from the frozen budget record through
 * `SCOREBOARD_BUDGETS`; this module declares no budget of its own.
 */
import { SCOREBOARD_BUDGETS } from "./scoreboard-budgets";
import {
  judgeSubjectRun,
  percentile,
  subjectOfArtifact,
  type ScoreboardArtifact,
} from "./scoreboard";
import { deriveRunEligibility, pipelineOfArtifact } from "./artifact-reader";
import { formatSubject, type SubjectRecord } from "./subject";
import { subjectRowKey } from "./subject-verdict";

/** The frozen bars; the same table every scoreboard gate reads. */
const P50_BUDGET_MS = SCOREBOARD_BUDGETS.replyGapP50Ms.value;
const P95_BUDGET_MS = SCOREBOARD_BUDGETS.replyGapP95Ms.value;

/**
 * Below this many samples a scope has no meaningful median: judge the tail.
 * This is the existing reply-gap gate's rule (`scoreboard.ts`), not a new
 * number — the parity test keeps the two in step.
 */
export const MIN_SAMPLES_FOR_P50 = 3;

/** A measured round is two subjects (spec: "two subjects"). */
export const MEASURED_ROUND_SUBJECTS = 2;

/** …with two consecutive clean runs each (spec: "two consecutive clean runs"). */
export const CLEAN_RUNS_PER_SUBJECT = 2;

/** Three measured failures stop the automatic cutover (spec: kill criterion). */
export const KILL_CRITERION_ROUNDS = 3;

// ── Small-sample scope judgement ────────────────────────────────────────────

export type ReplyGapScopeStatus = "PASS" | "FAIL" | "INFO";

/**
 * One scope's reply-gap verdict. `judgedAgainst` is the budget that decided it:
 * `p95` for a small sample, `p50` once the scope is big enough for a median,
 * `none` when the scope measured nothing.
 */
export type ReplyGapScopeVerdict = {
  readonly scope: string;
  readonly sampleCount: number;
  /** True when the scope is below `MIN_SAMPLES_FOR_P50`. */
  readonly smallSample: boolean;
  readonly judgedAgainst: "p50" | "p95" | "none";
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly p50BudgetMs: number;
  readonly p95BudgetMs: number;
  readonly status: ReplyGapScopeStatus;
  readonly detail: string;
};

/**
 * Judge one scope's measured reply gaps. A small sample is judged against the
 * p95 tail; only a scope with enough samples is a p50 gate. No samples is INFO,
 * never PASS (an unmeasured scope proves nothing).
 */
export function judgeReplyGapScope(
  scope: string,
  gapsMs: readonly number[],
): ReplyGapScopeVerdict {
  const values = gapsMs.filter((value) => Number.isFinite(value));
  const count = values.length;
  if (count === 0) {
    return {
      scope,
      sampleCount: 0,
      smallSample: true,
      judgedAgainst: "none",
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      p50BudgetMs: P50_BUDGET_MS,
      p95BudgetMs: P95_BUDGET_MS,
      status: "INFO",
      detail: `${scope}: no measured reply gaps; nothing to judge`,
    };
  }
  const p50Ms = percentile(values, 50) as number;
  const p95Ms = percentile(values, 95) as number;
  const maxMs = Math.max(...values);
  const smallSample = count < MIN_SAMPLES_FOR_P50;
  if (smallSample) {
    // The spec's tiny-scope sample is the tail, because a "median" of one or two
    // samples is just the sample itself. The tail bar is the frozen p95 budget.
    const passed = maxMs <= P95_BUDGET_MS;
    return {
      scope,
      sampleCount: count,
      smallSample: true,
      judgedAgainst: "p95",
      p50Ms,
      p95Ms,
      maxMs,
      p50BudgetMs: P50_BUDGET_MS,
      p95BudgetMs: P95_BUDGET_MS,
      status: passed ? "PASS" : "FAIL",
      detail:
        `${scope}: ${count} sample${count === 1 ? "" : "s"} (below the ` +
        `${MIN_SAMPLES_FOR_P50}-sample median floor), judged against the p95 tail, not its own median: ` +
        `max ${maxMs}ms ${passed ? "≤" : ">"} ${P95_BUDGET_MS}ms p95 budget`,
    };
  }
  const p50Breach = p50Ms > P50_BUDGET_MS;
  const p95Breach = p95Ms > P95_BUDGET_MS;
  const passed = !p50Breach && !p95Breach;
  const breach = p50Breach
    ? `p50 ${p50Ms}ms > ${P50_BUDGET_MS}ms budget`
    : `p95 ${p95Ms}ms > ${P95_BUDGET_MS}ms budget`;
  return {
    scope,
    sampleCount: count,
    smallSample: false,
    judgedAgainst: "p50",
    p50Ms,
    p95Ms,
    maxMs,
    p50BudgetMs: P50_BUDGET_MS,
    p95BudgetMs: P95_BUDGET_MS,
    status: passed ? "PASS" : "FAIL",
    detail: passed
      ? `${scope}: p50 ${p50Ms}ms ≤ ${P50_BUDGET_MS}ms, p95 ${p95Ms}ms ≤ ${P95_BUDGET_MS}ms (n=${count})`
      : `${scope}: ${breach} (p50 ${p50Ms}ms / p95 ${p95Ms}ms, n=${count})`,
  };
}

// ── One round's runs ────────────────────────────────────────────────────────

/** One round attempt: the artifacts it measured, in measurement order. */
export type RoundInput = {
  /** Stable round label, cited by the verdict (`round-1`). */
  readonly label: string;
  readonly artifacts: readonly ScoreboardArtifact[];
};

type JudgedRun = {
  artifact: ScoreboardArtifact;
  subject: SubjectRecord;
  key: string;
  label: string;
  runId: string;
  pipeline: string;
  /** The run's own measured median reply gap; null when nothing was measured. */
  gapMs: number | null;
  /** A contaminated run: eligibility refuses it, whatever its numbers say. */
  ineligible: boolean;
  eligibilityReasons: readonly string[];
  failedGates: readonly string[];
  replyGapGateFailed: boolean;
};

function gapOf(artifact: ScoreboardArtifact): number | null {
  const value = artifact.latency?.replyGapP50Ms;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function judgeRun(artifact: ScoreboardArtifact): JudgedRun {
  const subject = subjectOfArtifact(artifact);
  const eligibility = deriveRunEligibility({ artifact });
  const verdict = judgeSubjectRun({ gates: artifact.gates, eligibility });
  return {
    artifact,
    subject,
    key: subjectRowKey(subject),
    label: formatSubject(subject),
    runId: artifact.runId,
    pipeline: pipelineOfArtifact(artifact, `artifact ${artifact.runId}`),
    gapMs: gapOf(artifact),
    ineligible: verdict.kind === "ineligible",
    eligibilityReasons: verdict.reasons,
    failedGates: verdict.failedGates,
    replyGapGateFailed: verdict.failedGates.includes("reply-gap"),
  };
}

/** The latest adjacent pair of clean runs that both measured a reply gap. */
function lastConsecutiveCleanPair(runs: readonly JudgedRun[]): JudgedRun[] | null {
  for (let index = runs.length - CLEAN_RUNS_PER_SUBJECT; index >= 0; index -= 1) {
    const pair = [runs[index], runs[index + 1]];
    if (pair.every((run) => !run.ineligible && run.gapMs !== null)) return pair;
  }
  return null;
}

// ── One measured round ──────────────────────────────────────────────────────

export type RoundDisposition = "measured" | "rerun" | "incomplete";

/**
 * One round's verdict. Only a `measured` round counts toward the three; a
 * `rerun` round is contaminated evidence that must be measured again, and an
 * `incomplete` round never had the two-by-two shape to begin with.
 */
export type MeasuredRoundVerdict = {
  readonly label: string;
  readonly disposition: RoundDisposition;
  /** True only for two subjects × two consecutive clean runs, all measured. */
  readonly measured: boolean;
  /** Same as `measured`: a contaminated or incomplete round is not counted. */
  readonly counted: boolean;
  readonly subjects: readonly string[];
  readonly runs: readonly string[];
  /** The round's own small-sample-aware reply-gap verdict; null unless measured. */
  readonly replyGap: ReplyGapScopeVerdict | null;
  readonly replyGapPassed: boolean;
  /** Required gates other than `reply-gap` that failed in a counted run. */
  readonly otherGateFailures: readonly string[];
  /** Named reasons why the round is not measured, or why it blocks. */
  readonly reasons: readonly string[];
  readonly detail: string;
};

/**
 * Judge one round attempt. Contamination outranks the numbers: an ineligible run
 * makes the attempt a re-run, never a measurement. A missing run, a missing gap
 * or a third subject makes it incomplete. Only after those two checks does the
 * reply-gap scope decide.
 */
export function judgeMeasuredRound(input: RoundInput): MeasuredRoundVerdict {
  const runs = input.artifacts.map(judgeRun);
  const bySubject = new Map<string, JudgedRun[]>();
  for (const run of runs) {
    const list = bySubject.get(run.key);
    if (list) list.push(run);
    else bySubject.set(run.key, [run]);
  }

  const reasons: string[] = [];
  let contaminated = false;
  const selected: JudgedRun[] = [];
  for (const subjectRuns of bySubject.values()) {
    const pair = lastConsecutiveCleanPair(subjectRuns);
    if (pair) {
      selected.push(...pair);
      continue;
    }
    const ineligible = subjectRuns.filter((run) => run.ineligible);
    const unmeasured = subjectRuns.filter((run) => !run.ineligible && run.gapMs === null);
    if (ineligible.length > 0) {
      contaminated = true;
      reasons.push(
        `${subjectRuns[0].label} has no two consecutive clean runs: ` +
          ineligible
            .map((run) => `run ${run.runId} is ineligible (${run.eligibilityReasons.join("; ")})`)
            .join("; "),
      );
    } else if (unmeasured.length > 0) {
      reasons.push(
        `${subjectRuns[0].label} has no two consecutive clean runs: ` +
          `no measured reply gap in ${unmeasured.map((run) => run.runId).join(", ")}`,
      );
    } else {
      reasons.push(
        `${subjectRuns[0].label} has no two consecutive clean runs ` +
          `(${subjectRuns.length} run${subjectRuns.length === 1 ? "" : "s"} recorded)`,
      );
    }
  }

  if (bySubject.size !== MEASURED_ROUND_SUBJECTS) {
    reasons.unshift(`a measured round needs two subjects, not ${bySubject.size}`);
  }
  const foreign = runs.filter((run) => run.pipeline !== "cascade");
  if (foreign.length > 0) {
    reasons.push(
      `the kill criterion judges cascade runs: ${foreign
        .map((run) => `${run.runId} is ${run.pipeline}`)
        .join(", ")}`,
    );
  }

  const measured =
    bySubject.size === MEASURED_ROUND_SUBJECTS &&
    selected.length === MEASURED_ROUND_SUBJECTS * CLEAN_RUNS_PER_SUBJECT &&
    foreign.length === 0 &&
    selected.every((run) => run.gapMs !== null);

  if (!measured) {
    const disposition: RoundDisposition = contaminated ? "rerun" : "incomplete";
    return {
      label: input.label,
      disposition,
      measured: false,
      counted: false,
      subjects: [...bySubject.keys()],
      runs: runs.map((run) => run.runId),
      replyGap: null,
      replyGapPassed: false,
      otherGateFailures: [],
      reasons,
      detail:
        disposition === "rerun"
          ? `round ${input.label}: re-run, not counted (contaminated: ${reasons.join("; ")})`
          : `round ${input.label}: not measured, not counted (${reasons.join("; ")})`,
    };
  }

  const replyGap = judgeReplyGapScope(
    input.label,
    selected.map((run) => run.gapMs as number),
  );
  const gateFailures = selected.filter((run) => run.replyGapGateFailed);
  for (const run of gateFailures) {
    reasons.push(`run ${run.runId} reports its own reply-gap gate FAIL`);
  }
  const otherGateFailures = [
    ...new Set(
      selected.flatMap((run) => run.failedGates.filter((gate) => gate !== "reply-gap")),
    ),
  ];
  const replyGapPassed = replyGap.status === "PASS" && gateFailures.length === 0;
  const gapOutcome = replyGapPassed ? "passed" : "failed";
  const ownGateFailures =
    gateFailures.length === 0
      ? ""
      : `; ${gateFailures
          .map((run) => `run ${run.runId} reports its own reply-gap gate FAIL`)
          .join("; ")}`;
  const gateOutcome =
    otherGateFailures.length === 0
      ? ""
      : replyGapPassed
        ? `; blocks cutover on ${otherGateFailures.join(", ")} (the kill criterion did not fire)`
        : `; also fails ${otherGateFailures.join(", ")}`;
  return {
    label: input.label,
    disposition: "measured",
    measured: true,
    counted: true,
    subjects: [...bySubject.keys()],
    runs: selected.map((run) => run.runId),
    replyGap,
    replyGapPassed,
    otherGateFailures,
    reasons,
    detail:
      `measured round ${input.label}: ${MEASURED_ROUND_SUBJECTS} subjects × ` +
      `${CLEAN_RUNS_PER_SUBJECT} consecutive clean runs; reply gap ${gapOutcome} ` +
      `(${replyGap.detail}${ownGateFailures})${gateOutcome}`,
  };
}

// ── The kill criterion ──────────────────────────────────────────────────────

/**
 * The owner's explicit acceptance of the risk after the kill criterion fired.
 * It is a dated decision record with the evidence attached — never a pass, and
 * never automatic: `evaluateKillCriterion` reports `RISK-ACCEPTED`, keeps
 * `automaticCutover` false, and carries this record for the reviewer.
 */
export type OwnerRiskAcceptance = {
  readonly kind: "risk-acceptance";
  readonly owner: string;
  /** ISO calendar date the owner accepted the risk (`YYYY-MM-DD`). */
  readonly acceptedOn: string;
  /** The decision record the acceptance lives in. */
  readonly decisionRecord: string;
  /** The evidence the decision cites (round labels, run ids, artifact paths). */
  readonly evidence: readonly string[];
};

/** A risk acceptance that cannot stand as a dated record. */
export class InvalidRiskAcceptanceError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(
      `risk acceptance is invalid: ${field} ${reason}; ` +
        "the kill criterion needs a dated owner decision record with its evidence attached",
    );
    this.name = "InvalidRiskAcceptanceError";
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate and normalize an acceptance record, naming the bad field. */
export function validateOwnerRiskAcceptance(value: unknown): OwnerRiskAcceptance {
  if (typeof value !== "object" || value === null) {
    throw new InvalidRiskAcceptanceError("kind", 'must be "risk-acceptance"');
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "risk-acceptance") {
    throw new InvalidRiskAcceptanceError("kind", 'must be "risk-acceptance"');
  }
  const owner = typeof record.owner === "string" ? record.owner.trim() : "";
  if (owner === "") {
    throw new InvalidRiskAcceptanceError("owner", "must name the owner who accepted the risk");
  }
  const acceptedOn = typeof record.acceptedOn === "string" ? record.acceptedOn : "";
  if (!isCalendarDate(acceptedOn)) {
    throw new InvalidRiskAcceptanceError("acceptedOn", "must be a YYYY-MM-DD date");
  }
  const decisionRecord =
    typeof record.decisionRecord === "string" ? record.decisionRecord.trim() : "";
  if (decisionRecord === "") {
    throw new InvalidRiskAcceptanceError(
      "decisionRecord",
      "must name the decision record the acceptance lives in",
    );
  }
  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence: string[] = [];
  for (const item of rawEvidence) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new InvalidRiskAcceptanceError(
        "evidence",
        "must be a list of non-empty evidence references",
      );
    }
    evidence.push(item.trim());
  }
  if (evidence.length === 0) {
    throw new InvalidRiskAcceptanceError(
      "evidence",
      "must attach the evidence the decision was taken on",
    );
  }
  return { kind: "risk-acceptance", owner, acceptedOn, decisionRecord, evidence };
}

export type KillCriterionStatus =
  | "PASS"
  | "INCOMPLETE"
  | "BLOCKED"
  | "KILLED"
  | "RISK-ACCEPTED";

export type KillCriterionVerdict = {
  readonly rounds: readonly MeasuredRoundVerdict[];
  /** Complete rounds (two subjects × two consecutive clean runs). */
  readonly measuredRounds: readonly MeasuredRoundVerdict[];
  readonly measuredCount: number;
  /** Contaminated attempts; re-run, never counted. */
  readonly rerunRounds: readonly MeasuredRoundVerdict[];
  readonly replyGapFailures: readonly MeasuredRoundVerdict[];
  /** Rounds that passed the reply gap but failed another required gate. */
  readonly otherGateFailures: readonly MeasuredRoundVerdict[];
  readonly killed: boolean;
  /** Any non-PASS verdict leaves the automatic cutover where it was. */
  readonly blocksCutover: boolean;
  readonly automaticCutover: boolean;
  readonly status: KillCriterionStatus;
  readonly acceptance: OwnerRiskAcceptance | null;
  readonly detail: string;
};

/**
 * Judge the kill criterion over every round attempt seen. Contaminated rounds
 * are excluded from the count; an acceptance can be recorded after the
 * criterion fires but changes the status to `RISK-ACCEPTED` (never `PASS`) and
 * never re-enables the automatic cutover.
 */
export function evaluateKillCriterion(input: {
  rounds: readonly RoundInput[];
  acceptance?: OwnerRiskAcceptance | null;
}): KillCriterionVerdict {
  const rounds = input.rounds.map(judgeMeasuredRound);
  const measuredRounds = rounds.filter((round) => round.measured);
  const rerunRounds = rounds.filter((round) => round.disposition === "rerun");
  const replyGapFailures = measuredRounds.filter((round) => !round.replyGapPassed);
  const otherGateFailures = measuredRounds.filter(
    (round) => round.replyGapPassed && round.otherGateFailures.length > 0,
  );
  const killed = replyGapFailures.length >= KILL_CRITERION_ROUNDS;
  const acceptance =
    input.acceptance === undefined || input.acceptance === null
      ? null
      : validateOwnerRiskAcceptance(input.acceptance);

  let status: KillCriterionStatus;
  if (killed && acceptance !== null) status = "RISK-ACCEPTED";
  else if (killed) status = "KILLED";
  else if (otherGateFailures.length > 0) status = "BLOCKED";
  else if (measuredRounds.length < KILL_CRITERION_ROUNDS) status = "INCOMPLETE";
  else status = "PASS";

  const automaticCutover = status === "PASS";
  const gapBudget = `${P50_BUDGET_MS}ms p50`;
  const counts =
    `${measuredRounds.length} measured round${measuredRounds.length === 1 ? "" : "s"}, ` +
    `${replyGapFailures.length} failing the reply gap, ` +
    `${rerunRounds.length} re-run`;
  const blockingGates = [...new Set(otherGateFailures.flatMap((round) => round.otherGateFailures))];
  const detail =
    status === "KILLED"
      ? `kill criterion fired: ${KILL_CRITERION_ROUNDS} measured rounds failed ${gapBudget}; ` +
        `routing stays off and the automatic cutover does not proceed`
      : status === "RISK-ACCEPTED"
        ? `kill criterion fired: ${KILL_CRITERION_ROUNDS} measured rounds failed ${gapBudget}; ` +
          `the owner recorded a risk acceptance on ${acceptance?.acceptedOn} in ` +
          `${acceptance?.decisionRecord} — a dated decision record, not a pass; ` +
          `the automatic cutover stays stopped`
        : status === "BLOCKED"
          ? `cutover blocked on ${blockingGates.join(", ")}: a round passed the reply gap but ` +
            `failed another required gate; the kill criterion did not fire and the work continues`
          : status === "INCOMPLETE"
            ? `kill criterion needs ${KILL_CRITERION_ROUNDS} measured rounds; ${counts}`
            : `kill criterion clear: ${counts}, all within ${gapBudget}; the automatic cutover ` +
              `may proceed (the other cutover requirements still apply)`;

  return {
    rounds,
    measuredRounds,
    measuredCount: measuredRounds.length,
    rerunRounds,
    replyGapFailures,
    otherGateFailures,
    killed,
    blocksCutover: !automaticCutover,
    automaticCutover,
    status,
    acceptance,
    detail,
  };
}
