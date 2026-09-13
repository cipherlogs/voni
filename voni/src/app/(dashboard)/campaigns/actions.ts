"use server";

import { revalidatePath } from "next/cache";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { agents, campaignLeads, campaigns, leads } from "@/lib/db/schema";
import { requireCtx, requireCtxOrRedirect } from "@/lib/session";
import {
  allowedConsentStatuses,
  callingWindowSchema,
  consentPolicySchema,
  evaluateCallingWindow,
  parseCallingWindow,
  parseConsentPolicy,
} from "@/lib/campaigns/policy";

/**
 * Campaign creation and status (plan Day 7-8). Lead imports run as durable
 * lead_csv_import jobs (see the LeadImport component and
 * src/lib/leads/import.ts), not as server actions.
 *
 * Same convention as the agent actions: mutations return a discriminated
 * result instead of throwing, because every failure here is something the
 * operator can act on — a CSV with no phone column is a fixable file, not a
 * server error.
 */

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(120),
  agentId: z.string().uuid("Choose an agent."),
  callingWindow: callingWindowSchema,
  consentPolicy: consentPolicySchema,
  maxAttempts: z.number().int().min(1).max(10),
  retryAfterMinutes: z.number().int().min(5).max(10080),
});

export type CampaignInput = z.infer<typeof createSchema>;

export type CampaignResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

export async function createCampaignAction(raw: unknown): Promise<CampaignResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to create a campaign." };
  }

  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const input = parsed.data;

  // The agent must belong to this workspace. Without this check the agent id is
  // just a uuid from the browser, and a campaign could be pointed at another
  // tenant's agent — which the dispatcher would then happily deploy.
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, input.agentId), eq(agents.organizationId, ctx.organizationId)),
    )
    .limit(1);
  if (!agent) return { ok: false, message: "That agent is not in this workspace." };

  const [row] = await db
    .insert(campaigns)
    .values({
      organizationId: ctx.organizationId,
      agentId: input.agentId,
      name: input.name,
      callingWindow: input.callingWindow,
      consentPolicy: input.consentPolicy,
      maxAttempts: input.maxAttempts,
      retryAfterMinutes: input.retryAfterMinutes,
      status: "draft",
    })
    .returning({ id: campaigns.id });

  revalidatePath("/campaigns");
  return { ok: true, id: row.id };
}

const STATUSES = ["draft", "active", "paused", "completed"] as const;

