/**
 * Economics evaluators for the verdict core.
 *
 * E1, E2 and E4 judge one call: E1 asks whether the call's own `cost.priced`
 * row measured its cost, E2 judges that row's `totalUsd` against the frozen
 * per-call ceiling, and E4 counts the call's budget stop from the persisted end
 * message. The harness never recomputes a price: a measured row is read
 * verbatim, an unmeasured one fails closed and keeps its named reason.
 *
 * E3 judges a run, not a call. Its three bars are alternative ceilings by run
 * kind, so one call cannot bind them; the run gate (`economics/run-ceiling.ts`)
 * narrows the contract to the plan's ceiling and supplies the run's own total.
 * A per-call attempt is reported unmeasured rather than judged against the
 * wrong ceiling.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Economics" E1-E4.
 */

import type { EvaluatorModule, PropertyEvaluator } from "../types";
import { evaluateRunCost } from "../../economics/run-ceiling";
import { PricedCostError, legBreakdown, readPricedRow } from "../../economics/priced-cost";

function reasonOf(error: unknown): string {
  if (error instanceof PricedCostError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** The row and the rate table that priced it; a verdict cites both. */
function auditOf(cost: { rateTableVersion: string | null; legs: readonly unknown[] }): string[] {
  return [
    "cost:priced",
    ...(cost.rateTableVersion === null ? [] : [`cost:rate-table:${cost.rateTableVersion}`]),
    ...(cost.legs.length === 0 ? ["cost:zero-session"] : []),
  ];
}

const e1: PropertyEvaluator = {
  propertyId: "E1",
  source: "economics.evaluators.ts",
  bars: [],
  evaluate(context) {
    try {
      const cost = readPricedRow(context.source);
      return {
        kind: "measured",
        passed: cost.measured,
        citations: auditOf(cost),
        detail: cost.measured
          ? `cost measured: $${String(cost.totalUsd)} from ${cost.rateTableVersion}` +
            (cost.source === null ? "" : `; ${cost.source}`)
          : `cost unmeasured: ${cost.unmeasuredReason ?? "no reason recorded"}`,
      };
    } catch (error) {
      return {
        kind: "unmeasured",
        reason: `the call's priced row cannot be read: ${reasonOf(error)}`,
        citations: [],
      };
    }
  },
};

const e2: PropertyEvaluator = {
  propertyId: "E2",
  source: "economics.evaluators.ts",
  bars: [{ key: "dvCostPerCallMaxUsd", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const cost = readPricedRow(context.source);
      if (!cost.measured || cost.totalUsd === null) {
        return {
          kind: "unmeasured",
          reason:
            `the call's cost is unmeasured, so no per-call ceiling can be judged: ` +
            `${cost.unmeasuredReason ?? "no reason recorded"} ` +
            `[${legBreakdown(cost)}]`,
          citations: auditOf(cost),
        };
      }
      return {
        kind: "measured",
        samples: [cost.totalUsd],
        citations: auditOf(cost),
        detail:
          `the call priced $${cost.totalUsd.toFixed(6)} from ${cost.rateTableVersion} ` +
          `[${legBreakdown(cost)}]`,
      };
    } catch (error) {
      return {
        kind: "unmeasured",
        reason: `the call's priced row cannot be read: ${reasonOf(error)}`,
        citations: [],
      };
    }
  },
};

const e3: PropertyEvaluator = {
  propertyId: "E3",
  source: "economics.evaluators.ts",
  bars: [
    { key: "dvCostFastRunMaxUsd", statistic: "each", comparison: "at-most" },
    { key: "dvCostNightlyRunMaxUsd", statistic: "each", comparison: "at-most" },
    { key: "dvCostFullRunMaxUsd", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    return evaluateRunCost(context.source);
  },
};

function budgetStopOf(ledger: Record<string, unknown>): {
  stopped: boolean;
  reason: string;
} {
  const end = ledger.end;
  const record =
    typeof end === "object" && end !== null && !Array.isArray(end)
      ? (end as Record<string, unknown>)
      : null;
  const budget = record?.budget;
  if (typeof budget === "object" && budget !== null && !Array.isArray(budget)) {
    const stop = budget as Record<string, unknown>;
    const reason =
      typeof stop.reason === "string" && stop.reason.trim() !== ""
        ? stop.reason.trim()
        : "a budget stop was recorded without its reason";
    return { stopped: true, reason };
  }
  if (record?.endedBy === "budget") {
    return {
      stopped: true,
      reason:
        "the end message says the call ended on its ceiling but carries no stop facts; " +
        "E4 counts it as a stop rather than trusting a missing record",
    };
  }
  const turns = Array.isArray(ledger.turns) ? ledger.turns : [];
  const row = turns.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).type === "budget.stopped",
  ) as Record<string, unknown> | undefined;
  if (row !== undefined) {
    return {
      stopped: true,
      reason:
        typeof row.reason === "string" && row.reason.trim() !== ""
          ? row.reason.trim()
          : "a budget.stopped row was recorded without its reason",
    };
  }
  return { stopped: false, reason: "" };
}

const e4: PropertyEvaluator = {
  propertyId: "E4",
  source: "economics.evaluators.ts",
  bars: [{ key: "dvBudgetStopMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    const source = context.source;
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      return {
        kind: "unmeasured",
        reason: "the ledger evidence is not an object, so no budget stop can be counted",
        citations: [],
      };
    }
    const ledger = source as Record<string, unknown>;
    const end = ledger.end;
    if (end === null || end === undefined) {
      return {
        kind: "unmeasured",
        reason:
          "the ledger carries no persisted end message; whether the call hit its ceiling " +
          "cannot be known, so E4 fails closed",
        citations: [],
      };
    }
    const stop = budgetStopOf(ledger);
    return {
      kind: "measured",
      samples: [stop.stopped ? 1 : 0],
      citations: stop.stopped ? ["ledger:end", "ledger:budget.stopped"] : ["ledger:end"],
      detail: stop.stopped
        ? `the call hit a budget stop: ${stop.reason}`
        : "the call ended with no budget stop",
    };
  },
};

const economics: EvaluatorModule = {
  family: "economics",
  evaluators: [e1, e2, e3, e4],
};

export default economics;
