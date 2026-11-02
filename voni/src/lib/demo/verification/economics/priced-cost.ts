/**
 * The call's priced row, read verbatim.
 *
 * Cost is evidence the pipeline produced: `cascade/cost.py` prices the units
 * the vendors reported and `cascade.call.CostSummary` writes one `cost.priced`
 * row per call. The harness reads that row — its `measured`, `totalUsd`,
 * `rateTableVersion` and leg breakdown — and never multiplies a unit by a rate
 * of its own. A row that says it is unmeasured stays unmeasured: no leg is a
 * zero, no total is a partial sum.
 *
 * The one measured zero with no legs is a call that opened no session: the app
 * refused before any vendor call, so no audio, token or character was spent.
 * That row must total zero and state its reason; an empty leg list never hides
 * a price.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Ground truth comes first".
 */

export const PRICED_COST_ERROR_CODES = ["malformed-cost", "missing-total"] as const;

export type PricedCostErrorCode = (typeof PRICED_COST_ERROR_CODES)[number];

export class PricedCostError extends Error {
  readonly code: PricedCostErrorCode;

  constructor(code: PricedCostErrorCode, message: string) {
    super(message);
    this.name = "PricedCostError";
    this.code = code;
  }
}

/** One leg of the priced row, exactly as the pipeline wrote it. */
export type PricedLeg = {
  readonly leg: string;
  readonly measured: boolean;
  readonly amountUsd: number | null;
  readonly unit: string;
  readonly quantity: number | null;
  /** The vendor's own reported units, validated; an absent map stays empty. */
  readonly units: Readonly<Record<string, number>>;
  /** The vendor's own words for an unmeasured leg; empty when measured. */
  readonly reasons: readonly string[];
};

/** The call's own cost facts. A null total is unmeasured, never a zero. */
export type PricedCost = {
  readonly measured: boolean;
  readonly totalUsd: number | null;
  readonly rateTableVersion: string | null;
  readonly legs: readonly PricedLeg[];
  /** Why the row is a measured zero with no leg; null when legs carried it. */
  readonly source: string | null;
  readonly unmeasuredReason: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PricedCostError("malformed-cost", `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function amountOf(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PricedCostError(
      "malformed-cost",
      `${what} must be a finite, non-negative amount or null, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function unitsOf(name: string, raw: unknown): Readonly<Record<string, number>> {
  if (raw === undefined || raw === null) return {};
  const record = objectOf(raw, `cost leg "${name}".units`);
  const units: Record<string, number> = {};
  for (const [unit, value] of Object.entries(record)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new PricedCostError(
        "malformed-cost",
        `cost leg "${name}".units.${unit} must be a finite, non-negative number, ` +
          `got ${JSON.stringify(value)}`,
      );
    }
    units[unit] = value;
  }
  return units;
}

function legOf(name: string, raw: unknown): PricedLeg {
  const record = objectOf(raw, `cost leg "${name}"`);
  if (typeof record.measured !== "boolean") {
    throw new PricedCostError(
      "malformed-cost",
      `cost leg "${name}" does not say whether it was measured`,
    );
  }
  const measured = record.measured;
  const amount = amountOf(record.amountUsd, `cost leg "${name}".amountUsd`);
  if (measured && amount === null) {
    throw new PricedCostError(
      "malformed-cost",
      `cost leg "${name}" claims to be measured but carries no priced amount; ` +
        "an unmeasured leg must say so instead",
    );
  }
  if (!measured && amount !== null) {
    throw new PricedCostError(
      "malformed-cost",
      `cost leg "${name}" is unmeasured but carries an amount; a partial price is not a cost`,
    );
  }
  const quantity = record.quantity;
  if (
    quantity !== null &&
    quantity !== undefined &&
    (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0)
  ) {
    throw new PricedCostError(
      "malformed-cost",
      `cost leg "${name}".quantity must be a finite, non-negative number or null`,
    );
  }
  const source = text(record.source);
  return {
    leg: name,
    measured,
    amountUsd: amount,
    unit: text(record.unit) || "unknown",
    quantity: typeof quantity === "number" ? quantity : null,
    units: unitsOf(name, record.units),
    reasons: source === "" ? [] : [source],
  };
}

/**
 * Read one `cost.priced` row. A measured row must cite the rate table that
 * priced it and carry a finite non-negative total; an unmeasured row must keep
 * `totalUsd: null` and name why.
 */
export function readPricedRow(row: unknown): PricedCost {
  const record = objectOf(row, "the priced cost row");
  if (typeof record.measured !== "boolean") {
    throw new PricedCostError(
      "malformed-cost",
      "the priced cost row does not say whether it was measured",
    );
  }
  const measured = record.measured;
  const rateTableVersion = text(record.rateTableVersion);
  const totalUsd = amountOf(record.totalUsd, "the priced cost row's totalUsd");

  if (measured && rateTableVersion === "") {
    throw new PricedCostError(
      "malformed-cost",
      "a measured cost row must cite the rate table that priced it",
    );
  }
  if (measured && totalUsd === null) {
    throw new PricedCostError(
      "missing-total",
      "a measured cost row carries no total; a total is never inferred from legs",
    );
  }
  if (!measured && totalUsd !== null) {
    throw new PricedCostError(
      "malformed-cost",
      "an unmeasured cost row carries a total; a zero would claim a price the table never gave",
    );
  }

  const legsRecord = objectOf(record.legs, "the priced cost row's legs");
  const legs = Object.entries(legsRecord).map(([name, raw]) => legOf(name, raw));
  const source = text(record.source);
  if (legs.length === 0) {
    // A call that opened no session has no audio, token or character to price.
    // That is a measured zero, but only when the row prices zero and says why;
    // an empty leg list is never a place to hide a nonzero total.
    if (!measured) {
      throw new PricedCostError(
        "malformed-cost",
        "an unmeasured cost row names no legs; without a leg there is nothing to explain",
      );
    }
    if (totalUsd !== 0) {
      throw new PricedCostError(
        "malformed-cost",
        "a cost row with no legs must total zero; a price without a priced leg is invented",
      );
    }
    if (source === "") {
      throw new PricedCostError(
        "malformed-cost",
        "a zero-leg cost row must state why no session opened; a zero without its reason is a stand-in",
      );
    }
  }

  const unmeasuredReason = text(record.unmeasuredReason);
  return {
    measured,
    totalUsd,
    rateTableVersion: rateTableVersion === "" ? null : rateTableVersion,
    legs,
    source: source === "" ? null : source,
    unmeasuredReason: measured ? null : unmeasuredReason || "the cost claim is incomplete",
  };
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** `stt $0.003100; llm $0.027000; tts unmeasured (reason)` — never a bare total. */
export function legBreakdown(cost: PricedCost): string {
  if (cost.legs.length === 0) {
    return `zero usage (${cost.source ?? "no source recorded"})`;
  }
  return cost.legs
    .map((leg) =>
      leg.measured && leg.amountUsd !== null
        ? `${leg.leg} ${usd(leg.amountUsd)}`
        : `${leg.leg} unmeasured (${leg.reasons[0] ?? "no source recorded"})`,
    )
    .join("; ");
}