export async function setCampaignStatusAction(
  id: string,
  status: (typeof STATUSES)[number],
): Promise<CampaignResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to change this campaign." };
  }
  if (!STATUSES.includes(status)) return { ok: false, message: "Unknown status." };

  // Activating a campaign is what makes the dispatcher start handing its leads
  // to the dialer, so it is worth being sure there is something to dial and
  // someone to dial it with. Both failures are silent otherwise: the runner
  // just reports "no leads due" forever.
  if (status === "active") {
    const [{ queued }] = await db
      .select({ queued: count() })
      .from(campaignLeads)
      .where(
        and(eq(campaignLeads.campaignId, id), eq(campaignLeads.status, "queued")),
      );
    if (queued === 0) {
      return { ok: false, message: "Import leads before activating this campaign." };
    }
    const [deployed] = await db
      .select({ remote: agents.assemblyaiAgentId })
      .from(campaigns)
      .innerJoin(agents, eq(agents.id, campaigns.agentId))
      .where(
        and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)),
      )
      .limit(1);
    if (!deployed?.remote) {
      return {
        ok: false,
        message: "This campaign's agent is still a draft — publish it first.",
      };
    }
  }

  const updated = await db
    .update(campaigns)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .returning({ id: campaigns.id });
  if (updated.length === 0) return { ok: false, message: "Campaign not found." };

  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${id}`);
  return { ok: true, id };
}

export async function listCampaigns() {
  const ctx = await requireCtxOrRedirect("/campaigns");
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      callingWindow: campaigns.callingWindow,
      consentPolicy: campaigns.consentPolicy,
      maxAttempts: campaigns.maxAttempts,
      agentName: agents.name,
      agentDeployed: agents.assemblyaiAgentId,
      total: sql<number>`(
        SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = ${campaigns.id}
      )`,
      queued: sql<number>`(
        SELECT COUNT(*)::int FROM campaign_leads cl
        WHERE cl.campaign_id = ${campaigns.id} AND cl.status = 'queued'
      )`,
      reached: sql<number>`(
        SELECT COUNT(*)::int FROM campaign_leads cl
        WHERE cl.campaign_id = ${campaigns.id} AND cl.status = 'reached'
      )`,
    })
    .from(campaigns)
    .innerJoin(agents, eq(agents.id, campaigns.agentId))
    .where(eq(campaigns.organizationId, ctx.organizationId))
    .orderBy(desc(campaigns.createdAt));
}

export async function getCampaign(id: string) {
  const ctx = await requireCtxOrRedirect("/campaigns");
  const [row] = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      callingWindow: campaigns.callingWindow,
      consentPolicy: campaigns.consentPolicy,
      maxAttempts: campaigns.maxAttempts,
      retryAfterMinutes: campaigns.retryAfterMinutes,
      agentId: campaigns.agentId,
      agentName: agents.name,
      agentDeployed: agents.assemblyaiAgentId,
    })
    .from(campaigns)
    .innerJoin(agents, eq(agents.id, campaigns.agentId))
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) return null;

  const members = await db
    .select({
      id: campaignLeads.id,
      status: campaignLeads.status,
      attempts: campaignLeads.attempts,
      lastAttemptAt: campaignLeads.lastAttemptAt,
      nextAttemptAfter: campaignLeads.nextAttemptAfter,
      lastOutcome: campaignLeads.lastOutcome,
      leadId: leads.id,
      leadName: leads.name,
      phone: leads.phone,
      consentStatus: leads.consentStatus,
    })
    .from(campaignLeads)
    .innerJoin(leads, eq(leads.id, campaignLeads.leadId))
    .where(eq(campaignLeads.campaignId, id))
    .orderBy(campaignLeads.createdAt)
    .limit(200);

  return { campaign: row, members };
}

/**
 * Bulk queue triage: remove members from the queue (Undo re-inserts within a
 * short window) or reset them to queued (idempotent retry). Capped at 200 per
 * call, org-checked through the campaign row so one tenant can never touch
 * another's queue. No schema changes: removal deletes rows, reset updates
 * only the queue fields, and re-insert reuses the import's conflict guard.
 */

const queueBulkSchema = z.object({
  campaignId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(200),
  op: z.enum(["remove", "reset"]),
});

export type QueueBulkResult =
  | { ok: true; removed: { id: string; leadId: string }[]; reset: string[] }
  | { ok: false; message: string };

async function orgCampaign(campaignId: string, organizationId: string) {
  const [row] = await db
    .select({ id: campaigns.id, maxAttempts: campaigns.maxAttempts })
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

export async function queueBulkAction(raw: unknown): Promise<QueueBulkResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to manage the queue." };
  }
  const parsed = queueBulkSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Pick up to 200 queue rows." };
  }
  const campaign = await orgCampaign(parsed.data.campaignId, ctx.organizationId);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  const wanted = new Set(parsed.data.ids);
  const rows = await db
    .select({ id: campaignLeads.id, leadId: campaignLeads.leadId })
    .from(campaignLeads)
    .where(eq(campaignLeads.campaignId, parsed.data.campaignId));
  const matching = rows.filter((row) => wanted.has(row.id));

  if (parsed.data.op === "remove") {
    if (matching.length === 0) return { ok: true, removed: [], reset: [] };
    await db
      .delete(campaignLeads)
      .where(
        and(
          eq(campaignLeads.campaignId, parsed.data.campaignId),
          sql`${campaignLeads.id} IN (${sql.join(matching.map((m) => sql`${m.id}`), sql`, `)})`,
        ),
      );
    revalidatePath(`/campaigns/${parsed.data.campaignId}`);
    return {
      ok: true,
      removed: matching.map((m) => ({ id: m.id, leadId: m.leadId })),
      reset: [],
    };
  }

  if (matching.length === 0) return { ok: true, removed: [], reset: [] };
  // Idempotent per row: already-queued rows with no attempts are left alone
  // (guarded in SQL), so a repeated reset is a no-op rather than a rewrite.
  const updated = await db
    .update(campaignLeads)
    .set({
      status: "queued",
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAfter: null,
      lastOutcome: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(campaignLeads.campaignId, parsed.data.campaignId),
        sql`${campaignLeads.id} IN (${sql.join(matching.map((m) => sql`${m.id}`), sql`, `)})`,
        sql`NOT (${campaignLeads.status} = 'queued' AND ${campaignLeads.attempts} = 0 AND ${campaignLeads.lastOutcome} IS NULL)`,
      ),
    )
    .returning({ id: campaignLeads.id });
  revalidatePath(`/campaigns/${parsed.data.campaignId}`);
  return { ok: true, removed: [], reset: updated.map((u) => u.id) };
}

/** Re-insert removed queue rows within the Undo window. The unique
 * (campaign, lead) index makes this safe to repeat — already-restored rows
 * are skipped, never duplicated. */
export async function queueUndoRemoveAction(
  campaignId: string,
  leadIds: string[],
): Promise<{ ok: true; restored: number } | { ok: false; message: string }> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to manage the queue." };
  }
  if (
    typeof campaignId !== "string" ||
    !Array.isArray(leadIds) ||
    leadIds.length === 0 ||
    leadIds.length > 200
  ) {
    return { ok: false, message: "Nothing to restore." };
  }
  const campaign = await orgCampaign(campaignId, ctx.organizationId);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  const restored = await db
    .insert(campaignLeads)
    .values(leadIds.map((leadId) => ({ campaignId, leadId })))
    .onConflictDoNothing({
      target: [campaignLeads.campaignId, campaignLeads.leadId],
    })
    .returning({ id: campaignLeads.id });
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, restored: restored.length };
}

export async function listAgentOptions() {
  const ctx = await requireCtxOrRedirect("/campaigns");
  return db
    .select({
      id: agents.id,
      name: agents.name,
      deployed: agents.assemblyaiAgentId,
    })
    .from(agents)
    .where(eq(agents.organizationId, ctx.organizationId))
    .orderBy(desc(agents.updatedAt));
}

/**
 * Why is (or is not) this campaign dialling right now?
 *
 * The plan's competitive thesis is legibility — the deep review-mining in
 * Section B names "black-box failure diagnosis" as a validated complaint about
 * every competitor. A campaign that is active, correctly configured, and simply
 * outside its calling window looks identical to a broken one unless the product
 * says so. This is what makes the difference visible on the page.
 */
export async function getCampaignDispatchStatus(id: string) {
  const ctx = await requireCtxOrRedirect("/campaigns");

  const [row] = await db
    .select({
      status: campaigns.status,
      callingWindow: campaigns.callingWindow,
      consentPolicy: campaigns.consentPolicy,
      maxAttempts: campaigns.maxAttempts,
      deployed: agents.assemblyaiAgentId,
    })
    .from(campaigns)
    .innerJoin(agents, eq(agents.id, campaigns.agentId))
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) return null;

  const window = parseCallingWindow(row.callingWindow);
  const consent = allowedConsentStatuses(parseConsentPolicy(row.consentPolicy));
  const verdict = evaluateCallingWindow(window, new Date());

  // "Due" means eligible on every count except the calling window, which is
  // reported separately — otherwise a closed window would show an empty queue
  // and hide the fact that there is work waiting.
  const due = await db.execute(sql`
    SELECT COUNT(*)::int AS due
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ${id}
      AND cl.status = 'queued'
      AND cl.attempts < ${row.maxAttempts}
      AND (cl.next_attempt_after IS NULL OR cl.next_attempt_after <= now())
      AND l.consent_status IN (${sql.join(consent.map((c) => sql`${c}`), sql`, `)})
  `);
  const dueNow = (due.rows as { due: number }[])[0]?.due ?? 0;

  const blockers: string[] = [];
  if (row.status !== "active") blockers.push(`the campaign is ${row.status}`);
  if (!row.deployed) blockers.push("the agent is not published");
  if (!verdict.allowed) blockers.push(verdict.reason);
  if (dueNow === 0) blockers.push("no leads are due");

  return { window, dueNow, windowOpen: verdict.allowed, blockers };
}
