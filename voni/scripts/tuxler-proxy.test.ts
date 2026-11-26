/**
 * `tuxler-proxy` as a process: started, pointed at a relay on loopback, asked for
 * one health report. The runner depends on the exit code — a client that is not a
 * live session must fail the step, not print and carry on — so it is checked here
 * rather than assumed.
 *
 * The child is spawned asynchronously on purpose: the relay lives in this process,
 * so blocking the event loop would starve it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeRelay } from "../src/lib/tuxler/fake-relay";

const VONI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(VONI_ROOT, "scripts", "tuxler-proxy.mts");
const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: VONI_ROOT,
      env: { ...process.env, ...env },
    });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tuxler-proxy did not exit: ${stdout}${stderr}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function parseHealth(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  assert.ok(start !== -1, `no health report printed: ${stdout}`);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

test("a client that logs in prints its health and exits zero", async () => {
  const relay = await FakeRelay.start({ changesLimit: 7, changesUsed: 4 });
  try {
    const result = await run(
      [
        "--once",
        // A session probe: the pool is covered by the client tests, and it would
        // need a real ASN lookup to fill.
        "--no-pool",
        "--relay-host",
        "127.0.0.1",
        "--relay-port",
        String(relay.port),
        "--timeout-ms",
        "15000",
      ],
      { TUXLER_EMAIL: EMAIL, TUXLER_PASSWORD: PASSWORD, TUXLER_HEALTH_PORT: "0" },
    );
    assert.equal(result.status, 0, result.stderr);
    const health = parseHealth(result.stdout);
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    const buckets = health.buckets as Array<{ limit: number; remaining: number }>;
    assert.equal(buckets[0].limit, 7);
    assert.equal(buckets[0].remaining, 3);
    assert.ok(!result.stdout.includes(PASSWORD), "the CLI printed the password");
    assert.ok(!result.stdout.includes(EMAIL), "the CLI printed the account");
  } finally {
    await relay.close();
  }
});

test("an out-of-range pool size is refused by the CLI, not silently clamped", async () => {
  for (const [name, value] of [
    ["TUXLER_POOL_TARGET", "9"],
    ["TUXLER_POOL_TARGET", "2"],
    ["TUXLER_POOL_TARGET", "3.5"],
    ["TUXLER_POOL_DEPTH", "4"],
  ] as const) {
    const result = await run(["--once", "--no-pool", "--relay-port", "1"], {
      TUXLER_HEALTH_PORT: "0",
      [name]: value,
    });
    assert.equal(result.status, 1, `${name}=${value} was accepted`);
    assert.match(result.stderr, new RegExp(name), "the refusal names the variable");
    assert.equal(result.stdout.trim(), "", "nothing was started or printed as health");
  }
});

test("a client with no credential reports why and exits non-zero", async () => {
  const result = await run(["--once", "--relay-host", "127.0.0.1", "--relay-port", "1"], {
    TUXLER_HEALTH_PORT: "0",
  });
  assert.equal(result.status, 1);
  const health = parseHealth(result.stdout);
  assert.equal(health.ok, false);
  assert.equal((health.lastError as { reason: string }).reason, "credential-missing");
});
