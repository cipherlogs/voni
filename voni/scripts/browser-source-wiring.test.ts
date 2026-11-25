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
    [
      "EMAIL_CLICK_REPORT_SECRET",
      "BROWSER_PROXY_SERVER",
      "BROWSER_PROXY_USERNAME",
      "BROWSER_PROXY_PASSWORD",
    ],
    "the workflow reads the report secret and the optional proxy only",
  );

  assert.doesNotMatch(
    WORKFLOW,
    /EMAIL_CLICK_REPORT_SECRET:\s*["']?[A-Za-z0-9._~+/=-]{8,}/,
    "a literal secret in the workflow is a credential in git",
  );
});

test("the optional proxy comes from repository secrets, never a literal", () => {
  // The values are optional: an empty secret is an empty env var, which the
  // runner reads as "no proxy".
  for (const name of [
    "BROWSER_PROXY_SERVER",
    "BROWSER_PROXY_USERNAME",
    "BROWSER_PROXY_PASSWORD",
  ]) {
    assert.ok(
      WORKFLOW.includes(`${name}: \${{ secrets.${name} }}`),
      `${name} is passed from the repository secret of the same name`,
    );
  }

  // A committed proxy address or password would outlive the rotation that
  // invented it. Nothing on the right-hand side may be a literal.
  const envLines = WORKFLOW.split("\n").filter((line) =>
    /^\s+BROWSER_PROXY_[A-Z]+:/.test(line),
  );
  assert.equal(envLines.length, 3, "exactly the three proxy variables are mapped");
  for (const line of envLines) {
    assert.match(
      line,
      /: \$\{\{ secrets\.BROWSER_PROXY_(?:SERVER|USERNAME|PASSWORD) \}\}$/,
      `${line.trim()} must be a secret reference`,
    );
  }

  // The runner reads all three and hands them to Playwright only.
  for (const name of [
    "BROWSER_PROXY_SERVER",
    "BROWSER_PROXY_USERNAME",
    "BROWSER_PROXY_PASSWORD",
  ]) {
    assert.ok(
      RUNNER.includes(`readEnv("${name}")`),
      `browser-click.mjs reads ${name}`,
    );
  }
  assert.match(
    RUNNER,
    /if \(config\.proxy !== undefined\) launchOptions\.proxy = config\.proxy;/,
    "the manual override stays one launch option, and absent means no proxy",
  );
  assert.match(
    RUNNER,
    /proxy=\$\{egressKind\(config\)\}/,
    "the startup line names the egress mode without naming a proxy",
  );
  assert.doesNotMatch(
    RUNNER,
    /console\.[a-z]+\([^)]*proxy[^)]*password/i,
    "a proxy password must never be printed",
  );
  assert.match(
    RUNNER,
    /BROWSER_PROXY_USERNAME and BROWSER_PROXY_PASSWORD must be set together/,
    "half a credential pair is a refusal, not an empty password",
  );
  assert.match(
    RUNNER,
    /BROWSER_PROXY_SERVER is malformed/,
    "a malformed server fails loudly before Chrome starts",
  );
});

