import { ilike, type SQLWrapper } from "drizzle-orm";
import { leads } from "@/lib/db/schema";
import {
  latestBlockersNonEmpty,
  liveAppointmentExists,
  workedLeadExists,
} from "@/lib/outcomes/predicates";

/**
 * Dashboard drill-down filter for /leads (`?stage=`).
 *
 * Three curated aliases name derived outcomes rather than raw
 * `pipeline_state` values — that column is free text defaulting to "new"
 * and nothing writes stage names into it yet, so matching it raw would
 * silently return nothing for "worked". The aliases mirror the dashboard
 * outcome cards (leads that were worked, lead grain for booked, latest
 * blocker state for handoff) so a card count and its filtered list agree by
 * construction — both sides build on `@/lib/outcomes/predicates`. Any other
 * value passes through as a raw
 * `pipeline_state` match for forward compatibility — case-insensitive, so
 * the dashboard funnel links the DB's own casing and still matches after
 * normalization lowercases it.
 */
export function normalizeStageFilter(
  raw: string | string[] | null | undefined,
): string | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return undefined;
  const stage = first.trim().toLowerCase();
  return stage === "" ? undefined : stage;
}

export function isOutcomeStage(stage: string): boolean {
  return stage === "worked" || stage === "booked" || stage === "handoff";
}

/**
 * Operator label for a raw `pipeline_state` value. The column is free
 * text defaulting to "new", so the raw value must never render
 * verbatim — "new" and "Contacted" mean nothing to an operator.
 * Known states get a plain label; anything else is humanized
 * (underscores to spaces, sentence case) rather than echoed raw.
 */
export function pipelineStateLabel(
  raw: string | null | undefined,
): string {
  const value = (raw ?? "").trim().toLowerCase();
  switch (value) {
    case "":
      return "—";
    case "new":
      return "Not called yet";
    case "contacted":
      return "Called";
    case "completed":
      return "Done";
    default: {
      const words = value.replace(/[_-]+/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/**
 * Human label for the active-filter chip. Curated outcome aliases
 * keep their labels; raw stages go through the pipeline label so the
 * chip never shows "new" verbatim.
 */
export function stageFilterLabel(stage: string): string {
  switch (stage) {
    case "worked":
      return "Worked";
    case "booked":
      return "Booked";
    case "handoff":
      return "Needs handoff";
    default:
      return pipelineStateLabel(stage);
  }
}

/** Extra WHERE fragment for a normalized stage; undefined when unfiltered. */
export function stageCondition(
  stage: string | undefined,
): SQLWrapper | undefined {
  if (!stage) return undefined;
  switch (stage) {
    case "worked":
      return workedLeadExists(leads.id);
    case "booked":
      return liveAppointmentExists(leads.id);
    case "handoff":
      return latestBlockersNonEmpty(leads.id);
    default:
      // ilike, not eq: the funnel links the DB's own casing ("new",
      // "Contacted") through ?stage=, and normalizeStageFilter lowercases it —
      // an exact match would silently return nothing for any mixed-case stage.
      return ilike(leads.pipelineState, stage);
  }
}
