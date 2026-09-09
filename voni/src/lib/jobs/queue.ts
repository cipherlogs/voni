/**
 * Enqueueing and staged-file access for background jobs.
 *
 * Production prefers the Cloudflare Queue binding (`JOB_QUEUE`); a failed or
 * missing send falls back to request-lifetime execution, then one-minute Cron.
 * Under `next dev` the same processor runs in-process. Messages carry only
 * `{ jobId, kind }`, while Neon remains the durable source of truth.
 */

import type {
  DispatchResult,
  JobDispatcher,
  JobMessage,
  StagedBlobStore,
} from "./contracts";
import { markQueuedStage } from "./store";

type SendableQueue = { send: (message: unknown) => Promise<void> };

export type RuntimeBindings = {
  queue?: SendableQueue;
  waitUntil?: (promise: Promise<unknown>) => void;
};

async function getRuntimeBindings(): Promise<RuntimeBindings> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env, ctx } = await getCloudflareContext({ async: true });
    const queue = (env as Record<string, unknown>).JOB_QUEUE as
      | SendableQueue
      | undefined;
    return {
      queue: queue && typeof queue.send === "function" ? queue : undefined,
      waitUntil:
        ctx && typeof ctx.waitUntil === "function"
          ? ctx.waitUntil.bind(ctx)
          : undefined,
    };
  } catch {
    return {};
  }
}

export async function dispatchWithRuntime(
  message: JobMessage,
  options: {
    runtime: RuntimeBindings;
    development: boolean;
    execute: (jobId: string) => Promise<void>;
    markWaiting: (jobId: string) => Promise<unknown>;
  },
): Promise<DispatchResult> {
  const { runtime, development, execute, markWaiting } = options;
  if (!development) {
    if (runtime.queue) {
      try {
        await runtime.queue.send(message);
        return { state: "dispatched", channel: "queue" };
      } catch {
        // The Neon row already committed; dispatch failure must not make the
        // accepted submission appear to have failed.
      }
    }
    await markWaiting(message.jobId).catch(() => undefined);
    if (runtime.waitUntil) {
      const work = execute(message.jobId);
      runtime.waitUntil(work);
      return { state: "recovery-pending", channel: "wait-until" };
    }
    return { state: "recovery-pending", channel: "cron" };
  }

  const work = execute(message.jobId).catch((error) => {
    console.error(
      `[jobs] inline processor failed for ${message.jobId}: ${error instanceof Error ? error.name : "unknown"}`,
    );
  });
  runtime.waitUntil?.(work);
  if (!runtime.waitUntil) void work;
  return { state: "inline", channel: "inline" };
}

export const cloudflareJobDispatcher: JobDispatcher = {
  async dispatch(message): Promise<DispatchResult> {
    const runtime = await getRuntimeBindings();
    const { runJob } = await import("./processor");
    return dispatchWithRuntime(message, {
      runtime,
      development: process.env.NODE_ENV === "development",
      execute: runJob,
      markWaiting: (jobId) => markQueuedStage(jobId, "waiting-for-worker"),
    });
  },
};

export async function enqueueJobMessage(
  message: JobMessage,
): Promise<DispatchResult> {
  return cloudflareJobDispatcher.dispatch(message);
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

const r2StagedBlobStore: StagedBlobStore = {
  async put(key, value) {
    const bucket = await getCsvBucket();
    if (!bucket) throw new Error("CSV staging is unavailable.");
    await bucket.put(key, value);
  },
  async read(key) {
    const bucket = await getCsvBucket();
    if (!bucket) return null;
    const object = await bucket.get(key);
    return object?.text() ?? null;
  },
  async delete(key) {
    const bucket = await getCsvBucket();
    if (bucket) await bucket.delete(key);
  },
};

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
  await r2StagedBlobStore.put(key, bytes);
  return { r2Key: key };
}

export async function readStagedCsv(source: {
  r2Key?: string;
  csvText?: string;
}): Promise<string> {
  if (source.csvText !== undefined) return source.csvText;
  if (!source.r2Key) throw new Error("CSV import has no staged file.");
  const text = await r2StagedBlobStore.read(source.r2Key);
  if (text === null) throw new Error("The staged CSV file expired or staging is unavailable.");
  return text;
}

export async function deleteStagedCsv(r2Key: string): Promise<void> {
  await r2StagedBlobStore.delete(r2Key).catch(() => undefined);
}
