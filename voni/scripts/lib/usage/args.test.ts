/**
 * `demo:usage`'s argv contract: one run id or `--latest`, never both, never
 * neither. Parsing decides what was asked; it never reads evidence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { UsageCliError } from "./types";
import { parseUsageArgs } from "./args";

function refusalCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof UsageCliError, `expected a usage refusal, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a refusal, but the call returned");
}

test("parses --run", () => {
  const request = parseUsageArgs(["--run", "browser-mvz52mbv-c2516073"]);
  assert.equal(request.runId, "browser-mvz52mbv-c2516073");
  assert.equal(request.latest, false);
});

test("parses --latest", () => {
  const request = parseUsageArgs(["--latest"]);
  assert.equal(request.latest, true);
  assert.equal(request.runId, undefined);
});

test("parses the npm invocation prefix", () => {
  const request = parseUsageArgs([
    "npm",
    "run",
    "demo:usage",
    "--",
    "--run",
    "verify-1",
  ]);
  assert.equal(request.runId, "verify-1");
});

test("refuses both --run and --latest", () => {
  assert.equal(refusalCode(() => parseUsageArgs(["--run", "x", "--latest"])), "bad-input");
});

test("refuses neither --run nor --latest", () => {
  assert.equal(refusalCode(() => parseUsageArgs([])), "bad-input");
});

test("refuses --run without a value", () => {
  assert.equal(refusalCode(() => parseUsageArgs(["--run"])), "bad-input");
  assert.equal(refusalCode(() => parseUsageArgs(["--run", "--latest"])), "bad-input");
});

test("refuses a run id that could escape the evidence root", () => {
  for (const id of ["../secret", "a/b", "..", ""]) {
    assert.equal(refusalCode(() => parseUsageArgs(["--run", id])), "bad-input", id);
  }
});

test("refuses an unknown flag", () => {
  assert.equal(refusalCode(() => parseUsageArgs(["--json"])), "bad-input");
});
