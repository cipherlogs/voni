import { MAX_JOB_ATTEMPTS, JOB_LEASE_MS } from "./processor";
import {
  deleteTerminalJobsOlderThan,
  findAbandonedJobs,
  findMissedJobs,
  recoverAbandonedJob,
} from "./store";

export const MISSED_JOB_MS = 10 * 60 * 1000;
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Periodic maintenance, run by the worker's scheduled handler (production)
 * via POST /api/internal/jobs/sweep:
 *
 * - Missed queue messages are republished so claiming can proceed. Claiming
 *   is idempotent, so a message that was merely slow causes no harm.
 * - Abandoned leases (worker died mid-flight) are taken over while attempts
 *   remain, then republished; exhausted ones are already failed by the
 *   takeover.
 * - Terminal jobs past retention are hard-deleted.
 */
export async function sweepJobs(
  publish: (message: { jobId: string; kind: string }) => Promise<void>,
): Promise<{ republished: number; recovered: number; exhausted: number; deleted: number }> {
  let republished = 0;
  let recovered = 0;
  let exhausted = 0;

  const missed = await findMissedJobs(MISSED_JOB_MS);
  for (const job of missed) {
    await publish({ jobId: job.id, kind: job.kind }).catch((error) =>
      console.error(`[jobs] republish failed for ${job.id}`, error),
    );
    republished += 1;
  }

  const abandoned = await findAbandonedJobs();
  for (const job of abandoned) {
    const outcome = await recoverAbandonedJob(job.id, JOB_LEASE_MS, MAX_JOB_ATTEMPTS);
    if (outcome === null) continue;
    if (outcome === "exhausted") {
      exhausted += 1;
      console.warn(`[jobs] job ${job.id} lease-exhausted`);
      continue;
    }
    await publish({ jobId: job.id, kind: job.kind }).catch((error) =>
      console.error(`[jobs] republish failed for ${job.id}`, error),
    );
    recovered += 1;
    console.warn(`[jobs] job ${job.id} lease recovered, requeued`);
  }

  const deleted = await deleteTerminalJobsOlderThan(TERMINAL_RETENTION_MS);
  if (deleted > 0) console.log(`[jobs] retention swept ${deleted} terminal jobs`);
  return { republished, recovered, exhausted, deleted };
}
