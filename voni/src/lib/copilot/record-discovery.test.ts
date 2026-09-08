import test from 'node:test';
import assert from 'node:assert/strict';
import { continueRecordSearch, openRecordReference, type DiscoveryRepository, type SearchJob } from './record-discovery';
import { publicRecordResult } from './record-contracts';
const jobId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const reference = `${jobId}.33333333-3333-4333-8333-333333333333`;
const nextRef = `${jobId}.44444444-4444-4444-8444-444444444444`;
const scope = { userId: 'user', organizationId: 'org' };
function setup() {
  const job: SearchJob = { id: jobId, kind: 'record_search', status: 'succeeded', creatorId: 'user', organizationId: 'org', input: { kind: 'agents', query: 'Sara' }, result: { matches: [{ ref: reference, id, kind: 'agents', label: 'Sara', description: 'draft' }, { ref: `${jobId}.55555555-5555-4555-8555-555555555555`, id: '66666666-6666-4666-8666-666666666666', kind: 'agents', label: 'Sara', description: 'ready' }], next: { ref: nextRef, after: id } } };
  let exists = true;
  const repo: DiscoveryRepository = { getJob: async (_scope, requested) => requested === job.id ? job : null, exists: async () => exists };
  return { repo, job, removeAccess: () => { exists = false; } };
}
test('ambiguous names retain descriptive matches; only one returned reference opens', async () => {
  const h = setup(); const result = publicRecordResult(h.job.result)!; assert.equal(result.matches.length, 2); assert.notEqual(result.matches[0].description, result.matches[1].description);
  await assert.rejects(openRecordReference(h.repo, scope, 'Sara'));
  assert.deepEqual(await openRecordReference(h.repo, scope, reference), { destination: `/agents/${id}`, label: 'Sara' });
  assert.ok(!JSON.stringify(result).includes(id));
});
test('fabricated refs, raw ids, URL paths and missing jobs are refused', async () => {
  const h = setup(); for (const invalid of [id, `/agents/${id}`, `${jobId}.77777777-7777-4777-8777-777777777777`, `88888888-8888-4888-8888-888888888888.${id}`]) await assert.rejects(openRecordReference(h.repo, scope, invalid));
});
test('cross-user and cross-workspace access cannot open or paginate cached results', async () => {
  const h = setup(); for (const stranger of [{ ...scope, userId: 'other' }, { ...scope, organizationId: 'other' }]) {
    await assert.rejects(openRecordReference(h.repo, stranger, reference)); await assert.rejects(continueRecordSearch(h.repo, stranger, nextRef));
  }
});
test('deleted records and permission changes are rechecked on every open', async () => {
  const h = setup(); await openRecordReference(h.repo, scope, reference); h.removeAccess(); await assert.rejects(openRecordReference(h.repo, scope, reference), /deleted|available/);
});
test('continuation preserves original kind/query and uses only stored cursor', async () => {
  const h = setup(); assert.deepEqual(await continueRecordSearch(h.repo, scope, nextRef), { kind: 'agents', query: 'Sara', after: id });
  await assert.rejects(continueRecordSearch(h.repo, scope, reference)); await assert.rejects(openRecordReference(h.repo, scope, nextRef));
});
test('cancelled/failed jobs and changed job ownership invalidate references', async () => {
  const h = setup(); for (const status of ['running', 'cancelled', 'failed']) { h.job.status = status; await assert.rejects(openRecordReference(h.repo, scope, reference)); }
  h.job.status = 'succeeded'; h.job.creatorId = 'other'; await assert.rejects(openRecordReference(h.repo, scope, reference));
});
