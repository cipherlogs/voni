/**
 * The internal call must carry `env` and `ctx`.
 *
 * This is the exact regression that left the deployed cron broken: the worker
 * called the generated fetch handler with only a `Request`, the handler read
 * `Object.entries(env)` on `undefined`, and every tick threw before reaching a
 * route. Nothing downstream could see it — the queue consumer and the `/email`
 * source ticker simply never ran, while the console kept promising clicks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NO_CONTEXT, createInternalCaller } from "./internal-call";

type Seen = { url: string; secret: string | null; body: unknown; env: unknown; ctx: unknown };

function spy(status = 200): { calls: Seen[]; fetch: Parameters<typeof createInternalCaller>[0] } {
  const calls: Seen[] = [];
  return {
    calls,
    fetch: async (request, env, ctx) => {
      calls.push({
        url: request.url,
        secret: request.headers.get("x-voni-worker-secret"),
        body: await request.text(),
        env,
        ctx,
      });
      return new Response(null, { status });
    },
  };
}

test("the bound environment and execution context reach the handler", async () => {
  const recorded = spy();
  const callInternal = createInternalCaller(recorded.fetch);
  const env = { JOB_WORKER_SECRET: "s3cret", JOB_QUEUE: { send: async () => {} } };
  const waitUntil = () => {};
  const ctx = { waitUntil, passThroughOnException: () => {} };

  await callInternal("/api/internal/sources/tick", "s3cret", { dryRun: true }, env, ctx);

  assert.equal(recorded.calls.length, 1);
  const [call] = recorded.calls;
  assert.equal(call.url, "https://voni.internal/api/internal/sources/tick");
  assert.equal(call.secret, "s3cret");
  assert.deepEqual(JSON.parse(String(call.body)), { dryRun: true });
  assert.equal(call.env, env, "env is forwarded, not dropped");
  assert.equal(call.ctx, ctx, "ctx is forwarded, not dropped");
});

test("a missing execution context is replaced, never passed as undefined", async () => {
  const recorded = spy();
  const callInternal = createInternalCaller(recorded.fetch);

  await callInternal("/api/internal/jobs/sweep", "s3cret", {}, {}, undefined);

  assert.deepEqual(recorded.calls[0].ctx, NO_CONTEXT);
});

test("a non-2xx answer throws, so a cron retries and a queue message can be dead-lettered", async () => {
  const callInternal = createInternalCaller(spy(503).fetch);
  await assert.rejects(
    () => callInternal("/api/internal/jobs/sweep", "s3cret", {}, {}, undefined),
    /internal \/api\/internal\/jobs\/sweep failed with 503/,
  );
});
