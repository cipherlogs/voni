import { z } from "zod";
import { db } from "@/lib/db";
import { NoProviderAvailableError } from "@/lib/llm";
import {
  JOB_INPUT_SCHEMAS,
  type JobKind,
} from "./kinds";
import {
  claimJob,
  completeJob,
  failJob,
  findGenerationPlaceholderId,
  getJobById,
  heartbeatJob,
  isCancelRequested,
  markCancelled,
  requeueJob,
  sanitizeJobError,
  type JobDb,
  type JobRow,
} from "./store";

/** How long a claimed job may run before the sweeper considers it abandoned. */
export const JOB_LEASE_MS = 10 * 60 * 1000;

/** Attempts before a repeatedly-transient job is failed permanently. */
export const MAX_JOB_ATTEMPTS = 3;

export class CancelledJobError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledJobError";
  }
}

/** Throw if the creator asked to cancel — processors call this between
 * external attempts so queued work stops immediately and running work stops
 * at the next safe boundary. */
export async function throwIfCancelled(
  jobId: string,
  database: JobDb = db,
): Promise<void> {
  if (await isCancelRequested(jobId, database)) throw new CancelledJobError();
}

/**
 * Transient = worth an automatic retry: queue/DB/network blips, 429s, 5xx.
 * Everything else is permanent: invalid input, provider exhaustion ("every
 * account failed" is a state to fix, not a blip), schema failure, credential
 * rejection, or an ordinary failed connection test — which is a completed
 * test result, not a failure at all, and never reaches this path.
 */
export function isTransientJobError(error: unknown): boolean {
  // Provider exhaustion is a state to fix (add keys, wait out cooldowns),
  // not a blip — even when the underlying attempt errors were 429s, every
  // account is now cooling down and an immediate retry would just fail
  // again. The error type wins over message-content heuristics.
  if (error instanceof NoProviderAvailableError) return false;
  if (error instanceof z.ZodError) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/NoProviderAvailableError|exhausted|invalid|validation|credential|unauthorized|forbidden|HTTP 4\d\d/i.test(message)) {
    // 429 is the one 4xx that means "try again later".
    if (/429|too many requests|rate[- ]?limit/i.test(message)) return true;
    return false;
  }
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|5\d\d|service unavailable|bad gateway|gateway timeout|temporar|try again/i.test(
    message,
  );
}

function errorCodeFor(error: unknown): Parameters<typeof failJob>[1] {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/NoProviderAvailableError|exhausted/i.test(message)) return "provider-exhausted";
  if (/stale version|newer configuration/i.test(message)) return "stale-version";
  if (/deployment|assemblyai|provision/i.test(message)) return "provider-failure";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/429|rate[- ]?limit/i.test(message)) return "rate-limited";
  if (/HTTP 401|unauthorized|credential|forbidden|HTTP 403/i.test(message)) return "auth";
  if (/not found|HTTP 404/i.test(message)) return "not-found";
  if (/conflict|duplicate|already/i.test(message)) return "conflict";
  return "unknown";
}

export type JobHandler = (job: JobRow, input: never) => Promise<unknown>;

async function handlerFor(kind: JobKind): Promise<JobHandler> {
  switch (kind) {
    case "record_search":
      return (await import("./processors/record-search")).runRecordSearchJob as JobHandler;
    case "agent_generation":
      return (await import("./processors/generation")).runGenerationJob as JobHandler;
    case "agent_deployment":
      return (await import("./processors/deployment")).runDeploymentJob as JobHandler;
    case "integration_test":
      return (await import("./processors/integration-test")).runIntegrationTestJob as JobHandler;
    case "lead_csv_import":
      return (await import("./processors/csv-import")).runCsvImportJob as JobHandler;
  }
}

/**
 * Execute one job: claim (idempotent under duplicate delivery), validate
 * input, run, then complete / retry-transient / fail-permanent. Never throws
 * for job-domain outcomes — a crash would burn an infrastructure retry and
 * re-run work that already finished.
 */
export async function runJob(jobId: string, database: JobDb = db): Promise<void> {
  const claimed = await claimJob(jobId, JOB_LEASE_MS, database);
  if (!claimed) return;

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    void heartbeatJob(jobId, JOB_LEASE_MS, database).catch(() => undefined);
  }, Math.floor(JOB_LEASE_MS / 3));
  try {
    const schema = JOB_INPUT_SCHEMAS[claimed.kind as JobKind];
    if (!schema) {
      await failJob(jobId, "invalid-input", `Unknown job kind: ${claimed.kind}.`, database);
      return;
    }
    const parsed = schema.safeParse(claimed.input);
    if (!parsed.success) {
      await failJob(jobId, "invalid-input", "The job input is invalid.", database);
      return;
    }
    await throwIfCancelled(jobId, database);
    const handler = await handlerFor(claimed.kind as JobKind);
    const result = await handler(claimed, parsed.data as never);
    await throwIfCancelled(jobId, database);
    // Finished generation jobs land on the placeholder detail page. The
    // placeholder row is created client-side after start, so resolve it here
    // at completion; when there is none (older jobs, failed write) the ?job=
    // URL from start stays.
    let targetUrl: string | undefined;
    if (claimed.kind === "agent_generation") {
      const placeholderId = await findGenerationPlaceholderId(
        jobId,
        database,
      ).catch(() => null);
      if (placeholderId) targetUrl = `/agents/${placeholderId}`;
    }
    const ok = await completeJob(jobId, result, database, targetUrl);
    if (!ok) {
      console.warn(
        `[jobs] job ${jobId} finished but was no longer running (cancelled or retried).`,
      );
    }
    console.log(
      `[jobs] job ${jobId} kind=${claimed.kind} status=succeeded attempt=${claimed.attemptCount + 1} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    if (error instanceof CancelledJobError || (await isCancelRequested(jobId, database))) {
      await markCancelled(jobId, database);
      console.log(`[jobs] job ${jobId} kind=${claimed.kind} status=cancelled`);
      return;
    }
    const attempts = claimed.attemptCount + 1;
    if (isTransientJobError(error) && attempts < MAX_JOB_ATTEMPTS) {
      await requeueJob(jobId, database);
      const { enqueueJobMessage } = await import("./queue");
      await enqueueJobMessage({ jobId, kind: claimed.kind }).catch(() => undefined);
      console.warn(
        `[jobs] job ${jobId} kind=${claimed.kind} status=requeued attempt=${attempts} error=${sanitizeJobError(error)}`,
      );
      return;
    }
    const code = errorCodeFor(error);
    await failJob(jobId, code, sanitizeJobError(error) || "The job failed.", database);
    console.warn(
      `[jobs] job ${jobId} kind=${claimed.kind} status=failed attempt=${attempts} code=${code} durationMs=${Date.now() - startedAt}`,
    );
  } finally {
    clearInterval(heartbeat);
  }
}

export const jobExecutor = {
  execute: runJob,
};

/** Read-only peek for the queue consumer: skip messages for terminal jobs. */
export async function isJobQueued(id: string, database: JobDb = db): Promise<boolean> {
  const job = await getJobById(id, database);
  return job?.status === "queued";
}
