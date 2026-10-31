/**
 * Certificate refusals. Every one names the offending field, property or run:
 * the certificate may never default an unknown schema, a missing signature, a
 * mismatched fingerprint or an uncited verdict into a pass.
 *
 * A refusal is exit 2 (bad input or missing evidence). A well-formed
 * certificate that is merely unsigned is not a refusal: it carries the
 * `pending-human` verdict and exits 3 through {@link certificateExitCode}.
 */

import type { CertificateVerdict, CertificateVerdictExit } from "./types";

/** `demo:certificate` / `demo:verify` exit code for a named refusal. */
export const CERTIFICATE_REFUSAL_EXIT_CODE = 2;

export type CertificateErrorCode =
  | "unreadable-certificate"
  | "invalid-json"
  | "malformed-certificate"
  | "unknown-schema-version"
  | "unknown-target"
  | "unknown-mode"
  | "invalid-plan"
  | "invalid-code-fingerprint"
  | "invalid-build"
  | "invalid-corpus-reference"
  | "invalid-vendor-builds"
  | "unknown-vendor-leg"
  | "missing-vendor-build"
  | "duplicate-vendor-leg"
  | "invalid-coverage"
  | "coverage-row-missing"
  | "invalid-property-verdict"
  | "duplicate-property-verdict"
  | "verdict-without-citations"
  | "invalid-residual-risks"
  | "unknown-residual-risk"
  | "missing-residual-risk"
  | "missing-panel-signature"
  | "unexpected-panel-signature"
  | "invalid-panel-signature"
  | "invalid-eligibility"
  | "invalid-cost"
  | "verdict-mismatch"
  | "pass-without-certified"
  | "target-mismatch"
  | "run-id-mismatch"
  | "code-fingerprint-mismatch"
  | "corpus-hash-mismatch"
  | "unknown-scenario"
  | "locale-mismatch"
  | "repetition-out-of-plan"
  | "duplicate-attempt"
  | "duplicate-corpus-scenario"
  | "empty-corpus"
  | "property-contract-mismatch"
  | "unsafe-run-id";

export class CertificateError extends Error {
  readonly code: CertificateErrorCode;
  readonly exitCode = CERTIFICATE_REFUSAL_EXIT_CODE;

  constructor(code: CertificateErrorCode, message: string) {
    super(message);
    this.name = "CertificateError";
    this.code = code;
  }
}

/**
 * The CLI exit for a well-formed certificate: 0 certified, 1 not-demo-ready or
 * ineligible, 3 pending human. A refusal exits 2 before a verdict is returned.
 */
export function certificateExitCode(verdict: CertificateVerdict): CertificateVerdictExit {
  switch (verdict) {
    case "certified":
      return 0;
    case "not-demo-ready":
    case "ineligible":
      return 1;
    case "pending-human":
      return 3;
  }
}
