import { and, desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { calls, leads, conversationStates } from '@/lib/db/schema';
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
