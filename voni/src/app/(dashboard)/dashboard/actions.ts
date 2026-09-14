"use server";

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  calls,
  campaignLeads,
  campaigns,
  agents,
  leads,
} from "@/lib/db/schema";
import type { DashboardSetupState } from "@/lib/dashboard/setup";
import {
  callConnected,
  latestBlockersNonEmpty,
  liveAppointmentExists,
  workedLeadExists,
} from "@/lib/outcomes/predicates";
import { requireCtxOrRedirect } from "@/lib/session";

export type DashboardSummary = {
  leadsWorked: number;
  connectedCalls: number;
  appointmentsBooked: number;
  needsHandoff: number;
  stages: Array<{ stage: string; value: number }>;
  emptyCampaigns: Array<{ id: string; name: string }>;
  setup: DashboardSetupState;
  /** True until the workspace records its first dashboard outcome. */
  isFirstRun: boolean;
};

/**
 * Conversion view backing query: outcome totals derive from recorded
 * rows, never placeholders. A lead counts as worked once it has a
 * call, connected once a call completed, booked while it holds a live
 * (non-cancelled) appointment, and needing a handoff while its latest
 * extraction state names a blocker. Each predicate lives in
 * `@/lib/outcomes/predicates`, shared with the `?stage=` / `?outcome=`
 * list filters, so a card and its filtered list agree by construction.
 * Booked counts leads — not appointment rows — matching the `?stage=booked`
 * lead list it links to. The stage funnel stays available as raw group-by
 * counts for the collapsed view.
 */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const ctx = await requireCtxOrRedirect("/dashboard");
  const org = ctx.organizationId;

  const [worked] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(eq(leads.organizationId, org), workedLeadExists(leads.id)),
    );

  const [connected] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(calls)
    .innerJoin(leads, eq(calls.leadId, leads.id))
    .where(
      and(eq(leads.organizationId, org), callConnected()),
    );

  const [booked] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(eq(leads.organizationId, org), liveAppointmentExists(leads.id)),
    );

  const [handoff] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, org),
        latestBlockersNonEmpty(leads.id),
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

  const [[createdAgent], [importedLead], [activatedCampaign]] =
    await Promise.all([
      db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.organizationId, org),
            isNull(agents.generationJobId),
          ),
        )
        .limit(1),
      db
        .select({ id: campaignLeads.id })
        .from(campaignLeads)
        .innerJoin(campaigns, eq(campaignLeads.campaignId, campaigns.id))
        .where(eq(campaigns.organizationId, org))
        .limit(1),
      db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.organizationId, org),
            inArray(campaigns.status, ["active", "paused", "completed"]),
          ),
        )
        .limit(1),
    ]);

  const leadsWorked = worked?.value ?? 0;
  const connectedCalls = connected?.value ?? 0;
  const appointmentsBooked = booked?.value ?? 0;
  const needsHandoff = handoff?.value ?? 0;
  return {
    leadsWorked,
    connectedCalls,
    appointmentsBooked,
    needsHandoff,
    stages: stageRows,
    emptyCampaigns,
    setup: {
      agentCreated: Boolean(createdAgent),
      leadsImported: Boolean(importedLead),
      campaignActivated: Boolean(activatedCampaign),
    },
    isFirstRun:
      leadsWorked === 0 &&
      connectedCalls === 0 &&
      appointmentsBooked === 0 &&
      needsHandoff === 0,
  };
}
