"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCtx } from "@/lib/session";
import { enqueueJobMessage } from "@/lib/jobs/queue";
import { getJob, requestCancel, retryJob } from "@/lib/jobs/store";

/**
 * Bulk retry / cancel for the /jobs page triage bar. Loops the creator-scoped
 * single-job transitions (`requestCancel` / `retryJob`) instead of adding a
 * bulk SQL path, so bulk inherits the same guards — no new job kinds, no
 * schema changes. Every id resolves to success or a per-id failure message;
 * nothing throws across the boundary.
 */

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  op: z.enum(["retry", "cancel"]),
});

export type BulkJobFailure = { id: string; message: string };

export type BulkJobsResult =
  | { ok: true; succeeded: string[]; failed: BulkJobFailure[] }
  | { ok: false; succeeded: string[]; failed: BulkJobFailure[] }
  | { ok: false; succeeded: []; failed: []; message: string };

export async function bulkJobsAction(raw: unknown): Promise<BulkJobsResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return {
      ok: false,
      succeeded: [],
      failed: [],
      message: "Sign in again to manage jobs.",
    };
  }

  const parsed = bulkSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      succeeded: [],
      failed: [],
      message: "Pick up to 200 jobs to retry or cancel.",
    };
  }

  const succeeded: string[] = [];
  const failed: BulkJobFailure[] = [];
  for (const id of new Set(parsed.data.ids)) {
    try {
      if (parsed.data.op === "cancel") {
        const job = await requestCancel(ctx.organizationId, ctx.userId, id);
        if (!job) {
          failed.push({ id, message: "Job not found." });
        } else if (
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "cancelled"
        ) {
          failed.push({ id, message: "Already finished — nothing to cancel." });
        } else {
          succeeded.push(id);
        }
      } else {
        const current = await getJob(ctx.organizationId, ctx.userId, id);
        if (!current) {
          failed.push({ id, message: "Job not found." });
        } else if (
          current.status !== "failed" &&
          current.status !== "cancelled"
        ) {
          failed.push({
            id,
            message: "Only failed or cancelled jobs can be retried.",
          });
        } else {
          const retried = await retryJob(ctx.organizationId, ctx.userId, id);
          if (!retried || retried.status !== "queued") {
            failed.push({ id, message: "Could not be retried — try again." });
          } else {
            await enqueueJobMessage({ jobId: retried.id, kind: retried.kind });
            succeeded.push(id);
          }
        }
      }
    } catch {
      failed.push({ id, message: "That did not work — try again." });
    }
  }

  revalidatePath("/jobs");
  return { ok: failed.length === 0, succeeded, failed } as BulkJobsResult;
}
