import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUDGET_BOUND,
  UnknownBoundError,
  UnsetBoundError,
  budgetVerdict,
  readBrowserE2eBudget,
} from "./browser-e2e-budget.mjs";

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * The browser E2E runtime budget is one of the spec's open numbers
 * (`.scratch/meta-cascade/spec.md`, open dependency 18). The runner reads it
 * from the one registry; an open bound is a named blocker, never an invented
 * timeout.
 */
function registry(bounds: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-budget-"));
  const path = join(dir, "thresholds.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      budget_record: {
        path: "voni/src/lib/demo/scoreboard-budgets.json",
        version: 1,
        date: "2026-10-29",
      },
      bounds,
    }),
  );
  return path;
}

const ENTRY = { unit: "s", gate: "ci.browser-e2e", ticket: "149", note: "" };

test("a recorded budget is read with its source and gate", () => {
  const path = registry({
    [BUDGET_BOUND]: {
      ...ENTRY,
      value: 240,
      source: "owner: the browser job's measured p95",
      date: "2026-10-30",
    },
  });
  const budget = readBrowserE2eBudget({ registryPath: path });
  assert.equal(budget.status, "measured");
  assert.equal(budget.budgetS, 240);
  assert.equal(budget.unit, "s");
  assert.equal(budget.gate, "ci.browser-e2e");
  assert.equal(budget.ticket, "149");
});

test("an open bound is a named blocker, not a default or an invented timeout", () => {
  const path = registry({ [BUDGET_BOUND]: ENTRY });
  const budget = readBrowserE2eBudget({ registryPath: path });
  assert.equal(budget.status, "open");
  assert.equal(budget.budgetS, null);
  assert.match(budget.blocker ?? "", /ci\.browser_e2e_budget_s/);
  assert.match(budget.blocker ?? "", /ticket 149/);
  assert.match(budget.blocker ?? "", /no default is substituted/);
});

test("a missing declaration is refused by name, never defaulted", () => {
  const path = registry({ something_else: ENTRY });
  assert.throws(
    () => readBrowserE2eBudget({ registryPath: path }),
    (error: unknown) =>
      error instanceof UnknownBoundError &&
      error.message.includes("ci.browser_e2e_budget_s"),
  );
});

test("a record-backed budget resolves from the committed record", () => {
  const path = registry({
    [BUDGET_BOUND]: { ...ENTRY, budget_key: "replyGapP50Ms" },
  });
  const budget = readBrowserE2eBudget({
    registryPath: path,
    repoRoot: REPO,
  });
  assert.equal(budget.status, "measured");
  assert.equal(budget.budgetS, 1500);
  assert.match(budget.source, /scoreboard-budgets\.json#replyGapP50Ms/);
});

test("a budget in the wrong unit is refused", () => {
  const path = registry({
    [BUDGET_BOUND]: { ...ENTRY, unit: "ms", value: 240, source: "x", date: "2026-10-30" },
  });
  assert.throws(() => readBrowserE2eBudget({ registryPath: path }), /unit/);
});

test("the real registry declares the gate this job claims", () => {
  // Independent source of truth: the committed registry. If ticket 04 lands a
  // value, this keeps passing; if the bound moves away from the browser gate,
  // the runner and the workflow are no longer talking about the same number.
  const budget = readBrowserE2eBudget({ repoRoot: REPO });
  assert.equal(budget.bound, BUDGET_BOUND);
  assert.equal(budget.gate, "ci.browser-e2e");
  assert.equal(budget.ticket, "149");
  assert.equal(budget.unit, "s");
});

test("within budget claims measured time against the recorded number", () => {
  const verdict = budgetVerdict({
    elapsedMs: 95_000,
    budget: {
      status: "measured",
      budgetS: 120,
      blocker: null,
      bound: BUDGET_BOUND,
    } as never,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.claimed, true);
  assert.match(verdict.line, /95\.0s/);
  assert.match(verdict.line, /120s/);
});

test("over budget fails and names the pre-merge move, never a nightly fallback", () => {
  const verdict = budgetVerdict({
    elapsedMs: 121_000,
    budget: {
      status: "measured",
      budgetS: 120,
      blocker: null,
      bound: BUDGET_BOUND,
    } as never,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.claimed, true);
  assert.match(verdict.line, /over budget/);
  assert.match(verdict.line, /required pre-merge job/);
  assert.match(verdict.line, /never nightly-only/);
});

test("an open budget makes no runtime claim", () => {
  const verdict = budgetVerdict({
    elapsedMs: 95_000,
    budget: {
      status: "open",
      budgetS: null,
      blocker: "bound 'ci.browser_e2e_budget_s' is unset: ticket 149 must supply a value",
      bound: BUDGET_BOUND,
    } as never,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.claimed, false);
  assert.match(verdict.line, /UNMEASURED/);
  assert.match(verdict.line, /ticket 149/);
  assert.doesNotMatch(verdict.line, /within/);
});

test("an unset bound raises by name when a caller insists on a value", () => {
  const path = registry({ [BUDGET_BOUND]: ENTRY });
  const budget = readBrowserE2eBudget({ registryPath: path });
  assert.throws(
    () => {
      if (budget.status === "open") throw new UnsetBoundError(budget);
    },
    (error: unknown) =>
      error instanceof UnsetBoundError &&
      /ci\.browser_e2e_budget_s/.test((error as Error).message),
  );
});
