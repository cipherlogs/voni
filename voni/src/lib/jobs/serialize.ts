import { publicRecordResult } from "@/lib/copilot/record-contracts";
import type { JobRow } from "./store";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Creator-facing job shape. `input` is deliberately excluded: a CSV import's
 * input can hold up to 2 MB of staged text in dev, and nothing in the job
 * center needs it — results, statuses, and error states are all here.
 */
export function jobToJson(job: JobRow) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    title: job.title,
    targetUrl: job.targetUrl,
    relatedId: job.relatedId,
    result: job.kind === "record_search" ? publicRecordResult(job.result) : job.result,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    stage: job.stage,
    progressTotal: job.progressTotal,
    progressDone: job.progressDone,
    attemptCount: job.attemptCount,
    cancelRequested: job.cancelRequested,
    createdAt: iso(job.createdAt),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
    seenAt: iso(job.seenAt),
    dismissedAt: iso(job.dismissedAt),
    updatedAt: iso(job.updatedAt),
  };
}

export type JobJson = ReturnType<typeof jobToJson>;
