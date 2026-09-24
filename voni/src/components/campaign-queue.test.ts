import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-index.test.ts): the repo
// has no jsdom/component-render setup, so the queue filter, the BackLink
// swap, and the blocker association are checked on the real sources.
const componentsDir = dirname(fileURLToPath(import.meta.url));
const pageDir = join(
  componentsDir,
  "..",
  "app",
  "(dashboard)",
  "campaigns",
  "[id]",
);
const queueSource = readFileSync(join(componentsDir, "campaign-queue.tsx"), "utf8");
const pageSource = readFileSync(join(pageDir, "page.tsx"), "utf8");
const controlsSource = readFileSync(
  join(componentsDir, "campaign-controls.tsx"),
  "utf8",
);

test("queue filters client-side by name or phone, jobs-page pattern", () => {
  assert.ok(queueSource.includes('type="search"'));
  assert.ok(queueSource.includes('aria-label="Search queue"'));
  assert.ok(queueSource.includes("useState"));
  assert.ok(queueSource.includes("useMemo"));
  assert.ok(queueSource.includes("toLowerCase"));
  assert.ok(queueSource.includes("leadName"));
  assert.ok(queueSource.includes("member.phone"));
});

test("queue keeps the empty state and adds a no-match state", () => {
  assert.ok(queueSource.includes("No leads in this campaign yet"));
  assert.ok(queueSource.includes("Import a CSV above"));
  assert.ok(queueSource.includes("No matches in this view"));
});

test("queue labels states in human words (shared with lead detail)", () => {
  assert.ok(queueSource.includes("queueStatus("), "queue reads the shared status helper");
  const statusSource = readFileSync(join(componentsDir, "..", "lib", "campaigns", "status.ts"), "utf8");
  for (const label of ["Queued", "Dialing", "Reached", "No answer", "Skipped"]) {
    assert.ok(statusSource.includes(label), `missing ${label}`);
  }
});

test("campaign detail uses the shared BackLink, queue, and no bespoke table", () => {
  assert.ok(pageSource.includes("BackLink"));
  assert.ok(pageSource.includes("CampaignQueue"));
  assert.ok(!pageSource.includes("LEAD_STATUS_LABEL"));
  assert.ok(!pageSource.includes("<Table>"));
});

test("activation blocker is associated with the disabled Activate button", () => {
  // The note renders in the page's Dialer section; the button points at it.
  assert.ok(controlsSource.includes("campaign-blocker-"));
  assert.ok(controlsSource.includes("aria-describedby"));
  assert.ok(pageSource.includes("campaign-blocker-${campaign.id}"));
  assert.ok(pageSource.includes('role="note"'));
});
