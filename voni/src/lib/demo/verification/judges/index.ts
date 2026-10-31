/**
 * Machine judges and calibration: two transcript-grounded judges, escalation,
 * vendor independence and the weighted-kappa gate against panel gold labels.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for the decisions this module enforces.
 */

export { JudgeError, type JudgeErrorCode } from "./errors";

export {
  RATING_MAX,
  RATING_MIN,
  linearWeight,
  weightedKappa,
  type KappaResult,
  type RatingPair,
} from "./kappa";

export { rubricHash, validateRubric } from "./rubric";

export {
  AGENT_VENDOR,
  assertJudgeIndependence,
  createJudgePanel,
  reconcileCall,
  scoreIndependently,
  validateTranscript,
  type JudgePanel,
} from "./panel";

export { calibrate } from "./calibration";
export { h6Evaluator } from "./h6";

export type {
  AxisCalibration,
  AxisJudgement,
  CalibrationItem,
  CalibrationRecord,
  CalibrationTable,
  CalibrationVerdict,
  CallJudgement,
  GroundedTranscript,
  IndependentScores,
  JudgeEvidence,
  JudgeIdentity,
  JudgeInput,
  JudgeScore,
  MachineJudge,
  ReconcileInput,
  Rubric,
  RubricAxis,
  TranscriptTurn,
} from "./types";
