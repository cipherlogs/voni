/**
 * `demo:verify`'s named refusals.
 *
 * Bad input and missing evidence are one exit code (2) but never one message:
 * every refusal names the target, mode, Locale, scenario, key, corpus item,
 * vendor build or lock holder that made the run impossible. A refusal is never
 * a skip, and it never becomes a verdict.
 */

/** `demo:verify` exit code for bad input or missing evidence. */
export const VERIFY_REFUSAL_EXIT_CODE = 2 as const;

export const VERIFY_ERROR_CODES = [
  "bad-input",
  "unknown-target",
  "unknown-locale",
  "unknown-mode",
  "unsupported-target",
  "unsupported-mode",
  "missing-scenario",
  "missing-key",
  "missing-corpus",
  "missing-locale-corpus",
  "missing-vendor-build",
  "run-ceiling",
  "timing-lock-held",
  "adapter-refused",
  "certificate-refused",
  "resume-mode-unsupported",
  "journal-run-id-invalid",
  "journal-missing",
  "journal-torn",
  "journal-malformed",
  "journal-schema-unknown",
  "journal-run-id-mismatch",
  "journal-target-mismatch",
  "journal-code-mismatch",
  "journal-corpus-mismatch",
  "journal-vendor-builds-mismatch",
  "journal-plan-mismatch",
  "journal-evidence-missing",
] as const;

export type VerifyErrorCode = (typeof VERIFY_ERROR_CODES)[number];

export class VerifyCliError extends Error {
  readonly code: VerifyErrorCode;
  readonly exitCode = VERIFY_REFUSAL_EXIT_CODE;
  /** Every missing item this refusal names, in the order it was found. */
  readonly missing: readonly string[];

  constructor(code: VerifyErrorCode, message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "VerifyCliError";
    this.code = code;
    this.missing = missing;
  }
}

export function refuse(
  code: VerifyErrorCode,
  message: string,
  missing: readonly string[] = [],
): never {
  throw new VerifyCliError(code, message, missing);
}
