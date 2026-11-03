/**
 * Merge the panel gate's H1-H5/H7 verdicts into a certification run.
 *
 * The generic run judge has no per-attempt evaluator for the panel's ratios and
 * per-Locale floors, so the panel gate computes those properties and this
 * function replaces them in the run verdict, in contract order. Every other
 * property, run failure and the eligibility verdict are untouched: the panel
 * can make a human property red, never make a machine failure green.
 */

import type { RunVerdict, RunVerdictValue } from "../verdict";
import type { PropertyVerdict } from "../verdict";
import { PanelError } from "./errors";

const PANEL_PROPERTY_IDS = ["H1", "H2", "H3", "H4", "H5", "H7"] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function verdictOf(run: RunVerdict, properties: readonly PropertyVerdict[]): RunVerdictValue {
  if (!run.eligibility.eligible) return "ineligible";
  if (
    properties.some((property) => property.status === "FAIL") ||
    run.failures.length > 0
  ) {
    return "not-demo-ready";
  }
  return "certified";
}

/**
 * Replace the panel-owned properties in `run`. The panel verdict must name
 * every one of H1-H5/H7 exactly once; a partial panel is a refusal, not a
 * smaller claim.
 */
export function applyPanelVerdict(
  run: RunVerdict,
  panel: readonly PropertyVerdict[],
): RunVerdict {
  const replacement = new Map<string, PropertyVerdict>();
  for (const property of panel) {
    if (!(PANEL_PROPERTY_IDS as readonly string[]).includes(property.propertyId)) {
      throw new PanelError(
        "missing-panel-property",
        `the panel verdict names "${property.propertyId}", which the panel does not own; ` +
          `the panel owns ${PANEL_PROPERTY_IDS.join(", ")}`,
      );
    }
    if (replacement.has(property.propertyId)) {
      throw new PanelError(
        "missing-panel-property",
        `the panel verdict records "${property.propertyId}" twice`,
      );
    }
    replacement.set(property.propertyId, property);
  }
  for (const id of PANEL_PROPERTY_IDS) {
    if (!replacement.has(id)) {
      throw new PanelError(
        "missing-panel-property",
        `the panel verdict has no "${id}"; a partial panel cannot certify a full contract`,
      );
    }
  }
  for (const property of run.properties) {
    if (
      (PANEL_PROPERTY_IDS as readonly string[]).includes(property.propertyId) &&
      !replacement.has(property.propertyId)
    ) {
      throw new PanelError(
        "missing-panel-property",
        `the run has panel property "${property.propertyId}" but the panel verdict omits it`,
      );
    }
  }

  const properties = run.properties.map(
    (property) => replacement.get(property.propertyId) ?? property,
  );
  const failedPropertyIds = properties
    .filter((property) => property.status === "FAIL")
    .map((property) => property.propertyId);
  const verdict = verdictOf(run, properties);
  const sampleCount = properties.reduce((sum, property) => sum + property.sampleCount, 0);
  const citations = unique(properties.flatMap((property) => property.citations));

  return {
    ...run,
    verdict,
    certifiable: verdict === "certified",
    properties,
    failedPropertyIds,
    sampleCount,
    citations,
    detail:
      verdict === "ineligible"
        ? run.detail
        : verdict === "certified"
          ? `certified: ${properties.length}/${properties.length} properties pass ` +
            `(${sampleCount} samples, ${run.eligibility.callCount} calls), panel merged`
          : `not-demo-ready: ${failedPropertyIds.length} of ${properties.length} properties failed ` +
            `(${failedPropertyIds.join(", ")})` +
            `${run.failures.length === 0 ? "" : `; ${run.failures.join("; ")}`}`,
  };
}
