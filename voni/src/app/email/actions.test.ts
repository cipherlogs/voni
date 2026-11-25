/**
 * Source-text assertions for the `/email` control actions, in the same shape as
 * the repo's other mutation tests. The node runner has no Next request context
 * or Grafana, so what is proved here is the surface itself: every mutation
 * gates on the page grant above input handling, the one password form spends an
 * attempt budget before comparing anything, the write gate and the page gate
 * are the same predicate, and no result can carry an upstream body.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isPageUnlocked,
  pagePasswordDigest,
} from "@/lib/email/page-gate";
import { baseTargetUrl } from "@/lib/email/pool";
import { buildCheckScript } from "@/lib/email/check-script";
import {
  TARGET_SELECTION_DEFAULT,
  pickTarget,
  readTargetSelection,
} from "@/lib/email/target-selection";
import {
  UNLOCK_MAX_GLOBAL,
  UNLOCK_MAX_PER_IP,
  UNLOCK_UNAVAILABLE_MESSAGE,
  UNLOCK_WINDOW_SECONDS,
  spendUnlockAttempt,
} from "@/lib/email/unlock-throttle";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");
const throttleSource = readFileSync(
  join(here, "../../lib/email/unlock-throttle.ts"),
  "utf8",
);
const rateLimitSource = readFileSync(
  join(here, "../../lib/demo/rate-limit.ts"),
  "utf8",
);
const syntheticSource = readFileSync(
  join(here, "../../lib/grafana/synthetic.ts"),
  "utf8",
);
const clicksSource = readFileSync(
  join(here, "../../lib/email/clicks.ts"),
  "utf8",
);

/** One valid script secret; `buildCheckScript` refuses a malformed literal. */
const SECRET = "0123456789abcdef0123456789abcdef";
/**
 * The removed control secret's variable name, composed so this file can never
 * satisfy — or trip — the sweep that proves it is gone.
 */
const REMOVED_CONTROL = ["EMAIL", "CONTROL"].join("_");
/** A target row's own URL, which is what `baseTargetUrl` folds a stamp onto. */
const TARGET_A = "https://voni.cc/a";
const TARGET_B = "https://voni.cc/b";

