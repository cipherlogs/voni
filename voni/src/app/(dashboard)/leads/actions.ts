"use server";

import { revalidatePath } from "next/cache";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import {
  normalizeStageFilter,
  stageCondition,
} from "@/lib/leads/stage-filter";
import { requireCtx, requireCtxOrRedirect } from "@/lib/session";

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
 *
 * Options for /leads filtering. `stage` accepts the raw search-param value:
 * normalization happens here so direct callers get the same behavior as the
 * page. Curated aliases (worked/booked/handoff) name derived outcomes; any
 * other value matches `pipeline_state` raw for forward compatibility.
 */
export type ListLeadsOptions = {
  stage?: string | string[] | null;
};

export type ListLeadsResult = Awaited<ReturnType<typeof listLeadsRows>>;

async function listLeadsRows(limit: number, options: ListLeadsOptions) {
  const ctx = await requireCtxOrRedirect("/leads");
  const stage = normalizeStageFilter(options.stage);
  const extra = stageCondition(stage);

  const latestState = (column: string) => sql<string | null>`(
    SELECT cs.${sql.raw(column)} FROM conversation_states cs
    WHERE cs.lead_id = ${leads.id}
    ORDER BY cs.created_at DESC
    LIMIT 1
  )`;

  const scope = extra
    ? and(eq(leads.organizationId, ctx.organizationId), extra)
    : eq(leads.organizationId, ctx.organizationId);

  const [rows, [{ value: total }]] = await Promise.all([
    db
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
      .where(scope)
      .orderBy(desc(leads.updatedAt))
      .limit(limit),
    // Exact total on the same org-scoped filter, so the result count reads
    // the whole filtered set — not just the capped page the table shows.
    db.select({ value: count() }).from(leads).where(scope),
  ]);
  return { rows, total, stage };
}

export async function listLeads(
  limit = 200,
  options: ListLeadsOptions = {},
): Promise<ListLeadsResult> {
  return listLeadsRows(limit, options);
}

/**
 * Bulk stage move for the leads table's header select-all. One org-scoped
 * UPDATE; ids are capped at the visible 200 and validated, and rows outside
 * the org are never touched (the IN list is intersected with an org-scoped
 * read first, per the queue-bulk precedent). The stage accepts raw
 * `pipeline_state` values only — the derived aliases (worked/booked/handoff)
 * name query predicates, not stored states, so writing them would silently
 * orphan the row from both the alias and the raw funnel.
 */
const bulkStageSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  stage: z.string().trim().min(1, "Choose a stage.").max(120),
});

export type LeadsBulkResult =
  | { ok: true; updated: string[] }
  | { ok: false; message: string };

const RESERVED_STAGE_ALIASES = ["worked", "booked", "handoff"];

export async function bulkLeadsStageAction(
  raw: unknown,
): Promise<LeadsBulkResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to update leads." };
  }
  const parsed = bulkStageSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Pick up to 200 leads and a stage." };
  }
  const stage = parsed.data.stage.toLowerCase();
  if (RESERVED_STAGE_ALIASES.includes(stage)) {
    return {
      ok: false,
      message: "That stage is a curated filter, not a pipeline stage.",
    };
  }

  const wanted = new Set(parsed.data.ids);
  const owned = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        inArray(leads.id, [...wanted]),
      ),
    );
  if (owned.length === 0) {
    return { ok: false, message: "Those leads are no longer in this workspace." };
  }

  const updated = await db
    .update(leads)
    .set({ pipelineState: stage, updatedAt: new Date() })
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        inArray(
          leads.id,
          owned.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: leads.id });
  revalidatePath("/leads");
  return { ok: true, updated: updated.map((row) => row.id) };
}
