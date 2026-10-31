/**
 * The scenario loader's refusals. Every error names the offending item and
 * carries the CLI's refusal exit code: an unknown property, a missing take, an
 * unhashed fixture or a changed file is never a skip that reads green.
 */

/** `demo:verify` exit code for a named refusal (spec, "Commands and exit codes"). */
export const SCENARIO_REFUSAL_EXIT_CODE = 2;

export type ScenarioErrorCode =
  | "malformed-scenario"
  | "malformed-manifest"
  | "unknown-field"
  | "missing-field"
  | "invalid-name"
  | "unknown-class"
  | "unknown-locale"
  | "unknown-property"
  | "duplicate-property"
  | "empty-properties"
  | "unknown-trigger"
  | "invalid-trigger"
  | "invalid-timeline"
  | "unknown-take"
  | "duplicate-take"
  | "empty-script"
  | "unhashed-take"
  | "invalid-hash"
  | "unsafe-take-path"
  | "unknown-fault"
  | "invalid-fault"
  | "unknown-edge-condition"
  | "invalid-edge-condition"
  | "held-out-mismatch"
  | "duplicate-scenario"
  | "empty-scenario"
  | "empty-corpus"
  | "missing-scenario"
  | "unexpected-corpus-entry"
  | "missing-manifest"
  | "missing-take"
  | "empty-take"
  | "take-drift"
  | "unreadable-corpus"
  | "missing-fast-scenario"
  | "fast-scenario-mismatch"
  | "fast-coverage-gap"
  | "fast-ceiling-unset"
  | "fast-verdict-incomplete"
  | "fast-run-incomplete"
  | "fast-ceiling-unsettled"
  | "missing-locale-scenario"
  | "locale-scenario-mismatch"
  | "locale-coverage-gap"
  | "locale-ceiling-unset"
  | "locale-evidence-missing"
  | "locale-residual-risk"
  | "invalid-audio"
  | "tts-failed";

export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly exitCode = SCENARIO_REFUSAL_EXIT_CODE;

  constructor(code: ScenarioErrorCode, message: string) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
  }
}
