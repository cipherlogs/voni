/**
 * Custom OpenNext worker: the generated fetch handler plus queue and
 * scheduled handlers for durable background jobs.
 *
 * Both handlers re-dispatch through internal routes on the generated fetch
 * handler (POST /api/internal/jobs/consume and .../sweep) rather than
 * importing app code here: the OpenNext server bundle already resolves @/
 * aliases, next/cache, and the AI SDK with its workerd patches, while a
 * second hand-bundled copy of the same modules fails to resolve them.
 * Queue messages carry only `{ jobId, kind }`; Postgres owns the truth.
 */

// The generated artifact exists after an OpenNext build but not on a fresh
// checkout — @ts-ignore (per the upstream custom-worker docs) tolerates both,
// unlike @ts-expect-error which errors when the artifact is present.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore `.open-next/worker.ts` is generated at build time
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";

type WorkerEnv = {
  JOB_QUEUE?: { send: (message: unknown) => Promise<void> };
  JOB_WORKER_SECRET?: string;
};

type QueueBatch = {
  messages: { body: unknown }[];
};

function workerSecret(env: WorkerEnv): string {
  if (!env.JOB_WORKER_SECRET) {
    throw new Error("JOB_WORKER_SECRET binding is missing.");
  }
  return env.JOB_WORKER_SECRET;
}

/** Call back into our own server; non-2xx becomes an infra retry / DLQ. */
async function callInternal(
  path: string,
  secret: string,
  body: unknown,
): Promise<void> {
  const response = await handler.fetch(
    new Request(`https://voni.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voni-worker-secret": secret,
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    throw new Error(`internal ${path} failed with ${response.status}`);
  }
}

const worker = {
  fetch: handler.fetch,

  async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
    const secret = workerSecret(env);
    for (const message of batch.messages) {
      await callInternal("/api/internal/jobs/consume", secret, {
        message: message.body,
      });
    }
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    await callInternal("/api/internal/jobs/sweep", workerSecret(env), {});
  },
};

export default worker;
