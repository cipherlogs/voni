import { testIntegration } from "@/lib/platform/checks";
import { throwIfCancelled } from "../processor";
import type { JobInput } from "../kinds";
import type { JobRow } from "../store";

/**
 * integration_test: run one provider/service connectivity probe.
 *
 * A failed connectivity check is a *completed test result*, not a job
 * failure — the result row (including the history row `testIntegration`
 * writes) carries the failure, and the job succeeds. Only infrastructure
 * errors (no credential resolver, DB down) throw.
 */
export async function runIntegrationTestJob(
  job: JobRow,
  input: JobInput<"integration_test">,
) {
  await throwIfCancelled(job.id);
  const tested = await testIntegration(
    input.service,
    job.creatorId,
    fetch,
    input.accountId,
  );
  await throwIfCancelled(job.id);
  return {
    service: input.service,
    status: tested.status,
    latencyMs: tested.latencyMs,
    error: tested.error,
    testedAt: tested.testedAt.toISOString(),
  };
}
