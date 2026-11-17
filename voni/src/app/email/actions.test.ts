/**
 * Source-text assertions for the `/email` control actions, in the same shape as
 * the repo's other mutation tests. The node runner has no Next request context
 * or Grafana, so what is proved here is the surface itself: every mutation
 * gates on the control cookie above input handling, the unlock comparison is
 * constant time and never names deployment configuration, and no result can
 * carry an upstream body.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "actions.ts"),
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

test("unlockControl compares with timingSafeEqual over SHA-256 digests", () => {
  const unlock = fnBody("unlockControl");
  assert.match(unlock, /timingSafeEqual\(digest\(/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.ok(
    unlock.includes("digest(submitted)") && unlock.includes("digest(expected)"),
    "both sides are hashed before comparison, so the buffers are fixed length",
  );
});

test("unlockControl never says whether the env secret is set", () => {
  const unlock = fnBody("unlockControl");
  assert.ok(unlock.includes('"Wrong secret."'));
  assert.doesNotMatch(
    unlock,
    /not configured|missing env|is not set|unset/i,
    "a wrong secret and an unset secret must be the same answer",
  );
  assert.doesNotMatch(source, /console\.(log|error|warn)/, "nothing sensitive is logged");
});

test("unlockControl sets the documented cookie", () => {
  const unlock = fnBody("unlockControl");
  assert.match(unlock, /name: COOKIE/);
  assert.match(unlock, /httpOnly: true/);
  assert.match(unlock, /sameSite: "lax"/);
  assert.match(unlock, /path: "\/email"/);
  assert.match(unlock, /maxAge: 60 \* 60 \* 12/);
  assert.match(unlock, /secure: process\.env\.NODE_ENV === "production"/);
  assert.ok(source.includes('const COOKIE = "voni_email_control"'));
});

test("unlock and lock redirect to a fixed notice instead of returning success state", () => {
  const unlock = fnBody("unlockControl");
  assert.match(unlock, /redirect\("\/email\?notice=unlocked"\)/);
  assert.doesNotMatch(unlock, /return\s*\{\s*ok: true/);

  const lock = fnBody("lockControl");
  assert.match(lock, /redirect\("\/email\?notice=locked"\)/);
  assert.doesNotMatch(lock, /return\s*\{\s*ok: true/);
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
  assert.match(fnBody("unlockControl"), /return \{ ok: false, error: "Wrong secret\." \}/);
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

test("the check id comes from the named secret with the known fallback", () => {
  assert.match(source, /secret\("EMAIL_CLICK_CHECK_ID"\)/);
  assert.match(source, /DEFAULT_CHECK_ID = 68584/);
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

  const errorMessages = [...unlock.matchAll(/error: "([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(errorMessages, [
    "This page is not configured.",
    "Wrong password.",
  ]);
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

test("lockPage drops the gate cookie and returns to the gate", () => {
  const lock = fnBody("lockPage");
  assert.match(lock, /cookieStore\.delete\(\{ name: PAGE_COOKIE, path: "\/email" \}\)/);
  assert.match(lock, /redirect\("\/email"\)/);
});
