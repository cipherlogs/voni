/**
 * The trace facts both adapters read, in one place.
 *
 * The browser adapter certifies and the protocol adapter diagnoses, but they
 * read the same service trace and must agree on what it means. Four helpers
 * were duplicated byte-for-byte before this module: the JSONL parser, the turn
 * id list, the first-row-of-type lookup, and — the one that matters — the
 * eligibility rule. `provider_fallback` and a budget stop are the anti-lie
 * rule: a call carrying either can never certify. Duplicating it meant one
 * adapter could be fixed and the other left lying. It is single-sourced here.
 *
 * The parser takes the caller's error factory so each adapter keeps its own
 * named error type; the parse rule itself is shared.
 */

import type { CallEligibilityFact } from "@/lib/demo/verification/verdict";

/** The adapter's own error type, so a refusal keeps its family's code. */
export type AdapterErrorFactory = (code: string, message: string) => Error;

/** Parse one JSONL trace; a malformed line is a named refusal, never skipped. */
export function parseTrace(
  text: string,
  file: string,
  error: AdapterErrorFactory,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (cause) {
      throw error(
        "trace-malformed",
        `${file} line ${index + 1} is not JSON: ${(cause as Error).message}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw error("trace-malformed", `${file} line ${index + 1} is not a JSON object`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

export function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Rows that belong to a turn, in trace order. */
export function turnRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.filter((row) => stringField(row, "turn") !== null);
}

/** Each turn id once, in the order the trace first names it. */
export function turnIds(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const turn = stringField(row, "turn");
    if (turn !== null && !seen.has(turn)) {
      seen.add(turn);
      ids.push(turn);
    }
  }
  return ids;
}

export function firstRow(
  rows: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> | null {
  return rows.find((row) => row.type === type) ?? null;
}

export type EligibilityInput = {
  readonly callId: string;
  readonly scenario: string;
  /** The persisted end document; the protocol adapter may not have one. */
  readonly end: Record<string, unknown> | null;
  readonly rows: readonly Record<string, unknown>[];
};

/**
 * The anti-lie rule, in one place: a provider fallback or a budget stop makes
 * the call ineligible. The fact names where it happened, so the certificate
 * and the defect cards can cite it; it never reports a fallback as a pass.
 */
export function eligibilityOf(input: EligibilityInput): CallEligibilityFact {
  const fallback = firstRow(input.rows, "provider_fallback");
  const budgetRow = firstRow(input.rows, "budget.stopped");
  const budget = input.end?.budget;
  const budgetRecord =
    budget !== null && typeof budget === "object" && !Array.isArray(budget)
      ? (budget as Record<string, unknown>)
      : null;
  const budgetStop =
    budgetRecord !== null
      ? String(budgetRecord.reasons ?? budgetRecord.reason ?? "budget ceiling")
      : budgetRow !== null
        ? String(budgetRow.reason ?? budgetRow.spend ?? "budget.stopped")
        : input.end?.endedBy === "budget"
          ? "budget ceiling"
          : null;
  const providerFallback =
    fallback !== null
      ? `${String(fallback.leg ?? "vendor")} at ${String(fallback.phase ?? "turn")}`
      : null;
  return {
    callId: input.callId,
    scenario: input.scenario,
    providerFallback,
    budgetStop,
  };
}
