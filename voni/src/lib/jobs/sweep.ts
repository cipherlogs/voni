import { jobExecutor, MAX_JOB_ATTEMPTS, JOB_LEASE_MS } from "./processor";
import {
  deleteTerminalJobsOlderThan,
  findAbandonedJobs,
  findMissedJobs,
  markQueuedStage,
  recoverAbandonedJob,
} from "./store";

export const MISSED_JOB_MS = 45 * 1000;
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Periodic maintenance, run by the worker's scheduled handler (production)
 * via POST /api/internal/jobs/sweep:
 *
 * - Missed queue messages are claimed and executed directly. Claiming is
 *   idempotent, so overlapping cron invocations and late delivery converge.
 * - Abandoned leases (worker died mid-flight) are taken over while attempts
 *   remain, then executed directly; exhausted ones are already failed by the
 *   takeover.
 * - Terminal jobs past retention are hard-deleted.
 */
export async function sweepJobs(
  execute: (jobId: string) => Promise<void> = jobExecutor.execute,
): Promise<{ started: number; recovered: number; exhausted: number; deleted: number }> {
  let started = 0;
  let recovered = 0;
  let exhausted = 0;

  const missed = await findMissedJobs(MISSED_JOB_MS);
  for (const job of missed) {
    if (!(await markQueuedStage(job.id, "recovery-started"))) continue;
    await execute(job.id).catch((error) =>
      console.error(`[jobs] recovery execution failed for ${job.id}: ${error instanceof Error ? error.name : "unknown"}`),
    );
    started += 1;
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
    await markQueuedStage(job.id, "recovery-started");
    await execute(job.id).catch((error) =>
      console.error(`[jobs] recovered execution failed for ${job.id}: ${error instanceof Error ? error.name : "unknown"}`),
    );
    recovered += 1;
    console.warn(`[jobs] job ${job.id} lease recovered, requeued`);
  }

  const deleted = await deleteTerminalJobsOlderThan(TERMINAL_RETENTION_MS);
  if (deleted > 0) console.log(`[jobs] retention swept ${deleted} terminal jobs`);
  return { started, recovered, exhausted, deleted };
}
