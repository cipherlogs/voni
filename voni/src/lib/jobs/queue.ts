/**
 * Enqueueing and staged-file access for background jobs.
 *
 * Production always goes through the Cloudflare Queue binding (`JOB_QUEUE`):
 * messages carry only `{ jobId, kind }`. Under `next dev` there is no queue,
 * so the same processor runs in-process instead — same code path, no
 * duplicated logic. Callers never need to know which one was used.
 */

export type JobMessage = { jobId: string; kind: string };

type SendableQueue = { send: (message: unknown) => Promise<void> };

async function getQueueBinding(): Promise<SendableQueue | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const queue = (env as Record<string, unknown>).JOB_QUEUE as
      | SendableQueue
      | undefined;
    return queue && typeof queue.send === "function" ? queue : undefined;
  } catch {
    return undefined;
  }
}

export async function enqueueJobMessage(
  message: JobMessage,
): Promise<"queue" | "inline"> {
  // OpenNext exposes an emulated producer in next dev without running a
  // Queue consumer. Sending there strands durable rows in queued forever.
  const queue = process.env.NODE_ENV === "development" ? undefined : await getQueueBinding();
  if (queue) {
    await queue.send(message);
    return "queue";
  }
  // Development dispatcher: same processor, in-process. Fire and forget —
  // the job row is already durable, and the response must return in <1s.
  const { runJob } = await import("./processor");
  void runJob(message.jobId).catch((error) => {
    console.error(`[jobs] inline processor failed for ${message.jobId}`, error);
  });
  return "inline";
}

export type CsvSource =
  | { kind: "r2"; key: string }
  | { kind: "inline"; text: string };

type R2BucketLike = {
  put: (key: string, value: ArrayBuffer | string) => Promise<unknown>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  delete: (key: string) => Promise<void>;
};

async function getCsvBucket(): Promise<R2BucketLike | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as Record<string, unknown>).CSV_STAGING as
      | R2BucketLike
      | undefined;
    return bucket && typeof bucket.put === "function" ? bucket : undefined;
  } catch {
    return undefined;
  }
}

/** Stage CSV bytes privately. Falls back to inline storage when no R2
 * binding exists (local dev); the 2 MB cap applies on both paths. */
export async function stageCsv(
  organizationId: string,
  jobId: string,
  fileName: string,
  bytes: ArrayBuffer,
): Promise<{ r2Key?: string; csvText?: string }> {
  const bucket = await getCsvBucket();
  if (!bucket) {
    return { csvText: new TextDecoder().decode(bytes) };
  }
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const key = `${organizationId}/${jobId}/${Date.now()}-${safeName || "import.csv"}`;
  await bucket.put(key, bytes);
  return { r2Key: key };
}

export async function readStagedCsv(source: {
  r2Key?: string;
  csvText?: string;
}): Promise<string> {
  if (source.csvText !== undefined) return source.csvText;
  if (!source.r2Key) throw new Error("CSV import has no staged file.");
  const bucket = await getCsvBucket();
  if (!bucket) throw new Error("CSV staging is unavailable.");
  const object = await bucket.get(source.r2Key);
  if (!object) throw new Error("The staged CSV file expired.");
  return object.text();
}

export async function deleteStagedCsv(r2Key: string): Promise<void> {
  const bucket = await getCsvBucket();
  if (!bucket) return;
  await bucket.delete(r2Key).catch(() => undefined);
}
