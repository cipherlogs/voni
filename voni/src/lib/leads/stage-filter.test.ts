import assert from "node:assert/strict";
import test from "node:test";
import {
  isOutcomeStage,
  normalizeStageFilter,
  stageCondition,
  stageFilterLabel,
} from "./stage-filter.js";
import {
  callOutcomeCondition,
  callOutcomeLabel,
  normalizeCallOutcome,
} from "../calls/outcome-filter.js";
import {
  callConnected,
  latestBlockersNonEmpty,
  liveAppointmentExists,
  workedLeadExists,
} from "../outcomes/predicates.js";
import { leads } from "../db/schema.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pure normalizer units: no DB, no session.
test("stage normalizer trims, lowercases, and takes the first value", () => {
  assert.equal(normalizeStageFilter("Worked"), "worked");
  assert.equal(normalizeStageFilter([" booked ", "handoff"]), "booked");
  assert.equal(normalizeStageFilter(""), undefined);
  assert.equal(normalizeStageFilter("   "), undefined);
  assert.equal(normalizeStageFilter(null), undefined);
  assert.equal(normalizeStageFilter(undefined), undefined);
  assert.equal(normalizeStageFilter([]), undefined);
});

test("outcome-stage set matches the three dashboard cards", () => {
  assert.ok(isOutcomeStage("worked"));
  assert.ok(isOutcomeStage("booked"));
  assert.ok(isOutcomeStage("handoff"));
  assert.ok(!isOutcomeStage("new"));
  assert.ok(!isOutcomeStage(""));
});

test("stage labels read as operator language", () => {
  assert.equal(stageFilterLabel("worked"), "Worked");
  assert.equal(stageFilterLabel("booked"), "Booked");
  assert.equal(stageFilterLabel("handoff"), "Needs handoff");
  assert.equal(stageFilterLabel("new"), "Not called yet");
});

/**
 * Interpolated identifiers stringify as placeholders under String(sql), so
 * assertions read the literal query chunks instead — the FROM/JOIN/table
 * names live there while bound values stay parameterized.
 */
function fragmentText(fragment: unknown): string {
  const chunks =
    (
      fragment as {
        queryChunks?: Array<{ value?: unknown }>;
      }
    ).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (Array.isArray(chunk.value)) return chunk.value.join("");
      // Bound params (e.g. the raw stage string) carry their value directly.
      return typeof chunk.value === "string" ? chunk.value : "";
    })
    .join(" ");
}

test("stage conditions reuse the dashboard predicates", () => {
  const worked = fragmentText(stageCondition("worked"));
  assert.ok(worked.includes("calls"), "worked counts leads with calls");
  const booked = fragmentText(stageCondition("booked"));
  assert.ok(
    booked.includes("appointments") && booked.includes("cancelled"),
    "booked skips cancelled appointments",
  );
  const handoff = fragmentText(stageCondition("handoff"));
  assert.ok(
    handoff.includes("conversation_states") && handoff.includes("blockers"),
    "handoff checks the latest blockers",
  );
  const raw = fragmentText(stageCondition("contacted"));
  assert.ok(
    !raw.includes("exists(select"),
    "unknown stages are not outcome fragments",
  );
  assert.ok(raw.includes("ilike"), "unknown stages are a raw ilike match");
  assert.equal(stageCondition(undefined), undefined);
});

test("raw stages match case-insensitively for funnel links", () => {
  const source = readFileSync(join(here, "stage-filter.ts"), "utf8");
  assert.ok(
    source.includes("ilike(leads.pipelineState"),
    "funnel-linked raw stages use ilike, not eq",
  );
});

test("funnel stage cards link to their filtered leads view", () => {
  const page = readFileSync(join(dashboardDir, "page.tsx"), "utf8");
  assert.ok(
    page.includes("encodeURIComponent(stage.stage)"),
    "funnel href carries the DB stage casing",
  );
  assert.ok(
    page.includes("/leads?stage="),
    "funnel cards link to the filtered leads list",
  );
  // Funnel links name their stage through the operator label, not the raw
  // DB value — the template literal is `View ${pipelineStateLabel(...)} leads`.
  assert.ok(
    page.includes("View ${pipelineStateLabel(stage.stage)} leads"),
    "funnel links name their stage for assistive tech",
  );
  assert.ok(
    page.includes("<StatStrip"),
    "funnel uses the shared dashboard-01 KPI strip",
  );
});

