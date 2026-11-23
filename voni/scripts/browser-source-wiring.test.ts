import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CHECK_INPUTS,
  BROWSER_CHECK_WORKFLOW_FILE,
  dispatchBrowserCheck,
  type BrowserCheckInput,
} from "../src/lib/github/dispatch";
import { MAX_JOB_SECONDS } from "../src/lib/email/sources";
import type { RunnerOs } from "../src/lib/email/click-report";

/**
 * The browser-check workflow is a contract with a file this test cannot run: a
 * GitHub runner. These tests read the workflow as text and the dispatcher as
 * code, and fail by name when the two drift — a renamed input, a raised
 * timeout, a per-repository permission, a literal secret — because every one
 * of those only shows up in production otherwise.
 *
 * The runner's browser behaviour is deliberately not tested here: a local
 * fixture cannot prove an affiliate accepted a real click. That claim belongs
 * to one human-approved dispatched run.
 */

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const WORKFLOW = readFileSync(
  resolve(REPO, ".github/workflows", BROWSER_CHECK_WORKFLOW_FILE),
  "utf8",
);
const RUNNER = readFileSync(resolve(REPO, "voni/scripts/browser-click.mjs"), "utf8");

/** The input names and their `type:` lines, as declared by the workflow. */
function declaredInputs(text: string): { names: string[]; types: string[] } {
  const marker = "\non:\n  workflow_dispatch:\n    inputs:\n";
  const start = text.indexOf(marker);
  assert.notEqual(
    start,
    -1,
    "browser-check.yml must be workflow_dispatch with an inputs block",
  );
  const block = text.slice(start + marker.length);
  const names: string[] = [];
  const types: string[] = [];
  for (const line of block.split("\n")) {
    if (/^\S/.test(line)) break;
    const name = /^ {6}([a-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      names.push(name[1]!);
      continue;
    }
    const type = /^ {8}type:\s*(\S+)$/.exec(line);
    if (type) types.push(type[1]!);
  }
  return { names, types };
}

/** The lines of one named step, so a comment elsewhere cannot satisfy a check. */
function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `browser-check.yml has no step named ${name}`);
  const rest = WORKFLOW.slice(start + marker.length);
  const ends = [
    rest.indexOf("\n      - name: "),
    rest.indexOf("\n      - uses: "),
  ].filter((index) => index !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

test("the workflow is dispatch-only and declares exactly the dispatcher's inputs", () => {
  assert.match(
    WORKFLOW,
    /^on:\n {2}workflow_dispatch:\n/m,
    "the only trigger is workflow_dispatch",
  );
  assert.doesNotMatch(
    WORKFLOW,
    /^ {2}(?:push|pull_request|pull_request_target|schedule|workflow_call|workflow_run):/m,
    "no second trigger may start clicks nobody asked for",
  );

  const { names, types } = declaredInputs(WORKFLOW);
  assert.deepEqual(
    names,
    Object.values(BROWSER_CHECK_INPUTS),
    "the workflow declares the names dispatchBrowserCheck sends",
  );
  assert.equal(
    types.length,
    names.length,
    "every input declares its type, so none is inferred",
  );
  assert.ok(
    types.every((type) => type === "string"),
    "a dispatch input is a string, as the dispatcher stringifies it",
  );
});

test("a segment is comfortably inside GitHub's six-hour ceiling", () => {
  const match = /timeout-minutes:\s*(\d+)/.exec(WORKFLOW);
  assert.ok(match, "the job declares a timeout: a hang must fail, not sit");
  const minutes = Number(match[1]);
  assert.ok(minutes < 360, `timeout ${minutes} must stay under six hours`);
  assert.ok(
    minutes > MAX_JOB_SECONDS / 60,
    "the timeout must outlast the longest segment the dispatcher may ask for",
  );

  // One cap: the workflow's input documents MAX_JOB_SECONDS, not a second one.
  assert.match(WORKFLOW, /at most 20000/, "the input names the one segment cap");
  assert.doesNotMatch(WORKFLOW, /20880|348 minutes/, "the old cap is gone");
});

test("the runner imports the schedule domain's constants instead of copying them", () => {
  assert.match(
    RUNNER,
    /import\s*\{[^}]*INTERVAL_SECONDS[^}]*MAX_JOB_SECONDS[^}]*\}\s*from\s*"\.\.\/src\/lib\/email\/sources\.ts"/,
    "the runner imports both constants from the domain, through tsx",
  );
  assert.match(
    RUNNER,
    /const MIN_INTERVAL_SECONDS = INTERVAL_SECONDS\[0\]/,
    "the interval floor is the domain's first value",
  );
  assert.match(
    RUNNER,
    /const MAX_INTERVAL_SECONDS = INTERVAL_SECONDS\[INTERVAL_SECONDS\.length - 1\]/,
    "the interval ceiling is the domain's last value",
  );
  assert.doesNotMatch(
    RUNNER,
    /348 \* 60|20_880|MAX_WINDOW_SECONDS/,
    "no second window cap in the runner",
  );
  assert.doesNotMatch(
    RUNNER,
    /const MAX_INTERVAL_SECONDS = 3_600/,
    "the ceiling is not re-declared as a literal",
  );
});

