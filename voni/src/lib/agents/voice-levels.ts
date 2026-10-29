/**
 * The per-voice output level a stored agent body carries.
 *
 * ── The contract (voice-parity ticket 37) ─────────────────────────────────
 * A voice's level is `output.volume` on the stored agent body — demo or
 * tenant — and nowhere else. The browser applies no level processing
 * (ticket 36); the stored body is the single place the level is expressed,
 * so a change is deployable, fingerprinted and auditable.
 *
 * ── Where the number comes from ───────────────────────────────────────────
 * The target for a voice is its own measured reference: the vendor's render
 * of the line the agent actually speaks, at native level, with no client,
 * platform or model in the path. That is the first of the three W0 captures
 * (`src/lib/demo/reference-render.ts`) and the file the timbre gate compares
 * Delivered audio against (ticket 16, tolerance 0.20 LU).
 *
 * `output.volume` is an attenuation (the platform caps it at 100, the voice's
 * native reference — it cannot boost). So the decision is:
 *
 *   - the measured reference is already the target → 100, no processing;
 *   - a *delivered* capture above the reference would need attenuation to
 *     bring delivered back to it, expressed as 100·10^(−ΔdB/20);
 *   - a voice quieter than its reference cannot be corrected here (no boost
 *     exists) and is never attenuated for "matching" another voice: the old
 *     cross-voice gain table was the defect this ticket removes.
 *
 * The measurement is recorded in `evidence/voice-levels/levels.json` with the
 * date, method, requestable command (`npm run voice:levels`) and every take,
 * so the number on the body can be audited without re-running anything. A
 * recapture is a new evidence record, never a silent retune.
 *
 * ── The measured run (2026-10-29) ─────────────────────────────────────────
 * Three vendor renders per voice of that voice's own greeting, measured with
 * `src/lib/audio/level-facts.ts`. Every offered voice that the TTS endpoint
 * serves measured at or within the gate's 0.20 LU tolerance of the committed
 * `anna` floor (−20.04 LUFS; measured medians −20.11 … −26.41) and no take
 * clips (worst true peak −1.48 dBTP), so no voice needs attenuation and none
 * may be boosted: `volume = 100` for every measured voice. The measured level
 * is the voice's own reference, so unity is the decision, not a default that
 * skipped the measurement.
 *
 * `juergen` is the exception the vendor's TTS endpoint does not serve
 * (`422 voice_not_found`), so it has no measured reference. It keeps the named
 * `UNMEASURED_VOICE_OUTPUT_VOLUME` and the gate reports it unmeasured — an
 * unmeasured voice never passes on a default (ticket 21).
 */

/**
 * `output.volume` for a voice with no measured reference: the platform's
 * native (unity) level. Named so an unmeasured voice is visible as a decision,
 * never an invented quieter number.
 */
export const UNMEASURED_VOICE_OUTPUT_VOLUME = 100;

/** One voice's measured reference and the level decision it supports. */
export type VoiceLevelMeasurement = {
  voice: string;
  /** The voice's own Locale — a voice speaks exactly one. */
  locale: string;
  /** Median gated integrated loudness across the takes, LUFS (BS.1770-4). */
  integratedLufs: number;
  /** Loudest true peak across the takes, dBTP. */
  truePeakDbtp: number;
  /** The `output.volume` the stored body carries: 100 = native reference. */
  volume: number;
};

/**
 * Measured 2026-10-29, produced by `npm run voice:levels`. Values are the
 * evidence file's, rounded to 2 decimals so the registry and the committed
 * record can be compared exactly; the test in `voices.test.ts` fails if either
 * side moves alone.
 */
export const MEASURED_VOICE_LEVELS: readonly VoiceLevelMeasurement[] = Object.freeze([
  { voice: "alba", locale: "en", integratedLufs: -21.78, truePeakDbtp: -5.93, volume: 100 },
  { voice: "anna", locale: "en", integratedLufs: -20.11, truePeakDbtp: -4.05, volume: 100 },
  { voice: "charles", locale: "en", integratedLufs: -20.64, truePeakDbtp: -1.88, volume: 100 },
  { voice: "estelle", locale: "fr", integratedLufs: -25.34, truePeakDbtp: -9.62, volume: 100 },
  { voice: "eve", locale: "en", integratedLufs: -22.24, truePeakDbtp: -2.65, volume: 100 },
  { voice: "george", locale: "en", integratedLufs: -22.39, truePeakDbtp: -2.52, volume: 100 },
  { voice: "giovanni", locale: "it", integratedLufs: -25.56, truePeakDbtp: -2.24, volume: 100 },
  { voice: "jane", locale: "en", integratedLufs: -20.57, truePeakDbtp: -3.39, volume: 100 },
  { voice: "jean", locale: "en", integratedLufs: -21.89, truePeakDbtp: -5.2, volume: 100 },
  { voice: "lola", locale: "es", integratedLufs: -23.75, truePeakDbtp: -6.58, volume: 100 },
  { voice: "mary", locale: "en", integratedLufs: -21.03, truePeakDbtp: -3.19, volume: 100 },
  { voice: "michael", locale: "en", integratedLufs: -22.63, truePeakDbtp: -2.77, volume: 100 },
  { voice: "paul", locale: "en", integratedLufs: -22.04, truePeakDbtp: -1.48, volume: 100 },
  { voice: "rafael", locale: "pt", integratedLufs: -26.41, truePeakDbtp: -6.58, volume: 100 },
  { voice: "vera", locale: "en", integratedLufs: -21.21, truePeakDbtp: -3.85, volume: 100 },
].map((row) => Object.freeze(row)));

/** The measurement behind a voice's level, or null when it has none. */
export function voiceLevelMeasurement(voiceId: string): VoiceLevelMeasurement | null {
  return MEASURED_VOICE_LEVELS.find((row) => row.voice === voiceId) ?? null;
}

/**
 * The `output.volume` a stored body carries for this voice. An unmeasured
 * voice keeps the named native default; it is never given an invented level.
 */
export function voiceOutputVolume(voiceId: string): number {
  return voiceLevelMeasurement(voiceId)?.volume ?? UNMEASURED_VOICE_OUTPUT_VOLUME;
}
