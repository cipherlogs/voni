/**
 * Defect-card and replay refusals. Every one names the property, session, turn,
 * file or command it refused; a card is never built from a default or a guess.
 */

export const DEFECT_CARD_ERROR_CODES = [
  "invalid-run",
  "unknown-property",
  "unknown-family",
  "card-for-pass",
  "missing-attribution",
  "duplicate-attribution",
  "no-failed-scenario",
  "ambiguous-scenario",
  "scenario-mismatch",
  "unknown-session",
  "duplicate-session",
  "locale-mismatch",
  "target-mismatch",
  "turn-required",
  "unknown-turn",
  "unknown-evidence",
  "missing-evidence",
  "missing-evidence-file",
  "missing-audio",
  "invalid-excerpt",
  "audio-media-mismatch",
  "excerpt-out-of-bounds",
  "unreadable-wav",
  "missing-modules",
  "module-pointer",
  "missing-module-file",
  "invalid-replay",
] as const;

export type DefectCardErrorCode = (typeof DEFECT_CARD_ERROR_CODES)[number];

/** A bad-input or missing-evidence refusal: the spec's exit 2. */
export class DefectCardError extends Error {
  readonly code: DefectCardErrorCode;
  readonly exitCode = 2;

  constructor(code: DefectCardErrorCode, message: string) {
    super(message);
    this.name = "DefectCardError";
    this.code = code;
  }
}
