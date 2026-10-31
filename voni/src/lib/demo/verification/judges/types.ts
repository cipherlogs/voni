/**
 * The judge panel's vocabulary: a rubric, a transcript a judge must cite, and
 * the two independent scores that are reconciled by the escalation ladder.
 *
 * A score is grounded: every judgment cites transcript turn ids, and an axis is
 * rated on the panel's 1-5 scale. The panel never invents a score for an axis
 * the judges did not resolve; an unresolved call goes to the human panel.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging".
 */

/** One rated axis. `anchors` is the 1-5 wording the judge is given. */
export type RubricAxis = {
  readonly id: string;
  readonly question: string;
  readonly anchors?: readonly string[];
};

/** The rubric a call is scored against. Any change moves its hash. */
export type Rubric = {
  readonly id: string;
  readonly axes: readonly RubricAxis[];
};

/** One speaker turn a judge may cite. Ids are unique inside a transcript. */
export type TranscriptTurn = {
  readonly id: string;
  readonly speaker: "caller" | "agent";
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
};

/** The call as heard: the only ground truth a machine judge may use. */
export type GroundedTranscript = {
  readonly callId: string;
  readonly turns: readonly TranscriptTurn[];
};

/** One judge model's identity. `vendor` is the model provider, not the agent's. */
export type JudgeIdentity = {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
};

/** One judge's rating of one call. Every rubric axis is scored exactly once. */
export type JudgeScore = {
  readonly judgeId: string;
  readonly callId: string;
  readonly scores: Readonly<Record<string, number>>;
  /** Transcript turn ids supporting the scores; empty is ungrounded. */
  readonly citations: readonly string[];
  readonly rationale?: string;
};

/** What a judge is handed: the same transcript and rubric for every judge. */
export type JudgeInput = {
  readonly transcript: GroundedTranscript;
  readonly rubric: Rubric;
};

/**
 * A machine judge: an identity plus the function that scores a call. The
 * function is handed only the transcript and rubric, never another judge's
 * score, so the first two judges are independent by construction.
 */
export type MachineJudge = {
  readonly identity: JudgeIdentity;
  score(input: JudgeInput): JudgeScore | Promise<JudgeScore>;
};

/** The two independent first-pass scores for one call. */
export type IndependentScores = {
  readonly callId: string;
  readonly first: JudgeScore;
  readonly second: JudgeScore;
};

/** One axis after reconciliation. */
export type AxisJudgement = {
  readonly axis: string;
  readonly first: number;
  readonly second: number;
  readonly third?: number;
  /** True when the first two are within one point. */
  readonly agreed: boolean;
  /** True when a final score exists; a panel disagreement has none. */
  readonly resolved: boolean;
  readonly final: number | null;
};

/** How one call's scores ended: agreed, third-judge resolved, or panel. */
export type CallJudgement = {
  readonly callId: string;
  readonly state: "agreed" | "escalated" | "panel";
  /** Null whenever any axis is unresolved; never a partial machine verdict. */
  readonly final: Readonly<Record<string, number>> | null;
  readonly axes: readonly AxisJudgement[];
  readonly unresolvedAxes: readonly string[];
  readonly citations: readonly string[];
  readonly detail: string;
};

/** What `reconcileCall` reads: two scores, plus a third only after a dispute. */
export type ReconcileInput = {
  readonly callId: string;
  readonly rubric: Rubric;
  readonly first: JudgeScore;
  readonly second: JudgeScore;
  readonly third?: JudgeScore;
};

/** A rating x gold counts table, used to build synthetic calibration samples. */
export type CalibrationTable = readonly (readonly number[])[];

/** One judge's rating of one call on one axis, beside the panel's gold label. */
export type CalibrationItem = {
  readonly callId: string;
  readonly axis: string;
  readonly judgeId: string;
  /** The machine judge's rating on the 1-5 scale. */
  readonly score: number;
  /** The owner's blind gold label on the same call and axis. */
  readonly gold: number;
};

/**
 * A calibration record: the rubric it was scored against, the judges it
 * covers, and every call/axis pair. The rubric hash makes a rubric change
 * invalidate the record; it is never recalibrated silently.
 */
export type CalibrationRecord = {
  readonly rubricHash: string;
  readonly judges: readonly JudgeIdentity[];
  readonly items: readonly CalibrationItem[];
};

/** One judge's agreement on one axis. */
export type AxisCalibration = {
  readonly judgeId: string;
  readonly axis: string;
  /** Null when the sample carries no defined kappa; never treated as a pass. */
  readonly kappa: number | null;
  readonly count: number;
  readonly belowBar: boolean;
  readonly reason?: string;
};

/** The calibration gate's verdict: only `verified` may be used to gate. */
export type CalibrationVerdict = {
  readonly status: "verified" | "unverified";
  /** The frozen H6 bar, read from the budget record. */
  readonly minKappa: number;
  readonly rubricHash: string;
  readonly axes: readonly AxisCalibration[];
  /** Every defined kappa, including below-bar values, for the certificate. */
  readonly kappas: readonly number[];
  readonly reasons: readonly string[];
  readonly citations: readonly string[];
  readonly detail: string;
};

/** The judge evidence source: a rubric and the panel's calibration record. */
export type JudgeEvidence = {
  readonly rubric: Rubric;
  readonly calibration: CalibrationRecord;
};
