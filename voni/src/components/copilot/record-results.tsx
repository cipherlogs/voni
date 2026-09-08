"use client";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { JobRow } from "@/components/jobs/job-row";
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingButton } from '@/components/loading-button';
import { useJobs } from '@/components/jobs/jobs-provider';
import type { JobJson } from '@/lib/jobs/serialize';
import type { PublicRecordResult } from '@/lib/copilot/record-contracts';
export function RecordResults({ job }: { job: JobJson }) {
  const router = useRouter();
  const { refresh, addOptimistic, removeOptimistic } = useJobs();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = job.result as PublicRecordResult | null;
  async function command(action: 'open' | 'continue', ref: string) {
    if (pending) return;
    setPending(ref); setError(null);
    const key = action === 'continue' ? addOptimistic('Continue record search', 'record_search') : null;
    try {
      const res = await fetch('/api/copilot/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ref, ...(action === 'continue' ? { idempotencyKey: `continue:${ref}` } : {}) }) });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'Could not open this result.'); return; }
      if (action === 'open') router.push(body.destination);
      else { await refresh(); router.push(body.targetUrl); }
    } catch { setError('Connection interrupted. Retry this request or check Jobs.'); }
    finally { if (key) removeOptimistic(key); setPending(null); }
  }
  if (!result) return null;
  return <Card data-copilot-scope="search-results" data-copilot-key={job.id}>
    <CardHeader><CardTitle>{job.title}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {result.matches.length === 0 ? <p>No records match this search.</p> : <p>{result.matches.length} matches. Choose the record you mean.</p>}
      {result.matches.map((match) => <div key={match.ref} data-copilot-key={match.ref} className="flex items-center justify-between gap-3">
        <div><p>{match.label}</p><p className="text-muted-foreground text-sm">{match.description}</p></div>
        <LoadingButton data-copilot-effect="navigation" pending={pending === match.ref} pendingText="Opening…" aria-label={`Open ${match.label}: ${match.description}`} onClick={() => void command('open', match.ref)}>Open</LoadingButton>
      </div>)}
      {result.continuation ? <Button data-copilot-effect="view" disabled={pending === result.continuation} onClick={() => void command('continue', result.continuation!)}>{pending === result.continuation ? 'Searching…' : 'More matches'}</Button> : null}
    </CardContent>
  </Card>;
}

/** A direct result destination remains usable after reload or history pagination. */
export function RecordSearchDestination({ id }: { id: string }) {
  const { jobs } = useJobs();
  const [loaded, setLoaded] = useState<JobJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = jobs.find((job) => job.id === id) ?? loaded;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) { if (active) setError('This search is no longer available to your account.'); return; }
        const { job } = await res.json();
        if (active) { setLoaded(job); setError(null); }
      } catch { if (active) setError('Could not load this search. Reconnect to try again.'); }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [id]);
  if (error) return <Alert><AlertDescription>{error}</AlertDescription></Alert>;
  if (!current) return <p role="status">Loading search result…</p>;
  if (current.kind !== 'record_search') return <p>This job is not a record search.</p>;
  return <div className="space-y-3"><JobRow job={current} />{current.status === 'succeeded' ? <RecordResults job={current} /> : null}</div>;
}