test("card titles enter heading navigation", () => {
  const card = readFileSync(
    join(here, "..", "..", "components", "ui", "card.tsx"),
    "utf8",
  );
  assert.ok(
    card.includes('as: Tag = "h2"'),
    "CardTitle renders as h2 by default",
  );
  assert.ok(card.includes("as?:"), "call sites can still opt out to div");
});

// Calls ?outcome= units: whitelist, not passthrough.
test("call outcome normalizer whitelists the three card outcomes", () => {
  assert.equal(normalizeCallOutcome("connected"), "connected");
  assert.equal(normalizeCallOutcome(" Booked "), "booked");
  assert.equal(normalizeCallOutcome(["handoff", "connected"]), "handoff");
  assert.equal(normalizeCallOutcome("worked"), undefined);
  assert.equal(normalizeCallOutcome("no_answer"), undefined);
  assert.equal(normalizeCallOutcome(""), undefined);
  assert.equal(normalizeCallOutcome(null), undefined);
});

test("call outcome labels and conditions mirror the dashboard cards", () => {
  assert.equal(callOutcomeLabel("connected"), "Connected");
  assert.equal(callOutcomeLabel("booked"), "Booked");
  assert.equal(callOutcomeLabel("handoff"), "Needs handoff");
  // isNotNull wraps the column (field names differ across drizzle builds),
  // so assert on behavior instead: the condition is the shared
  // callConnected() predicate, defined in the outcomes module.
  const connectedSource = readFileSync(
    join(here, "..", "outcomes", "predicates.ts"),
    "utf8",
  );
  assert.ok(callOutcomeCondition("connected") !== undefined);
  assert.ok(
    connectedSource.includes("isNotNull(calls.endedAt)"),
    "connected means the call ended",
  );
  assert.ok(
    fragmentText(callOutcomeCondition("booked")).includes("appointments"),
    "booked reuses the appointment check",
  );
  assert.ok(
    fragmentText(callOutcomeCondition("handoff")).includes("blockers"),
    "handoff reuses the blockers check",
  );
  assert.equal(callOutcomeCondition(undefined), undefined);
});

/**
 * Parity: dashboard cards and drill-down lists share one predicate per
 * outcome. `normalizeSql` strips parameter bindings and whitespace so a
 * card query and a list filter normalize to the same predicate text.
 */
function normalizeSql(fragment: unknown): string {
  return fragmentText(fragment).replace(/\s+/g, " ").trim();
}

test("card SQL and list SQL normalize to the same worked predicate", () => {
  const cardSource = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  assert.ok(cardSource.includes("workedLeadExists"));
  assert.equal(
    normalizeSql(stageCondition("worked")),
    normalizeSql(workedLeadExists(leads.id)),
    "card and list share the worked predicate",
  );
  assert.ok(
    normalizeSql(stageCondition("worked")).includes("calls"),
    "worked counts leads with calls",
  );
});

test("card SQL and list SQL normalize to the same booked predicate, both grains", () => {
  assert.equal(
    normalizeSql(stageCondition("booked")),
    normalizeSql(liveAppointmentExists(leads.id)),
    "card and lead-list share the booked predicate",
  );
  assert.equal(
    normalizeSql(callOutcomeCondition("booked")),
    normalizeSql(liveAppointmentExists(leads.id)),
    "call-list booked matches lead-list booked up to the bound column",
  );
  assert.ok(
    normalizeSql(stageCondition("booked")).includes("cancelled"),
    "booked skips cancelled appointments",
  );
});

test("card SQL and list SQL normalize to the same handoff predicate, incl NULL/empty-blockers edges", () => {
  assert.equal(
    normalizeSql(stageCondition("handoff")),
    normalizeSql(latestBlockersNonEmpty(leads.id)),
    "card and lead-list share the handoff predicate",
  );
  assert.equal(
    normalizeSql(callOutcomeCondition("handoff")),
    normalizeSql(latestBlockersNonEmpty(leads.id)),
    "call-list handoff matches lead-list handoff up to the bound column",
  );
  const handoff = normalizeSql(stageCondition("handoff"));
  // Edge documentation, in SQL semantics: NULL (no state row) yields NULL
  // from `<>`, which WHERE treats as not-true — never a handoff; '[]'
  // (empty blocker list) yields false — never a handoff. Only a non-empty
  // blocker array yields true.
  assert.ok(
    handoff.includes("<> '[]'"),
    "handoff fires only on a non-empty blocker list",
  );
  assert.ok(
    handoff.includes("order by created_at desc limit 1"),
    "handoff reads the latest state row only",
  );
});

