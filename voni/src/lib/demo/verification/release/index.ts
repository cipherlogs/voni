/**
 * Release and cutover gates (ticket 29): the streak, the staging gate, the
 * post-flip confirmation, the rollback value and the monthly production record.
 *
 * Every function reads a committed certificate or a committed record. None of
 * them runs a call, opens a vendor, or invents a green: a missing certificate,
 * a pending panel, a dirty tree, a coverage gap or a different target is a
 * named refusal. A certificate is true only for its own target; production
 * never inherits a staging green.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Targets, runs and cadence" and
 * "Statistics and the pass rule"; ADR 0013; docs/agents/demo-verification.md.
 */

export { ReleaseError, RELEASE_REFUSAL_EXIT_CODE, type ReleaseErrorCode } from "./errors";

export {
  STREAK_SIZE,
  evaluateCertificateStreak,
  isCleanCertification,
  type CertificateStreak,
  type StreakBreak,
  type StreakBreakCode,
} from "./streak";

export {
  evaluateCutoverGate,
  assertProductionCertificate,
  type CutoverGateCheck,
  type CutoverGateResult,
} from "./gate";

export {
  POST_FLIP_MAX_CALLS,
  parsePostFlipConfirmation,
  evaluatePostFlipConfirmation,
  type PostFlipCall,
  type PostFlipConfirmation,
  type PostFlipEvaluation,
} from "./confirmation";

export {
  ROLLBACK_ROUTING_MODE,
  rollbackRoutingValue,
  parseRollbackRecord,
  evaluateRollback,
  type RollbackRecord,
  type RollbackEvaluation,
} from "./rollback";

export {
  MONTHLY_PRODUCTION_CRON,
  MONTHLY_RECORD_VERSION,
  monthlyProductionRecord,
  parseMonthlyProductionRecord,
  evaluateMonthlyProduction,
  type MonthlyProductionEntry,
  type MonthlyProductionRecord,
  type MonthlyEvaluation,
} from "./monthly";
