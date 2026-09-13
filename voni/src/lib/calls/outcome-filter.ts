import type { SQLWrapper } from "drizzle-orm";
import { calls } from "@/lib/db/schema";
import {
  callConnected,
  latestBlockersNonEmpty,
  liveAppointmentExists,
} from "@/lib/outcomes/predicates";

export type CallOutcomeFilter = "connected" | "booked" | "handoff";

/**
 * Dashboard drill-down filter for /calls (`?outcome=`).
 *
 * Whitelist, not passthrough: there is no free-text outcome column on
 * calls, so anything outside the three dashboard-backed outcomes falls back
 * to the unfiltered list rather than 404ing. Predicates mirror the
 * dashboard cards — connected reuses "ended", booked reuses the
 * non-cancelled appointment check, handoff reuses the latest-blockers
 * check — so a card count and its filtered list agree by construction: both
 * sides build on `@/lib/outcomes/predicates`. Grain differs by design for
 * connected: the card and the `?outcome=connected` list both count calls,
 * while the other two cards count leads against lead lists.
 */
export function normalizeCallOutcome(
  raw: string | string[] | null | undefined,
): CallOutcomeFilter | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return undefined;
  const outcome = first.trim().toLowerCase();
  return outcome === "connected" ||
    outcome === "booked" ||
    outcome === "handoff"
    ? outcome
    : undefined;
}

export function callOutcomeLabel(outcome: CallOutcomeFilter): string {
  switch (outcome) {
    case "connected":
      return "Connected";
    case "booked":
      return "Booked";
    case "handoff":
      return "Needs handoff";
  }
}

/** Extra WHERE fragment for a normalized outcome; undefined when unfiltered. */
export function callOutcomeCondition(
  outcome: CallOutcomeFilter | undefined,
): SQLWrapper | undefined {
  switch (outcome) {
    case "connected":
      return callConnected();
    case "booked":
      return liveAppointmentExists(calls.leadId);
    case "handoff":
      return latestBlockersNonEmpty(calls.leadId);
    default:
      return undefined;
  }
}