test("a Click takes its own exit from the control port, never a launch proxy", () => {
  assert.match(
    RUNNER,
    /readEnv\("TUXLER_CONTROL_URL"\)/,
    "the runner reads the loopback control address",
  );
  assert.match(
    RUNNER,
    /from "\.\/browser-exit-pool\.mjs"/,
    "the control calls live in their own module, not a copy inside the runner",
  );
  assert.match(
    RUNNER,
    /contextOptions\.proxy = \{ server: exit\.socksUrl \}/,
    "the exit is bound to the context, so each Click leaves from its own address",
  );
  assert.match(
    RUNNER,
    /await acquireExit\(config\.poolUrl\)/,
    "a Click asks the pool before it opens a browser context",
  );
  assert.match(
    RUNNER,
    /releaseExit\(\s*config\.poolUrl/,
    "and gives the exit back with an outcome",
  );
  assert.doesNotMatch(
    RUNNER,
    /launchOptions\.proxy = config\.pool/,
    "a pool exit never becomes a launch-wide proxy",
  );

  const acquire = RUNNER.indexOf("await acquireExit(config.poolUrl)");
  const click = RUNNER.indexOf("clickOnce(await browserFor(), target, config, passId, taken.exit)");
  assert.ok(
    acquire !== -1 && click !== -1 && acquire < click,
    "a Click asks the pool before it asks Chrome for a context",
  );
  assert.match(
    RUNNER,
    /clickOnce\(await browserFor\(\), target, config, passId, taken\.exit\)/,
    "Chrome starts on the first Click that has an exit, not before one exists",
  );
});

test("the pool and the manual override cannot both be configured", () => {
  const refusal = RUNNER.indexOf("manual override");
  assert.notEqual(refusal, -1, "the conflict is refused with its own sentence");
  assert.match(RUNNER, /TUXLER_CONTROL_URL/);
  assert.match(RUNNER, /BROWSER_PROXY_SERVER/);
  const launch = RUNNER.indexOf("chromium.launch(");
  assert.ok(
    refusal !== -1 && launch !== -1 && refusal < launch,
    "the refusal happens before Chrome is started",
  );
  assert.match(
    RUNNER,
    /BROWSER_PROXY_USERNAME and BROWSER_PROXY_PASSWORD must be set together/,
    "the manual override is still validated on its own",
  );
});

test("the launch closes the QUIC and WebRTC leak paths", () => {
  const launch = RUNNER.slice(
    RUNNER.indexOf("const launchOptions"),
    RUNNER.indexOf("chromium.launch("),
  );
  assert.match(launch, /args:\s*\[/, "the launch passes Chrome flags");
  assert.match(launch, /"--disable-quic"/, "QUIC is a path around an HTTP proxy");
  assert.match(
    launch,
    /"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"/,
    "WebRTC must not send non-proxied UDP",
  );
});

test("the rotation mode comes from the shared setting, and both modes are honoured", () => {
  assert.match(
    RUNNER,
    /readEnv\("BROWSER_CHECK_SELECTION"\)/,
    "the mode is the dispatched setting, not a local flag",
  );
  assert.match(RUNNER, /parseTargetSelection/);
  assert.match(
    RUNNER,
    /from "\.\.\/src\/lib\/email\/target-selection\.ts"/,
    "the mode's names come from the app, not a second copy",
  );
  assert.match(RUNNER, /selection === "rotate"/, "rotate holds one exit for the pass");
  assert.match(RUNNER, /let passExit/, "a rotate pass keeps the lease across its targets");
});

test("a pooled click reports the exit it used and a failed acquire writes the reason", () => {
  assert.match(RUNNER, /function egressKind\(config\)/);
  assert.match(
    RUNNER,
    /return config\.poolUrl !== undefined \? "pool" : config\.proxy === undefined \? "none" : "manual";/,
  );
  assert.match(RUNNER, /exitIp: exit === undefined \? null : exit\.ip/);
  assert.match(RUNNER, /exitCountry: exit === undefined \? null : exit\.country/);
  assert.match(RUNNER, /exitAsn: exit === undefined \? null : exit\.asn/);
  assert.match(RUNNER, /failureReason/, "a click that got no exit stores why");
  assert.match(
    RUNNER,
    /reportUnavailable\(/,
    "no exit means no row claiming a response and no browser context",
  );
  assert.match(
    RUNNER,
    /exit=\$\{result\.exitIp\}/,
    "the run log prints the same address the row records",
  );
  assert.match(
    RUNNER,
    /result\.failure === null \? "good" : "failed"/,
    "a failed click gives its exit a strike",
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

test("a click presents as the device class its profile claims, not only a UA", () => {
  // A phone UA on a desktop DOM (no touch, 1x DPR, 1440px window) is a
  // contradiction page JavaScript can read, so the device class sets all of
  // these together and clickOnce spreads one helper's answer into the context.
  assert.match(RUNNER, /contextOptionsFor\(profile\)/);
  assert.match(RUNNER, /\.\.\.contextOptionsFor\(profile\),/);
  assert.match(
    RUNNER,
    /isMobile: true, hasTouch: true, deviceScaleFactor: 3/,
    "phone: mobile viewport, touch, 3x DPR",
  );
  assert.match(
    RUNNER,
    /isMobile: true, hasTouch: true, deviceScaleFactor: 2/,
    "tablet: mobile viewport, touch, 2x DPR",
  );
  assert.match(
    RUNNER,
    /isMobile: false, hasTouch: false, deviceScaleFactor: 1/,
    "desktop: non-touch, 1x DPR",
  );
  // The viewports are unchanged; only the signals around them were missing.
  assert.match(RUNNER, /width: 390, height: 844/);
  assert.match(RUNNER, /width: 820, height: 1_180/);
  assert.match(RUNNER, /width: 1_440, height: 900/);
});

test("the runner labels every click with its pass and reports the final pass", () => {
  assert.match(RUNNER, /const passId = randomUUID\(\)/, "one id per pass");
  assert.match(RUNNER, /randomUUID/, "the id is generated, never reused from input");
  assert.match(
    RUNNER,
    /clickOnce\([^)]*target, config, passId, /,
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
    selection: "rotate",
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
  assert.equal(
    body.inputs[BROWSER_CHECK_INPUTS.selection],
    "rotate",
    "the rotation mode rides the dispatch, so the runner and Grafana cannot disagree",
  );
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
      selection: "random",
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
  assert.match(
    result.fallback.command,
    /-f selection=random/,
    "a hand-run dispatch names the mode too, or the run would not match the setting",
  );
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
    selection: "random",
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
  // The mode is one of two names, never a free string: a dispatch carrying
  // anything else would land on the runner as an unknown mode.
  const badSelection = await dispatchBrowserCheck(
    { ...base, selection: "shuffle" as BrowserCheckInput["selection"] },
    deps,
  );

  for (const result of [badOs, noTargets, longWindow, badSelection]) {
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /^The browser check was not dispatched: /);
  }
  assert.match(
    badSelection.ok ? "" : badSelection.error,
    /"shuffle" is not one of random, rotate/,
    "the refusal names the two modes",
  );
});
