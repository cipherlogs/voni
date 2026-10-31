/**
 * The contract registry's refusals. Every error names the offending item: the
 * loader may never default a missing bar, source or key into a pass.
 */

export type ContractErrorCode =
  | "duplicate-property"
  | "duplicate-family"
  | "duplicate-threshold"
  | "unknown-family"
  | "empty-family"
  | "unknown-property"
  | "missing-statement"
  | "missing-bar"
  | "invalid-kind"
  | "unknown-evidence"
  | "unknown-threshold-source"
  | "numeric-bar-without-threshold"
  | "threshold-on-categorical-bar"
  | "unrecorded-threshold"
  | "unreadable-record"
  | "malformed-record";

export class ContractRegistryError extends Error {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = "ContractRegistryError";
    this.code = code;
  }
}
