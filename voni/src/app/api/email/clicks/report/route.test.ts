import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as the other route tests): the route
// writes to the database, so the surface it exposes — one method, one secret,
// one narrow body — is checked on the real source.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

test("the report route exports POST only", () => {
  assert.match(source, /export async function POST\(/);
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`export (async )?function ${method}\\(`),
      `${method} is exported, so Next would not answer 405`,
    );
  }
});

test("the report route carries no route segment config", () => {
  // `cacheComponents: true` rejects these exports at build time. Anchored at
  // line start so the header comment may still name the ban.
  assert.doesNotMatch(source, /^export const (dynamic|revalidate|runtime)/m);
});

test("the report route is machine-gated by a named secret header", () => {
  assert.match(source, /EMAIL_CLICK_REPORT_SECRET/);
  assert.match(source, /x-voni-click-secret/);
  assert.match(source, /isClickReportAuthorized/);
});

test("the report route answers 503 when the secret is unset", () => {
  assert.match(source, /status: number, reason: string/);
  assert.match(source, /503,\s*\n?\s*"not_configured"/);
});

test("the report route answers 401 for a wrong or missing secret", () => {
  assert.match(source, /401,\s*\n?\s*"unauthorized"/);
});

test("the report route refuses bodies over 4096 bytes with 413", () => {
  assert.match(source, /MAX_BODY_BYTES = 4096/);
  assert.match(source, /413,\s*\n?\s*"too_large"/);
});

test("the report route rejects unparsable JSON with 400", () => {
  assert.match(source, /JSON\.parse\(text\)/);
  assert.match(source, /400,\s*\n?\s*"bad_json"/);
});

test("the report route persists through the named writer and reports 502", () => {
  assert.match(source, /recordAffiliateClick/);
  assert.match(source, /502,\s*\n?\s*"not_stored"/);
  // The payload must not reach the logs: only the error message is logged.
  assert.match(source, /error instanceof Error \? error\.message/);
});

test("the report route never caches", () => {
  assert.match(source, /"Cache-Control": "no-store"/);
});
