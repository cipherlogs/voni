/**
 * The one threshold resolver every evaluator family shares.
 *
 * A bar comes from the contract's frozen record and nowhere else. A missing,
 * non-numeric or non-finite threshold is an error by name: an evaluator must
 * never substitute a default (the old lifecycle copy fell back to 300 ms) or
 * read it as "no bar" (which read as a pass). The evaluator's own `catch`
 * turns the error into `unmeasured`, which the verdict fails closed.
 */

import type { ContractPropertyEntry } from "../../contract";

export type ThresholdContext = {
  readonly property: Pick<ContractPropertyEntry, "id" | "thresholds">;
};

export function threshold(context: ThresholdContext, key: string): number {
  const found = context.property.thresholds.find((entry) => entry.key === key);
  if (
    found === undefined ||
    typeof found.value !== "number" ||
    !Number.isFinite(found.value)
  ) {
    throw new Error(
      `the contract resolved no numeric "${key}" for property "${context.property.id}"; ` +
        "a bar must come from the frozen threshold record, never a default",
    );
  }
  return found.value;
}
