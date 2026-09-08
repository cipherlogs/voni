import { ImportCancelledError, processCsvImport } from "@/lib/leads/import";
import { JOB_LEASE_MS, CancelledJobError, throwIfCancelled } from "../processor";
import { deleteStagedCsv, readStagedCsv } from "../queue";
import { safeRevalidatePath } from "../revalidate";
import { heartbeatJob, isCancelRequested } from "../store";
import type { JobInput } from "../kinds";
import type { JobRow } from "../store";

/**
 * lead_csv_import: parse a staged CSV and upsert leads + campaign members.
 *
 * The upload route enforces the 2 MB cap and stages the bytes (R2 in
 * production, inline in dev); this processor only ever reads the staged
 * source. Chunked upserts with progress heartbeats make long imports
 * resumable: a retry re-runs idempotent statements rather than duplicating
 * work. Cancellation is honored between chunks.
 */
export async function runCsvImportJob(
  job: JobRow,
  input: JobInput<"lead_csv_import">,
) {
  await throwIfCancelled(job.id);
  const csvText = await readStagedCsv(input);
  await throwIfCancelled(job.id);
  try {
    const summary = await processCsvImport({
      organizationId: job.organizationId,
      campaignId: input.campaignId,
      csvText,
      onProgress: async (done, total) => {
        await heartbeatJob(job.id, JOB_LEASE_MS, undefined, {
          stage: "importing",
          progressTotal: total,
          progressDone: done,
        });
      },
      shouldCancel: () => isCancelRequested(job.id),
    });
    await throwIfCancelled(job.id);
    if (input.r2Key) await deleteStagedCsv(input.r2Key);
    safeRevalidatePath("/campaigns");
    safeRevalidatePath(`/campaigns/${input.campaignId}`);
    safeRevalidatePath("/leads");
    return { campaignId: input.campaignId, ...summary };
  } catch (error) {
    if (error instanceof ImportCancelledError) throw new CancelledJobError();
    throw error;
  }
}
