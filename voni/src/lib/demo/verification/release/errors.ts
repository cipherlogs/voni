/** A named release/cutover refusal; bad input or missing evidence is exit 2. */

export const RELEASE_REFUSAL_EXIT_CODE = 2 as const;

export type ReleaseErrorCode =
  | "bad-input"
  | "missing-evidence"
  | "invalid-record"
  | "not-short"
  | "wrong-target"
  | "wrong-mode"
  | "vendor-sessions";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  readonly exitCode = RELEASE_REFUSAL_EXIT_CODE;

  constructor(code: ReleaseErrorCode, message: string) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}
