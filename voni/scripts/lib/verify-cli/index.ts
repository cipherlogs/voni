/**
 * `demo:verify`'s testable contract: argv, plan, dispatch and exit code.
 *
 * The command entry (`scripts/demo-verify.mts`) wires the real browser and
 * protocol adapters and the machine-wide timing lock; nothing in this module
 * opens a vendor.
 */

export {
  VERIFY_MODES,
  VERIFY_USAGE,
  parseVerifyArgs,
  type VerifyMode,
  type VerifyRequest,
} from "./args";

export { VERIFY_ERROR_CODES, VERIFY_REFUSAL_EXIT_CODE, VerifyCliError } from "./errors";

export {
  LOCALE_CORE_SCENARIOS,
  planVerify,
  runKindOf,
  type PlannedScenario,
  type VerifyPlan,
} from "./plan";

export {
  defaultRunId,
  exitForCertificate,
  runVerify,
  type DiagnoseInput,
  type DiagnoseOutcome,
  type ScenarioCallInput,
  type ScenarioCallOutcome,
  type VerifyDeps,
  type VerifyResult,
  type VerifyStatus,
} from "./run";
