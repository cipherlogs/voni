import { and, asc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { member } from "@/lib/db/auth-schema";
import { agents, campaigns, leads, calls } from '@/lib/db/schema';
import { getJob } from '@/lib/jobs/store';
import { devBypassEnabled } from '@/lib/dev-bypass';
import type { RecordScope, DiscoveryRepository } from './record-discovery';
import type { RecordKind, RecordSearchInput } from './record-contracts';

export async function hasSearchMembership(scope: RecordScope): Promise<boolean> {
  if (devBypassEnabled() && scope.userId === 'dev-bypass-user' && scope.organizationId === 'dev-bypass-org') return true;
  return (await db.select({ id: member.id }).from(member).where(and(eq(member.userId, scope.userId), eq(member.organizationId, scope.organizationId))).limit(1)).length === 1;
}
export async function queryRecords(scope: RecordScope, input: RecordSearchInput) {
  if (!await hasSearchMembership(scope)) throw new Error('Forbidden: workspace permission was removed.');
  const pattern = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`;
  if (input.kind === 'calls') {
    return db.select({ id: calls.id, label: sql<string>`coalesce(${leads.name}, ${leads.phone})`, description: sql<string>`${calls.direction} || ' call · ' || coalesce(${calls.startedAt}::text, ${calls.createdAt}::text)` })
      .from(calls).innerJoin(leads, eq(calls.leadId, leads.id))
      .where(and(eq(leads.organizationId, scope.organizationId), or(ilike(leads.name, pattern), ilike(leads.phone, pattern)), input.after ? gt(calls.id, input.after) : undefined))
      .orderBy(asc(calls.id)).limit(21);
  }
  if (input.kind === 'leads') return db.select({ id: leads.id, label: sql<string>`coalesce(${leads.name}, 'Unnamed lead')`, description: sql<string>`${leads.phone} || ' · ' || ${leads.pipelineState}` }).from(leads)
    .where(and(eq(leads.organizationId, scope.organizationId), or(ilike(leads.name, pattern), ilike(leads.phone, pattern)), input.after ? gt(leads.id, input.after) : undefined)).orderBy(asc(leads.id)).limit(21);
  if (input.kind === 'agents') return db.select({ id: agents.id, label: agents.name, description: sql<string>`${agents.deploymentStatus} || ' · updated ' || ${agents.updatedAt}::text` }).from(agents)
    .where(and(eq(agents.organizationId, scope.organizationId), ilike(agents.name, pattern), input.after ? gt(agents.id, input.after) : undefined)).orderBy(asc(agents.id)).limit(21);
  return db.select({ id: campaigns.id, label: campaigns.name, description: sql<string>`${campaigns.status} || ' · updated ' || ${campaigns.updatedAt}::text` }).from(campaigns)
    .where(and(eq(campaigns.organizationId, scope.organizationId), ilike(campaigns.name, pattern), input.after ? gt(campaigns.id, input.after) : undefined)).orderBy(asc(campaigns.id)).limit(21);
}
export async function recordExists(scope: RecordScope, kind: RecordKind, id: string): Promise<boolean> {
  if (!await hasSearchMembership(scope)) return false;
  if (kind === 'calls') return (await db.select({ id: calls.id }).from(calls).innerJoin(leads, eq(calls.leadId, leads.id)).where(and(eq(calls.id, id), eq(leads.organizationId, scope.organizationId))).limit(1)).length === 1;
  const table = kind === 'agents' ? agents : kind === 'campaigns' ? campaigns : leads;
  return (await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.organizationId, scope.organizationId))).limit(1)).length === 1;
}
export const recordRepository: DiscoveryRepository = {
  getJob: async (scope, id) => await hasSearchMembership(scope) ? getJob(scope.organizationId, scope.userId, id) : null,
  exists: recordExists,
};
