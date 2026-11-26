/**
 * The client's two configured sizes, and the pool they actually build.
 *
 * The default matters as much as the value: a dispatch that carries no target
 * must still fill to five, and a depth of three is the ticket's default. The
 * last test drives `createExitPool` with the parsed values, so "the setting
 * reaches the client" is proved on the pool's own snapshot rather than on the
 * parser alone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createExitPool, type PoolSession } from "./pool";
import {
  POOL_DEPTH_ENV,
  POOL_TARGET_ENV,
  PoolConfigError,
  poolConfigFromEnv,
} from "./config";

const DEFAULT = { target: 5, depth: 3 };

/** The pool reads only the account frame before it starts, so this is enough. */
function inertSession(): PoolSession {
  return {
    requestChange: async () => ({ kind: "not-available", tag: "inert" }),
    snapshot: () =>
      ({
        account: { resetAt: null, changesUsed: null, changesLimit: null },
        clientIp: null,
        state: "connected",
      }) as unknown as ReturnType<PoolSession["snapshot"]>,
  } as unknown as PoolSession;
}

test("an unset or blank environment is the documented default", () => {
  for (const env of [{}, { [POOL_TARGET_ENV]: "", [POOL_DEPTH_ENV]: "  " }]) {
    assert.deepEqual(poolConfigFromEnv(env), DEFAULT);
  }
});

test("the configured target and depth are what the client is told", () => {
  assert.deepEqual(
    poolConfigFromEnv({ [POOL_TARGET_ENV]: "8", [POOL_DEPTH_ENV]: "0" }),
    { target: 8, depth: 0 },
  );
  assert.deepEqual(
    poolConfigFromEnv({ [POOL_TARGET_ENV]: "3", [POOL_DEPTH_ENV]: "1" }),
    { target: 3, depth: 1 },
  );
});

test("a target outside three to eight is refused, not clamped", () => {
  for (const value of ["2", "9", "0", "3.5", "five", "-1", "75"]) {
    assert.throws(
      () => poolConfigFromEnv({ [POOL_TARGET_ENV]: value }),
      (error: unknown) =>
        error instanceof PoolConfigError && error.message.includes(POOL_TARGET_ENV),
      `${value} was accepted`,
    );
  }
});

test("a depth outside zero to three is refused, and zero is allowed", () => {
  assert.equal(poolConfigFromEnv({ [POOL_DEPTH_ENV]: "0" }).depth, 0);
  for (const value of ["-1", "4", "1.5", "deep"]) {
    assert.throws(
      () => poolConfigFromEnv({ [POOL_DEPTH_ENV]: value }),
      (error: unknown) =>
        error instanceof PoolConfigError && error.message.includes(POOL_DEPTH_ENV),
      `${value} was accepted`,
    );
  }
});

test("a configured pool really is that size, on the pool's own snapshot", () => {
  const config = poolConfigFromEnv({ [POOL_TARGET_ENV]: "7", [POOL_DEPTH_ENV]: "0" });
  const pool = createExitPool({
    session: inertSession(),
    relayHost: "server1.ipsharkk.com",
    ...config,
  });

  const snapshot = pool.snapshot();
  assert.equal(snapshot.target, 7, "the pool fills to the configured target");
  assert.equal(snapshot.depth, 0, "depth zero means no child buckets");
});
