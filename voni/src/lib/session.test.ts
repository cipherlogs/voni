import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 06, seam: the per-request session/user + workspace/member boundary
// (voni/src/lib/session.ts). Catches: repeated session + member resolution
// within one request (layout + page + detail + follow-up reads). Misses: live
// request-scope dedup — the node runner has no request context, so structure
// and delegation are asserted on the real source and the dev-server runtime
// check covers behavior. React `cache()` outside a request calls through
// uncached, so importing this module in unit tests stays pollution-free.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "session.ts"),
  "utf8",
);

test("getCtx core is wrapped in React cache for per-request dedup", () => {
  // Version-matched guide (Next docs: caching-without-cache-components):
  // wrap ORM/session reads in `cache` from react so repeated reads within a
  // single request resolve once. Same pattern the audit prescribes for W4/S1.
  assert.match(source, /from "react"|from 'react'/);
  assert.match(source, /\bimport \{[^}]*\bcache\b[^}]*\}/);
  assert.match(source, /cache\(/);
});

test("requireCtx and requireCtxOrRedirect delegate to the cached core", () => {
  const requireBody = source.slice(source.indexOf("export async function requireCtx"));
  assert.ok(
    requireBody.includes("getCtx()"),
    "requireCtx resolves through the cached getCtx core",
  );
  const redirectBody = source.slice(
    source.indexOf("export async function requireCtxOrRedirect"),
  );
  assert.ok(
    redirectBody.includes("getCtx()"),
    "requireCtxOrRedirect resolves through the cached getCtx core",
  );
  // One shared core, not one cache per wrapper: the wrappers must not each
  // define their own session lookup.
  assert.equal(
    source.split("auth.api.getSession").length - 1,
    1,
    "exactly one getSession call site — every wrapper shares the cached core",
  );
});

test("same data surface: Ctx shape and failure modes preserved", () => {
  for (const field of [
    "userId",
    "organizationId",
    "email",
    "name",
    "image",
    "role",
  ]) {
    assert.ok(source.includes(field), `Ctx keeps ${field}`);
  }
  assert.ok(
    source.includes("Not signed in"),
    "requireCtx still throws for server actions to catch",
  );
  assert.ok(
    source.includes("/login?next="),
    "requireCtxOrRedirect still sends signed-out pages to login",
  );
  // First-sign-in org minting stays inside the cached core, so a repeated
  // read in the same request returns the same ctx instead of re-resolving.
  assert.ok(source.includes("crypto.randomUUID"));
});
