/**
 * The upload path's promises, tested without Grafana:
 *
 *   - a committed script without the placeholder is refused (the guard that
 *     keeps a secret out of git is only real if it fails on the bad file),
 *   - a secret that cannot survive a JavaScript string literal is refused
 *     before the swap, and an accepted one still parses,
 *   - injection replaces exactly the placeholder and nothing else,
 *   - the generated file never carries a value that looks like a secret, and
 *     its run options pin IPv4 and fail on a failed report,
 *   - the report body the script builds is the body the route parses, and its
 *     final URL is clipped at the bound the parser accepts.
 *
 * The helpers live in `scripts/lib/affiliate-check.ts`, so importing them
 * loads no `.env.local`, spawns nothing and reaches no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseClickReport } from "../src/lib/email/click-report";
import {
  AffiliateCheckUploadError,
  changedCheckFields,
  injectReportSecret,
  REPORT_BODY_SOURCE,
  REPORT_FINAL_URL_SOURCE,
  REPORT_SECRET_PATTERN,
  REPORT_SECRET_PLACEHOLDER,
} from "./lib/affiliate-check";

const GENERATED = new URL("./affiliate-click-check.k6.js", import.meta.url);
const SECRET = "0123456789abcdef0123456789abcdef";

const SOURCE_WITH_PLACEHOLDER = [
  'const REPORT_URL = "https://voni.cc/api/email/clicks/report";',
  `const REPORT_SECRET = "${REPORT_SECRET_PLACEHOLDER}";`,
  `const REPORTING_ENABLED = REPORT_SECRET !== "${REPORT_SECRET_PLACEHOLDER}";`,
  "export default function affiliateClickCheck() {}",
].join("\n");

/** Parse the emitted text as a script body: a broken string literal throws here. */
function assertParses(source: string): void {
  const body = source
    .replace(/^import .*$/gm, "")
    .replace(/^export default /gm, "")
    .replace(/^export /gm, "");
  assert.doesNotThrow(() => new Function(body));
}

test("the placeholder guard refuses a script that has no placeholder", () => {
  const alreadyInjected = `const REPORT_SECRET = "${SECRET}";`;
  assert.throws(
    () => injectReportSecret(alreadyInjected, SECRET),
    (error: unknown) =>
      error instanceof AffiliateCheckUploadError &&
      /no "__REPORT_SECRET__" placeholder/.test(error.message) &&
      /may already carry a real secret/.test(error.message),
  );
});

test("injection replaces exactly one occurrence and leaves the rest byte-identical", () => {
  const injected = injectReportSecret(SOURCE_WITH_PLACEHOLDER, SECRET);
  const at = SOURCE_WITH_PLACEHOLDER.indexOf(REPORT_SECRET_PLACEHOLDER);
  const tail = at + REPORT_SECRET_PLACEHOLDER.length;

  assert.equal(
    injected,
    SOURCE_WITH_PLACEHOLDER.replace(REPORT_SECRET_PLACEHOLDER, () => SECRET),
  );
  assert.equal(injected.slice(0, at), SOURCE_WITH_PLACEHOLDER.slice(0, at));
  // Exactly one secret, and the enable check still compares against the
  // placeholder — replacing that comparison too would disable reporting.
  assert.equal(injected.split(SECRET).length - 1, 1);
  assert.equal(
    injected.slice(at + SECRET.length),
    SOURCE_WITH_PLACEHOLDER.slice(tail),
  );
  assert.equal(
    injected.includes(
      `const REPORTING_ENABLED = REPORT_SECRET !== "${REPORT_SECRET_PLACEHOLDER}";`,
    ),
    true,
  );
});

test("injection refuses an empty secret or the placeholder itself", () => {
  assert.throws(
    () => injectReportSecret(SOURCE_WITH_PLACEHOLDER, ""),
    /empty or still the placeholder/,
  );
  assert.throws(
    () => injectReportSecret(SOURCE_WITH_PLACEHOLDER, REPORT_SECRET_PLACEHOLDER),
    /empty or still the placeholder/,
  );
});

