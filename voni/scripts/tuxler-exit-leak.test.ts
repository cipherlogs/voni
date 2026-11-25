import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EGRESS_LAUNCH_ARGS } from "./browser-egress.mjs";
import {
  ASSIGNED_EXIT_IP,
  CLIENT_IP,
  SCENARIOS,
  WRONG_EXIT_IP,
  compareObservedAddress,
} from "./tuxler-exit-leak.mjs";

/**
 * The leak check is only worth its CI minute if it fails when the browser
 * leaves without its exit. These tests run the check as the build does — a real
 * browser, the runner's own launch and context settings, the runner's control
 * client against a local fake — and assert a non-zero exit, not a warning, for
 * every way that leak can happen.
 *
 * The positive needs no Tuxler account and no live relay: the exit is a loopback
 * SOCKS listener bound to 127.0.0.2, so the address the page observes is the
 * address a target would see. Everything above the relay is the runner's code.
 */

const VONI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(VONI, "..");
const CI = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");

function runCheck(scenario: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The dispatch-time knob must not decide a check on a pull request.
  delete env.TUXLER_LEAK_CHANNEL;
  return spawnSync(process.execPath, ["scripts/tuxler-exit-leak.mjs", scenario], {
    cwd: VONI,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
}

/** Everything a reader sees, for the "no credential" assertions. */
function output(result: ReturnType<typeof runCheck>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/** The lines of one named CI step, so a comment elsewhere cannot satisfy it. */
function ciStep(text: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `ci.yml has no step named ${name}`);
  const rest = text.slice(start + marker.length);
  const ends = [rest.indexOf("\n      - name: "), rest.indexOf("\n      - uses: ")]
    .filter((index) => index !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

test("the assigned exit is proven: the page observes the lease's exact address", () => {
  const result = runCheck("assigned");
  const text = output(result);

  assert.equal(result.status, 0, `the assigned exit must pass, got:\n${text}`);
  assert.match(
    result.stdout,
    new RegExp(`ok: the page observed ${ASSIGNED_EXIT_IP.replaceAll(".", "\\.")}, which is the assigned exit`),
    "a green run says which address it saw",
  );
  assert.match(text, /scenario=assigned/, "a green run names the scenario it proved");
  assert.match(text, /connections-through-exit=1/, "the traffic did pass through the exit");
});

test("a context launched without a proxy is a leak, not a warning", () => {
  const result = runCheck("direct-context");
  const text = output(result);

  assert.equal(result.status, 1, `a direct connection must fail the build, got:\n${text}`);
  assert.match(
    text,
    new RegExp(`LEAK: the page observed ${CLIENT_IP.replaceAll(".", "\\.")}, not the assigned exit`),
    "the message names the address that leaked",
  );
  assert.match(text, /reached the internet without its exit/);
  assert.match(text, /connections-through-exit=0/, "the exit served nothing, and the message says so");
});

test("the handshake's derived port routes directly and is a leak", () => {
  const result = runCheck("derived-port");
  const text = output(result);

  assert.equal(result.status, 1, `the derived port must fail the build, got:\n${text}`);
  assert.match(
    text,
    new RegExp(`the page observed ${CLIENT_IP.replaceAll(".", "\\.")}, not the assigned exit`),
    "the derived port exposes the client's own address",
  );
  assert.match(text, /scenario=derived-port/);
});

test("a wrong exit cannot pass: the comparison is the exact address", () => {
  const result = runCheck("wrong-exit");
  const text = output(result);

  assert.equal(result.status, 1, `a neighbouring exit must fail, got:\n${text}`);
  assert.match(
    text,
    new RegExp(
      `observed ${ASSIGNED_EXIT_IP.replaceAll(".", "\\.")}, not the assigned exit ${WRONG_EXIT_IP.replaceAll(".", "\\.")}`,
    ),
    "a different address in the same /24 is not the assigned exit",
  );
});

test("a listener that is gone after the lease is a leak, not a silent pass", () => {
  const result = runCheck("listener-gone");
  const text = output(result);

  assert.equal(result.status, 1, `a dead listener must fail the build, got:\n${text}`);
  assert.match(
    text,
    /LEAK: nothing was observed through the assigned exit/,
    "no observation is a leak, never an empty success",
  );
  assert.match(text, /ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED/);
});

test("the check fails no scenario it cannot name, and prints no credential", () => {
  for (const scenario of SCENARIOS) {
    const text = output(runCheck(scenario));
    assert.doesNotMatch(
      text,
      /[a-z]+:\/\/[^/\s@]+@/i,
      `${scenario} printed a URL with userinfo: a credential must never reach a log`,
    );
    assert.doesNotMatch(text, /password\s*[:=]\s*\S/i, `${scenario} printed a password`);
  }

  const unknown = spawnSync(process.execPath, ["scripts/tuxler-exit-leak.mjs", "assigned-ish"], {
    cwd: VONI,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(unknown.status, 2, "an unknown scenario must not silently become the assigned one");
  assert.match(unknown.stderr, /scenario must be one of/);
});

test("the verdict compares addresses exactly, never a country or an ASN", () => {
  assert.deepEqual(
    compareObservedAddress({ observed: "203.0.113.7", exitIp: "203.0.113.7" }),
    {
      leaked: false,
      message: "ok: the page observed 203.0.113.7, which is the assigned exit",
    },
  );
  const neighbour = compareObservedAddress({ observed: "203.0.113.8", exitIp: "203.0.113.7" });
  assert.equal(neighbour.leaked, true, "one address off is a different exit");

  const none = compareObservedAddress({ observed: null, exitIp: "203.0.113.7", failure: "timeout" });
  assert.equal(none.leaked, true, "no observation proves nothing");
  assert.match(none.message, /nothing was observed through the assigned exit 203\.0\.113\.7 \(timeout\)/);

  const blank = compareObservedAddress({ observed: "  ", exitIp: "203.0.113.7" });
  assert.equal(blank.leaked, true, "a blank address is not an exit");
});

test("the leak check runs in CI, with a browser, and fails the job", () => {
  // Scope to the job the check runs in: the browser-e2e job has its own
  // Chromium step and its own budget.
  const verify = CI.slice(0, CI.indexOf("\n  browser-e2e:"));
  assert.match(verify, /^\s{4}timeout-minutes:\s*\d+$/m, "the verify job is bounded");

  const install = ciStep(verify, "Chromium");
  assert.match(
    install,
    /npx playwright install --with-deps chromium/,
    "the job the leak check runs in installs the browser it drives",
  );

  const step = ciStep(verify, "Tuxler exit leak");
  assert.match(
    step,
    /run: node --import tsx --test scripts\/tuxler-exit-leak\.test\.ts/,
    "the step runs the check by name, so deleting it fails by name",
  );
  assert.doesNotMatch(step, /continue-on-error/, "a leak must fail the job, not warn");
  assert.doesNotMatch(step, /if:\s*\$\{\{/, "the leak check is not conditional on secrets");

  assert.ok(
    verify.indexOf("Tuxler exit leak") > verify.indexOf("Chromium"),
    "the browser is installed before the check uses it",
  );
});

test("the check launches with the runner's egress settings, not a copy", () => {
  const runner = readFileSync(resolve(VONI, "scripts/browser-click.mjs"), "utf8");
  const check = readFileSync(resolve(VONI, "scripts/tuxler-exit-leak.mjs"), "utf8");

  assert.match(
    runner,
    /from "\.\/browser-egress\.mjs"/,
    "the runner takes its launch flags and context proxy from the shared module",
  );
  assert.match(
    check,
    /from "\.\/browser-egress\.mjs"/,
    "the check takes the same settings, so a runner flag cannot drift out of the check",
  );
  assert.match(check, /launchOptionsFor\(/);
  assert.match(check, /exitContextProxy\(/);

  // An unproxied QUIC path would bypass the exit the check just proved.
  assert.ok(EGRESS_LAUNCH_ARGS.includes("--disable-quic"), "QUIC is off in the shared flags");
  assert.ok(
    EGRESS_LAUNCH_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
    "WebRTC may not send non-proxied UDP in the shared flags",
  );
});
