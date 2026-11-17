/**
 * The upload path's promises, tested without Grafana:
 *
 *   - a committed script without the placeholder is refused (the guard that
 *     keeps a secret out of git is only real if it fails on the bad file),
 *   - injection replaces exactly the placeholder and nothing else,
 *   - the generated file never carries a value that looks like a secret,
 *   - the report body the script builds is the body the route parses.
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

test("injection keeps a secret containing replacement patterns literal", () => {
  const dollar = "a$&b$`c$$d";
  const injected = injectReportSecret(SOURCE_WITH_PLACEHOLDER, dollar);
  assert.equal(injected.includes(dollar), true);
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

test("the committed script carries the placeholder and no 48-hex value", () => {
  const generated = readFileSync(GENERATED, "utf8");
  assert.equal(generated.includes(`"${REPORT_SECRET_PLACEHOLDER}"`), true);
  assert.doesNotMatch(generated, /[0-9a-f]{48}/i);
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

test("the generated script reports to voni with the phase tag", () => {
  const generated = readFileSync(GENERATED, "utf8");
  assert.match(
    generated,
    /const REPORT_URL = "https:\/\/voni\.cc\/api\/email\/clicks\/report";/,
  );
  assert.match(generated, /"x-voni-click-secret": REPORT_SECRET/);
  assert.match(generated, /tags: \{ phase: "report" \}/);
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
