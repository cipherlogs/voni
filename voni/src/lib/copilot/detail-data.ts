import { and, count, desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { calls, leads, conversationStates } from '@/lib/db/schema';
import {
  callOutcomeCondition,
  normalizeCallOutcome,
  type CallOutcomeFilter,
} from '@/lib/calls/outcome-filter';
import { requireCtxOrRedirect } from '@/lib/session';
export async function leadDetail(id: string) {
  const ctx = await requireCtxOrRedirect(`/leads/${id}`);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.organizationId, ctx.organizationId))).limit(1);
  if (!lead) notFound();
  const [state] = await db.select().from(conversationStates).where(eq(conversationStates.leadId, id)).orderBy(desc(conversationStates.createdAt)).limit(1);
  return { lead, state };
}
export async function callDetail(id: string) {
  const ctx = await requireCtxOrRedirect(`/calls/${id}`);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const [call] = await db.select({ id: calls.id, name: leads.name, phone: leads.phone, direction: calls.direction, startedAt: calls.startedAt, endedAt: calls.endedAt, transcript: calls.transcript }).from(calls).innerJoin(leads, eq(calls.leadId, leads.id)).where(and(eq(calls.id, id), eq(leads.organizationId, ctx.organizationId))).limit(1);
  if (!call) notFound();
  return call;
}

const CALL_LIST_COLUMNS = {
  id: calls.id,
  leadId: calls.leadId,
  name: leads.name,
  phone: leads.phone,
  direction: calls.direction,
  startedAt: calls.startedAt,
  endedAt: calls.endedAt,
} as const;

/**
 * Recent calls for the agents-page section and the /calls index: org-scoped
 * `calls` joined to `leads` for the display name, newest first. Same join +
 * scoping as `callDetail`, so visibility rules match the detail route the
 * rows link to.
 */
export type ListCallsFilter = {
  /** Raw ?outcome= value; normalization happens here so direct callers match
   *  the page. Unknown values degrade to unfiltered, never a 404. */
  outcome?: string | string[] | null;
};

export async function listCalls(
  page: number,
  pageSize: number,
  filter: ListCallsFilter = {},
) {
  const ctx = await requireCtxOrRedirect("/calls");
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(50, Math.max(1, Math.floor(pageSize)));
  const outcome: CallOutcomeFilter | undefined = normalizeCallOutcome(
    filter.outcome,
  );
  const extra = callOutcomeCondition(outcome);
  const scope = extra
    ? and(eq(leads.organizationId, ctx.organizationId), extra)
    : eq(leads.organizationId, ctx.organizationId);
  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select(CALL_LIST_COLUMNS)
      .from(calls)
      .innerJoin(leads, eq(calls.leadId, leads.id))
      .where(scope)
      .orderBy(desc(calls.startedAt))
      .limit(safeSize)
      .offset((safePage - 1) * safeSize),
    // Exact total for the pagination footer: one cheap count on the same
    // org-scoped join (plus the filter when active), so "Page N" can say
    // "of M" and the final page never overshoots to an empty page by design.
    db
      .select({ value: count() })
      .from(calls)
      .innerJoin(leads, eq(calls.leadId, leads.id))
      .where(scope),
  ]);
  return { rows, page: safePage, pageSize: safeSize, total, outcome };
}

/** The 5 most recent calls, for the secondary section on /agents. */
export async function recentCalls() {
  const { rows } = await listCalls(1, 5);
  return rows;
}
