/**
 * Economics: the call's priced row and the run ceilings above it.
 *
 * E1-E4's evaluators live in `verdict/evaluators/economics.evaluators.ts`;
 * this module owns the evidence they read and the run gate a fast, nightly or
 * full run calls before it starts and after it ends. Cost is always the call's
 * own `cost.priced` row, never recomputed here.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Economics" E1-E4.
 */

export {
  PRICED_COST_ERROR_CODES,
  PricedCostError,
  legBreakdown,
  readPricedRow,
  type PricedCost,
  type PricedCostErrorCode,
  type PricedLeg,
} from "./priced-cost";

export {
  COST_BOUND_ERROR_CODES,
  CostBoundError,
  boundPricedCost,
  cutCallIdsFromAttempts,
  evidenceCallId,
  evidenceHasCut,
  type CostBound,
  type CostBoundErrorCode,
  type CostBoundUnpricedLeg,
} from "./cost-bound";

export {
  PER_CALL_CEILING_KEY,
  RUN_CEILING_ERROR_CODES,
  RUN_CEILING_KEYS,
  RUN_KINDS,
  RUN_SCENARIO,
  RunCeilingError,
  contractForRunCeiling,
  evaluateRunCost,
  preflightRunCeiling,
  runCeilingEvidence,
  runCeilingFor,
  runCostSource,
  scopeRunToCeiling,
  settleRunCeiling,
  type RunCeilingCheck,
  type RunCeilingErrorCode,
  type RunCostRow,
  type RunCostSource,
  type RunKind,
} from "./run-ceiling";

export { judgeRunWithCeiling } from "./run-verdict";