test("connected card and list share the ended-call predicate", () => {
  const cardSource = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  assert.ok(cardSource.includes("callConnected"));
  assert.equal(
    normalizeSql(callOutcomeCondition("connected")),
    normalizeSql(callConnected()),
    "list connected matches the card predicate",
  );
});

test("dashboard cards reuse all four shared predicates", () => {
  const actions = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  for (const name of [
    "workedLeadExists",
    "callConnected",
    "liveAppointmentExists",
    "latestBlockersNonEmpty",
  ]) {
    assert.ok(actions.includes(name), `dashboard reuses ${name}`);
  }
  const stageSource = readFileSync(join(here, "stage-filter.ts"), "utf8");
  for (const name of [
    "workedLeadExists",
    "liveAppointmentExists",
    "latestBlockersNonEmpty",
  ]) {
    assert.ok(stageSource.includes(name), `stage filter reuses ${name}`);
  }
  const outcomeSource = readFileSync(
    join(here, "..", "calls", "outcome-filter.ts"),
    "utf8",
  );
  for (const name of [
    "callConnected",
    "liveAppointmentExists",
    "latestBlockersNonEmpty",
  ]) {
    assert.ok(outcomeSource.includes(name), `outcome filter reuses ${name}`);
  }
  assert.ok(
    !stageSource.includes("exists(select 1 from") &&
      !outcomeSource.includes("exists(select 1 from"),
    "no inline outcome SQL left in either filter",
  );
});

// Source-text assertions (same approach as calls-index.test.ts): the repo has
// no jsdom/component-render setup, so cross-file wiring — dashboard links,
// list params, empty-state branching — is checked on the real sources.
const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(here, "..", "..", "app", "(dashboard)", "dashboard");
const leadsDir = join(here, "..", "..", "app", "(dashboard)", "leads");
const callsDir = join(here, "..", "..", "app", "(dashboard)", "calls");

test("dashboard first-run replaces the zero grid with a setup path", () => {
  const page = readFileSync(join(dashboardDir, "page.tsx"), "utf8");
  const actions = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  const setup = readFileSync(join(here, "..", "dashboard", "setup.ts"), "utf8");
  assert.ok(actions.includes("isFirstRun"), "summary exposes first-run");
  assert.ok(page.includes("isFirstRun"), "page branches on first-run");
  assert.ok(
    setup.includes('"/agents/new"') &&
      setup.includes('"/campaigns/new"') &&
      setup.includes('"/campaigns"'),
    "setup steps link to agent creation, campaign creation, campaigns",
  );
  assert.ok(
    !page.includes("Hero") && !page.includes("eyebrow"),
    "no hero-metric template or kicker per the craft floor",
  );
});

test("first-run covers zero outcomes with waiting campaigns, not without", () => {
  const actions = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  const gate = actions.slice(actions.indexOf("isFirstRun:"));
  assert.ok(
    gate.includes("appointmentsBooked === 0"),
    "booked outcome still gates first-run",
  );
  assert.ok(
    !gate.includes("emptyCampaigns.length === 0"),
    "empty campaigns no longer veto the setup path",
  );
});

test("setup step 2 names the waiting campaign and deep-links its import", () => {
  const page = readFileSync(join(dashboardDir, "page.tsx"), "utf8");
  const setup = readFileSync(join(here, "..", "dashboard", "setup.ts"), "utf8");
  assert.ok(
    setup.includes("Import leads into ${waitingCampaign.name}"),
    "step 2 titles the campaign-creation truth when a campaign waits",
  );
  assert.ok(
    setup.includes("#import"),
    "setup and next-action links land on the import section",
  );
  assert.ok(
    !page.includes("import a CSV into a new or existing campaign"),
    "no stale import-anywhere copy next to the campaign link",
  );
  const campaignPage = readFileSync(
    join(here, "..", "..", "app", "(dashboard)", "campaigns", "[id]", "page.tsx"),
    "utf8",
  );
  assert.ok(
    campaignPage.includes('id="import"'),
    "campaign detail exposes the import anchor",
  );
});

