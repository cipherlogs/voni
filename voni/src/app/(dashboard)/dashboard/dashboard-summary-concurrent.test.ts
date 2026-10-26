import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Ticket 02: dashboard summary resolves concurrently at the service
// boundary. Same approach as the repo's source-text prior art
// (calls-index.test.ts, shell-dashboard.test.ts): no jsdom, no live DB —
// the real server-action source is checked for the property that
// distinguishes serial from parallel: every count/group query must be
// launched before any of their results is awaited.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");
const fn = source.slice(source.indexOf("export async function getDashboardSummary"));

test("summary count/group queries launch before any result is awaited", () => {
  // Each `await db` in sequence is one serialized roundtrip. Zero means no
  // query waits on another: they all resolve concurrently. (Setup checks
  // below ride in their own Promise.all, as before.)
  const sequentialDbAwaits = fn.match(/await\s+db\b/g) ?? [];
  assert.equal(
    sequentialDbAwaits.length,
    0,
    `expected zero sequential \`await db\` roundtrips, found ${sequentialDbAwaits.length}`,
  );
});

test("the six summary queries share one parallel group", () => {
  const groupAt = fn.indexOf("Promise.all");
  assert.ok(groupAt !== -1, "summary queries resolve in a Promise.all group");
  const group = fn.slice(groupAt);
  for (const fragment of [
    "workedLeadExists",
    "callConnected",
    "liveAppointmentExists",
    "latestBlockersNonEmpty",
    "groupBy(leads.pipelineState)",
    "campaignLeads",
  ]) {
    assert.ok(group.includes(fragment), `parallel group keeps ${fragment}`);
  }
});

test("concurrent summary returns the same data shape as before", () => {
  // Outcome predicates unchanged: card and list agreement is by
  // construction, so the names must stay.
  for (const name of [
    "workedLeadExists",
    "callConnected",
    "liveAppointmentExists",
    "latestBlockersNonEmpty",
  ]) {
    assert.ok(fn.includes(name), `summary reuses ${name}`);
  }
  // Empty-campaign shape unchanged: unled campaigns, capped at three.
  assert.ok(fn.includes(".having(sql`count("), "empty-campaign having stays");
  assert.ok(fn.includes(".limit(3)"), "empty campaigns stay capped at 3");
  // Setup existence checks unchanged: un-generated agent, imported lead,
  // activated campaign.
  assert.ok(fn.includes("isNull(agents.generationJobId)"), "agent check stays");
  assert.ok(
    fn.includes('inArray(campaigns.status, ["active", "paused", "completed"])'),
    "campaign activation check stays",
  );
  // First-run gate unchanged: zero outcomes across all four cards, and
  // empty campaigns still do not veto the setup path.
  const gate = fn.slice(fn.indexOf("isFirstRun:"));
  for (const field of [
    "leadsWorked === 0",
    "connectedCalls === 0",
    "appointmentsBooked === 0",
    "needsHandoff === 0",
  ]) {
    assert.ok(gate.includes(field), `first-run gate keeps ${field}`);
  }
  assert.ok(
    !gate.includes("emptyCampaigns.length === 0"),
    "empty campaigns still do not veto the setup path",
  );
});

test("dashboard page contract is untouched by the concurrency change", () => {
  const page = readFileSync(join(here, "page.tsx"), "utf8");
  assert.ok(page.includes("isFirstRun"), "page still branches on first-run");
  assert.ok(page.includes("emptyCampaigns"), "page still surfaces empty campaigns");
  for (const href of [
    "/leads?stage=worked",
    "/calls?outcome=connected",
    "/leads?stage=booked",
    "/leads?stage=handoff",
  ]) {
    assert.ok(page.includes(href), `card still links to ${href}`);
  }
});
