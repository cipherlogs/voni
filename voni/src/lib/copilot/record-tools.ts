import { z } from 'zod';
import { recordKindSchema, type PublicRecordResult } from './record-contracts';
import type { BusToolResult, RegisteredTool } from './bus';
import type { JobJson } from '@/lib/jobs/serialize';

export function recordTools(deps: {
  navigate: (destination: string) => Promise<BusToolResult>;
  route: () => string;
  addOptimistic: (title: string, kind: string) => string;
  removeOptimistic: (key: string) => void;
  refresh: () => Promise<void>;
  background: (message: string) => void;
  fetcher?: typeof fetch;
}): RegisteredTool[] {
  const fetcher = deps.fetcher ?? fetch;
  // A repeated tool call reconciles the same accepted job, including after a lost response.
  const requests = new Map<string, string>();
  const acceptedJobs = new Map<string, string>();
  const common = { effect: { mutates: false, scope: 'records', reversible: true }, routes: '*' as const, mode: 'interactive' as const, listed: true, executor: null };
  const searchSchema = z.object({ kind: recordKindSchema.optional(), query: z.string().trim().min(1).max(160).optional(), continuation: z.string().max(100).optional() }).refine((a) => a.continuation ? !a.kind && !a.query : Boolean(a.kind && a.query));
  const openSchema = z.object({ ref: z.string().max(100) });
  return [
    { ...common, name: 'ui_search_records', description: 'Find agents, campaigns, leads, or calls by name/phone using authorized server queries. Returns descriptive matches and opaque references, or an accepted durable job. Multiple matches require user selection. For another page, supply only the returned continuation. Jobs survive navigation and closure; use jobs_read_status or open the result in Jobs.', schema: searchSchema,
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['agents', 'campaigns', 'leads', 'calls'] }, query: { type: 'string' }, continuation: { type: 'string' } }, additionalProperties: false },
      run: async (raw) => {
        const args = raw as z.infer<typeof searchSchema>;
        const signature = JSON.stringify(args);
        const idempotencyKey = requests.get(signature) ?? crypto.randomUUID();
        requests.set(signature, idempotencyKey);
        const title = args.continuation ? 'Continue record search' : `Search ${args.kind}: ${args.query}`;
        const optimistic = deps.addOptimistic(title, 'record_search');
        const route = deps.route();
        const started = Date.now();
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await fetcher('/api/copilot/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args.continuation ? { action: 'continue', ref: args.continuation, idempotencyKey } : { action: 'search', kind: args.kind, query: args.query, idempotencyKey }) });
          const body = await response.json();
          if (!response.ok) { done = true; return { ok: false, error: body.error ?? 'Search could not start.', retryable: response.status >= 500 }; }
          acceptedJobs.set(signature, body.jobId);
          void deps.refresh();
          timer = setTimeout(() => { if (!done && route === deps.route()) deps.background("This is continuing in the background. You can browse Voni and return when it is ready."); }, Math.max(0, 3000 - (Date.now() - started)));
          // The job is already durable. This short wait only serves a still-waiting copilot.
          let job = body.job as JobJson;
          while (Date.now() - started < 2400 && route === deps.route() && ['queued', 'running'].includes(job.status)) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const remaining = Math.max(1, 2500 - (Date.now() - started));
            try {
              const peek = await fetcher(`/api/jobs/${job.id}`, { signal: AbortSignal.timeout(remaining), cache: 'no-store' });
              if (!peek.ok) break;
              job = (await peek.json()).job;
            } catch { break; }
          }
          if (job.status === 'succeeded' && route === deps.route()) {
            done = true;
            void deps.refresh();
            return { ok: true, data: { accepted: true, completed: true, jobId: job.id, ...(job.result as PublicRecordResult), next: 'Ask the user to select a descriptive match if there is more than one. Open only its returned reference.' } };
          }
          if (['failed', 'cancelled'].includes(job.status)) { done = true; return { ok: false, error: job.errorMessage ?? `Search ${job.status}.`, retryable: true, note: `Job ${job.id}. Retry or cancel through Jobs.` }; }
          return { ok: true, data: { accepted: true, completed: false, jobId: job.id, status: job.status, destination: job.targetUrl, next: 'Search was accepted. Read this job status to get the matches, or open its result from Jobs. Do not say matches are ready yet.' } };
        } catch {
          done = true;
          return { ok: false, error: 'Search acceptance is uncertain. Repeat the same search to reconcile the same request, or check Jobs.', retryable: true };
        } finally {
          if (done && timer) clearTimeout(timer);
          deps.removeOptimistic(optimistic);
          void deps.refresh();
        }
      } },
    { ...common, name: 'ui_open_record', description: 'Open exactly one opaque record reference returned by ui_search_records or its completed job. Never accepts a name, raw id, path, or invented reference. Rechecks access and existence before navigation.', schema: openSchema, parameters: z.toJSONSchema(openSchema) as Record<string, unknown>,
      run: async (raw) => {
        const response = await fetcher('/api/copilot/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'open', ref: (raw as { ref: string }).ref }) });
        const body = await response.json();
        if (!response.ok) {
          const jobId = (raw as { ref: string }).ref.split('.')[0];
          for (const [signature, id] of acceptedJobs) if (id === jobId) { requests.delete(signature); acceptedJobs.delete(signature); }
          return { ok: false, error: body.error ?? 'Record is unavailable. Search again.', retryable: false };
        }
        return deps.navigate(body.destination);
      } },
  ];
}
