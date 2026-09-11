"use server";

import { and, count, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  appointments,
  calls,
  campaignLeads,
  campaigns,
  conversationStates,
  leads,
} from "@/lib/db/schema";
import { requireCtxOrRedirect } from "@/lib/session";

export type DashboardSummary = {
  leadsWorked: number;
  connectedCalls: number;
  appointmentsBooked: number;
  needsHandoff: number;
  stages: Array<{ stage: string; value: number }>;
  emptyCampaigns: Array<{ id: string; name: string }>;
};

/**
 * Conversion view backing query: outcome totals derive from recorded
 * rows, never placeholders. A lead counts as worked once it has a
 * call, connected once a call completed, and needing a handoff while
 * its latest extraction state names a blocker. The stage funnel stays
 * available as raw group-by counts for the collapsed view.
 */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const ctx = await requireCtxOrRedirect("/dashboard");
  const org = ctx.organizationId;

  const [worked] = await db
    .select({
      value: sql<number>`count(distinct ${calls.leadId})::int`,
    })
    .from(calls)
    .innerJoin(leads, eq(calls.leadId, leads.id))
    .where(eq(leads.organizationId, org));

  const [connected] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(calls)
    .innerJoin(leads, eq(calls.leadId, leads.id))
    .where(
      and(eq(leads.organizationId, org), isNotNull(calls.endedAt)),
    );

  const [booked] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(appointments)
    .innerJoin(leads, eq(appointments.leadId, leads.id))
    .where(
      and(
        eq(leads.organizationId, org),
        ne(appointments.status, "cancelled"),
      ),
    );

  const [handoff] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, org),
        sql`(
          select cs.blockers
          from ${conversationStates} as cs
          where cs.lead_id = ${leads.id}
          order by cs.created_at desc
          limit 1
        )::text <> '[]'`,
      ),
    );

  const stageRows = await db
    .select({ stage: leads.pipelineState, value: count() })
    .from(leads)
    .where(eq(leads.organizationId, org))
    .groupBy(leads.pipelineState);

  const emptyCampaigns = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .leftJoin(
      campaignLeads,
      eq(campaignLeads.campaignId, campaigns.id),
    )
    .where(eq(campaigns.organizationId, org))
    .groupBy(campaigns.id, campaigns.name)
    .having(sql`count(${campaignLeads.id}) = 0`)
    .limit(3);

  return {
    leadsWorked: worked?.value ?? 0,
    connectedCalls: connected?.value ?? 0,
    appointmentsBooked: booked?.value ?? 0,
    needsHandoff: handoff?.value ?? 0,
    stages: stageRows,
    emptyCampaigns,
  };
}
