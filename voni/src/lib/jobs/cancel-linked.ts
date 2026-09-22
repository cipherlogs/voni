import { and, eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { backgroundJobs } from "@/lib/db/schema";

/**
 * Shared delete-rail job helpers for `deleteAgentAction` and
 * `deleteCampaignAction`.
 *
 * Both deletes follow the same rail: cancel in-flight linked jobs first so
 * workers converge instead of failing on a row that disappears mid-run,
 * then hard-delete only terminal rows by id (never by title — names are not
 * unique). Still-running rows keep their `cancelRequested` flag so the
 * worker observes the signal at its next boundary; the retention sweeper
 * removes the cancelled tombstones later.
 */
export type LinkedJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type LinkedJobRef = {
  id: string;
  status: LinkedJobStatus;
};

export type FreshLinkedJobRef = LinkedJobRef & {
  cancelRequested: boolean;
};

/**
 * Cancel one linked job. A worker can claim a job (queued -> running) at any
 * point during a delete, so the queued-cancel update is guarded on
 * status='queued' and reads back affected rows (.returning): zero affected
 * rows means a claimJob flipped the row to running, and the fallback flags
 * the now-running row so the worker converges to cancelled.
 */
export async function cancelOneLinkedJob(
  jobId: string,
  status: LinkedJobStatus,
  cancelledMessage: string,
): Promise<void> {
  if (status === "queued") {
    const updated = await db
      .update(backgroundJobs)
      .set({
        status: "cancelled",
        errorCode: "cancelled",
        errorMessage: cancelledMessage,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.status, "queued")),
      )
      .returning({ id: backgroundJobs.id });
    if (updated.length > 0) return;
    // Lost a claim race: the job is running now. Flag it so the worker
    // observes the cancel at its next boundary and converges to cancelled.
    await db
      .update(backgroundJobs)
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.status, "running"),
        ),
      );
  } else if (status === "running") {
    await db
      .update(backgroundJobs)
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId));
  }
}

/** Cancel every linked job in a frozen discovery set. */
export async function cancelLinkedJobs(
  jobs: LinkedJobRef[],
  cancelledMessage: string,
): Promise<void> {
  for (const job of jobs) {
    await cancelOneLinkedJob(job.id, job.status, cancelledMessage);
  }
}

/**
 * Cancel a fresh re-discovery sweep: still-queued rows are cancelled, and
 * running rows without the flag get it. Covers jobs claimed or enqueued
 * between the first cancel pass and the row delete.
 */
export async function cancelFreshLinkedJobs(
  jobs: FreshLinkedJobRef[],
  cancelledMessage: string,
): Promise<void> {
  for (const job of jobs) {
    if (job.status === "queued") {
      await cancelOneLinkedJob(job.id, job.status, cancelledMessage);
    } else if (job.status === "running" && !job.cancelRequested) {
      await db
        .update(backgroundJobs)
        .set({ cancelRequested: true, updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
    }
  }
}

/**
 * Hard-delete only terminal rows (succeeded/failed/cancelled) by id,
 * org-scoped. Running/queued rows survive so workers still see the cancel
 * signal.
 */
export async function deleteTerminalLinkedJobs(
  jobIds: Iterable<string>,
  organizationId: string,
): Promise<void> {
  for (const jobId of jobIds) {
    await db
      .delete(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.organizationId, organizationId),
          or(
            eq(backgroundJobs.status, "succeeded"),
            eq(backgroundJobs.status, "failed"),
            eq(backgroundJobs.status, "cancelled"),
          ),
        ),
      );
  }
}