test("injection refuses a secret that would break or change the string literal", () => {
  // A quote ends the literal; a backslash starts an escape. Either way every
  // guard upstream would still pass and the reports would 401 (or not run).
  for (const bad of ['abc"def', "abc\\defg", "abc'defg", "abc defg", "abc$defg", "abc`defg"]) {
    assert.throws(
      () => injectReportSecret(SOURCE_WITH_PLACEHOLDER, bad),
      (error: unknown) =>
        error instanceof AffiliateCheckUploadError &&
        /EMAIL_CLICK_REPORT_SECRET must be at least 8 characters from/.test(
          error.message,
        ) &&
        /quote or a backslash/.test(error.message),
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
  assert.equal(REPORT_SECRET_PATTERN.test("abc\"def"), false);
  assert.equal(REPORT_SECRET_PATTERN.test("abc\\defg"), false);
});

test("injection refuses a secret shorter than its minimum", () => {
  assert.throws(
    () => injectReportSecret(SOURCE_WITH_PLACEHOLDER, "short"),
    /must be at least 8 characters from/,
  );
  // The boundary itself is accepted: exactly eight characters pass.
  assert.equal(REPORT_SECRET_PATTERN.test("12345678"), true);
});

test("injection accepts the URL-safe alphabet and emits parseable JavaScript", () => {
  const accepted = "ok-secret-123";
  assert.equal(REPORT_SECRET_PATTERN.test(accepted), true);
  const injected = injectReportSecret(SOURCE_WITH_PLACEHOLDER, accepted);
  assert.equal(injected.includes(`const REPORT_SECRET = "${accepted}";`), true);
  assertParses(injected);

  // A base64-shaped secret keeps its `+`, `/` and `=` characters literally.
  const base64ish = "ab+cd/ef=gh.~_ij";
  const withBase64 = injectReportSecret(SOURCE_WITH_PLACEHOLDER, base64ish);
  assert.equal(withBase64.includes(`const REPORT_SECRET = "${base64ish}";`), true);
  assertParses(withBase64);

  // And the real generated script, injected, is still a valid program body.
  assertParses(injectReportSecret(readFileSync(GENERATED, "utf8"), accepted));
});

test("the committed script carries the placeholder and no 48-hex value", () => {
  const generated = readFileSync(GENERATED, "utf8");
  assert.equal(generated.includes(`"${REPORT_SECRET_PLACEHOLDER}"`), true);
  assert.doesNotMatch(generated, /[0-9a-f]{48}/i);
});

test("the generated run options pin IPv4 and fail on any failed report", () => {
  const generated = readFileSync(GENERATED, "utf8");
  assert.match(generated, /export const options = \{/);
  assert.match(generated, /dns: \{ policy: "onlyIPv4" \}/);
  assert.match(generated, /thresholds: \{ report_failed: \["count==0"\] \}/);
});

test("injecting the committed script produces an enabled, secret-bearing copy", () => {
  const generated = readFileSync(GENERATED, "utf8");
  const injected = injectReportSecret(generated, SECRET);
  assert.equal(injected.includes(`const REPORT_SECRET = "${SECRET}";`), true);
  assert.equal(injected.split(SECRET).length - 1, 1);
  assert.equal(
    injected.includes(
      `REPORT_SECRET !== "${REPORT_SECRET_PLACEHOLDER}"`,
    ),
    true,
  );
});

test("the generated script reports to voni without following redirects", () => {
  const generated = readFileSync(GENERATED, "utf8");
  assert.match(
    generated,
    /const REPORT_URL = "https:\/\/voni\.cc\/api\/email\/clicks\/report";/,
  );
  assert.match(generated, /"x-voni-click-secret": REPORT_SECRET/);
  assert.match(generated, /tags: \{ phase: "report" \}/);
  // A 3xx must not carry the body and the secret header to another host.
  assert.match(generated, /redirects: 0/);
  assert.match(generated, /timeout: "2s"/);
  assert.match(generated, /function buildReportBody\(record, ranAt\)/);
});

test("the payload builder produces every field the parser requires", () => {
  const buildReportBody = new Function(
    `${REPORT_BODY_SOURCE}\nreturn buildReportBody;`,
  )() as (record: Record<string, unknown>, ranAt: string) => Record<string, unknown>;

  const click = {
    target: "https://voni.cc/test?utm_source=gmail.com&utm_medium=email&utm_campaign=voni-email",
    source: "gmail.com",
    finalUrl: "https://voni.cc/test?utm_source=gmail.com&utm_medium=email&utm_campaign=voni-email",
    status: 200,
    ms: 187,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
    device: "mobile",
    browser: "Chrome",
  };
  const ranAt = new Date().toISOString();
  const payload = buildReportBody(click, ranAt);

  assert.deepEqual(Object.keys(payload).sort(), [
    "browser",
    "device",
    "finalUrl",
    "ms",
    "ranAt",
    "source",
    "status",
    "target",
    "userAgent",
  ]);
  assert.equal(payload["ranAt"], ranAt);

  const parsed = parseClickReport(payload, new Date());
  assert.equal(parsed.ok, true);

  // The transport-failure shape: both nulls are the parser's "no response".
  const failed = buildReportBody(
    { ...click, status: null, finalUrl: null },
    new Date().toISOString(),
  );
  assert.equal(parseClickReport(failed, new Date()).ok, true);
});

test("the final URL is null on a failed click or past the parser's bound", () => {
  const reportFinalUrl = new Function(
    `${REPORT_FINAL_URL_SOURCE}\nreturn reportFinalUrl;`,
  )() as (status: number, url: string) => string | null;

  assert.equal(reportFinalUrl(200, "https://voni.cc/test"), "https://voni.cc/test");
  // status 0 is a transport failure: k6 echoes the request URL, which is not a landing.
  assert.equal(reportFinalUrl(0, "https://voni.cc/test"), null);
  assert.equal(reportFinalUrl(200, ""), null);
  // 2048 is the parser's bound; 2049 is a row it cannot store.
  const atBound = `https://voni.cc/${"a".repeat(2048 - "https://voni.cc/".length)}`;
  assert.equal(atBound.length, 2048);
  assert.equal(reportFinalUrl(200, atBound), atBound);
  assert.equal(reportFinalUrl(200, `${atBound}a`), null);
});

test("the read-back diff names a field that moved and stays quiet when none did", () => {
  const before = {
    id: 68584,
    job: "voni-affiliate-click-us",
    target: "https://voni.cc/email",
    enabled: true,
    frequency: 60_000,
    timeout: 30_000,
    probes: [1, 2, 3, 4],
    labels: { team: "growth" },
    tenantId: 1,
    modified: 1,
  };
  assert.deepEqual(changedCheckFields(before, { ...before, modified: 2 }), []);
  assert.deepEqual(
    changedCheckFields(before, { ...before, frequency: 120_000, probes: [1, 2] }),
    ["frequency", "probes"],
  );
});
