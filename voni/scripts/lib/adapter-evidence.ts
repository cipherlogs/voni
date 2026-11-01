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

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolLogRow } from "@/lib/demo/tool-log";
import type { CallEligibilityFact } from "@/lib/demo/verification/verdict";
import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";

/** The repository root, resolved from this module (`voni/scripts/lib/`). */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The pipeline's per-call trace directory.
 *
 * Both adapters must resolve it the same way: the service writes
 * `<repo>/voice-pipeline/.events` (its own `DEFAULT_EVENTS_DIR`), so a reader
 * that looks under `voni/voice-pipeline/.events` finds no trace at all. That
 * is not a short run — it is a refusal, and it names this path.
 */
export function defaultEventsDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.VOICE_PIPELINE_EVENTS_DIR?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return join(REPO_ROOT, "voice-pipeline", ".events");
}

/** The adapter's own error type, so a refusal keeps its family's code. */
export type AdapterErrorFactory = (code: string, message: string) => Error;

/** A run id and call id become directory names; anything else is refused. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function requireSafeId(value: string, what: string, error: AdapterErrorFactory): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw error(
      "run-dir-invalid",
      `${what} "${value}" is not a safe directory name; use letters, digits, dot, dash or underscore`,
    );
  }
  return value;
}

export function runDirectory(
  runRoot: string,
  runId: string,
  error: AdapterErrorFactory,
): string {
  return resolve(runRoot, requireSafeId(runId, "run id", error));
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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

/** One trimmed non-empty string field; a missing or blank value is null. */
function stringField(row: Record<string, unknown>, field: string): string | null {
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

/** The tool log and inbox delivery an adapter collected after the call. */
export type ToolEvidenceCollection = {
  readonly log: readonly ToolLogRow[];
  readonly delivery: InboxDelivery | null;
  readonly gap: string | null;
};

/** The tool block both adapters put in a bundle, with its named absence. */
export type ToolBundle = {
  readonly calls: readonly Record<string, unknown>[];
  readonly results: readonly Record<string, unknown>[];
  readonly log?: readonly ToolLogRow[];
  readonly delivery?: InboxDelivery;
  readonly gap?: string;
};

/**
 * The tool rows, the demo tool log and the real inbox delivery, in one place.
 * Both adapters read the same three facts and must present them the same way;
 * a gap is appended to the caller's gaps so it can never be silently dropped.
 */
export function toolBundle(
  rows: readonly Record<string, unknown>[],
  evidence: ToolEvidenceCollection | undefined,
  gaps: string[],
): ToolBundle {
  const gap = evidence?.gap ?? null;
  if (gap !== null) gaps.push(gap);
  return {
    calls: rows.filter((row) => row.type === "turn.tool_call"),
    results: rows.filter((row) => row.type === "turn.tool_result"),
    ...(evidence === undefined || evidence.log.length === 0 ? {} : { log: evidence.log }),
    ...(evidence === undefined || evidence.delivery === null
      ? {}
      : { delivery: evidence.delivery }),
    ...(gap === null ? {} : { gap }),
  };
}

/**
 * The call's own priced row, copied verbatim — the harness never recomputes a
 * price. A trace with no priced row records that as a named gap, never a zero.
 */
export function pricedRow(
  rows: readonly Record<string, unknown>[],
  gaps: string[],
): Record<string, unknown> | null {
  const priced = firstRow(rows, "cost.priced");
  if (priced === null) {
    gaps.push("the trace carries no cost.priced row; cost is never recomputed by the runner");
  }
  return priced;
}
