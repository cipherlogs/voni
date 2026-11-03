/**
 * Verdict-core refusals. Every one names the offending property, bar or
 * attempt: the engine may never default an unknown evaluator, bar or sample
 * into a pass.
 */

export type VerdictErrorCode =
  | "duplicate-evaluator"
  | "unknown-property"
  | "unknown-family"
  | "empty-evaluator-module"
  | "malformed-evaluator-module"
  | "invalid-evaluator"
  | "family-mismatch"
  | "unknown-bar"
  | "missing-bar-binding"
  | "duplicate-bar-binding"
  | "bars-on-categorical-property"
  | "invalid-bar-binding"
  | "duplicate-attempt"
  | "invalid-attempt"
  | "unreadable-evaluators";

export class VerdictError extends Error {
  readonly code: VerdictErrorCode;

  constructor(code: VerdictErrorCode, message: string) {
    super(message);
    this.name = "VerdictError";
    this.code = code;
  }
}
