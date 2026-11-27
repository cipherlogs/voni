/**
 * Custom OpenNext worker: the generated fetch handler plus queue and
 * scheduled handlers for durable background jobs.
 *
 * Both handlers re-dispatch through internal routes on the generated fetch
 * handler (POST /api/internal/jobs/consume and .../sweep, then .../sources/tick
 * after the sweep) rather than importing app code here: the OpenNext server
 * bundle already resolves @/ aliases, next/cache, and the AI SDK with its
 * workerd patches, while a second hand-bundled copy of the same modules fails
 * to resolve them.
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

// A relative import, not `@/`: this file is bundled by wrangler outside the
// OpenNext server bundle, so the alias would not resolve. The module is pure
// and dependency-free on purpose.
import { createInternalCaller, type WorkerContext } from "./src/lib/jobs/internal-call";

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

/**
 * Call back into our own server; non-2xx becomes an infra retry / DLQ.
 *
 * `env` and `ctx` are not optional here: the generated handler dereferences
 * both before it runs a route (`Object.entries(env)`, `ctx.waitUntil.bind`),
 * so the three-argument call is the only working shape. See
 * `src/lib/jobs/internal-call.ts` for what happens when it is not.
 */
const callInternal = createInternalCaller(handler.fetch);

const worker = {
  fetch: handler.fetch,

  async queue(batch: QueueBatch, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
    const secret = workerSecret(env);
    for (const message of batch.messages) {
      await callInternal(
        "/api/internal/jobs/consume",
        secret,
        { message: message.body },
        env,
        ctx,
      );
    }
  },

  async scheduled(
    _event: unknown,
    env: WorkerEnv,
    ctx: WorkerContext,
  ): Promise<void> {
    const secret = workerSecret(env);

    // Jobs first, and a sweep failure still fails the cron: a job that is not
    // swept is lost work. The source ticker runs after it and is subordinate —
    // it merely asks whether a runner loop needs restarting, so an unreachable
    // route, a missing database row or a GitHub outage must not turn the sweep
    // into a failed invocation and must not be retried as though jobs were at
    // stake.
    await callInternal("/api/internal/jobs/sweep", secret, {}, env, ctx);
    try {
      await callInternal("/api/internal/sources/tick", secret, {}, env, ctx);
    } catch (error) {
      console.error("sources: tick failed", error);
    }
  },
};

export default worker;
