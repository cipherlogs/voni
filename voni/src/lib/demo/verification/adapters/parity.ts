/**
 * Adapter parity: one scenario run through both adapters must reach the same
 * verdict on the properties that do not depend on wall-clock timing.
 *
 * The browser adapter certifies; the protocol adapter diagnoses. The protocol
 * adapter is allowed to be faster, so timing and behaviour properties are not
 * compared. It is never allowed to be more permissive: a property that passes
 * on the protocol adapter while the browser adapter fails it is a named
 * disagreement, not a second opinion.
 *
 * The comparison reads only the verdict core's public result. It never reads an
 * adapter's internals, a run directory or a private measurement — two adapters
 * agree when the contract says they agree.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters" and
 * "Testing decisions" (parity between adapters on deterministic scenarios; no
 * mocks on the golden path).
 */

import type {
  PropertyStatus,
  PropertyVerdictReason,
  RunVerdict,
  RunVerdictValue,
} from "../verdict";

/** The two adapters the seam has. There is no third. */
export const ADAPTER_KINDS = ["browser", "protocol"] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** One adapter's public result, narrowed to what parity may read. */
export type AdapterVerdictSnapshot = {
  readonly adapter: AdapterKind;
  readonly runId: string;
  readonly scenario: string;
  readonly verdict: RunVerdictValue;
  /** The contract properties this run judged, in contract order. */
  readonly properties: readonly AdapterPropertySnapshot[];
};

export type AdapterPropertySnapshot = {
  readonly propertyId: string;
  /** `deterministic` properties are compared; timing and behaviour are not. */
  readonly kind: string;
  readonly status: PropertyStatus;
  readonly reason: PropertyVerdictReason;
};

export const PARITY_DISAGREEMENT_KINDS = [
  /** The protocol adapter passed a deterministic property the browser failed. */
  "protocol-more-permissive",
  /** The protocol adapter failed a deterministic property the browser passed. */
  "protocol-less-permissive",
  /** Same pass/fail, different reason, or a categorical disagreement. */
  "status-disagreement",
  /** One adapter did not report a property the other did. */
  "property-missing",
  /** The two runs are not the same scenario; there is nothing to compare. */
  "scenario-mismatch",
] as const;

export type ParityDisagreementKind = (typeof PARITY_DISAGREEMENT_KINDS)[number];

export type ParityDisagreement = {
  readonly kind: ParityDisagreementKind;
  readonly propertyId: string | null;
  readonly detail: string;
};

export type ParityReport = {
  /** True only when every deterministic property agrees. */
  readonly agree: boolean;
  readonly scenario: string;
  /** The properties parity actually compared. */
  readonly comparedPropertyIds: readonly string[];
  readonly disagreements: readonly ParityDisagreement[];
  /**
   * Exactly what was not compared, named: the protocol adapter may be faster,
   * so timing and behaviour properties are outside parity by design.
   */
  readonly notCompared: readonly string[];
};

/** The verdict-core result, narrowed for parity. */
export function snapshotVerdict(
  adapter: AdapterKind,
  verdict: RunVerdict,
  scenario: string,
): AdapterVerdictSnapshot {
  return {
    adapter,
    runId: verdict.runId,
    scenario,
    verdict: verdict.verdict,
    properties: verdict.properties.map((property) => ({
      propertyId: property.propertyId,
      kind: property.kind,
      status: property.status,
      reason: property.reason,
    })),
  };
}

function disagreement(
  kind: ParityDisagreementKind,
  propertyId: string | null,
  detail: string,
): ParityDisagreement {
  return { kind, propertyId, detail };
}

/**
 * Compare two adapters' verdicts for one scenario.
 *
 * Deterministic properties are compared one for one. A missing property in
 * either run is a disagreement: silence is not agreement. Timing and behaviour
 * properties are named as not compared, because the protocol adapter may be
 * faster — never more permissive.
 */
export function compareAdapterVerdicts(
  browser: AdapterVerdictSnapshot,
  protocol: AdapterVerdictSnapshot,
): ParityReport {
  if (browser.scenario !== protocol.scenario) {
    return {
      agree: false,
      scenario: browser.scenario,
      comparedPropertyIds: [],
      disagreements: [
        disagreement(
          "scenario-mismatch",
          null,
          `the browser ran "${browser.scenario}" but the protocol ran ` +
            `"${protocol.scenario}"; parity compares one scenario`,
        ),
      ],
      notCompared: [],
    };
  }

  const browserById = new Map(
    browser.properties.map((property) => [property.propertyId, property]),
  );
  const protocolById = new Map(
    protocol.properties.map((property) => [property.propertyId, property]),
  );
  const ids = browser.properties.map((property) => property.propertyId);

  const compared: string[] = [];
  const notCompared: string[] = [];
  const disagreements: ParityDisagreement[] = [];

  for (const id of ids) {
    const left = browserById.get(id);
    const right = protocolById.get(id);
    if (left === undefined || right === undefined) {
      disagreements.push(
        disagreement(
          "property-missing",
          id,
          left === undefined
            ? `${id} is not in the browser verdict; an absent property is not a pass`
            : `${id} is not in the protocol verdict; an absent property is not a pass`,
        ),
      );
      continue;
    }
    if (left.kind !== "deterministic") {
      notCompared.push(
        `${id} (${left.kind}) is not compared: the protocol adapter may be faster, ` +
          "never more permissive",
      );
      continue;
    }
    compared.push(id);
    if (left.status === right.status && left.reason === right.reason) continue;
    if (left.status !== right.status) {
      const kind: ParityDisagreementKind =
        right.status === "PASS" && left.status === "FAIL"
          ? "protocol-more-permissive"
          : left.status === "PASS" && right.status === "FAIL"
            ? "protocol-less-permissive"
            : "status-disagreement";
      disagreements.push(
        disagreement(
          kind,
          id,
          `${id}: browser ${left.status} (${left.reason}) but protocol ` +
            `${right.status} (${right.reason})`,
        ),
      );
      continue;
    }
    disagreements.push(
      disagreement(
        "status-disagreement",
        id,
        `${id}: both adapters report ${left.status}, but the browser reason is ` +
          `"${left.reason}" and the protocol reason is "${right.reason}"`,
      ),
    );
  }

  // A property only the protocol reports is equally a disagreement.
  for (const property of protocol.properties) {
    if (browserById.has(property.propertyId)) continue;
    disagreements.push(
      disagreement(
        "property-missing",
        property.propertyId,
        `${property.propertyId} is in the protocol verdict but not the browser verdict`,
      ),
    );
  }

  return {
    agree: disagreements.length === 0,
    scenario: browser.scenario,
    comparedPropertyIds: compared,
    disagreements,
    notCompared,
  };
}

/** The one-line summary a run record carries. */
export function parityLine(report: ParityReport): string {
  if (report.agree) {
    return (
      `parity: ${report.comparedPropertyIds.length} deterministic propert` +
      `${report.comparedPropertyIds.length === 1 ? "y" : "ies"} agree on ` +
      `"${report.scenario}"`
    );
  }
  const names = report.disagreements.map((item) => item.propertyId ?? item.kind);
  return (
    `parity: ${report.disagreements.length} disagreement(s) on "${report.scenario}" ` +
    `(${names.join(", ")}); the protocol adapter may be faster, never more permissive`
  );
}
