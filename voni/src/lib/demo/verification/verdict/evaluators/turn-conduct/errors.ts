/**
 * A turn-taking or conduct evaluator's named refusal.
 *
 * Every reader in this family either returns the evidence it was handed or
 * throws one of these codes. The evaluator turns a code into an `unmeasured`
 * result, which the verdict engine fails closed — a missing artifact is never
 * a pass.
 */

export const TURN_CONDUCT_ERROR_CODES = [
  "missing-evidence",
  "malformed-evidence",
  "unreadable-wav",
  "no-anchor",
] as const;

export type TurnConductErrorCode = (typeof TURN_CONDUCT_ERROR_CODES)[number];

export class TurnConductError extends Error {
  readonly code: TurnConductErrorCode;

  constructor(code: TurnConductErrorCode, message: string) {
    super(message);
    this.name = "TurnConductError";
    this.code = code;
  }
}
