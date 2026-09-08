/** Pure authorization/opaque-reference checks, with a server-owned repository. */
import { z } from 'zod';
import { recordSearchInputSchema, recordSearchResultSchema, type RecordKind, type RecordSearchInput } from './record-contracts';
export type RecordScope = { userId: string; organizationId: string };
export type SearchJob = { id: string; creatorId: string; organizationId: string; kind: string; status: string; input: unknown; result: unknown };
export type DiscoveryRepository = {
  getJob: (scope: RecordScope, id: string) => Promise<SearchJob | null>;
  exists: (scope: RecordScope, kind: RecordKind, id: string) => Promise<boolean>;
};
const referenceSchema = z.string().regex(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/);
export class RecordReferenceError extends Error {}
async function resultForReference(repo: DiscoveryRepository, scope: RecordScope, reference: string) {
  if (!referenceSchema.safeParse(reference).success) throw new RecordReferenceError('Read search results again for a valid reference.');
  const job = await repo.getJob(scope, reference.split('.')[0]);
  if (!job || job.creatorId !== scope.userId || job.organizationId !== scope.organizationId || job.kind !== 'record_search' || job.status !== 'succeeded') throw new RecordReferenceError('These search results are no longer available to your account.');
  const result = recordSearchResultSchema.safeParse(job.result);
  if (!result.success) throw new RecordReferenceError('Read search results again.');
  return { job, result: result.data };
}
export async function openRecordReference(repo: DiscoveryRepository, scope: RecordScope, reference: string) {
  const { result } = await resultForReference(repo, scope, reference);
  const matches = result.matches.filter((match) => match.ref === reference);
  if (matches.length !== 1) throw new RecordReferenceError('Select one returned record reference.');
  const match = matches[0];
  if (!await repo.exists(scope, match.kind, match.id)) throw new RecordReferenceError('This record was deleted or is no longer available to your account. Search again.');
  return { destination: `/${match.kind}/${match.id}`, label: match.label };
}
export async function continueRecordSearch(repo: DiscoveryRepository, scope: RecordScope, reference: string): Promise<RecordSearchInput> {
  const { job, result } = await resultForReference(repo, scope, reference);
  if (!result.next || result.next.ref !== reference) throw new RecordReferenceError('Use the returned continuation reference.');
  const input = recordSearchInputSchema.parse(job.input);
  return { ...input, after: result.next.after };
}
