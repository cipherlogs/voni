import { db } from "@/lib/db";
import { isJobQueued, runJob } from "./processor";
import type { JobDb } from "./store";

/**
 * One Cloudflare Queue message. Shared by the production consumer
 * (worker.ts) and the integration smoke test, so the parse/ack/ignore
 * rules are verified in exactly one place.
 *
 * Returns "ignored" for malformed messages and for jobs that are no longer
 * queued (duplicate delivery, cancelled, already finished) — those ack
 * without work. "processed" means runJob owned the outcome, including
 * recorded failures. Unexpected throws propagate so the infrastructure
 * retry (then the dead-letter queue) handles worker crashes.
 */
export async function consumeMessage(
  body: unknown,
  database: JobDb = db,
): Promise<"ignored" | "processed"> {
  if (!body || typeof body !== "object") {
    console.error("[jobs] ignoring malformed queue message");
    return "ignored";
  }
  const { jobId, kind } = body as { jobId?: unknown; kind?: unknown };
  if (typeof jobId !== "string" || typeof kind !== "string") {
    console.error("[jobs] ignoring malformed queue message");
    return "ignored";
  }
  if (!(await isJobQueued(jobId, database))) return "ignored";
  await runJob(jobId, database);
  return "processed";
}
