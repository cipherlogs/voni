import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The runner's configuration gate, exercised as the process CI runs.
 *
 * Each case stops in `readConfig`, before Chrome is launched or a target is
 * clicked: a pooled run must never silently prefer the manual override, and a
 * control address that is not loopback is not a client this runner may use.
 */

const VONI = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASE_ENV = {
  BROWSER_CHECK_OS: "ubuntu",
  BROWSER_CHECK_TARGETS: JSON.stringify(["https://voni.cc/test"]),
  BROWSER_CHECK_INTERVAL: "60",
  BROWSER_CHECK_WINDOW: "60",
  BROWSER_CHECK_SELECTION: "random",
  EMAIL_CLICK_REPORT_SECRET: "test-report-secret",
};

function run(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...BASE_ENV };
  // The parent's environment must not decide these cases.
  for (const name of [
    "TUXLER_CONTROL_URL",
    "BROWSER_PROXY_SERVER",
    "BROWSER_PROXY_USERNAME",
    "BROWSER_PROXY_PASSWORD",
  ]) {
    delete childEnv[name];
  }
  Object.assign(childEnv, env);
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/browser-click.mjs"],
    {
      cwd: VONI,
      env: childEnv,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

test("the pool and the manual override together are refused before any click", () => {
  const result = run({
    TUXLER_CONTROL_URL: "http://127.0.0.1:41000",
    BROWSER_PROXY_SERVER: "http://proxy.example.com:8080",
  });

  assert.equal(result.status, 2, `expected a configuration refusal, got ${result.status}`);
  assert.match(result.stderr, /TUXLER_CONTROL_URL/);
  assert.match(result.stderr, /BROWSER_PROXY_SERVER/);
  assert.match(result.stderr, /manual override/);
  assert.doesNotMatch(result.stderr, /pass 1 click/, "no target was attempted");
});

test("a control URL that is not loopback is refused", () => {
  for (const controlUrl of [
    "http://proxy.example.com:41000",
    "http://user:pass@127.0.0.1:41000",
    "https://127.0.0.1:41000",
    "127.0.0.1:41000",
  ]) {
    const result = run({ TUXLER_CONTROL_URL: controlUrl });
    assert.equal(result.status, 2, `${controlUrl} was accepted`);
    assert.match(result.stderr, /TUXLER_CONTROL_URL/);
    assert.doesNotMatch(result.stderr, /pass 1 click/);
  }
});

test("an unknown rotation mode is refused, not replaced by a default", () => {
  const result = run({ BROWSER_CHECK_SELECTION: "shuffle" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /BROWSER_CHECK_SELECTION/);
  assert.doesNotMatch(result.stderr, /pass 1 click/);
});

test("the workflow passes the rotation mode the runner reads", () => {
  const workflow = readFileSync(
    resolve(VONI, "../.github/workflows/browser-check.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /BROWSER_CHECK_SELECTION: \$\{\{ inputs\.selection \}\}/,
    "the mode on the dispatch is the mode the runner reads",
  );
});
