import { isNotNull, sql, type SQLWrapper } from "drizzle-orm";
import { calls } from "@/lib/db/schema";

/**
 * Shared outcome predicates: the single source of truth for "worked",
 * "connected", "booked", and "needs handoff".
 *
 * The dashboard outcome cards (`(dashboard)/dashboard/actions.ts`) and the
 * drill-down list filters (`lib/leads/stage-filter.ts` for `?stage=`,
 * `lib/calls/outcome-filter.ts` for `?outcome=`) are parallel queries that
 * used to spell these predicates out independently and could drift apart —
 * a card count and its filtered list would then silently disagree. Those
 * three callers build their WHERE fragments from these four functions
 * instead, so a card and its list agree by construction. There is no fourth
 * consumer: the remaining SQL on the same tables needs a different shape —
 * the leads table's `callCount` counts calls (COUNT, not EXISTS) and the
 * detail pages select rows rather than filtering on them — so this file
 * stays four predicates for three callers by design.
 *
 * Each predicate takes the lead-id column of the caller's grain: `leads.id`
 * for lead lists and dashboard cards, `calls.leadId` for call lists. The
 * emitted SQL text is identical either way (the column binds as a
 * parameter), only the bound value differs.
 */

/** A lead counts as worked once it has at least one call. */
export function workedLeadExists(leadId: SQLWrapper): SQLWrapper {
  return sql`exists(select 1 from calls where calls.lead_id = ${leadId})`;
}

/** A lead counts as booked while it holds a live (non-cancelled) appointment. */
export function liveAppointmentExists(leadId: SQLWrapper): SQLWrapper {
  return sql`exists(select 1 from appointments where appointments.lead_id = ${leadId} and appointments.status <> 'cancelled')`;
}

/**
 * A lead needs a human handoff while its latest extraction state names a
 * blocker. No state row (NULL) and an empty blocker list both read as
 * false — never a handoff: `NULL <> '[]'` is NULL, which WHERE drops, and
 * `'[]' <> '[]'` is false.
 */
export function latestBlockersNonEmpty(leadId: SQLWrapper): SQLWrapper {
  return sql`((select blockers from conversation_states where conversation_states.lead_id = ${leadId} order by created_at desc limit 1)::text <> '[]')`;
}

/** A call counts as connected once it ended. */
export function callConnected(): SQLWrapper {
  return isNotNull(calls.endedAt);
}