test("concurrency is per OS and queued, and the token is read-only", () => {
  const group = /concurrency:\n(?: {2}.*\n)*? {2}group:\s*(.+)/.exec(WORKFLOW);
  assert.ok(group, "the workflow declares a concurrency group");
  assert.match(
    group[1]!,
    /inputs\.os/,
    "the group is per OS: one segment per OS, not one global lock",
  );
  assert.match(
    WORKFLOW,
    /cancel-in-progress:\s*false/,
    "queued, never cancelled: two windows must not overlap",
  );

  assert.match(WORKFLOW, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(
    WORKFLOW,
    /contents: write|permissions: write-all|pull-requests: write|actions: write/,
    "a click needs no write permission on the repository",
  );
});

test("the report secret comes from repository secrets and no literal is committed", () => {
  assert.match(
    WORKFLOW,
    /EMAIL_CLICK_REPORT_SECRET: \$\{\{ secrets\.EMAIL_CLICK_REPORT_SECRET \}\}/,
    "the runner receives the click-report secret the intake already checks",
  );

  const referenced = [
    ...WORKFLOW.matchAll(/secrets\.([A-Za-z0-9_]+)/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(referenced)],
    ["EMAIL_CLICK_REPORT_SECRET"],
    "the workflow reads no secret other than the click report's",
  );

  assert.doesNotMatch(
    WORKFLOW,
    /EMAIL_CLICK_REPORT_SECRET:\s*["']?[A-Za-z0-9._~+/=-]{8,}/,
    "a literal secret in the workflow is a credential in git",
  );
});

test("the runner installs real Chrome, clicks, and uploads screenshots on failure", () => {
  assert.match(WORKFLOW, /node-version:\s*22/);
  assert.match(WORKFLOW, /working-directory:\s*voni/);
  assert.match(WORKFLOW, /\n {6}- run: npm ci\n/);
  assert.match(
    WORKFLOW,
    /npx playwright install --with-deps chrome/,
    "real Chrome, not a bundled Chromium",
  );
  assert.match(
    WORKFLOW,
    /node --import tsx scripts\/browser-click\.mjs/,
    "the runner is the app's script, imported through tsx",
  );

  const upload = step("Failure screenshots");
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /if: always\(\)/, "a red run's screenshot is evidence too");
  assert.match(upload, /path: voni\/screenshots\//);
});

test("the runner launches Chrome once, isolates every click, and names its misses", () => {
  assert.equal(
    (RUNNER.match(/chromium\.launch\(/g) ?? []).length,
    1,
    "one launch per segment, not one per click",
  );
  assert.match(RUNNER, /channel: "chrome"/);
  assert.match(RUNNER, /browser\.newContext\(/, "a fresh context per click");
  assert.match(RUNNER, /context\.close\(/, "a context is closed before the next");
  assert.match(RUNNER, /page\.screenshot\(/, "a failed click leaves an image");

  // The utm stamping and the profile table live in the app, not in the runner.
  assert.match(RUNNER, /from "\.\.\/src\/lib\/email\/pool\.ts"/);
  assert.match(RUNNER, /from "\.\.\/src\/lib\/email\/user-agents\.ts"/);
  assert.doesNotMatch(
    RUNNER,
    /utm_source|EMAIL_PROVIDERS/,
    "a copy of the utm/provider logic would drift from the Grafana path",
  );

  // The secret is a header, never a line in the log.
  assert.match(RUNNER, /const REPORT_SECRET_ENV = "EMAIL_CLICK_REPORT_SECRET"/);
  assert.match(RUNNER, /readEnv\(REPORT_SECRET_ENV\)/);
  assert.doesNotMatch(
    RUNNER,
    /console\.[a-z]+\([^)]*secret/i,
    "the report secret must never be printed",
  );

  assert.match(RUNNER, /process\.exit\(1\)/, "a partial pass is a red run");
  assert.match(
    RUNNER,
    /no response from \$\{target\}/,
    "the red run names every target that never responded",
  );
});

test("the runner labels every click with its pass and reports the final pass", () => {
  assert.match(RUNNER, /const passId = randomUUID\(\)/, "one id per pass");
  assert.match(RUNNER, /randomUUID/, "the id is generated, never reused from input");
  assert.match(
    RUNNER,
    /clickOnce\(browser, target, config, passId\)/,
    "every click of the pass receives it",
  );
  assert.match(RUNNER, /passId,/, "the report carries it, successful or not");
  assert.match(
    RUNNER,
    /status = null;[\s\S]*?producer: "github",[\s\S]*?passId,/,
    "a failed navigation (status null) is still reported with the pass id",
  );

  assert.match(
    RUNNER,
    /finalPassMisses = attempted\.length > 0 \? passMisses : finalPassMisses/,
    "each pass's misses are tracked separately and the final pass wins",
  );
  assert.doesNotMatch(
    RUNNER,
    /misses\.delete\(target\)/,
    "a later pass recovering a target must not erase the earlier miss",
  );
  assert.match(RUNNER, /final pass no response from/, "the verdict names the final pass");
  assert.match(RUNNER, /report not stored for/, "and every report that never landed");
});

test("the dispatcher sends those inputs, on main, as strings", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const input: BrowserCheckInput = {
    os: "ubuntu",
    targets: ["https://voni.cc/test", "https://cipherlogs.github.io/print/"],
    intervalSeconds: 60,
    windowSeconds: 3_600,
  };
  const result = await dispatchBrowserCheck(input, {
    fetcher,
    readSecret: async () => "ghp_test_token",
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "dispatched");

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/actions\/workflows\/browser-check\.yml\/dispatches$/);

  const body = JSON.parse(String(calls[0]!.init.body)) as {
    ref: string;
    inputs: Record<string, string>;
  };
  assert.equal(body.ref, "main");
  assert.deepEqual(
    Object.keys(body.inputs).sort(),
    [...Object.values(BROWSER_CHECK_INPUTS)].sort(),
    "the input names are the workflow's own",
  );
  assert.equal(body.inputs[BROWSER_CHECK_INPUTS.os], "ubuntu");
  assert.equal(body.inputs[BROWSER_CHECK_INPUTS.interval], "60");
  assert.equal(body.inputs[BROWSER_CHECK_INPUTS.window], "3600");
  assert.deepEqual(
    JSON.parse(body.inputs[BROWSER_CHECK_INPUTS.targets]!),
    input.targets,
  );
});

test("no token hands back the manual command and makes no request", async () => {
  const fetcher = (async () => {
    throw new Error("an unconfigured dispatch must not reach GitHub");
  }) as unknown as typeof fetch;

  const result = await dispatchBrowserCheck(
    {
      os: "macos",
      targets: ["https://voni.cc/test"],
      intervalSeconds: 60,
      windowSeconds: 3_600,
    },
    { fetcher, readSecret: async () => undefined },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "manual");
  if (result.mode !== "manual") throw new Error("unreachable");
  assert.match(result.fallback.command, /gh workflow run browser-check\.yml/);
  assert.match(result.fallback.command, /-f os=macos/);
  assert.match(result.fallback.command, /-f interval=60/);
  assert.match(result.fallback.command, /-f window=3600/);
});

test("an impossible request is refused before it reaches GitHub", async () => {
  const fetcher = (async () => {
    throw new Error("a refused dispatch must not reach GitHub");
  }) as unknown as typeof fetch;
  const deps = { fetcher, readSecret: async () => "ghp_test_token" };
  const base: BrowserCheckInput = {
    os: "ubuntu",
    targets: ["https://voni.cc/test"],
    intervalSeconds: 60,
    windowSeconds: 3_600,
  };

  const badOs = await dispatchBrowserCheck(
    { ...base, os: "linux" as RunnerOs },
    deps,
  );
  const noTargets = await dispatchBrowserCheck({ ...base, targets: [] }, deps);
  const longWindow = await dispatchBrowserCheck(
    { ...base, windowSeconds: MAX_JOB_SECONDS + 1 },
    deps,
  );

  for (const result of [badOs, noTargets, longWindow]) {
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /^The browser check was not dispatched: /);
  }
});
