/**
 * The run's measured cost, as a bound rather than an invented total.
 *
 * A call's priced row is the only money evidence. When every leg is measured
 * its `totalUsd` is copied verbatim. When a designed turn cut stops the vendor
 * before it reports a usage chunk, the row keeps that leg `measured: false`;
 * the certificate sums the legs the vendors did report and names the unpriced
 * leg with the row's own source text. It never prices the missing tokens and
 * never writes a zero for them.
 *
 * Only a cancellation may explain a gap. A leg unpriced for any other reason
 * refuses the bound by name, so no unmeasured leg can hide behind "cut".
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Economics" E1-E4 and "Ground
 * truth comes first"; docs/agents/demo-verification.md records the bound.
 */

import type { ScenarioAttempt } from "../verdict";
import { PricedCostError, readPricedRow, type PricedCost } from "./priced-cost";
import type { RunCostRow } from "./run-ceiling";

export const COST_BOUND_ERROR_CODES = [
  "missing-priced-row",
  "malformed-cost",
  "unexplained-unpriced-leg",
  "no-priced-row",
] as const;

export type CostBoundErrorCode = (typeof COST_BOUND_ERROR_CODES)[number];

export class CostBoundError extends Error {
  readonly code: CostBoundErrorCode;

  constructor(code: CostBoundErrorCode, message: string) {
    super(message);
    this.name = "CostBoundError";
    this.code = code;
  }
}

/** One leg no priced row could price: the certificate names it, never zeros it. */
export type CostBoundUnpricedLeg = {
  readonly callId: string;
  readonly leg: string;
  readonly unit: string;
  /** The priced row's own words for the missing unit. */
  readonly source: string;
};

/** The run's measured lower bound and the legs it could not price. */
export type CostBound = {
  readonly usdMeasured: number;
  /** True only when every priced leg was measured. */
  readonly complete: boolean;
  readonly callCount: number;
  readonly unpriced: readonly CostBoundUnpricedLeg[];
};

/**
 * The sentence a cancelled turn leaves in the vendor's usage meter. A cut stops
 * the stream before its usage chunk, so the pipeline records the turn as
 * unmeasured with this source; no other absence is treated as a cut.
 */
const CUT_USAGE_GAP = /no usage chunk was recorded for this turn/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const id = value.callId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

function rowsOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function hasCutRow(rows: unknown): boolean {
  const list = rowsOf(rows);
  return (
    list !== null &&
    list.some((row) => isRecord(row) && row.type === "turn.cut")
  );
}

/**
 * True only when the call's own ledger or trace records a `turn.cut`. The
 * cost row alone is not evidence of a cancellation.
 */
export function evidenceHasCut(evidence: unknown): boolean {
  if (!isRecord(evidence)) return false;
  const ledger = evidence.ledger;
  if (isRecord(ledger) && hasCutRow(ledger.turns)) return true;
  const trace = evidence.trace;
  if (isRecord(trace) && hasCutRow(trace.rows)) return true;
  return false;
}

/** The call id the evidence itself names, from whichever artifact carries it. */
export function evidenceCallId(evidence: unknown): string | null {
  if (!isRecord(evidence)) return null;
  for (const key of ["cost", "trace", "ledger"] as const) {
    const source = evidence[key];
    const direct = callIdOf(source);
    if (direct !== null) return direct;
    if (!isRecord(source)) continue;
    const end = callIdOf(source.end);
    if (end !== null) return end;
    for (const rowsKey of ["rows", "turns"] as const) {
      const rows = rowsOf(source[rowsKey]);
      if (rows === null) continue;
      for (const row of rows) {
        const id = callIdOf(row);
        if (id !== null) return id;
      }
    }
  }
  return null;
}

/** Every call whose evidence records a cut; a gap needs one of these to be named. */
export function cutCallIdsFromAttempts(
  attempts: readonly ScenarioAttempt[],
): Set<string> {
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (!evidenceHasCut(attempt.evidence)) continue;
    const callId = evidenceCallId(attempt.evidence);
    if (callId !== null) ids.add(callId);
  }
  return ids;
}

function malformed(call: RunCostRow, error: unknown): CostBoundError {
  const detail =
    error instanceof PricedCostError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return new CostBoundError(
    "malformed-cost",
    `${call.callId} (${call.scenario}) does not carry a readable priced row: ${detail}`,
  );
}

/**
 * Sum the calls' own priced rows and legs. A cut-attributed unpriced leg is
 * named and left out of the sum; any other unpriced leg refuses the bound.
 */
export function boundPricedCost(input: {
  readonly calls: readonly RunCostRow[];
  /** Call ids whose evidence records a `turn.cut`. */
  readonly cutCallIds: ReadonlySet<string>;
}): CostBound {
  if (input.calls.length === 0) {
    throw new CostBoundError(
      "missing-priced-row",
      "the run recorded no call, so it carries no priced row to bound",
    );
  }
  const unpriced: CostBoundUnpricedLeg[] = [];
  let micros = 0;
  let pricedRows = 0;
  for (const call of input.calls) {
    if (call.cost === undefined || call.cost === null) {
      throw new CostBoundError(
        "missing-priced-row",
        `${call.callId} (${call.scenario}) has no cost.priced row; a bound cannot count a ` +
          "call that recorded no price",
      );
    }
    let priced: PricedCost;
    try {
      priced = readPricedRow(call.cost);
    } catch (error) {
      throw malformed(call, error);
    }
    if (priced.measured && priced.totalUsd !== null) {
      micros += Math.round(priced.totalUsd * 1_000_000);
      pricedRows += 1;
      continue;
    }
    let rowPriced = false;
    let rowUnpriced = 0;
    for (const leg of priced.legs) {
      if (leg.measured && leg.amountUsd !== null) {
        micros += Math.round(leg.amountUsd * 1_000_000);
        rowPriced = true;
        continue;
      }
      rowUnpriced += 1;
      const source = leg.reasons[0] ?? priced.unmeasuredReason ?? priced.source ?? "";
      if (source.trim() === "") {
        throw new CostBoundError(
          "unexplained-unpriced-leg",
          `${call.callId} (${call.scenario}) ${leg.leg} is unpriced and the row names no reason; ` +
            "an unnamed gap is never counted",
        );
      }
      // A barge-in cancels the agent's LLM turn before its usage chunk. Only
      // that leg, with that source, may be attributed to a recorded cut; an
      // unrelated leg with any other reason still refuses.
      const cutExplained = leg.leg === "llm" && CUT_USAGE_GAP.test(source);
      if (!input.cutCallIds.has(call.callId) || !cutExplained) {
        throw new CostBoundError(
          "unexplained-unpriced-leg",
          `${call.callId} (${call.scenario}) ${leg.leg} (${leg.unit}) is unmeasured but is not a ` +
            `cancelled turn: ${source}. A certificate never hides an unexplained gap behind a cut`,
        );
      }
      unpriced.push({ callId: call.callId, leg: leg.leg, unit: leg.unit, source });
    }
    if (rowUnpriced === 0) {
      throw new CostBoundError(
        "unexplained-unpriced-leg",
        `${call.callId} (${call.scenario}) says its cost is unmeasured but names no unpriced ` +
          "leg; the row contradicts itself",
      );
    }
    if (rowPriced) pricedRows += 1;
  }
  if (pricedRows === 0) {
    throw new CostBoundError(
      "no-priced-row",
      "the run carries no measured priced row; a certificate has no bound to record",
    );
  }
  return {
    usdMeasured: micros / 1_000_000,
    complete: unpriced.length === 0,
    callCount: input.calls.length,
    unpriced,
  };
}
