/**
 * Source-text assertions for the `/email` control actions, in the same shape as
 * the repo's other mutation tests. The node runner has no Next request context
 * or Grafana, so what is proved here is the surface itself: every mutation
 * gates on the control cookie above input handling, both password forms spend
 * an attempt budget before comparing anything, the unlock comparison and the
 * cookie format come from one module, and no result can carry an upstream body.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  controlCookieMatches,
  controlCookieValue,
} from "@/lib/email/control";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");
const syntheticSource = readFileSync(
  join(here, "../../lib/grafana/synthetic.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf("\nexport async function", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

test("every mutating action calls requireControl() itself", () => {
  for (const name of ["saveVolume", "toggleCheck", "runOneOffClick"]) {
    const body = fnBody(name);
    assert.match(
      body,
      /requireControl\(\)/,
      `${name} must re-check the cookie; client rendering is not a gate`,
    );
    assert.ok(
      body.indexOf("requireControl()") < body.indexOf("return locked()"),
      `${name} refuses before doing anything else`,
    );
  }
});

test("the control gate is auth-before-input", () => {
  const save = fnBody("saveVolume");
  assert.ok(
    save.indexOf("requireControl()") < save.indexOf("validateVolume({"),
    "saveVolume gates before parsing the form",
  );
  assert.ok(
    save.indexOf("requireControl()") < save.indexOf("updateCheck("),
    "saveVolume gates before writing to Grafana",
  );

  const toggle = fnBody("toggleCheck");
  assert.ok(
    toggle.indexOf("requireControl()") < toggle.indexOf("getCheck("),
    "toggleCheck gates before reading the check",
  );

  const click = fnBody("runOneOffClick");
  assert.ok(
    click.indexOf("requireControl()") < click.indexOf("nextEmailTarget()"),
    "runOneOffClick gates before drawing a target",
  );
});

test("unlockControl compares through the shared constant-time helper", () => {
  const unlock = fnBody("unlockControl");
  assert.match(
    unlock,
    /safeSecretEqual\(submitted, expected\)/,
    "both sides go through the module's own fixed-length digest compare",
  );
  assert.doesNotMatch(
    source,
    /timingSafeEqual/,
    "the comparison lives in @/lib/email/control, not in a second copy here",
  );
  assert.doesNotMatch(
    source,
    /function controlCookieValue|function constantTimeEqual|function digest/,
    "no local cookie format or comparison",
  );
  assert.match(
    source,
    /from "@\/lib\/email\/control"/,
    "the cookie is minted and verified through one module",
  );
});

test("a cookie minted by controlCookieValue satisfies requireControl's predicate", () => {
  const minted = controlCookieValue("an operator secret");
  assert.notEqual(minted, "an operator secret", "the secret never rides in the cookie");

  // This is the drift the shared module prevents: the page renders the lock
  // state with controlCookieMatches, so any format the writer mints must be
  // the exact value that predicate accepts.
  assert.equal(controlCookieMatches(minted, "an operator secret"), true);
  assert.equal(controlCookieMatches(minted, "another secret"), false);
  assert.equal(controlCookieMatches(undefined, "an operator secret"), false);
  assert.equal(controlCookieMatches(minted, undefined), false);
  assert.equal(controlCookieMatches("", "an operator secret"), false);
  assert.equal(controlCookieMatches(minted, ""), false);
});

test("both password forms spend the attempt budget before comparing anything", () => {
  const cases = [
    ["unlockControl", "safeSecretEqual("],
    ["unlockPage", "isPageUnlocked("],
  ] as const;

  for (const [name, comparison] of cases) {
    const body = fnBody(name);
    const budget = body.indexOf("await throttleUnlocks(");
    const compare = body.indexOf(comparison);
    assert.ok(budget >= 0, `${name} consults the limiter`);
    assert.ok(compare > 0, `${name} compares the submitted password`);
    assert.ok(
      budget < compare,
      `${name} must spend the budget first: a locked-out attacker must not learn anything from the comparison, including how long it takes`,
    );
    assert.ok(
      budget < body.indexOf("const submitted = "),
      `${name} throttles before it even reads the form`,
    );
  }
});

test("the unlock limiter is DB-backed, per-IP and global, 10 per 15 minutes", () => {
  assert.match(
    source,
    /import \{ bumpRateBucket, clientIp \} from "@\/lib\/demo\/rate-limit"/,
    "the same limiter the public demo uses, not a process-local counter",
  );
  assert.match(source, /const UNLOCK_MAX_PER_IP = 10;/);
  assert.match(source, /const UNLOCK_WINDOW_SECONDS = 15 \* 60;/);
  assert.ok(
    source.includes("email-unlock:${scope}:global:${window}"),
    "a global ceiling stops a distributed guess",
  );
  assert.ok(
    source.includes("email-unlock:${scope}:ip:${key}:${window}"),
    "a per-IP ceiling stops one guesser",
  );
  assert.match(
    source,
    /clientIp\(await headers\(\)\)/,
    "the header order is the limiter's (cf-connecting-ip first), not a new one",
  );
  assert.doesNotMatch(
    source,
    /headers\(\)\.get\(/,
    "no second opinion on which header names the client",
  );
});

test("a throttled unlock is the wrong-password refusal plus the wait", () => {
  assert.match(
    fnBody("unlockControl"),
    /throttled\(WRONG_SECRET, throttle\.retryAfterSeconds\)/,
  );
  assert.match(
    fnBody("unlockPage"),
    /throttled\(WRONG_PASSWORD, throttle\.retryAfterSeconds\)/,
  );
  assert.match(source, /const WRONG_SECRET = "Wrong secret\."/);
  assert.match(source, /const WRONG_PASSWORD = "Wrong password\."/);
  assert.ok(
    source.includes("error: `${wrongPassword} Too many attempts;"),
    "refusal opens with the action's own wrong-password sentence, so a throttled right password reads exactly like a throttled wrong one",
  );
});

test("unlockControl never says whether the env secret is set", () => {
  const unlock = fnBody("unlockControl");
  assert.ok(
    source.includes('const WRONG_SECRET = "Wrong secret.";'),
    "one fixed sentence for a missing secret and a wrong one",
  );
  assert.equal(
    (unlock.match(/error: WRONG_SECRET/g) ?? []).length,
    2,
    "both refusals in the action use that one sentence",
  );
  assert.doesNotMatch(
    unlock,
    /not configured|missing env|is not set|unset/i,
    "a wrong secret and an unset secret must be the same answer",
  );
  assert.doesNotMatch(source, /console\.(log|error|warn)/, "nothing sensitive is logged");
});

test("unlockControl sets the documented cookie", () => {
  const unlock = fnBody("unlockControl");
  assert.match(unlock, /name: EMAIL_CONTROL_COOKIE/);
  assert.match(unlock, /value: controlCookieValue\(expected\)/);
  assert.match(unlock, /httpOnly: true/);
  assert.match(unlock, /sameSite: "lax"/);
  assert.match(unlock, /path: "\/email"/);
  assert.match(unlock, /maxAge: 60 \* 60 \* 12/);
  assert.match(unlock, /secure: process\.env\.NODE_ENV === "production"/);
  assert.match(
    source,
    /EMAIL_CONTROL_COOKIE,/,
    "the cookie name is imported from @/lib/email/control",
  );
  assert.doesNotMatch(
    source,
    /const COOKIE = "voni_email_control"/,
    "the name is not re-declared here",
  );
});

test("unlock and lock redirect to a fixed notice instead of returning success state", () => {
  const unlock = fnBody("unlockControl");
  assert.match(unlock, /redirect\("\/email\?notice=unlocked"\)/);
  assert.doesNotMatch(unlock, /return\s*\{\s*ok: true/);

  const lock = fnBody("lockControl");
  assert.match(lock, /redirect\("\/email\?notice=locked"\)/);
  assert.doesNotMatch(lock, /return\s*\{\s*ok: true/);
});

test("lockControl keeps the redirect and warns that it rejects", () => {
  // The action never returns: `redirect` rejects by design. The caller in the
  // panel must tolerate that rejection rather than report a failed lock, so
  // the contract has to be in the action's own doc comment.
  assert.match(source, /tolerate a rejected promise/);
});

test("lockPage drops both grants, not just the visible one", () => {
  const lock = fnBody("lockPage");
  assert.match(lock, /cookieStore\.delete\(\{ name: PAGE_COOKIE, path: "\/email" \}\)/);
  assert.match(
    lock,
    /cookieStore\.delete\(\{ name: EMAIL_CONTROL_COOKIE, path: "\/email" \}\)/,
    "a locked page that still accepts writes is a lock that only hides the keypad",
  );
  assert.match(lock, /redirect\("\/email"\)/);
});

test("no success path returns the submitted secret", () => {
  for (const name of ["unlockControl", "lockControl"]) {
    const body = fnBody(name);
    assert.doesNotMatch(
      body,
      /return\s*\{[^}]*submitted/,
      `${name} must not echo what was typed into the form`,
    );
    assert.doesNotMatch(source, /message:\s*submitted/);
  }
  // A failed unlock is still a returned state, so the form can show it without
  // navigating away from the page.
  assert.match(
    fnBody("unlockControl"),
    /return \{ ok: false, error: WRONG_SECRET \}/,
  );
});

test("saveVolume clamps through validateVolume before writing", () => {
  const save = fnBody("saveVolume");
  assert.match(save, /validateVolume\(\{/);
  assert.match(save, /frequencyMs: frequencyMinutes \* 60_000/);
  assert.match(save, /clicksPerDay\(/);
  assert.ok(
    save.indexOf("if (!volume.ok)") < save.indexOf("updateCheck("),
    "an invalid volume never reaches Grafana",
  );
});

test("SyntheticResult failures are mapped, not echoed", () => {
  assert.match(source, /reason === "not_configured"/);
  assert.ok(source.includes("Grafana credentials are not configured on this deployment."));
  for (const name of ["saveVolume", "toggleCheck"]) {
    assert.match(fnBody(name), /describeSyntheticFailure\(/);
  }
});

test("no action reads or returns an upstream body", () => {
  assert.doesNotMatch(source, /response\.(json|text|arrayBuffer)\(/);
  assert.doesNotMatch(source, /await\s+response\.clone\(\)/);
  assert.doesNotMatch(source, /(error|message):\s*result\.data/);
});

test("the check id comes from the shared resolver, not a local copy", () => {
  assert.match(source, /resolveCheckId\(await secret\("EMAIL_CLICK_CHECK_ID"\)\)/);
  assert.doesNotMatch(
    source,
    /const DEFAULT_CHECK_ID|function checkId/,
    "the fallback and the parse live in one module",
  );
  // The resolver itself, so this test fails if the shared copy is moved or its
  // fallback changes without the panel following.
  assert.match(syntheticSource, /export const DEFAULT_CHECK_ID = 68584;/);
  assert.match(
    syntheticSource,
    /export function resolveCheckId\(raw: string \| undefined\): number \{/,
  );
  assert.match(
    syntheticSource,
    /Number\.isInteger\(parsed\) && parsed > 0 \? parsed : DEFAULT_CHECK_ID/,
  );
});

test("the one-off click says it runs from voni's server, not Grafana", () => {
  const click = fnBody("runOneOffClick");
  assert.match(click, /not Grafana/);
  // The identity (UA, referer, redirect policy) is owned by the simulator so
  // this button and the Grafana check cannot drift; the action must not
  // hand-roll a second set of headers.
  assert.match(click, /simulateOneClick\(\{ target, source \}\)/);
  assert.doesNotMatch(click, /referer:/);
  assert.doesNotMatch(click, /user-agent/);
  assert.match(click, /recordAffiliateClick\(/);
  assert.match(click, /userAgent,\n\s+device,\n\s+browser,/);
});

test("unlockPage compares through isPageUnlocked and stores only the digest", () => {
  const unlock = fnBody("unlockPage");
  assert.match(
    unlock,
    /isPageUnlocked\(\s*pagePasswordDigest\(submitted\),\s*expected\s*\)/,
    "the page gate is decided by the shared module, not a local comparison",
  );
  assert.match(unlock, /name: PAGE_COOKIE/);
  assert.match(unlock, /value: pagePasswordDigest\(submitted\)/);
  assert.doesNotMatch(
    unlock,
    /value:\s*submitted\b/,
    "the cookie never carries the submitted password itself",
  );
  assert.match(unlock, /\.\.\.pageGateCookieOptions\(\)/);
  assert.match(unlock, /redirect\("\/email"\)/);
});

test("unlockPage never returns or echoes the submitted password", () => {
  const unlock = fnBody("unlockPage");
  assert.doesNotMatch(unlock, /return\s*\{[^}]*submitted/);
  assert.doesNotMatch(unlock, /message:\s*submitted/);
  assert.doesNotMatch(unlock, /console\.(log|error|warn)/);
  assert.match(unlock, /error: "This page is not configured\."/);
  assert.match(unlock, /return \{ ok: false, error: WRONG_PASSWORD \}/);
  // The single-line regex deliberately cannot span the two error returns, so
  // naming the variable in either message would fail here.
  assert.doesNotMatch(unlock, /error:.*EMAIL_PAGE_PASSWORD/);
});

test("unlockPage checks the configuration before comparing anything", () => {
  const unlock = fnBody("unlockPage");
  assert.match(unlock, /secret\("EMAIL_PAGE_PASSWORD"\)/);
  assert.ok(
    unlock.indexOf("if (!expected)") < unlock.indexOf("isPageUnlocked("),
    "an unset page password never reaches the comparison",
  );
});

