import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Ticket 149's CI wiring is part of the seam: a browser artifact must exist
 * before merge, on every PR, without a vendor key and without a way to skip
 * the job green. These tests read the committed workflow; they fail by name
 * when the job, its gate, or its artifact upload goes missing.
 */

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");

/** The lines of one top-level job, so a comment elsewhere cannot satisfy a check. */
function job(name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `ci.yml has no ${name} job`);
  const rest = WORKFLOW.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The lines of one named step inside a job. */
function step(jobText: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = jobText.indexOf(marker);
  assert.notEqual(start, -1, `job has no step named ${name}`);
  const rest = jobText.slice(start + marker.length);
  const ends = [rest.indexOf("\n      - name: "), rest.indexOf("\n      - uses: ")]
    .filter((index) => index !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

test("the workflow runs the browser E2E on every PR", () => {
  assert.match(WORKFLOW, /\n {2}pull_request:\n/, "ci.yml triggers on pull_request");
  const browser = job("browser-e2e");
  assert.doesNotMatch(browser, /\n {4}paths:/, "no path filter may skip the seam");
  assert.doesNotMatch(browser, /\n {4}if:/, "no job-level if may skip the seam");
  assert.doesNotMatch(browser, /continue-on-error/, "the seam may not soft-fail");
  assert.match(browser, /timeout-minutes:/, "a hang must fail, not sit for six hours");
});

test("the browser job runs the cascade mode and installs a real Chromium", () => {
  const browser = job("browser-e2e");
  assert.match(browser, /scripts\/e2e-run\.mjs cascade/);
  const install = browser.slice(browser.indexOf("playwright install"));
  assert.match(install, /--with-deps chromium/, "a real browser, not a jsdom stand-in");
});

test("the delivered capture is uploaded on green and red alike", () => {
  const browser = job("browser-e2e");
  const upload = step(browser, "Delivered capture artifact");
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /if: always\(\)/, "a red run's capture is evidence too");
  assert.match(upload, /path: voni\/test-results\/cascade-e2e\//);
  assert.match(upload, /if-no-files-found: error/, "a green run without a file is a lie");
});

test("the browser job takes no vendor key", () => {
  const browser = job("browser-e2e");
  for (const key of [
    "META_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "CARTESIA_API_KEY",
    "OPENAI_API_KEY",
    "secrets.",
  ]) {
    assert.ok(!browser.includes(key), `browser-e2e must not carry ${key}`);
  }
});

test("a skipped or cancelled browser job cannot report success", () => {
  const gate = job("required-browser-e2e");
  assert.match(gate, /needs: \[browser-e2e\]/);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /test "\$\{\{ needs\.browser-e2e\.result \}\}" = "success"/);
});

test("the budget is read from the registry, never baked into the workflow", () => {
  // The workflow may carry a hang guard (`timeout-minutes`), but the runtime
  // claim comes from `ci.browser_e2e_budget_s` in the one registry, and the
  // runner is what reads it. A number in the YAML would be a second home.
  const runner = readFileSync(resolve(REPO, "voni/scripts/e2e-run.mjs"), "utf8");
  assert.match(runner, /readBrowserE2eBudget\(\{ repoRoot/);
  assert.match(runner, /budgetVerdict\(\{ elapsedMs, budget \}\)/);
  assert.doesNotMatch(
    job("browser-e2e"),
    /ci\.browser_e2e_budget_s\s*[:=]\s*\d/,
    "the workflow must not restate the budget",
  );
});

test("the harness page exists only in the isolated test build", () => {
  const page = readFileSync(
    resolve(REPO, "voni/src/app/e2e/cascade/page.tsx"),
    "utf8",
  );
  assert.match(page, /process\.env\.VONI_INSTANT_TEST_BUILD !== "1"/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /engine="cascade"/, "the page drives the real cascade client");
});

test("the fake service replays committed scripted frames, not inline code", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(REPO, "voni/tests/e2e/fixtures/cascade-call.json"), "utf8"),
  ) as { schemaVersion: number; frame?: unknown; frames: { frame: { type: string } }[] };
  assert.equal(fixture.schemaVersion, 1);
  const types = fixture.frames.map((entry) => entry.frame.type);
  assert.ok(types.includes("audio"), "the script has agent audio to deliver");
  assert.ok(types.includes("end_call"), "the script drives the goodbye drain");
  const fake = readFileSync(resolve(REPO, "voni/tests/e2e/cascade-fake-server.ts"), "utf8");
  assert.match(fake, /tests\/e2e\/fixtures\/cascade-call\.json/);
});

test("the nightly workflow is never part of the PR gate", () => {
  // Live vendor work belongs to nightly.yml only; ci.yml must keep running
  // with no schedule trigger and no nightly job name.
  assert.doesNotMatch(WORKFLOW, /\n {2}schedule:\n/);
  assert.doesNotMatch(WORKFLOW, /\n {2}nightly[a-z-]*:\n/);
  assert.doesNotMatch(WORKFLOW, /nightly\.yml/);
});
