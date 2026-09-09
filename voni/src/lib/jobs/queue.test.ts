import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWithRuntime } from "./queue";

const message = { jobId: "job-1", kind: "agent_generation" };

test("production queue success dispatches without local execution", async () => {
  let executed = 0;
  const result = await dispatchWithRuntime(message, {
    runtime: { queue: { send: async () => undefined } },
    development: false,
    execute: async () => { executed += 1; },
    markWaiting: async () => undefined,
  });
  assert.deepEqual(result, { state: "dispatched", channel: "queue" });
  assert.equal(executed, 0);
});

test("queue-send failure returns recovery-pending and uses waitUntil", async () => {
  let marked = 0;
  let waited: Promise<unknown> | null = null;
  const result = await dispatchWithRuntime(message, {
    runtime: {
      queue: { send: async () => { throw new Error("send failed"); } },
      waitUntil: (promise) => { waited = promise; },
    },
    development: false,
    execute: async () => undefined,
    markWaiting: async () => { marked += 1; },
  });
  assert.deepEqual(result, { state: "recovery-pending", channel: "wait-until" });
  assert.equal(marked, 1);
  assert.ok(waited);
  await waited;
});

test("missing production binding remains durable for cron recovery", async () => {
  let executed = 0;
  const result = await dispatchWithRuntime(message, {
    runtime: {},
    development: false,
    execute: async () => { executed += 1; },
    markWaiting: async () => undefined,
  });
  assert.deepEqual(result, { state: "recovery-pending", channel: "cron" });
  assert.equal(executed, 0);
});

test("development runs the shared executor inline", async () => {
  let executed = 0;
  const result = await dispatchWithRuntime(message, {
    runtime: {},
    development: true,
    execute: async () => { executed += 1; },
    markWaiting: async () => undefined,
  });
  assert.deepEqual(result, { state: "inline", channel: "inline" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, 1);
});
