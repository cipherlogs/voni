/**
 * One place for the ledger's sums and USD comparison.
 *
 * The priced row is the only source of money: `sumMeasuredLegs` adds the rows'
 * own `amountUsd` and skips an unmeasured leg instead of treating it as zero.
 * `sameUsd` is the one reconciliation tolerance (six decimals, the precision a
 * certificate records); a row total, a certificate aggregate and the ledger
 * total are all compared the same way, so a 1e-9 check cannot disagree with a
 * 1e-6 one.
 */

import type { PricedLeg } from "@/lib/demo/verification/economics";

import type { UsageCall } from "./types";

/** The precision a certificate records and every reconciliation uses. */
export const USD_RECONCILE_DECIMALS = 6;

export function roundUsd(amount: number, decimals = USD_RECONCILE_DECIMALS): number {
  const scale = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * scale) / scale;
}

/** True when two amounts agree at the certificate's six-decimal precision. */
export function sameUsd(left: number, right: number): boolean {
  return roundUsd(left) === roundUsd(right);
}

/** The measured money in a row's legs; an unmeasured leg contributes nothing. */
export function sumMeasuredLegs(legs: readonly PricedLeg[]): number {
  return legs.reduce((sum, leg) => sum + (leg.measured ? (leg.amountUsd ?? 0) : 0), 0);
}

/** The measured money in a run's calls, using the same leg rule. */
export function sumMeasuredCalls(calls: readonly UsageCall[]): number {
  return calls.reduce((sum, call) => sum + sumMeasuredLegs(call.priced.legs), 0);
}

/** Numeric version order: v9 before v10, never lexicographic. */
export function sortRateVersions(versions: Iterable<string>): string[] {
  const number = (id: string): number => {
    const match = / v(\d+)$/.exec(id);
    return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
  };
  return [...new Set(versions)].sort((a, b) => {
    const byNumber = number(a) - number(b);
    return byNumber === 0 ? a.localeCompare(b) : byNumber;
  });
}

/** `cascade-vendor-rates v1` → `v1`; a label for a mixed-version line. */
export function shortRateVersion(id: string): string {
  const match = / v(\d+)$/.exec(id);
  return match === null ? id : `v${match[1]}`;
}
