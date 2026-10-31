/**
 * The two-judge panel: independent scoring, transcript grounding, vendor
 * independence and the escalation ladder.
 *
 * Two judges score the same transcript on their own. A difference of one point
 * on an axis is agreement; more than one point escalates that axis to a third
 * judge. The third judge resolves an axis only when its rating is within one
 * point of both first scores. Anything left unresolved goes to the human panel
 * and carries no machine score — an unresolved call can never certify.
 *
 * Vendor independence is asserted when the panel is created: a judge whose
 * vendor is the agent's vendor, or whose vendor is unrecorded, is refused by
 * name. The agent's vendor is Meta; the judge model is never Meta.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging".
 */

import { JudgeError } from "./errors";
import { validateRubric } from "./rubric";
import { RATING_MAX, RATING_MIN } from "./kappa";
import type {
  AxisJudgement,
  CallJudgement,
  GroundedTranscript,
  IndependentScores,
  JudgeIdentity,
  JudgeScore,
  MachineJudge,
  ReconcileInput,
  Rubric,
} from "./types";

/** The agent runs on Meta's managed stack; a judge may never share it. */
export const AGENT_VENDOR = "meta";

/** Vendors that mean "not recorded"; they can never be asserted independent. */
const UNRECORDED_VENDORS = new Set(["", "unknown", "n/a", "none"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVendor(vendor: string): string {
  return text(vendor).toLowerCase();
}

function judgeName(identity: JudgeIdentity): string {
  return text(identity?.id) === "" ? "unnamed judge" : text(identity.id);
}

/**
 * Assert every judge is on a recorded vendor other than the agent's. Runs at
 * panel startup and again before calibration, so a judge cannot be added later
 * with an unchecked vendor.
 */
export function assertJudgeIndependence(
  judges: readonly JudgeIdentity[],
  agentVendor: string = AGENT_VENDOR,
): void {
  const agent = normalizeVendor(agentVendor);
  if (UNRECORDED_VENDORS.has(agent)) {
    throw new JudgeError(
      "vendor-unknown",
      `the agent's vendor "${agentVendor}" is not recorded; independence cannot be asserted`,
    );
  }
  for (const judge of judges) {
    const name = judgeName(judge);
    const vendor = normalizeVendor(judge?.vendor ?? "");
    if (UNRECORDED_VENDORS.has(vendor)) {
      throw new JudgeError(
        "vendor-unknown",
        `judge "${name}" has no recorded vendor; independence from "${agentVendor}" cannot be asserted`,
      );
    }
    if (vendor === agent) {
      throw new JudgeError(
        "vendor-collision",
        `judge "${name}" is on the agent's vendor "${vendor}"; the judge model must never be ` +
          "the agent's vendor",
      );
    }
  }
}

function assertDistinctJudgeIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = text(raw);
    if (id === "") {
      throw new JudgeError("duplicate-judge", "a judge has no id; judges are named");
    }
    if (seen.has(id)) {
      throw new JudgeError(
        "duplicate-judge",
        `two judges share the id "${id}"; a judge cannot score a call twice`,
      );
    }
    seen.add(id);
  }
}

function assertDistinctJudges(judges: readonly JudgeIdentity[]): void {
  assertDistinctJudgeIds(judges.map((judge) => judge?.id ?? ""));
}

export type JudgePanel = {
  readonly judges: readonly MachineJudge[];
};

/**
 * Build the two-judge panel. Refuses fewer than two judges, duplicate ids or a
 * judge on the agent's vendor. This is the startup assertion.
 */
export function createJudgePanel(input: {
  judges: readonly MachineJudge[];
  agentVendor?: string;
}): JudgePanel {
  const judges = input.judges ?? [];
  if (judges.length < 2) {
    throw new JudgeError(
      "panel-incomplete",
      `a judge panel needs two judges; got ${judges.length}`,
    );
  }
  assertDistinctJudges(judges.map((judge) => judge.identity));
  assertJudgeIndependence(
    judges.map((judge) => judge.identity),
    input.agentVendor ?? AGENT_VENDOR,
  );
  for (const judge of judges) {
    if (text(judge.identity.model) === "") {
      throw new JudgeError(
        "invalid-judge",
        `judge "${judgeName(judge.identity)}" records no model; a judge is a named model, ` +
          "not a vendor alone",
      );
    }
    if (typeof judge.score !== "function") {
      throw new JudgeError(
        "invalid-score",
        `judge "${judgeName(judge.identity)}" has no score function`,
      );
    }
  }
  return { judges: [...judges] };
}

