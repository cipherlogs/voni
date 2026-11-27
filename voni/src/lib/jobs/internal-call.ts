/**
 * The worker's one way back into its own server.
 *
 * The custom worker re-dispatches queue and cron work through internal routes
 * on the generated OpenNext fetch handler rather than importing app code. That
 * handler is `(request, env, ctx) => …`, and before it runs any route it does
 * two things with the last two arguments:
 *
 *   - `Object.entries(env)` — to copy string bindings onto `process.env`
 *   - `ctx.waitUntil.bind(ctx)` — to give the route an execution context
 *
 * Calling it with the request alone therefore throws before the route is
 * reached. That is not hypothetical: every cron tick of the deployed worker
 * failed with `TypeError: Cannot convert undefined or null to object` at
 * `.open-next/middleware/handler.mjs`, so the job sweep, the queue consumer and
 * the `/email` source ticker never ran. The only thing that ever ran was
 * `worker.fetch`, which Cloudflare calls with all three arguments.
 *
 * This module exists so that forwarding `env` and `ctx` is a thing a test can
 * prove, rather than a line a future edit can drop again.
 */

/** The Cloudflare execution context, as much of it as this worker uses. */
export type WorkerContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
  passThroughOnException?: () => void;
};

/** The generated handler's shape; `env` and `ctx` are forwarded untouched. */
export type InternalFetch = (
  request: Request,
  env: unknown,
  ctx: unknown,
) => Promise<Response>;

/** A route that captures nothing needs a context that does nothing. */
export const NO_CONTEXT: WorkerContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

/**
 * Build the caller bound to one fetch handler — the real worker binds it to the
 * generated `.open-next/worker.js` handler, a test binds it to a spy.
 *
 * A non-2xx answer becomes a throw: that is what turns a failed internal call
 * into a cron retry or a queue message going to the DLQ.
 */
export function createInternalCaller(fetch: InternalFetch) {
  return async function callInternal(
    path: string,
    secret: string,
    body: unknown,
    env: unknown,
    ctx: WorkerContext | undefined,
  ): Promise<void> {
    const response = await fetch(
      new Request(`https://voni.internal${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voni-worker-secret": secret,
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx ?? NO_CONTEXT,
    );
    if (!response.ok) {
      throw new Error(`internal ${path} failed with ${response.status}`);
    }
  };
}
