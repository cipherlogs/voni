/**
 * Judge-panel refusals. Every one names the judge, vendor, axis or turn it is
 * about: an unknown judge, a vendor collision or an ungrounded score may never
 * default into a pass.
 */

export type JudgeErrorCode =
  | "invalid-rating"
  | "invalid-rubric"
  | "invalid-transcript"
  | "invalid-score"
  | "ungrounded-score"
  | "call-mismatch"
  | "duplicate-judge"
  | "invalid-judge"
  | "judge-mismatch"
  | "panel-incomplete"
  | "vendor-unknown"
  | "vendor-collision"
  | "missing-evidence";

export class JudgeError extends Error {
  readonly code: JudgeErrorCode;

  constructor(code: JudgeErrorCode, message: string) {
    super(message);
    this.name = "JudgeError";
    this.code = code;
  }
}
