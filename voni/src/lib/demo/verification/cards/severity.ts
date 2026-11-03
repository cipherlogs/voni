/**
 * Severity, derived from the property's family.
 *
 * The spec names severity as a card field without defining a scale. This module
 * fixes one three-level scale so a card's severity is repeatable and cannot be
 * chosen per defect:
 *
 * - `critical` — a failure can mislead, harm or break the visitor's call:
 *   lifecycle, conduct, tools, resilience and security.
 * - `major` — the call works but misses the bar: turn-taking, comprehension,
 *   audio and economics.
 * - `minor` — a human-taste or proxy measurement: human.
 *
 * An unknown family is refused by name; it never defaults to `minor`.
 */

import type { FamilyId } from "../contract";

import { DefectCardError } from "./errors";
import type { Severity } from "./types";

const SEVERITY_BY_FAMILY: Readonly<Record<FamilyId, Severity>> = {
  lifecycle: "critical",
  "turn-taking": "major",
  conduct: "critical",
  comprehension: "major",
  tools: "critical",
  audio: "major",
  resilience: "critical",
  security: "critical",
  economics: "major",
  human: "minor",
};

/** The one severity ladder, lowest number first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  major: 1,
  minor: 2,
};

export function severityFor(family: FamilyId): Severity {
  const severity = SEVERITY_BY_FAMILY[family];
  if (severity === undefined) {
    throw new DefectCardError(
      "unknown-family",
      `family "${String(family)}" has no severity; a card is never defaulted to minor`,
    );
  }
  return severity;
}