/** Refuse a transcript that is not a call with ordered, uniquely named turns. */
export function validateTranscript(transcript: GroundedTranscript): void {
  if (text(transcript?.callId) === "") {
    throw new JudgeError("invalid-transcript", "a transcript must name its call id");
  }
  if (!Array.isArray(transcript.turns) || transcript.turns.length === 0) {
    throw new JudgeError(
      "invalid-transcript",
      `transcript "${transcript.callId}" has no turns; there is nothing to ground a score in`,
    );
  }
  const seen = new Set<string>();
  for (const turn of transcript.turns) {
    const id = text(turn?.id);
    if (id === "") {
      throw new JudgeError(
        "invalid-transcript",
        `transcript "${transcript.callId}" has a turn with no id`,
      );
    }
    if (seen.has(id)) {
      throw new JudgeError(
        "invalid-transcript",
        `transcript "${transcript.callId}" declares turn "${id}" twice`,
      );
    }
    seen.add(id);
    if (turn.speaker !== "caller" && turn.speaker !== "agent") {
      throw new JudgeError(
        "invalid-transcript",
        `transcript "${transcript.callId}" turn "${id}" has unknown speaker ` +
          `"${String(turn.speaker)}"`,
      );
    }
    if (typeof turn.text !== "string" || turn.text.trim() === "") {
      throw new JudgeError(
        "invalid-transcript",
        `transcript "${transcript.callId}" turn "${id}" has no text`,
      );
    }
    if (
      !Number.isFinite(turn.startMs) ||
      !Number.isFinite(turn.endMs) ||
      turn.startMs < 0 ||
      turn.endMs < turn.startMs
    ) {
      throw new JudgeError(
        "invalid-transcript",
        `transcript "${transcript.callId}" turn "${id}" has an invalid time range ` +
          `${String(turn.startMs)}-${String(turn.endMs)} ms`,
      );
    }
  }
}

function checkScores(scores: unknown, rubric: Rubric, judgeId: string): Record<string, number> {
  if (typeof scores !== "object" || scores === null || Array.isArray(scores)) {
    throw new JudgeError("invalid-score", `judge "${judgeId}" returned no score map`);
  }
  const record = scores as Record<string, unknown>;
  const expected = new Set(rubric.axes.map((axis) => axis.id));
  for (const axis of rubric.axes) {
    if (!(axis.id in record)) {
      throw new JudgeError(
        "invalid-score",
        `judge "${judgeId}" did not score axis "${axis.id}"`,
      );
    }
  }
  for (const axis of Object.keys(record)) {
    if (!expected.has(axis)) {
      throw new JudgeError(
        "invalid-score",
        `judge "${judgeId}" scored axis "${axis}", which is not in rubric "${rubric.id}"`,
      );
    }
  }
  const out: Record<string, number> = {};
  for (const axis of rubric.axes) {
    const value = record[axis.id];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < RATING_MIN ||
      value > RATING_MAX
    ) {
      throw new JudgeError(
        "invalid-score",
        `judge "${judgeId}" scored axis "${axis.id}" ${String(value)}; ratings are integers ` +
          `on the ${RATING_MIN}-${RATING_MAX} scale`,
      );
    }
    out[axis.id] = value;
  }
  return out;
}

function checkCitations(
  citations: unknown,
  transcript: GroundedTranscript,
  judgeId: string,
): string[] {
  if (!Array.isArray(citations) || citations.length === 0) {
    throw new JudgeError(
      "ungrounded-score",
      `judge "${judgeId}" cited no transcript turn; a score must be grounded`,
    );
  }
  const known = new Set(transcript.turns.map((turn) => turn.id));
  const out: string[] = [];
  for (const citation of citations) {
    const id = text(citation);
    if (id === "") continue;
    if (!known.has(id)) {
      throw new JudgeError(
        "ungrounded-score",
        `judge "${judgeId}" cited turn "${id}", which is not in transcript ` +
          `"${transcript.callId}"`,
      );
    }
    out.push(id);
  }
  if (out.length === 0) {
    throw new JudgeError(
      "ungrounded-score",
      `judge "${judgeId}" cited no transcript turn; a score must be grounded`,
    );
  }
  return [...new Set(out)];
}

function validateScore(
  score: JudgeScore,
  identity: JudgeIdentity,
  transcript: GroundedTranscript,
  rubric: Rubric,
): JudgeScore {
  if (typeof score !== "object" || score === null) {
    throw new JudgeError(
      "invalid-score",
      `judge "${judgeName(identity)}" returned no score`,
    );
  }
  const judgeId = text(score.judgeId);
  if (judgeId !== text(identity.id)) {
    throw new JudgeError(
      "judge-mismatch",
      `judge "${judgeName(identity)}" returned a score attributed to "${judgeId}"`,
    );
  }
  const callId = text(score.callId);
  if (callId !== transcript.callId) {
    throw new JudgeError(
      "call-mismatch",
      `judge "${judgeId}" scored call "${callId}" against transcript "${transcript.callId}"`,
    );
  }
  const scores = checkScores(score.scores, rubric, judgeId);
  const citations = checkCitations(score.citations, transcript, judgeId);
  return {
    judgeId,
    callId,
    scores,
    citations,
    ...(text(score.rationale) === "" ? {} : { rationale: text(score.rationale) }),
  };
}

