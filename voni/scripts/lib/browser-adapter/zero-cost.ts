/**
 * The zero-cost row for a call that opened no session.
 *
 * A mic-denied call can be refused by the app before any vendor call: no audio
 * was streamed, no token was spent and no character was synthesized. That is a
 * measured fact, not an estimate, so the call's `cost.priced` row totals zero
 * with zero legs. It still cites the committed rate table that would have
 * priced the call (read from `voice-pipeline/cascade/rates/v1.json`, the same
 * record `cascade.cost` loads) and states exactly why no leg ran. A real call's
 * row is never reused and a missing price is never filled with a nonzero value.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Ground truth comes first".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrowserAdapterError } from "./errors";

/** The reason a zero-leg row is a fact and not an estimate. */
export const NO_SESSION_COST_SOURCE =
  "no session opened (the app refused before any vendor call)";

/** The committed default table; `cascade.cost.DEFAULT_VERSION` points here. */
const RATE_TABLE_PATH = fileURLToPath(
  new URL("../../../../voice-pipeline/cascade/rates/v1.json", import.meta.url),
);

/** The table name and version, read from the one committed record. */
export function readCommittedRateTableVersion(): string {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(RATE_TABLE_PATH, "utf8"));
  } catch (error) {
    throw new BrowserAdapterError(
      "cost-missing",
      `cannot read the committed rate table at ${RATE_TABLE_PATH}: ${(error as Error).message}`,
    );
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new BrowserAdapterError(
      "cost-missing",
      `the committed rate table at ${RATE_TABLE_PATH} is not an object`,
    );
  }
  const record = document as Record<string, unknown>;
  const name = record.name;
  const version = record.version;
  if (typeof name !== "string" || name.trim() === "") {
    throw new BrowserAdapterError(
      "cost-missing",
      `the committed rate table at ${RATE_TABLE_PATH} names no table`,
    );
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new BrowserAdapterError(
      "cost-missing",
      `the committed rate table at ${RATE_TABLE_PATH} states no integer version`,
    );
  }
  return `${name.trim()} v${version}`;
}

/**
 * One measured `cost.priced` row for a call that never opened a session.
 *
 * No leg exists because no vendor was asked anything; the row states that
 * fact at its own level. `readPricedRow` accepts it only as a measured zero
 * with this source.
 */
export function zeroSessionCostRow(): Record<string, unknown> {
  return {
    type: "cost.priced",
    producer: "demo.verification.browser-adapter",
    measured: true,
    rateTableVersion: readCommittedRateTableVersion(),
    totalUsd: 0,
    legs: {},
    source: NO_SESSION_COST_SOURCE,
  };
}
