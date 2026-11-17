/**
 * Tripwire for the `/email` page gate.
 *
 * The node runner cannot execute a React Server Component, so this compares
 * source positions instead: the gate check must appear before the first call
 * that reads the synthetic check, the probes or the click history. That is the
 * single invariant that keeps the panel's data out of a locked response. If
 * someone moves a read above the gate — or moves the gate below a read — the
 * indexes flip and this fails.
 *
 * The comparison uses call expressions (`getCheck(`), not bare identifiers:
 * the import list at the top of the file names every helper before any code
 * runs, so matching the identifier alone would be true no matter what order
 * the body used.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "page.tsx"),
  "utf8",
);

const DATA_CALLS = [
  "getCheck(",
  "listProbes(",
  "affiliateClickStats(",
  "listAffiliateClicks(",
] as const;

test("the page gate runs before the first data read", () => {
  const gate = source.indexOf("isPageUnlocked(");
  assert.ok(gate >= 0, "page.tsx checks isPageUnlocked");

  for (const call of DATA_CALLS) {
    const at = source.indexOf(call);
    assert.ok(at >= 0, `${call} is called in page.tsx`);
    assert.ok(
      gate < at,
      `isPageUnlocked (index ${gate}) must come before ${call} (index ${at})`,
    );
  }
});

test("the locked branch returns the gate screen and never reaches the panel", () => {
  const locked = source.indexOf("if (!unlocked)");
  assert.ok(locked >= 0, "the page has an unlocked check");

  const gateScreen = source.indexOf("return <EmailGateScreen />");
  const panel = source.indexOf("<EmailControlData");
  assert.ok(gateScreen >= 0, "the locked branch renders EmailGateScreen");
  assert.ok(panel >= 0, "the unlocked branch renders EmailControlData");
  assert.ok(locked < gateScreen, "the gate is decided before the screen is chosen");
  assert.ok(gateScreen < panel, "the gate screen is rendered before the panel");
});

test("the gate screen carries no panel data or check metadata", () => {
  const start = source.indexOf("function EmailGateScreen()");
  assert.ok(start >= 0, "EmailGateScreen exists");
  const end = source.indexOf("/**", start + 1);
  const gateScreen = source.slice(start, end < 0 ? undefined : end);

  for (const call of DATA_CALLS) {
    assert.ok(!gateScreen.includes(call), `the gate screen must not call ${call}`);
  }
  assert.doesNotMatch(gateScreen, /AffiliateControlPanel|clicks=|stats=|check=/);
  assert.doesNotMatch(gateScreen, /68584|DEFAULT_CHECK_ID/);
});

test("the gate reads the page cookie and the page password", () => {
  assert.match(source, /jar\.get\(PAGE_COOKIE\)/);
  assert.match(source, /secret\("EMAIL_PAGE_PASSWORD"\)/);
  assert.match(source, /robots: \{ index: false, follow: false \}/);
});