/** Validate one score without a transcript, for reconciliation. */
function validateBareScore(score: JudgeScore, rubric: Rubric): JudgeScore {
  if (typeof score !== "object" || score === null) {
    throw new JudgeError("invalid-score", "a reconciliation input has no score");
  }
  const judgeId = text(score.judgeId);
  if (judgeId === "") {
    throw new JudgeError("invalid-score", "a reconciliation score has no judge id");
  }
  const callId = text(score.callId);
  if (callId === "") {
    throw new JudgeError("invalid-score", `judge "${judgeId}" scored no call id`);
  }
  return {
    judgeId,
    callId,
    scores: checkScores(score.scores, rubric, judgeId),
    citations: Array.isArray(score.citations) ? [...score.citations] : [],
    ...(text(score.rationale) === "" ? {} : { rationale: text(score.rationale) }),
  };
}

/**
 * Score one call twice, independently. Each judge gets the same transcript and
 * rubric and nothing else. A judge that fails to ground its score in a real
 * turn, misses an axis or leaves the 1-5 scale is refused by name.
 */
export async function scoreIndependently(input: {
  transcript: GroundedTranscript;
  rubric: Rubric;
  judges: readonly MachineJudge[];
}): Promise<IndependentScores> {
  validateRubric(input.rubric);
  validateTranscript(input.transcript);
  const panel = createJudgePanel({ judges: input.judges });
  if (panel.judges.length !== 2) {
    throw new JudgeError(
      "panel-incomplete",
      `independent first-pass scoring takes exactly two judges; got ${panel.judges.length}`,
    );
  }
  const [firstJudge, secondJudge] = panel.judges;
  const judgeInput = {
    transcript: input.transcript,
    rubric: input.rubric,
  };
  const first = await firstJudge.score(judgeInput);
  const second = await secondJudge.score(judgeInput);
  return {
    callId: input.transcript.callId,
    first: validateScore(first, firstJudge.identity, input.transcript, input.rubric),
    second: validateScore(second, secondJudge.identity, input.transcript, input.rubric),
  };
}

/**
 * Reconcile the two scores (and, after a dispute, a third). The final score
 * exists only when every axis is resolved; otherwise the call is `panel` and
 * `final` is null.
 */
export function reconcileCall(input: ReconcileInput): CallJudgement {
  validateRubric(input.rubric);
  const callId = text(input.callId);
  if (callId === "") {
    throw new JudgeError("invalid-score", "a reconciliation has no call id");
  }
  const first = validateBareScore(input.first, input.rubric);
  const second = validateBareScore(input.second, input.rubric);
  const third = input.third === undefined ? undefined : validateBareScore(input.third, input.rubric);
  const judges = [first.judgeId, second.judgeId, ...(third === undefined ? [] : [third.judgeId])];
  assertDistinctJudgeIds(judges);
  for (const score of [first, second, ...(third === undefined ? [] : [third])]) {
    if (score.callId !== callId) {
      throw new JudgeError(
        "call-mismatch",
        `judge "${score.judgeId}" scored call "${score.callId}", not "${callId}"`,
      );
    }
  }

  const axes: AxisJudgement[] = [];
  const unresolvedAxes: string[] = [];
  let disputed = false;
  for (const axis of input.rubric.axes) {
    const a = first.scores[axis.id];
    const b = second.scores[axis.id];
    const agreed = Math.abs(a - b) <= 1;
    if (agreed) {
      axes.push({
        axis: axis.id,
        first: a,
        second: b,
        agreed: true,
        resolved: true,
        final: (a + b) / 2,
      });
      continue;
    }

    disputed = true;
    const c = third?.scores[axis.id];
    if (c !== undefined && Math.abs(c - a) <= 1 && Math.abs(c - b) <= 1) {
      axes.push({
        axis: axis.id,
        first: a,
        second: b,
        third: c,
        agreed: false,
        resolved: true,
        final: c,
      });
      continue;
    }
    axes.push({
      axis: axis.id,
      first: a,
      second: b,
      ...(c === undefined ? {} : { third: c }),
      agreed: false,
      resolved: false,
      final: null,
    });
    unresolvedAxes.push(axis.id);
  }

  const citations = [
    ...new Set(
      [first, second, ...(third === undefined ? [] : [third])].flatMap((score) => score.citations),
    ),
  ];

  if (unresolvedAxes.length > 0) {
    return {
      callId,
      state: "panel",
      final: null,
      axes,
      unresolvedAxes,
      citations,
      detail:
        `call "${callId}": ${unresolvedAxes.join(", ")} unresolved ` +
        `(${third === undefined ? "no third judge" : "third judge did not bridge both scores"}); ` +
        "the call goes to the human panel",
    };
  }

  const final: Record<string, number> = {};
  for (const axis of axes) {
    if (axis.final === null) continue;
    final[axis.axis] = axis.final;
  }
  return {
    callId,
    state: disputed ? "escalated" : "agreed",
    final,
    axes,
    unresolvedAxes: [],
    citations,
    detail:
      disputed
        ? `call "${callId}": the third judge resolved every disputed axis`
        : `call "${callId}": the two judges agreed within one point on every axis`,
  };
}
