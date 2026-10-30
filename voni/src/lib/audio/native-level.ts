/**
 * Native level: the cascade has no gain stage (W1 ticket 127).
 *
 * Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point" — the cascade carries
 * no `output.volume`, no client gain and no limiter. Each voice's native level
 * is its target, so a delivered level difference names a pipeline or client
 * defect rather than a tuning knob. The managed path keeps `output.volume`
 * until it retires.
 *
 * This module is the one place the rule is written down, so the W0 instrument
 * and the re-audition pack read the same vocabulary:
 *
 * - {@link NATIVE_GAIN_STAGE} is the only stage a cascade render may declare;
 *   {@link assertNativeLevel} refuses any other stage by name, so a comparison
 *   whose `gainStage` says `normalised` cannot pass as native.
 * - {@link MANAGED_LEVEL_KEY} names the managed path's level (the stored body's
 *   `output.volume`). It is managed-only: {@link assertNoLevelStage} refuses it
 *   and every other level knob on a cascade request before a sample is read.
 * - {@link levelDefect} attributes a delivered level difference over the frozen
 *   `comparisonLevelLu` bar: a difference that survives the client-signature
 *   mask is `our pipeline`; one the mask removes was playback, so it is the
 *   `client`. Within the bar is no defect; an unmeasured level is not a zero.
 *
 * A level change is a new native render or a new voice decision. There is no
 * client stage to reach for: this module deliberately exposes no function that
 * applies a gain, because the absence of that function is the contract.
 */
import {
  SCOREBOARD_BUDGETS,
  type BudgetKey,
  type BudgetUnit,
} from "../demo/scoreboard-budgets";
import type { TwoCaptureComparison } from "./comparison";

/** The one stage a cascade render may declare: the synthesis bytes verbatim. */
export const NATIVE_GAIN_STAGE = "none";

/** The managed path's level, on the stored agent body. Managed-only. */
export const MANAGED_LEVEL_KEY = "output.volume";

/**
 * Keys that express a level stage if they appear on a cascade request or
 * output mapping. Covers the vendor's usual spellings so a smuggled knob is
 * named rather than dropped silently.
 */
export const LEVEL_STAGE_KEYS = [
  "volume",
  "output_volume",
  "gain",
  "gain_db",
  "makeup_gain",
  "limiter",
  "limiter_db",
  "normalisation",
  "normalization",
  "normalise",
  "normalize",
  "loudness",
  "agc",
] as const;

export type LevelStageKey = (typeof LEVEL_STAGE_KEYS)[number];

export type GainStageErrorCode = "gain-stage";

/** A level stage tried to enter the cascade, and is named. */
export class GainStageError extends Error {
  constructor(
    readonly code: GainStageErrorCode,
    readonly stage: string,
    readonly where: string,
  ) {
    super(
      `${where} carries a level stage "${stage}": the cascade has no output.volume, ` +
        "no gain, no limiter and no normalisation; a level change is a new native " +
        "render or a new voice decision, never a gain stage",
    );
    this.name = "GainStageError";
  }
}

/** Return `stage` when it is native; refuse any other stage by name. */
export function assertNativeLevel(stage: string, where = "render"): string {
  if (stage !== NATIVE_GAIN_STAGE) {
    throw new GainStageError("gain-stage", stage, where);
  }
  return stage;
}

/** Every level-stage key `parameters` carries, sorted and named. */
export function levelStageKeys(parameters: Record<string, unknown>): string[] {
  return Object.keys(parameters)
    .filter((key) => (LEVEL_STAGE_KEYS as readonly string[]).includes(key))
    .sort();
}

/**
 * Refuse a request/output mapping carrying any level-stage key, by name. Every
 * key is named, not just the first, so one run shows the whole set.
 */
export function assertNoLevelStage(parameters: Record<string, unknown>, where: string): void {
  const names = levelStageKeys(parameters);
  if (names.length > 0) {
    throw new GainStageError("gain-stage", names.join(", "), where);
  }
}

/** The frozen level bar, read from the one budget table. */
export type LevelBar = { key: BudgetKey; value: number; unit: BudgetUnit };

export type LevelDefect = {
  /** The causal layer the difference belongs to. */
  layer: "our pipeline" | "client";
  /** Delivered minus reference, in LU. */
  deltaLu: number;
  /** The frozen bar the difference crossed. */
  bar: LevelBar;
  /** One sentence naming the measurement, the bar and the layer. */
  detail: string;
};

function levelBar(): LevelBar {
  return {
    key: "comparisonLevelLu",
    value: SCOREBOARD_BUDGETS.comparisonLevelLu.value,
    unit: SCOREBOARD_BUDGETS.comparisonLevelLu.unit,
  };
}

/**
 * The unmasked integrated-level delta from the table's `integrated` row, or
 * `null` when either cell is unmeasured.
 */
function tableLevelDelta(comparison: TwoCaptureComparison): number | null {
  const row = comparison.rows.find((candidate) => candidate.id === "integrated");
  if (!row) return null;
  const reference = row.cells.reference;
  const delivered = row.cells.delivered;
  if (reference.kind !== "value" || delivered.kind !== "value") return null;
  return delivered.value - reference.value;
}

/**
 * Attribute a delivered level difference, or name why there is none.
 *
 * The pipeline audit measures the pair with the client-owned windows masked
 * out. A difference that survives that mask is server-side (`our pipeline`); a
 * difference only the unmasked table sees was playback the mask removed, so it
 * is the `client`. A comparison that declares any stage but native is refused
 * before its numbers are read, and an unmeasured level is `null` — never zero
 * and never agreement.
 */
export function levelDefect(comparison: TwoCaptureComparison): LevelDefect | null {
  assertNativeLevel(comparison.gainStage, "level leg");
  const bar = levelBar();
  const masked = comparison.pipeline.level;
  if (!masked.measured) return null;

  const delta = masked.value.deltaLu;
  if (Math.abs(delta) > bar.value) {
    return {
      layer: "our pipeline",
      deltaLu: delta,
      bar,
      detail:
        `the delivered level is ${Math.abs(delta).toFixed(2)} LU ` +
        `${delta < 0 ? "below" : "above"} the reference, over the ${bar.value} LU bar; ` +
        "the client-owned windows are masked out, so this is a server-side level change",
    };
  }

  const tableDelta = tableLevelDelta(comparison);
  if (tableDelta !== null && Math.abs(tableDelta) > bar.value) {
    return {
      layer: "client",
      deltaLu: tableDelta,
      bar,
      detail:
        `the delivered table reads ${Math.abs(tableDelta).toFixed(2)} LU ` +
        `${tableDelta < 0 ? "below" : "above"} the reference, but the difference is inside ` +
        `the client-owned windows that are masked out of the pipeline audit; it is a client ` +
        "playback stage, not a server gain",
    };
  }

  return null;
}

/**
 * The bar the level leg enforces, for a report that must print the source
 * rather than a restated number.
 */
export function comparisonLevelBar(): LevelBar {
  return levelBar();
}
