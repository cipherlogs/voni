import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCtx } from '@/lib/session';
import { startJob, JobStartError } from '@/lib/jobs/start';
import { jobToJson } from '@/lib/jobs/serialize';
import { recordKindSchema } from '@/lib/copilot/record-contracts';
import { continueRecordSearch, openRecordReference, RecordReferenceError } from '@/lib/copilot/record-discovery';
import { recordRepository } from '@/lib/copilot/record-repository';
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), kind: recordKindSchema, query: z.string().trim().min(1).max(160), idempotencyKey: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('continue'), ref: z.string().max(100), idempotencyKey: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('open'), ref: z.string().max(100) }).strict(),
]);
export async function POST(request: Request) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const parsed = argsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid record command.' }, { status: 400 });
  try {
    const args = parsed.data;
    if (args.action === 'open') return NextResponse.json(await openRecordReference(recordRepository, ctx, args.ref));
    const input = args.action === 'continue' ? await continueRecordSearch(recordRepository, ctx, args.ref) : { kind: args.kind, query: args.query };
    const { job, created } = await startJob(ctx, 'record_search', input, { idempotencyKey: args.idempotencyKey });
    return NextResponse.json({ jobId: job.id, status: job.status, targetUrl: job.targetUrl, created, job: jobToJson(job) }, { status: 202 });
  } catch (error) {
    if (error instanceof RecordReferenceError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof JobStartError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: 'Record search could not start. Retry with the same request.' }, { status: 503 });
  }
}
