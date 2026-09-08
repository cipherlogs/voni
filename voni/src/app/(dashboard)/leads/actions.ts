"use server";

import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireCtxOrRedirect } from "@/lib/session";

/**
 * The leads table (plan Section M: "/leads").
 *
 * Intent, blocker and next action come from `conversation_states`, which the
 * Day 9-10 extraction pipeline populates. They render as placeholders until
 * then — the columns exist now because they are the point of the product, and a
 * table that grows three columns later reads as a different table.
 *
 * They are read as correlated subqueries rather than a join: a lead accumulates
 * one `conversation_states` row per interaction, so joining would return the
 * same lead once per call it has had. Only the most recent state is current.
 */
export async function listLeads(limit = 200) {
  const ctx = await requireCtxOrRedirect("/leads");

  const latestState = (column: string) => sql<string | null>`(
    SELECT cs.${sql.raw(column)} FROM conversation_states cs
    WHERE cs.lead_id = ${leads.id}
    ORDER BY cs.created_at DESC
    LIMIT 1
  )`;

  return db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      source: leads.source,
      consentStatus: leads.consentStatus,
      pipelineState: leads.pipelineState,
      updatedAt: leads.updatedAt,
      intent: latestState("intent"),
      nextAction: latestState("next_action"),
      // `blockers` is a jsonb array; the table shows the first one, which is
      // the one an operator would act on.
      blocker: sql<string | null>`(
        SELECT cs.blockers->>0 FROM conversation_states cs
        WHERE cs.lead_id = ${leads.id}
        ORDER BY cs.created_at DESC
        LIMIT 1
      )`,
      callCount: sql<number>`(
        SELECT COUNT(*)::int FROM calls c WHERE c.lead_id = ${leads.id}
      )`,
    })
    .from(leads)
    .where(eq(leads.organizationId, ctx.organizationId))
    .orderBy(desc(leads.updatedAt))
    .limit(limit);
}
