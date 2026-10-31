import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FAST_CALLS,
  FULL_CALLS,
  NIGHTLY_CALLS,
} from "../src/lib/demo/verification/cadence";

/**
 * The CI gate over a demo:verify report: a clean scoped-pass and a clean
 * nightly health report are job successes even though both exit 1; a full run
 * is a success only with a certificate, and pending-human is loudly not a pass.
 */

const VONI = fileURLToPath(new URL("..", import.meta.url));

function run(mode: string, report: unknown): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "demo-gate-"));
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(report), "utf8");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/demo-gate-report.mjs", mode, path],
    { cwd: VONI, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a clean fast scoped-pass is a merge-gate success", () => {
  const result = run("fast", {
    mode: "fast",
    status: "scoped-pass",
    calls: FAST_CALLS,
    exitCode: 1,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a clean nightly health report is a success; the plan's call count is the cadence", () => {
  const result = run("nightly", {
    mode: "nightly",
    status: "health-clean",
    calls: NIGHTLY_CALLS,
    exitCode: 1,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a short or red run fails the gate by name", () => {
  const short = run("nightly", {
    mode: "nightly",
    status: "health-clean",
    calls: NIGHTLY_CALLS - 1,
    exitCode: 1,
  });
  assert.equal(short.status, 1);
  assert.match(short.stderr, new RegExp(`${NIGHTLY_CALLS}`));
  const red = run("fast", { mode: "fast", status: "not-demo-ready", calls: 10, exitCode: 1 });
  assert.equal(red.status, 1);
  assert.match(red.stderr, /not-demo-ready/);
  const refused = run("fast", { mode: "fast", status: "refused", calls: 0, exitCode: 2 });
  assert.equal(refused.status, 1);
});

test("a full run needs a certificate and names pending-human as not a pass", () => {
  const noCertificate = run("full", {
    mode: "full",
    status: "pending-human",
    calls: FULL_CALLS,
    exitCode: 3,
    certificate: null,
  });
  assert.equal(noCertificate.status, 1);
  assert.match(noCertificate.stderr, /no certificate/);

  const pending = run("full", {
    mode: "full",
    status: "pending-human",
    calls: FULL_CALLS,
    exitCode: 3,
    certificate: { verdict: "pending-human" },
  });
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /PENDING-HUMAN/);
  assert.match(pending.stdout, /not a pass/);

  const certified = run("full", {
    mode: "full",
    status: "certified",
    calls: FULL_CALLS,
    exitCode: 0,
    certificate: { verdict: "certified" },
  });
  assert.equal(certified.status, 0);
});
