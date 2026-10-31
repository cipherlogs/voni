/**
 * The judge record the conduct evaluators read.
 *
 * Conduct properties C3, C4, C6, C9 and C10 are judged from a machine judge's
 * per-property findings: the transcript-grounded record ticket 26 produces.
 * A finding carries the property id, a pass/fail verdict, the citations the
 * card needs, and the narrow counts this family judges. A missing finding is
 * `unmeasured` — an independent judge never turns into a self-assessment.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Conduct" C1–C10 and "Judging".
 */

import { TurnConductError } from "./errors";

export type ConductFinding = {
  readonly propertyId: string;
  readonly passed: boolean;
  readonly citations: readonly string[];
  readonly clarificationCount: number | null;
  readonly invented: readonly string[];
  readonly hangUps: number | null;
  readonly boundaries: number | null;
  readonly toolNarrations: readonly string[];
  readonly undoneClaims: readonly string[];
  readonly honest: boolean | null;
  readonly brief: boolean | null;
  readonly handoffRequested: boolean | null;
  readonly ignored: boolean | null;
};

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TurnConductError("malformed-evidence", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim() !== "") return [item.trim()];
    if (typeof item === "object" && item !== null) {
      const quoted = (item as Record<string, unknown>).quoted;
      if (typeof quoted === "string" && quoted.trim() !== "") return [quoted.trim()];
    }
    return [];
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Read a judge record's findings. The record may carry a calibration block
 * beside them; only `findings` is a call's judgement.
 */
export function readFindings(source: unknown, what: string): ConductFinding[] {
  const outer = recordOf(source, what);
  if (!Array.isArray(outer.findings)) {
    throw new TurnConductError(
      "missing-evidence",
      `${what} carries no property findings; a judge calibration record cannot judge a call`,
    );
  }
  return outer.findings.map((raw, index) => {
    const finding = recordOf(raw, `${what}.findings[${index}]`);
    if (typeof finding.propertyId !== "string" || finding.propertyId.trim() === "") {
      throw new TurnConductError(
        "malformed-evidence",
        `${what}.findings[${index}] names no property`,
      );
    }
    if (typeof finding.passed !== "boolean") {
      throw new TurnConductError(
        "malformed-evidence",
        `${what}.findings[${index}] (${finding.propertyId}) carries no boolean passed`,
      );
    }
    return {
      propertyId: finding.propertyId.trim(),
      passed: finding.passed,
      citations: stringsOf(finding.citations),
      clarificationCount: numberOrNull(finding.clarificationCount),
      invented: stringsOf(finding.invented),
      hangUps: numberOrNull(finding.hangUps),
      boundaries: numberOrNull(finding.boundaries),
      toolNarrations: stringsOf(finding.toolNarrations),
      undoneClaims: stringsOf(finding.undoneClaims),
      honest: booleanOrNull(finding.honest),
      brief: booleanOrNull(finding.brief),
      handoffRequested: booleanOrNull(finding.handoffRequested),
      ignored: booleanOrNull(finding.ignored),
    };
  });
}

/** The one finding for a property; a judge that did not judge it cannot pass it. */
export function findingOf(findings: readonly ConductFinding[], propertyId: string): ConductFinding {
  const finding = findings.find((entry) => entry.propertyId === propertyId);
  if (finding === undefined) {
    throw new TurnConductError(
      "missing-evidence",
      `the judge evidence carries no finding for ${propertyId}; the property is unmeasured`,
    );
  }
  return finding;
}
