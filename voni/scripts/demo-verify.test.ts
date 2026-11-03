/**
 * The `demo:verify` entry point as a process: the usage path is exit 0, bad
 * input is exit 2, and a real local fast run refuses by name while the vendor
 * keys and build record are absent. Nothing here needs a vendor or a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VONI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(VONI_ROOT, "scripts", "demo-verify.mts");

function run(args: readonly string[], env: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...args],
    {
      cwd: VONI_ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        ...env,
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--help is usage and exit 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: npm run demo:verify/);
  assert.match(result.stdout, /Exit codes: 0 certified, 1 not-demo-ready, 2 bad input/);
});

test("bad input exits 2 and names the offending token", () => {
  const result = run(["--target", "qa", "--fast"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown target "qa"/);
});

test("a local fast run with no keys refuses by name with exit 2", () => {
  // The committed vendor-build record (`evidence/vendor-builds.json`) landed on
  // 2026-11-01, so the environment refusal a keyless checkout sees is the key,
  // not the record. The record's own refusals are covered where the runner is
  // fed a missing or invalid one.
  const result = run(["--target", "local", "--fast"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /refused/);
  assert.match(result.stdout, /META_API_KEY/);
  assert.match(result.stdout, /ASSEMBLYAI_API_KEY/);
  assert.doesNotMatch(result.stdout, /vendor-builds/);
  assert.doesNotMatch(result.stdout, /certified/);
});

test("a staging target refuses before any key is considered", () => {
  const result = run(["--target", "staging", "--full"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /target "staging"/);
  assert.match(result.stdout, /evidence sink/);
});
