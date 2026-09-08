import { queryRecords } from '@/lib/copilot/record-repository';
import type { RecordSearchInput, RecordSearchResult } from '@/lib/copilot/record-contracts';
import { throwIfCancelled } from '../processor';
import type { JobRow } from '../store';
export async function runRecordSearchJob(job: JobRow, input: RecordSearchInput): Promise<RecordSearchResult> {
  await throwIfCancelled(job.id);
  const records = await queryRecords({ userId: job.creatorId, organizationId: job.organizationId }, input);
  await throwIfCancelled(job.id);
  const ref = () => `${job.id}.${crypto.randomUUID()}`;
  return { matches: records.slice(0, 20).map((record) => ({ ...record, kind: input.kind, ref: ref() })), next: records.length > 20 ? { ref: ref(), after: records[19].id } : null };
}