function fnBody(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf("\nexport async function", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

/** The body of an internal helper, which is not exported from a server module. */
function anyBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf("\nasync function ", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

test("every mutating action calls requirePageUnlock() itself", () => {
  for (const name of ["saveVolume", "toggleCheck", "runOneOffClick"]) {
    const body = fnBody(name);
    assert.match(
      body,
      /requirePageUnlock\(\)/,
      `${name} must re-check the page grant; client rendering is not a gate`,
    );
    assert.ok(
      body.indexOf("requirePageUnlock()") < body.indexOf("return locked()"),
      `${name} refuses before doing anything else`,
    );
  }
});

test("the write gate is auth-before-input", () => {
  const save = fnBody("saveVolume");
  assert.ok(
    save.indexOf("requirePageUnlock()") < save.indexOf("validateVolume({"),
    "saveVolume gates before parsing the form",
  );
  assert.ok(
    save.indexOf("requirePageUnlock()") < save.indexOf("updateCheck("),
    "saveVolume gates before writing to Grafana",
  );

  const toggle = fnBody("toggleCheck");
  assert.ok(
    toggle.indexOf("requirePageUnlock()") < toggle.indexOf("getCheck("),
    "toggleCheck gates before reading the check",
  );

  const click = fnBody("runOneOffClick");
  assert.ok(
    click.indexOf("requirePageUnlock()") < click.indexOf("listAffiliateTargets()"),
    "runOneOffClick gates before drawing a target",
  );
});

test("a write is authorized by the page password alone, and refused when the page is locked", () => {
  const PASSWORD = "the operator's page password";
  // Exactly the value `unlockPage` puts in the cookie: nothing else is minted.
  const granted = pagePasswordDigest(PASSWORD);

  assert.notEqual(granted, PASSWORD, "the password never rides in the cookie");
  assert.equal(
    isPageUnlocked(granted, PASSWORD),
    true,
    "an unlocked page writes: the page grant is the whole authorization",
  );
  assert.equal(
    isPageUnlocked(undefined, PASSWORD),
    false,
    "a locked or expired page has no cookie, so the write is refused",
  );
  assert.equal(
    isPageUnlocked(pagePasswordDigest("a guess"), PASSWORD),
    false,
    "another password's grant is refused",
  );
  assert.equal(
    isPageUnlocked(granted, ""),
    false,
    "an unconfigured password grants nothing",
  );

  // And the action's gate is that same predicate over that same cookie: one
  // answer for the page that renders the panel and the writes it offers, not a
  // second lock that can drift from it.
  const gate = anyBody("requirePageUnlock");
  assert.match(gate, /isPageUnlocked\(/, "the gate delegates the comparison");
  assert.match(gate, /cookieStore\.get\(PAGE_COOKIE\)/, "it reads the page cookie");
  assert.match(
    gate,
    /secret\("EMAIL_PAGE_PASSWORD"\)/,
    "it compares against the page password",
  );
  assert.doesNotMatch(gate, /controlCookie|safeSecretEqual/);
  assert.ok(
    !gate.includes(REMOVED_CONTROL),
    "the gate never reads the removed control secret",
  );
  assert.doesNotMatch(
    source,
    /unlockControl|lockControl/,
    "the second password form and its lock action are gone",
  );
  assert.doesNotMatch(
    source,
    /timingSafeEqual|function digest/,
    "no local comparison: the predicate lives in @/lib/email/page-gate",
  );
  assert.match(
    source,
    /from "@\/lib\/email\/page-gate"/,
    "the grant is minted and verified through one module",
  );
});

test("the removed control secret is gone from the code and the operator docs", () => {
  // Composed so this file cannot satisfy its own check.
  const REMOVED = [
    `${REMOVED_CONTROL}_SECRET`,
    ["voni", "email", "control"].join("_"),
    ["lib/email", "control"].join("/"),
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|md)$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(here, "../.."));
  files.push(join(here, "../../../ENVIRONMENT.md"));
  files.push(join(here, "../../../../docs/agents/email-pool.md"));

  assert.ok(files.length > 50, "the walk reaches the app sources");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const needle of REMOVED) {
      assert.ok(
        !text.includes(needle),
        `${file} still names the removed control secret (${needle})`,
      );
    }
  }
});

test("the one password form spends the attempt budget before comparing anything", () => {
  const body = fnBody("unlockPage");
  const budget = body.indexOf("await throttleUnlocks(");
  const compare = body.indexOf("isPageUnlocked(");
  assert.ok(budget >= 0, "unlockPage consults the limiter");
  assert.ok(compare > 0, "unlockPage compares the submitted password");
  assert.ok(
    budget < compare,
    "unlockPage must spend the budget first: a locked-out attacker must not learn anything from the comparison, including how long it takes",
  );
  assert.ok(
    budget < body.indexOf("const submitted = "),
    "unlockPage throttles before it even reads the form",
  );
});

test("the unlock limiter is DB-backed, per-IP and global, 10 per 15 minutes", () => {
  assert.match(
    source,
    /import \{ clientIp \} from "@\/lib\/demo\/rate-limit"/,
    "the same limiter the public demo uses, not a process-local counter",
  );
  assert.match(
    source,
    /spendUnlockAttempt\(\{ scope, ip: clientIp\(await headers\(\)\) \}\)/,
    "the policy is shared; the action supplies the form's scope and the caller's IP",
  );
  assert.match(
    throttleSource,
    /from "@\/lib\/demo\/rate-limit"/,
    "the store is the demo's Postgres-backed bucket, not a process-local map",
  );
  assert.equal(UNLOCK_MAX_PER_IP, 10);
  assert.equal(UNLOCK_WINDOW_SECONDS, 15 * 60);
  assert.ok(
    throttleSource.includes("email-unlock:${scope}:global:${window}"),
    "a global ceiling stops a distributed guess",
  );
  assert.ok(
    throttleSource.includes("email-unlock:${scope}:ip:${key}:${window}"),
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
  assert.ok(
    UNLOCK_MAX_GLOBAL >= 20 * UNLOCK_MAX_PER_IP,
    "the ceiling is out of reach for one IP's whole budget",
  );
});

/** A fake bucket store: the same atomic-increment contract, no database. */
function memoryBuckets() {
  const counts = new Map<string, number>();
  return {
    counts,
    bump: async (bucket: string, limit: number) => {
      const count = (counts.get(bucket) ?? 0) + 1;
      counts.set(bucket, count);
      return { ok: count <= limit, count };
    },
  };
}

const NOW = 1_700_000_000_000;
const WINDOW = Math.floor(NOW / (UNLOCK_WINDOW_SECONDS * 1000));

test("one IP's flood cannot spend the global ceiling or lock another IP out", async () => {
  const store = memoryBuckets();
  let allowedFromFlood = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const verdict = await spendUnlockAttempt({
      scope: "page",
      ip: "203.0.113.10",
      now: NOW,
      bump: store.bump,
    });
    if (verdict.allowed) allowedFromFlood += 1;
  }

  assert.equal(
    allowedFromFlood,
    UNLOCK_MAX_PER_IP,
    "the flood spends its own ten attempts and no more",
  );
  assert.equal(
    store.counts.get(`email-unlock:page:global:${WINDOW}`),
    UNLOCK_MAX_PER_IP,
    "200 requests from one IP reach the global bucket only as often as that IP was allowed",
  );

  const operator = await spendUnlockAttempt({
    scope: "page",
    ip: "198.51.100.7",
    now: NOW,
    bump: store.bump,
  });
  assert.deepEqual(
    operator,
    { allowed: true },
    "the correct password from a different address must still be able to unlock",
  );
});

test("a refused per-IP attempt never touches the global bucket", async () => {
  const calls: string[] = [];
  const bump = async (bucket: string) => {
    calls.push(bucket);
    return { ok: !bucket.includes(":ip:"), count: 999 };
  };

  const verdict = await spendUnlockAttempt({
    scope: "page",
    ip: "203.0.113.10",
    now: NOW,
    bump,
  });

  assert.equal(verdict.allowed, false);
  assert.equal(calls.length, 1, "the per-IP bucket is consulted first and alone");
  assert.match(calls[0]!, /:ip:/);
});

test("an allowed attempt spends the per-IP bucket before the global one", async () => {
  const calls: string[] = [];
  const bump = async (bucket: string) => {
    calls.push(bucket);
    return { ok: true, count: 1 };
  };

  await spendUnlockAttempt({
    scope: "page",
    ip: "203.0.113.10",
    now: NOW,
    bump,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /:ip:/);
  assert.match(calls[1]!, /:global:/);
});

test("an unresolved IP spends only the global bucket, not a fake per-IP one", async () => {
  const store = memoryBuckets();

  const verdict = await spendUnlockAttempt({
    scope: "page",
    ip: "unknown",
    now: NOW,
    bump: store.bump,
  });

  assert.deepEqual(verdict, { allowed: true });
  assert.deepEqual([...store.counts.keys()], [
    `email-unlock:page:global:${WINDOW}`,
  ]);
});

test("a limiter outage is a visible refusal, not a rejected action", async () => {
  const verdict = await spendUnlockAttempt({
    scope: "page",
    ip: "203.0.113.10",
    now: NOW,
    bump: async () => {
      throw new Error("the database is down");
    },
  });

  assert.deepEqual(verdict, {
    allowed: false,
    reason: "unavailable",
    error: "Could not check attempts right now. Try again in a moment.",
  });
  assert.equal(
    UNLOCK_UNAVAILABLE_MESSAGE,
    "Could not check attempts right now. Try again in a moment.",
  );
});

test("the password form returns the outage message instead of throwing", () => {
  const body = fnBody("unlockPage");
  assert.match(
    body,
    /if \(throttle\.reason === "unavailable"\)[\s\S]*return \{ ok: false, error: throttle\.error \}/,
    "unlockPage must render a limiter outage, not reject",
  );
  assert.ok(
    body.includes("throttled(WRONG_PASSWORD, throttle.retryAfterSeconds)"),
    "unlockPage still answers a real throttle as a wrong password",
  );
  assert.match(
    body,
    /if \(!throttle\.allowed\)/,
    "unlockPage decides from the verdict before anything else",
  );
});

test("the bucket salt comes from the deployment secret, not a public literal alone", () => {
  assert.match(
    throttleSource,
    /const salt = \(await secret\("BETTER_AUTH_SECRET"\)\) \?\? "voni-email-unlock";/,
    "the Worker binding is read through secret(); process.env alone can be empty",
  );
  assert.match(
    rateLimitSource,
    /const salt = \(await secret\("BETTER_AUTH_SECRET"\)\) \?\? "voni-demo";/,
    "the demo's IP key has the same flaw and the same fix",
  );
  for (const [label, text] of [
    ["actions.ts", throttleSource],
    ["rate-limit.ts", rateLimitSource],
  ] as const) {
    assert.doesNotMatch(
      text,
      /process\.env\.BETTER_AUTH_SECRET/,
      `${label} must not read the secret from process.env only`,
    );
  }
  assert.match(
    throttleSource,
    /the fallback \*is\* what runs/,
    "the comment says the fallback is reachable in production rather than pretending",
  );
});

test("a target that answered non-2xx is a different sentence from a refused hop", () => {
  const click = fnBody("runOneOffClick");
  assert.match(
    click,
    /the target answered HTTP \$\{status\}/,
    "a 404 is a fact about the target and quotes its status",
  );
  assert.match(
    click,
    /the visit was stopped before the chain finished/,
    "a refused hop keeps the stopping language",
  );
  assert.doesNotMatch(
    click,
    /click\.message/,
    "neither sentence quotes the simulator's address-bearing message",
  );
});

test("a throttled unlock is the wrong-password refusal plus the wait", () => {
  assert.match(
    fnBody("unlockPage"),
    /throttled\(WRONG_PASSWORD, throttle\.retryAfterSeconds\)/,
  );
  assert.match(source, /const WRONG_PASSWORD = "Wrong password\."/);
  assert.doesNotMatch(
    source,
    /WRONG_SECRET/,
    "the second form's sentence went with the second form",
  );
  assert.ok(
    source.includes("error: `${wrongPassword} Too many attempts;"),
    "refusal opens with the action's own wrong-password sentence, so a throttled right password reads exactly like a throttled wrong one",
  );
});

test("the password form never says whether the env password is set", () => {
  const unlock = fnBody("unlockPage");
  assert.match(
    unlock,
    /if \(!expected\)[\s\S]*error: "This page is not configured\."/,
    "an unset password is one fixed sentence, not a probe for the deployment",
  );
  assert.doesNotMatch(unlock, /error:.*EMAIL_PAGE_PASSWORD/);
  assert.doesNotMatch(
    unlock,
    /missing env|is not set|unset/i,
    "the answer names no variable and no state of the environment",
  );
  assert.doesNotMatch(source, /console\.(log|error|warn)/, "nothing sensitive is logged");
});

test("lockPage drops the only grant and returns to the password screen", () => {
  const lock = fnBody("lockPage");
  assert.match(lock, /cookieStore\.delete\(\{ name: PAGE_COOKIE, path: "\/email" \}\)/);
  assert.equal(
    (lock.match(/cookieStore\.delete\(/g) ?? []).length,
    1,
    "one grant, one delete: there is no second cookie left to drop",
  );
  assert.match(lock, /redirect\("\/email"\)/);
});

test("unlockPage never echoes the submitted password and redirects on success", () => {
  const unlock = fnBody("unlockPage");
  assert.doesNotMatch(
    unlock,
    /return\s*\{[^}]*submitted/,
    "unlockPage must not echo what was typed into the form",
  );
  assert.doesNotMatch(source, /message:\s*submitted/);
  assert.match(unlock, /redirect\("\/email"\)/);
  assert.doesNotMatch(unlock, /return\s*\{\s*ok: true/);
});

test("saveVolume clamps through validateVolume before writing", () => {
  const save = fnBody("saveVolume");
  assert.match(save, /validateVolume\(\{/);
  assert.match(save, /frequencyMs: frequencyMinutes \* 60_000/);
  assert.match(save, /clicksPerDay\(/);
  assert.ok(
    save.indexOf("if (!volume.ok)") < save.indexOf("uploadRebuiltCheck("),
    "an invalid volume never reaches Grafana",
  );
});

test("saveVolume validates the clicks the form sent", () => {
  const save = fnBody("saveVolume");
  assert.match(save, /formData\.get\("clicks"\)/, "the form's clicks are read");
  assert.match(
    save,
    /validateVolume\(\{[\s\S]*?clicksPerRun,/,
    "the click count goes through the same gate as the interval and probes",
  );
  assert.ok(
    save.indexOf("clicksPerRun,") < save.indexOf("uploadRebuiltCheck("),
    "a refused click count never builds or uploads a script",
  );
  assert.match(
    save,
    /clicksPerDay\(\s*volume\.value\.frequencyMs,\s*volume\.value\.probeIds\.length,\s*volume\.value\.clicksPerRun,?\s*\)/,
    "the success message quotes the three-factor estimate the preview showed",
  );
});

test("saveVolume refuses when the report secret is unconfigured", () => {
  const save = fnBody("saveVolume");
  assert.match(save, /await secret\("EMAIL_CLICK_REPORT_SECRET"\)/);
  assert.match(save, /if \(!reportSecret\)/);
  assert.match(
    save,
    /EMAIL_CLICK_REPORT_SECRET is not configured on this deployment/,
    "the refusal names what to set",
  );
  assert.doesNotMatch(
    source,
    /REPORT_SECRET_PLACEHOLDER/,
    "the action must never fall back to the placeholder: that writes a script that clicks silently",
  );
  assert.ok(
    save.indexOf("if (!reportSecret)") < save.indexOf("uploadRebuiltCheck("),
    "an unset secret is refused before the script is built",
  );
});

test("saveVolume rebuilds with the live target list, not the seed", () => {
  // The bug this covers: `buildCheckScript` defaults to `targets.json`, so a
  // volume save after pausing a creative silently resumed every paused target.
  const save = fnBody("saveVolume");
  assert.match(save, /await activeTargetUrls\(\)/);
  assert.match(
    save,
    /uploadRebuiltCheck\(\{\s*clicksPerRun: volume\.value\.clicksPerRun,\s*targets,\s*selection,?\s*\}\)/,
    "the count, the live list and the chosen mode go to the one upload path",
  );
  const upload = save.indexOf("uploadRebuiltCheck(");
  const update = save.indexOf("updateCheck(");
  assert.ok(upload >= 0 && update > upload, "script first, then frequency");
});

test("saveVolume refuses a missing or unrecognised mode before touching Grafana", () => {
  const save = fnBody("saveVolume");
  assert.match(
    save,
    /const selection = parseTargetSelection\(formData\.get\("selection"\)\)/,
    "the submitted mode is parsed by the shared module, not read as a string",
  );
  assert.ok(
    save.indexOf('formData.get("selection")') > save.indexOf("requirePageUnlock()"),
    "the mode is read after the cookie gate, like every other input",
  );
  const refusal = save.indexOf("if (selection === null)");
  assert.ok(refusal >= 0, "a missing or unrecognised mode is a refusal");
  assert.ok(
    refusal < save.indexOf('secret("EMAIL_CLICK_REPORT_SECRET")'),
    "a request with no mode never reads the report secret",
  );
  assert.ok(
    refusal < save.indexOf("uploadRebuiltCheck("),
    "a request with no mode never builds or uploads a script",
  );
  assert.ok(
    refusal < save.indexOf("updateCheck("),
    "a request with no mode never rewrites the interval",
  );
  assert.match(
    save,
    /error:\s*"Choose how each click picks its target: Random or Rotate through all\."/,
    "the refusal names the two choices instead of guessing",
  );
  // The parse is strict: a save with no mode must not fall back to the default
  // the way the burst does, because a save *is* the operator choosing.
  assert.doesNotMatch(save, /selection\s*(\?\?|\|\|)/);
});

test("the mode saveVolume submits is the marker the uploaded script carries", () => {
  const random = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: [TARGET_A],
    selection: "random",
  });
  assert.match(
    random,
    /^const TARGET_SELECTION = "random";$/m,
    "the stored script names the mode the operator saved",
  );
  assert.equal(
    readTargetSelection(random),
    "random",
    "the panel reads back the same mode it wrote, not a copy that can drift",
  );

  const rotate = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: [TARGET_A],
    selection: "rotate",
  });
  assert.equal(readTargetSelection(rotate), "rotate");

  const upload = source.slice(
    source.indexOf("async function uploadRebuiltCheck("),
    source.indexOf("async function pushTargetsToCheck("),
  );
  assert.match(
    upload,
    /selection: TargetSelection;/,
    "the upload path requires a mode, so no caller can omit it and inherit a default",
  );
  assert.match(
    upload,
    /buildCheckScript\(\{[\s\S]*?selection: change\.selection,/,
    "the mode reaches the builder, which is what writes the marker",
  );
});

test("a target add or pause keeps the mode Grafana's stored script reports", () => {
  // `pushTargetsToCheck` is private; the body is the slice up to the next export.
  const start = source.indexOf("async function pushTargetsToCheck(");
  assert.ok(start >= 0, "pushTargetsToCheck exists");
  const sync = source.slice(start, source.indexOf("\nexport async function", start));
  assert.match(
    sync,
    /selection: current\.data\.targetSelection \?\? TARGET_SELECTION_DEFAULT/,
    "a marked mode is preserved, and an unmarked (no-choice-yet) script takes the new default",
  );
  assert.match(
    sync,
    /clicksPerRun: current\.data\.clicksPerRun/,
    "and the count is still the stored one",
  );

  // End to end on the text: the stored script is the only copy of the mode, so
  // reading it back and rebuilding with it must reproduce rotate.
  const stored = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: [TARGET_A, TARGET_B],
    selection: "rotate",
  });
  const rebuilt = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: [TARGET_A, TARGET_B],
    selection: readTargetSelection(stored),
  });
  assert.equal(
    readTargetSelection(rebuilt),
    "rotate",
    "a target edit must not silently switch the check to random",
  );
});

test("one upload path serves both the volume form and target changes", () => {
  const upload = source.slice(
    source.indexOf("async function uploadRebuiltCheck("),
    source.indexOf("async function pushTargetsToCheck("),
  );
  assert.match(upload, /buildCheckScript\(\{/, "one builder");
  assert.match(
    upload,
    /uploadCheckScript\(\s*id,\s*Buffer\.from\(script, "utf8"\)\.toString\("base64"\),\s*AFFILIATE_CHECK_JOB,?\s*\)/,
    "the stored script is base64 of the built text, aimed at the affiliate job",
  );
  assert.match(
    upload,
    /if \(!uploaded\.ok\)[\s\S]*?describeSyntheticFailure\(uploaded\)/,
    "an upload failure is reported, not swallowed",
  );
  assert.match(
    source,
    /async function pushTargetsToCheck\([\s\S]*?return uploadRebuiltCheck\(/,
    "a target change reuses the same upload",
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
  assert.match(click, /simulateOneClick\(\{/);
  assert.match(click, /target,\n\s+source,\n\s+targets:/);
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

test("the burst form's field names match what the card renders", () => {
  const card = readFileSync(
    new URL("../../components/burst-card.tsx", import.meta.url),
    "utf8",
  );
  const burst = fnBody("runBurst");

  // A name mismatch is invisible to the compiler and to the card: the checkbox
  // group submits nothing and the planner says "select at least one zone",
  // which reads as an operator mistake. That shipped once.
  for (const field of ["clicks", "duration", "zones"]) {
    assert.match(
      card,
      new RegExp(`name="${field}"`),
      `burst-card renders a ${field} field`,
    );
  }
  assert.match(burst, /formData\.getAll\("zones"\)/);
  assert.match(burst, /formData\.get\("clicks"\)/);
  assert.match(burst, /formData\.get\("duration"\)/);
});

test("every target mutation gates first, then changes both sides through one path", () => {
  const mutations: Array<[string, string]> = [
    ["addTarget", "addAffiliateTarget("],
    ["toggleTarget", "setAffiliateTargetEnabled("],
    ["removeTarget", "removeAffiliateTarget("],
  ];

  for (const [name, write] of mutations) {
    const body = fnBody(name);
    assert.match(body, /requirePageUnlock\(\)/, `${name} must gate`);
    assert.ok(
      body.indexOf("return targetLocked()") < body.indexOf("listAffiliateTargets()"),
      `${name} refuses before reading the list`,
    );
    // Both sides move in `applyTargetChange`, which uploads before the row and
    // rolls the upload back if the row refuses. Asserting the name here keeps
    // the call from silently bypassing that path.
    assert.match(
      body,
      /applyTargetChange\(/,
      `${name} must go through the upload-then-write path`,
    );
    assert.ok(
      body.indexOf("applyTargetChange(") < body.indexOf(write),
      `${name} hands the write to applyTargetChange rather than calling it first`,
    );
  }
});

test("the target actions are exported for the card, and each locks like the rest", () => {
  for (const name of ["addTarget", "toggleTarget", "removeTarget"]) {
    assert.match(source, new RegExp(`export async function ${name}\\(`));
    assert.match(fnBody(name), /return targetLocked\(\)/);
  }
});

test("a target change re-reads the click count instead of resetting it", () => {
  // `pushTargetsToCheck` is private to the module, so `fnBody` (which finds an
  // export) cannot reach it; the body is the slice up to the next export.
  const start = source.indexOf("async function pushTargetsToCheck(");
  assert.ok(start >= 0, "pushTargetsToCheck exists");
  const sync = source.slice(start, source.indexOf("\nexport async function", start));
  assert.match(
    sync,
    /clicksPerRun: current\.data\.clicksPerRun/,
    "the count lives in Grafana's stored script; a target edit must keep it",
  );
  assert.match(sync, /uploadRebuiltCheck\(/, "the change must reach the probes");
});

test("the one-off click draws from the ticked subset, not the whole list", () => {
  const click = fnBody("runOneOffClick");
  assert.match(click, /await listAffiliateTargets\(\)/);
  assert.match(
    click,
    /formData\.getAll\("target"\)/,
    "the form names the candidate subset, one checkbox per enabled row",
  );
  assert.match(
    click,
    /const chosen = active\.filter\(\(target\) => wanted\.has\(target\.id\)\)/,
    "a ticked id is resolved against the enabled rows, never used as a URL",
  );
  assert.match(
    click,
    /const candidates = chosen\.map\(\(target\) => target\.url\)/,
    "the row's own URL is the candidate, in list order",
  );
  assert.match(
    click,
    /pickTarget\(candidates, selection, lastVisits\)/,
    "both modes draw from that subset; only the history differs",
  );
  assert.match(
    click,
    /await lastClickByTargetUrl\(\)/,
    "rotate ranks the subset by the recorded history",
  );
  assert.match(
    click,
    /byBase\.get\(baseTargetUrl\(url\)\)/,
    "the history key is the base URL, so a row's own utm params do not steal the rotation",
  );
  assert.doesNotMatch(
    click,
    /pickTarget\((active|targets)\b/,
    "the whole list is never the draw just because the list was read",
  );
  assert.match(
    click,
    /targets: targets\.map\(\(row\) => row\.url\)/,
    "paused hosts stay on the redirect allowlist",
  );
  assert.doesNotMatch(click, /nextEmailTarget\(/);
});

test("the one-off click refuses an empty or stale selection without echoing it", () => {
  const click = fnBody("runOneOffClick");
  assert.match(
    click,
    /error:\s*"Select at least one target for this click\."/,
    "an empty selection is refused before any target is read",
  );
  assert.ok(
    click.indexOf("requested.length === 0") < click.indexOf("listAffiliateTargets()"),
    "the empty-selection refusal costs no database read",
  );
  assert.match(
    click,
    /if \(chosen\.length !== wanted\.size\)/,
    "every ticked id must still be an enabled row",
  );
  assert.match(
    click,
    /error:\s*"One of the selected targets is paused or no longer in the list\. Reload the page\."/,
    "a stale page gets one sentence, not a partial draw",
  );
  assert.ok(
    click.indexOf("chosen.length !== wanted.size") < click.indexOf("pickTarget("),
    "a stale id never reaches the draw",
  );
  assert.doesNotMatch(
    click.slice(
      click.indexOf("if (chosen.length !== wanted.size)"),
      click.indexOf("const candidates ="),
    ),
    /\$\{/,
    "the refusal must not echo the ids or the URLs it rejected",
  );
});

test("random draws only from the subset it is given", () => {
  const only = [TARGET_A];
  for (const r of [0, 0.5, 0.999_999]) {
    assert.equal(
      pickTarget(only, "random", new Map(), () => r),
      TARGET_A,
      "a one-row selection always clicks that row, whatever the draw",
    );
  }

  const subset = [TARGET_A, TARGET_B];
  const full = [TARGET_A, TARGET_B, "https://voni.cc/c"];
  assert.equal(
    pickTarget(subset, "random", new Map(), () => 0.99),
    TARGET_B,
    "the last entry of the subset, not the last entry of the list it came from",
  );
  assert.notEqual(
    pickTarget(subset, "random", new Map(), () => 0.99),
    full[2],
    "an unticked row can never be drawn",
  );
});

test("rotate picks the least-recently-clicked row of the subset, keyed by base URL", () => {
  const c = "https://voni.cc/c";
  // A click row stores the stamped URL; `baseTargetUrl` is what folds it back
  // onto the row's key. The action passes that map straight through.
  const stampedB = `${TARGET_B}?utm_source=gmail.com&utm_medium=email&utm_campaign=voni-email`;
  assert.equal(baseTargetUrl(stampedB), TARGET_B, "a stamped visit belongs to its target");

  const history = new Map<string, number>([
    [baseTargetUrl(TARGET_A), 1_000],
    [baseTargetUrl(stampedB), 500],
  ]);

  assert.equal(
    pickTarget([TARGET_A, TARGET_B], "rotate", history),
    TARGET_B,
    "the older visit goes next, not the newer one",
  );
  assert.equal(
    pickTarget([TARGET_A, TARGET_B, c], "rotate", history),
    c,
    "a row never clicked wins over every seen row",
  );
  assert.equal(
    pickTarget([TARGET_A], "rotate", history),
    TARGET_A,
    "a one-row selection rotates to itself rather than being excluded",
  );
  assert.equal(
    pickTarget([TARGET_A, TARGET_B], "rotate", new Map([
      [TARGET_A, 10],
      [TARGET_B, 10],
    ])),
    TARGET_A,
    "equal timestamps keep the list's own order",
  );
});

test("the rotation history is one entry per target, folded from the stamp", () => {
  const start = clicksSource.indexOf("export async function lastClickByTargetUrl(");
  assert.ok(start >= 0, "lastClickByTargetUrl exists");
  const body = clicksSource.slice(start, clicksSource.indexOf("\n/**", start));
  assert.match(body, /max\(affiliateClicks\.ranAt\)/, "the latest visit per stored URL");
  assert.match(body, /\.groupBy\(affiliateClicks\.target\)/);
  assert.match(
    body,
    /const base = baseTargetUrl\(row\.target\)/,
    "the stamp is why one target is many rows, so the fold is the point",
  );
  assert.match(
    body,
    /if \(seen === undefined \|\| at > seen\)/,
    "two providers visiting one target keep the later visit, not two entries",
  );
  assert.match(
    clicksSource,
    /stamps every one with its provider's/,
    "the module says why the fold exists, not just that it does",
  );
});

test("a Grafana read failure still lets the one-off click run, on the default mode", () => {
  const click = fnBody("runOneOffClick");
  assert.match(
    click,
    /const selection = current\.ok\s*\?\s*\(current\.data\.targetSelection \?\? TARGET_SELECTION_LEGACY\)\s*:\s*TARGET_SELECTION_DEFAULT/,
    "an unmarked script still rotates, so the one-off follows that; the default is only the read-failure fallback",
  );
  assert.doesNotMatch(
    click,
    /if \(!current\.ok\)\s*return/,
    "a Grafana outage must not refuse a click the operator asked for",
  );
  assert.ok(
    click.indexOf("getCheck(") < click.indexOf("pickTarget("),
    "the mode is resolved before the draw, so the fallback is what it draws with",
  );
  assert.equal(TARGET_SELECTION_DEFAULT, "random");
});

test("the burst carries the live list and the check's mode into the dispatch", () => {
  const burst = fnBody("runBurst");
  assert.match(burst, /await activeTargetUrls\(\)/);
  assert.match(
    burst,
    /const selection = current\.ok\s*\?\s*\(current\.data\.targetSelection \?\? TARGET_SELECTION_DEFAULT\)\s*:\s*TARGET_SELECTION_DEFAULT/,
    "a burst rebuilds the script, so it uses the check's mode — or the new default when the script predates the setting",
  );
  assert.match(
    burst,
    /dispatchBurst\(planned\.plan, \{ targets, selection \}\)/,
    "both travel as one payload, so a workflow cannot take one without the other",
  );
  assert.match(
    burst,
    /must not cost the operator a burst/,
    "the fallback is explained where it is written",
  );
  assert.doesNotMatch(
    burst,
    /if \(!current\.ok\)\s*return/,
    "a Grafana read failure is not a reason to refuse the burst",
  );
  assert.ok(
    burst.indexOf("targets.length === 0") < burst.indexOf("dispatchBurst("),
    "an all-paused list must not dispatch the committed seed",
  );
});

test("adding a target uploads the active list, not the paused rows too", () => {
  const body = fnBody("addTarget");
  assert.match(
    body,
    /filter\(\(target\) => target\.enabled\)/,
    "a paused target must not start clicking because a sibling was added",
  );
  assert.match(body, /next: \[\.\.\.active, url\]/);
  assert.match(body, /canonicalTargetUrl\(raw\)/, "the row identity is canonical");
});

test("a failed row write puts the probes back to the previous list", () => {
  const change = source.slice(
    source.indexOf("async function applyTargetChange("),
    source.indexOf("const NO_ACTIVE_TARGETS"),
  );
  assert.match(
    change,
    /pushTargetsToCheck\(change\.next\)[\s\S]*?await write\(\)[\s\S]*?pushTargetsToCheck\(change\.previous\)/,
    "script, row, then a rollback upload when the row refused",
  );
  assert.match(change, /may still click the new list/, "a failed rollback is admitted");
});

test("pause and remove share one empty-list refusal", () => {
  assert.match(source, /const NO_ACTIVE_TARGETS =/);
  for (const name of ["toggleTarget", "removeTarget"]) {
    assert.match(fnBody(name), /next\.length === 0\) return \{ ok: false, error: NO_ACTIVE_TARGETS \}/);
  }
  // One owner for the rule; the data layer is the backstop, not a second gate
  // with its own sentence in the action.
  assert.doesNotMatch(fnBody("removeTarget"), /targets\.length <= 1/);
});

test("a burst refuses an empty active list instead of falling back to the seed", () => {
  const burst = fnBody("runBurst");
  assert.ok(
    burst.indexOf("targets.length === 0") < burst.indexOf("dispatchBurst("),
    "an all-paused list must not dispatch the committed seed",
  );
});

const GITHUB_ACTIONS = ["setGithubSourceEnabled", "saveGithubSchedule"];

test("the GitHub source actions gate inside the body, before reading the form", () => {
  for (const name of GITHUB_ACTIONS) {
    const body = fnBody(name);
    assert.match(
      body,
      /if \(!\(await requirePageUnlock\(\)\)\) return locked\(\);/,
      `${name} refuses before it parses anything`,
    );
    assert.ok(
      body.indexOf("requirePageUnlock()") < body.indexOf("formData.get("),
      `${name} authorises before the first field read`,
    );
  }
});

test("an illegal schedule value is refused by the shared parser and nothing is written", () => {
  const body = fnBody("saveGithubSchedule");

  assert.match(body, /parseInterval\(formData\.get\("interval"\)\)/);
  assert.match(body, /parseWindowSeconds\(formData\.get\("window"\)\)/);
  assert.match(body, /parseWindowStartHour\(formData\.get\("startHour"\)\)/);

  for (const parsed of ["interval", "activeWindow", "startHour"]) {
    assert.match(
      body,
      new RegExp(
        `if \\(!${parsed}\\.ok\\) return \\{ ok: false, error: ${parsed}\\.reason \\}`,
      ),
      `${parsed} refuses with the parser's fixed sentence`,
    );
  }

  // Every value is parsed before the row is touched: a bad start hour must not
  // leave a new interval behind.
  assert.ok(body.indexOf("interval.ok") < body.indexOf("activeWindow.ok"));
  assert.ok(body.indexOf("activeWindow.ok") < body.indexOf("startHour.ok"));
  assert.ok(
    body.indexOf("startHour.ok") < body.indexOf("saveSourceSchedule("),
    "the write is the last step after all three gates",
  );
});

test("the source actions take their rules from the schedule domain and its DB boundary", () => {
  assert.match(
    source,
    /import \{[\s\S]*?parseInterval,[\s\S]*?parseWindowSeconds,[\s\S]*?parseWindowStartHour,[\s\S]*?\} from "@\/lib\/email\/sources";/,
    "the parsers are the same ones the card and ticker use",
  );
  assert.match(
    source,
    /import \{[\s\S]*?GITHUB_SOURCE_PRODUCER,[\s\S]*?readSourceConfig,[\s\S]*?recordSourceDispatch,[\s\S]*?saveSourceSchedule,[\s\S]*?setSourceEnabled,[\s\S]*?\} from "@\/lib\/email\/source-config";/,
    "the row is read and written through the one source-config boundary",
  );

  const toggle = fnBody("setGithubSourceEnabled");
  assert.match(toggle, /setSourceEnabled\(GITHUB_SOURCE_PRODUCER, enabled\)/);
  assert.match(toggle, /const raw = formData\.get\("enabled"\)/);
  assert.match(
    toggle,
    /raw !== "true" && raw !== "false"/,
    "only the two words a form may post are accepted",
  );

  const schedule = fnBody("saveGithubSchedule");
  assert.match(
    schedule,
    /saveSourceSchedule\(GITHUB_SOURCE_PRODUCER, \{/,
    "the row is written through the one source-config boundary",
  );
});

test("every source action ends in a fixed sentence, and a refusal writes nothing", () => {
  const toggle = fnBody("setGithubSourceEnabled");
  assert.match(
    source,
    /const SOURCE_STATE_REASON = "Source state must be on or off\.";/,
  );
  assert.match(toggle, /return \{ ok: false, error: SOURCE_STATE_REASON \}/);
  assert.match(
    toggle,
    /"GitHub source enabled\. It starts clicking on the next tick, inside its window\."/,
  );
  assert.match(
    toggle,
    /"GitHub source disabled\. Nothing clicks from GitHub until it is enabled again\."/,
  );

  const schedule = fnBody("saveGithubSchedule");
  assert.match(
    schedule,
    /"Schedule saved\. The new interval, window and start hour apply on the next dispatch\."/,
  );
});

test("a successful source save revalidates, and no refusal does", () => {
  const writeFor: Record<string, string> = {
    setGithubSourceEnabled: "await setSourceEnabled(",
    saveGithubSchedule: "await saveSourceSchedule(",
  };
  for (const name of GITHUB_ACTIONS) {
    const body = fnBody(name);
    const writes = body.match(/revalidatePath\("\/email"\)/g) ?? [];
    assert.equal(writes.length, 1, `${name} revalidates once`);
    assert.ok(
      body.indexOf("revalidatePath(") > body.indexOf(writeFor[name]),
      `${name} revalidates only after the write`,
    );
    assert.match(
      body,
      /revalidatePath\("\/email"\);\s*\n\s*return \{\s*\n\s*ok: true,/,
      `${name} revalidates on the success path, not on a refusal`,
    );
  }
});

test("the source actions never echo the control secret or a submitted value", () => {
  for (const name of GITHUB_ACTIONS) {
    const body = fnBody(name);
    assert.doesNotMatch(body, /EMAIL_PAGE_PASSWORD|pagePasswordDigest|cookieStore.get(PAGE_COOKIE)/);
    assert.doesNotMatch(body, /\$\{formData|\$\{raw\}/);
    assert.doesNotMatch(body, /console\.(log|error)/);
  }
});

test("dispatch now gates inside the body, before it reads the OS", () => {
  const body = fnBody("dispatchGithubNow");
  assert.match(
    body,
    /if \(!\(await requirePageUnlock\(\)\)\) return \{ ok: false, error: LOCKED\.error \};/,
    "the dispatch refuses without the control cookie",
  );
  assert.ok(
    body.indexOf("requirePageUnlock()") < body.indexOf('formData.get("os")'),
    "authorisation happens before the first field read",
  );
  assert.ok(
    body.indexOf("requirePageUnlock()") < body.indexOf("dispatchBrowserCheck("),
    "a locked request never reaches GitHub",
  );
});

test("an OS outside the allowlist is refused with one fixed sentence", () => {
  const body = fnBody("dispatchGithubNow");
  assert.match(
    source,
    /const GITHUB_OS_REASON =\s*\n?\s*"Choose one operating system to dispatch: ubuntu, windows or macos\.";/,
  );
  assert.match(
    body,
    /\(RUNNER_OSES as readonly string\[\]\)\.includes\(os\)/,
    "the closed set in the schedule domain is the gate, not a second list",
  );
  assert.match(body, /if \(!.*includes\(os\)\) \{\s*return \{ ok: false, error: GITHUB_OS_REASON \};/);
  assert.ok(
    body.indexOf("GITHUB_OS_REASON") < body.indexOf("dispatchBrowserCheck("),
    "an unknown OS is refused before the dispatch",
  );
});

test("an all-paused list and a missing config row are refused, not dispatched", () => {
  const body = fnBody("dispatchGithubNow");
  assert.match(source, /const GITHUB_NO_TARGETS_REASON =/);
  assert.match(source, /const GITHUB_NOT_CONFIGURED_REASON =/);
  assert.match(body, /const targets = await activeTargetUrls\(\);/);
  assert.match(body, /if \(targets\.length === 0\) \{\s*return \{ ok: false, error: GITHUB_NO_TARGETS_REASON \};\s*\}/);
  assert.match(body, /const config = await readSourceConfig\(\);/);
  assert.match(body, /if \(!config\) return \{ ok: false, error: GITHUB_NOT_CONFIGURED_REASON \};/);
  assert.ok(
    body.indexOf("targets.length === 0") < body.indexOf("dispatchBrowserCheck("),
    "an empty list must not fall back to the committed seed",
  );
  assert.ok(
    body.indexOf("if (!config)") < body.indexOf("dispatchBrowserCheck("),
    "no schedule means nothing to dispatch",
  );
});

test("one OS is dispatched with the current targets and the saved interval and window", () => {
  const body = fnBody("dispatchGithubNow");

  // Targets come from the live list, never the form: a body that could name a
  // host would make this an open proxy on GitHub's runners.
  assert.doesNotMatch(body, /formData\.getAll\(/);
  assert.match(body, /dispatchBrowserCheck\(\{\s*os: os as RunnerOs,\s*targets,\s*intervalSeconds: config\.intervalSeconds,\s*windowSeconds: segment,?\s*\}\)/);

  // One segment, clamped to the job ceiling: the last part of an open window,
  // or a full segment when the window is closed.
  assert.match(
    body,
    /Math\.min\(\s*windowRemainingSeconds\(now, config\.windowSeconds, config\.windowStartHour\) \|\|\s*MAX_JOB_SECONDS,\s*MAX_JOB_SECONDS,?\s*\)/,
    "the window is the remaining segment, capped at MAX_JOB_SECONDS",
  );
  assert.match(source, /MAX_JOB_SECONDS[\s\S]*?from "@\/lib\/email\/sources"/);
});

test("a missing dispatch token is a manual success: the command, not an error", () => {
  const body = fnBody("dispatchGithubNow");

  assert.match(
    body,
    /if \(result\.mode === "manual"\) \{[\s\S]*?ok: true,\s*mode: "manual",[\s\S]*?fallback: result\.fallback,/,
    "manual mode is ok:true and carries the runnable command",
  );
  assert.match(
    body,
    /"No dispatch token is configured, so nothing was queued — run this line yourself:"/,
  );
  assert.ok(
    body.indexOf('result.mode === "manual"') < body.indexOf("recordSourceDispatch("),
    "a manual fallback records nothing",
  );
});

test("only a real dispatch is recorded and revalidated", () => {
  const body = fnBody("dispatchGithubNow");
  const records = body.match(/recordSourceDispatch\(/g) ?? [];
  assert.equal(records.length, 1, "one dispatch record, on the dispatched path only");
  assert.match(body, /await recordSourceDispatch\(GITHUB_SOURCE_PRODUCER, now\);/);

  const writes = body.match(/revalidatePath\("\/email"\)/g) ?? [];
  assert.equal(writes.length, 1, "one revalidation, after the record");
  assert.ok(
    body.indexOf("recordSourceDispatch(") < body.indexOf('revalidatePath("/email")'),
    "the card re-renders from the row the dispatch just wrote",
  );
  assert.match(
    body,
    /revalidatePath\("\/email"\);\s*\n\s*return \{\s*\n\s*ok: true,\s*\n\s*mode: "dispatched",/,
    "the dispatched result is the success path",
  );
  assert.match(body, /runUrl: result\.runUrl/);
});

test("the dispatcher's own sentences reach the operator unchanged", () => {
  const body = fnBody("dispatchGithubNow");
  assert.match(
    body,
    /if \(!result\.ok\) return \{ ok: false, error: result\.error \};/,
    "401, 403, 404, transport and other are the dispatcher's sentences, not rewritten here",
  );
  assert.doesNotMatch(
    body,
    /`[^`]*\$\{result\.error\}|result\.error\s*\+/,
    "the action never wraps or prefixes the sentence",
  );
  assert.doesNotMatch(body, /api\.github\.com|authorization|Bearer/);
});

test("dispatch stays an inline bounded call, with no durable job", () => {
  const body = fnBody("dispatchGithubNow");
  assert.doesNotMatch(source, /@\/lib\/jobs/);
  assert.doesNotMatch(body, /insertJob|createJob|jobId|enqueue/);
  assert.doesNotMatch(body, /await db\b/);
  assert.ok(
    body.indexOf("dispatchBrowserCheck(") > body.indexOf("segment"),
    "the one call is the bounded wait; nothing is scheduled after it",
  );
});

test("the dispatch never echoes the control or dispatch token", () => {
  const body = fnBody("dispatchGithubNow");
  assert.doesNotMatch(body, /EMAIL_PAGE_PASSWORD|pagePasswordDigest|cookieStore.get(PAGE_COOKIE)/);
  assert.doesNotMatch(body, /GITHUB_BURST_TOKEN|secret\("GITHUB/);
  assert.doesNotMatch(body, /\$\{formData/);
  assert.doesNotMatch(body, /console\.(log|error)/);
});

/**
 * Ticket 09: Pause all. The action is one form with two independent writes, so
 * the tests pin the properties that make partial failure honest: it authorises
 * inside its own body, it attempts both writes, each source's outcome is its
 * own, a failure is never reported as success, nothing is cancelled, and the
 * page is only revalidated when something actually moved.
 */
test("pauseAllSources authorises inside its body, before either write", () => {
  const body = fnBody("pauseAllSources");
  assert.match(body, /if \(!\(await requirePageUnlock\(\)\)\)/);
  assert.ok(
    body.indexOf("requirePageUnlock()") < body.indexOf("pauseGrafanaSource("),
    "the gate comes before the Grafana write",
  );
  assert.ok(
    body.indexOf("requirePageUnlock()") < body.indexOf("disableGithubSource("),
    "the gate comes before the GitHub write",
  );
  assert.match(
    body,
    /if \(!\(await requirePageUnlock\(\)\)\) return \{ ok: false, error: LOCKED\.error \};/,
    "a locked request claims no source outcome it did not attempt",
  );
});

test("pauseAllSources attempts both writes, independently", () => {
  const body = fnBody("pauseAllSources");
  assert.match(
    body,
    /Promise\.all\(\[\s*pauseGrafanaSource\(\)[\s\S]*?disableGithubSource\(\)/,
    "both helpers start together, so a slow or failing Grafana cannot skip GitHub",
  );
  assert.doesNotMatch(
    body,
    /if \(!grafana\.ok\) return|if \(grafana\.ok\)/,
    "neither outcome short-circuits the other write",
  );

  const grafana = anyBody("pauseGrafanaSource");
  assert.match(grafana, /getCheck\(/);
  assert.match(grafana, /updateCheck\(id, \{ enabled: false \}\)/);

  const github = anyBody("disableGithubSource");
  assert.match(github, /readSourceConfig\(\)/);
  assert.match(github, /setSourceEnabled\(GITHUB_SOURCE_PRODUCER, false\)/);
});

test("a partial failure is a refusal in words, never a silent success", () => {
  const body = fnBody("pauseAllSources");
  assert.match(body, /if \(!grafana\.ok\)/);
  assert.match(body, /if \(!github\.ok\)/);
  assert.match(body, /Grafana's check was not paused:/);
  assert.match(body, /The GitHub source was not disabled:/);
  assert.match(
    body,
    /ok: false,/,
    "at least one failed source means the whole action is not ok",
  );
  assert.match(
    body,
    /no target was changed and no queued GitHub segment was cancelled/,
    "the failure sentence states the two things Pause all does not do",
  );
  assert.doesNotMatch(
    body,
    /\$\{result\.error\}|\$\{formData|console\.(log|error)/,
    "no upstream body, form value or log line rides in the result",
  );
});

test("Pause all never cancels a queued or running GitHub segment", () => {
  const body = fnBody("pauseAllSources");
  assert.doesNotMatch(body, /\bcancel[A-Za-z]*\(/);
  assert.doesNotMatch(source, /cancelWorkflowRun|actions\/runs\//);
});

test("the page is revalidated only when a source actually changed", () => {
  const body = fnBody("pauseAllSources");
  const calls = body.split('revalidatePath("/email")').length - 1;
  assert.equal(calls, 1, "one revalidation site");
  assert.match(
    body,
    /const changed =[\s\S]*?grafana\.changed[\s\S]*?github\.changed[\s\S]*?if \(changed\) revalidatePath\("\/email"\);/,
    "the revalidation is guarded by the per-source changed flags",
  );
});

test("the Pause all result carries a per-source outcome", () => {
  assert.match(
    source,
    /export type PauseOutcome =[\s\S]*?ok: true; changed: boolean[\s\S]*?ok: false; error: string/,
    "each source reports changed/unchanged separately from failure",
  );
  assert.match(
    source,
    /export type PauseAllState = \{[\s\S]*?grafana\?: PauseOutcome;[\s\S]*?github\?: PauseOutcome;/,
  );
});
