import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Demo-verification ticket 01 retires the managed-era browser demo suite. The
 * demo is cascade-only now, so a browser-demo failure must come from the
 * cascade rig and nothing else. These tests read the committed suite; they
 * fail by name if a managed spec, its fake mint, or its place in the behavior
 * run comes back.
 */

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const E2E = resolve(REPO, "voni/tests/e2e");
const RUNNER = resolve(REPO, "voni/scripts/e2e-run.mjs");

/** The body of one `mode*` function, so a comment elsewhere cannot satisfy a check. */
function mode(source: string, name: string): string {
  const start = source.indexOf(`async function mode${name}()`);
  assert.notEqual(start, -1, `the runner has no mode${name}`);
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The managed-era share of the browser suite, retired by this ticket. */
const MANAGED_SPECS = [
  "demo-call-quality.spec.ts",
  "demo-email-test.spec.ts",
  "demo-hold.spec.ts",
  "demo-layout.spec.ts",
  "demo-races.spec.ts",
];

test("the managed-era demo specs are gone", () => {
  for (const name of MANAGED_SPECS) {
    assert.equal(
      existsSync(resolve(E2E, name)),
      false,
      `${name} is still a committed spec`,
    );
  }
  assert.equal(
    existsSync(resolve(E2E, "demo-layout.spec.ts-snapshots")),
    false,
    "the retired layout snapshots are still committed",
  );
});

test("the behavior suite runs no managed demo hold path", () => {
  const behavior = mode(readFileSync(RUNNER, "utf8"), "Behavior");
  assert.match(behavior, /tests\/e2e\/rig-liveness\.spec\.ts/);
  assert.doesNotMatch(
    behavior,
    /tests\/e2e\/demo-/,
    "a managed demo spec may not run in the behavior suite",
  );
  const specs = [...behavior.matchAll(/tests\/e2e\/[a-z0-9-]+\.spec\.ts/g)].map(
    ([spec]) => spec,
  );
  assert.ok(specs.length > 0, "the behavior suite names no spec at all");
  for (const spec of specs) {
    assert.equal(
      existsSync(resolve(REPO, "voni", spec)),
      true,
      `the behavior suite lists a dead path: ${spec}`,
    );
  }
});

test("no browser spec answers the demo mint with the retired managed body", () => {
  const specs = readdirSync(E2E).filter((name) => name.endsWith(".spec.ts"));
  const minting = specs.filter((name) =>
    readFileSync(resolve(E2E, name), "utf8").includes("/api/demo/token"),
  );
  assert.ok(minting.length > 0, "the cascade rig must still answer the one mint");
  for (const name of minting) {
    assert.match(
      readFileSync(resolve(E2E, name), "utf8"),
      /engine:\s*"cascade"/,
      `${name} answers the demo mint without the cascade contract`,
    );
  }
  // The shared fake carried the managed mint and the AssemblyAI socket; the
  // cascade rig owns its own service fake and needs neither.
  const shared = readFileSync(resolve(E2E, "demo-fakes.ts"), "utf8");
  assert.doesNotMatch(shared, /api\/demo\/token/, "the shared fake still mints");
  assert.doesNotMatch(shared, /agent_demo/, "the managed agent id is still faked");
  assert.doesNotMatch(
    shared,
    /agents\.assemblyai\.com/,
    "the shared fake still stands in for the managed socket",
  );
});

test("the e2e notes name the cascade rig as the only browser-demo evidence", () => {
  const notes = readFileSync(resolve(REPO, "voni/instant-nav.rig.md"), "utf8");
  assert.match(notes, /cascade rig is the only browser-demo evidence/i);
});

test("the cascade rig still runs, with its budget read from the registry", () => {
  const cascade = mode(readFileSync(RUNNER, "utf8"), "Cascade");
  assert.match(cascade, /tests\/e2e\/cascade-delivery\.spec\.ts/);
  assert.match(cascade, /readBrowserE2eBudget\(\{ repoRoot/);
  assert.match(cascade, /budgetVerdict\(\{ elapsedMs, budget \}\)/);
  for (const rel of [
    "tests/e2e/cascade-delivery.spec.ts",
    "tests/e2e/cascade-fake-server.ts",
    "tests/e2e/fixtures/cascade-call.json",
  ]) {
    assert.equal(
      existsSync(resolve(REPO, "voni", rel)),
      true,
      `the cascade rig lost ${rel}`,
    );
  }
});

test("the deletion leaves the CI workflows naming no managed demo spec", () => {
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/nightly.yml"]) {
    const source = readFileSync(resolve(REPO, workflow), "utf8");
    for (const name of MANAGED_SPECS) {
      assert.ok(
        !source.includes(name),
        `${workflow} still names the retired ${name}`,
      );
    }
  }
  const ci = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /path: voni\/test-results\/cascade-e2e\//);
});
