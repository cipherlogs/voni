/**
 * Panel refusals. Every one names the session, call, reviewer or certificate
 * field that failed, so an unsigned or under-sampled panel cannot be read as a
 * clean one.
 *
 * A refusal is exit 2 (bad input or missing evidence). An unsigned but
 * otherwise clean certificate is not a refusal: it is `pending-human` and exits
 * 3 through the certificate's own exit-code mapping.
 */

export const PANEL_REFUSAL_EXIT_CODE = 2;

export type PanelErrorCode =
  | "invalid-session"
  | "invalid-certificate"
  | "missing-reviewer"
  | "reviewer-mismatch"
  | "missing-signature-date"
  | "invalid-signature-date"
  | "date-mismatch"
  | "run-mismatch"
  | "target-mismatch"
  | "missing-locale"
  | "locale-shortfall"
  | "invalid-scope"
  | "out-of-scope-call"
  | "missing-scenario-class"
  | "missing-failing-call"
  | "panel-shortfall"
  | "empty-panel"
  | "unknown-rating"
  | "duplicate-rating"
  | "duplicate-call"
  | "incomplete-panel"
  | "rating-session-mismatch"
  | "missing-signature"
  | "missing-labels"
  | "invalid-signature"
  | "signature-mismatch"
  | "already-signed"
  | "certificate-not-pending"
  | "missing-panel-property";

export class PanelError extends Error {
  readonly code: PanelErrorCode;
  readonly exitCode = PANEL_REFUSAL_EXIT_CODE;

  constructor(code: PanelErrorCode, message: string) {
    super(message);
    this.name = "PanelError";
    this.code = code;
  }
}