test("booked card and list share lead grain, without over-claiming", () => {
  const actions = readFileSync(join(dashboardDir, "actions.ts"), "utf8");
  // Lead grain: the booked card counts leads (FROM leads WHERE the shared
  // live-appointment predicate), not appointment rows.
  assert.ok(actions.includes("liveAppointmentExists"));
  assert.ok(actions.includes(".from(leads)"));
  const page = readFileSync(join(dashboardDir, "page.tsx"), "utf8");
  assert.ok(
    page.includes("Booked leads"),
    "booked card labels its lead grain explicitly",
  );
  for (const source of [
    page,
    readFileSync(join(here, "stage-filter.ts"), "utf8"),
    readFileSync(
      join(here, "..", "calls", "outcome-filter.ts"),
      "utf8",
    ),
  ]) {
    assert.ok(
      !source.includes("can never disagree"),
      "no over-claiming agreement comment survives",
    );
  }
});

test("dashboard outcome cards link to their filtered lists", () => {
  const page = readFileSync(join(dashboardDir, "page.tsx"), "utf8");
  for (const href of [
    "/leads?stage=worked",
    "/calls?outcome=connected",
    "/leads?stage=booked",
    "/leads?stage=handoff",
  ]) {
    assert.ok(page.includes(href), `card links to ${href}`);
  }
  assert.ok(
    !page.includes("deliberately NOT links"),
    "the de-linking comment is gone — links exist now",
  );
  assert.ok(
    page.includes("<StatStrip"),
    "linked figures use the shared dashboard-01 KPI strip",
  );
});

test("leads list reads ?stage= inside the Suspense leaf with a clear path", () => {
  const page = readFileSync(join(leadsDir, "page.tsx"), "utf8");
  const actions = readFileSync(join(leadsDir, "actions.ts"), "utf8");
  // Normalization lives in the data layer (listLeads returns the normalized
  // stage); the page destructures stage/total from it and labels the chip.
  assert.ok(page.includes("stageFilterLabel"));
  assert.ok(page.includes("listLeads(200"));
  assert.ok(page.includes("searchParams"));
  assert.ok(
    page.indexOf("await searchParams") > page.indexOf("function LeadsRows"),
    "params resolve inside the rows leaf, not the shell (E1439)",
  );
  // The Filter menu's "All" option is the clear target (its pill × links there).
  assert.ok(page.includes('{ label: "All", href: "/leads"'), "filter clears to /leads");
  assert.ok(
    page.includes("No leads match this filter"),
    "filtered empty state differs from the unfiltered one",
  );
  assert.ok(
    actions.includes("ListLeadsOptions") && actions.includes("stageCondition"),
    "listLeads accepts and applies the stage filter",
  );
  assert.ok(
    actions.includes("total"),
    "listLeads returns the filtered total for the result count",
  );
  assert.ok(
    page.includes("countLabel"),
    "leads list renders an always-visible result count",
  );
  assert.ok(
    page.includes('role="status"'),
    "result count is a live status region",
  );
});

test("calls list reads ?outcome= with filter-carrying pagination", () => {
  const page = readFileSync(join(callsDir, "page.tsx"), "utf8");
  const data = readFileSync(
    join(here, "..", "copilot", "detail-data.ts"),
    "utf8",
  );
  assert.ok(page.includes("normalizeCallOutcome") || page.includes("outcome:"));
  assert.ok(
    data.includes("ListCallsFilter") &&
      data.includes("callOutcomeCondition"),
    "listCalls accepts and applies the outcome filter",
  );
  assert.ok(page.includes("outcome"), "calls page threads outcome through");
  assert.ok(
    page.includes('href="/calls"'),
    "filter chip clears to /calls",
  );
  assert.ok(
    page.includes("No calls match this filter"),
    "filtered empty state differs from the unfiltered ones",
  );
  // Pagination keeps the filter: prev/next hrefs carry outcome.
  assert.ok(
    page.includes("callsPageHref") || page.includes("outcome="),
    "pagination preserves the active filter",
  );
});
