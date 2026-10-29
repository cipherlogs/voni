/**
 * The one sensitive-capture window pair, derived from the stored body.
 *
 * Sensitive values (an email, a phone number, an address, a budget) need a
 * wider end-of-turn window than ordinary conversation, or the agent cuts the
 * caller off mid-entity. The browser has always widened to `1400 / 4000` for
 * that one turn; the phone bridge used its own `500 / 2000` and restored its own
 * `100 / 500`. Three window pairs for one product is exactly the drift ADR 0007
 * exists to stop.
 *
 * A body serves either the Turn preset (`turn_detection: null`, meaning-based
 * end-of-turn) or the demo latency experiment's explicit windows. The capture
 * window is the floor below, never narrowed by the body; a body that already
 * asks for a longer pause keeps its longer window. Restore is the body's own
 * setting, verbatim — never a transport guess.
 *
 * `telephony-bot/test_capture_windows.py` and
 * `./capture-windows.test.ts` both read `./capture-window-cases.json`, so phone
 * and browser are proved equal from the same bodies. Tolerance: 0 ms — the two
 * transports send identical values, not merely close ones.
 */

/** The body setting this derivation accepts: `null` is the Turn preset. */
export type BodyTurnDetection =
  | {
      min_silence?: number;
      max_silence?: number;
      interrupt_response?: boolean;
      interruption_delay?: number;
    }
  | null
  | undefined;

export type SensitiveCaptureWindows = {
  min_silence: number;
  max_silence: number;
  interrupt_response: boolean;
  interruption_delay: number;
};

/**
 * The product's sensitive-capture floor. The silence pair is speech start/end;
 * the interruption settings make barge-in usable while the caller dictates.
 */
export const SENSITIVE_CAPTURE_FLOOR = Object.freeze({
  min_silence: 1400,
  max_silence: 4000,
  interrupt_response: true,
  interruption_delay: 0,
});

function milliseconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

/**
 * The window pair for one sensitive turn, given the body's setting.
 *
 * The silence floor is a lower bound, not an override: a body that already asks
 * for a longer pause keeps it, so a stored-body change reaches the session
 * without a client deploy. The interruption settings stay the capture preset's
 * — sensitive capture is also the turn where fast barge-in matters.
 */
export function sensitiveCaptureWindows(
  turnDetection: BodyTurnDetection,
): SensitiveCaptureWindows {
  return {
    min_silence: Math.max(
      milliseconds(turnDetection?.min_silence),
      SENSITIVE_CAPTURE_FLOOR.min_silence,
    ),
    max_silence: Math.max(
      milliseconds(turnDetection?.max_silence),
      SENSITIVE_CAPTURE_FLOOR.max_silence,
    ),
    interrupt_response: SENSITIVE_CAPTURE_FLOOR.interrupt_response,
    interruption_delay: SENSITIVE_CAPTURE_FLOOR.interruption_delay,
  };
}
