import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Source-text guards for the one wiring that has no other witness.
 *
 * `lockPage` shipped with no caller once already: the function dropped both
 * cookies correctly and nothing in the UI invoked it, so the protection existed
 * for a code path nobody could reach. There is no runtime test for a client
 * component's click handler in this repo, so this asserts the wiring — the
 * import, the call, and the redirect-tolerant rejection handling — the way
 * `src/app/email/page.gate.test.ts` asserts the gate's shape.
 */

const panel = readFileSync(
  new URL("./affiliate-control-panel.tsx", import.meta.url),
  "utf8",
);

test("the panel imports lockPage from the actions module", () => {
  assert.match(panel, /lockPage,/);
  assert.match(panel, /from "@\/app\/email\/actions"/);
});

test("a Lock page control calls lockPage and is reachable in both panel states", () => {
  assert.match(panel, /await lockPage\(\);/);
  assert.match(panel, /data-testid="email-lock-page"/);

  const renders = panel.split("<LockPageButton />").length - 1;
  assert.equal(
    renders,
    2,
    "rendered for the unlocked panel and for the locked card, so the page lock exists without the control secret",
  );
});

test("the redirect rejection is swallowed, not reported as a failed lock", () => {
  assert.match(
    panel,
    /void handleLockPage\(\)\.catch\(\(\) => \{\}\);/,
    "lockPage redirects, and that rejection is the navigation",
  );
});
