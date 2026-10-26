import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 10: list mutation UX (per-item pending, never-silent feedback),
// durable long work pinned in the global job center, and async routes that
// stream a shaped shell with a recoverable error surface. The repo has no
// jsdom/component setup, so these pin the seams in source: the provider
// feedback contract, the per-item pending identifiers, the loading shells,
// the shared RouteError composition, and the job-kind → destination map.

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]) => join(here, "..", ...parts);
const read = (...parts: string[]) => readFileSync(src(...parts), "utf8");
const appSeg = (...parts: string[]) => src("app", "(dashboard)", ...parts);

function errorBoundaryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...errorBoundaryFiles(full));
    } else if (entry === "error.tsx") {
      out.push(full);
    }
  }
  return out;
}

test("openJob surfaces a failed seen-mark instead of swallowing it", () => {
  const provider = read("components", "jobs", "jobs-provider.tsx");
  const openJob = provider.slice(provider.indexOf("const openJob = useCallback"));
  // Mutation-feedback rule: a failed bookkeeping write toasts so the row's
  // unread state is explainable. Navigation still proceeds to the result
  // destination below.
  assert.ok(openJob.includes("toast.add"), "openJob failure must toast");
  assert.ok(!openJob.includes(".catch(() => undefined)"), "openJob must not swallow the seen-mark");
});

test("markSeen surfaces a failed seen-mark instead of swallowing it", () => {
  const provider = read("components", "jobs", "jobs-provider.tsx");
  const markSeen = provider.slice(provider.indexOf("const markSeen = useCallback"));
  assert.ok(markSeen.includes("toast.add"), "markSeen failure must toast");
  assert.ok(!markSeen.includes(".catch(() => undefined)"), "markSeen must not swallow the seen-mark");
});

test("agents/new streams a shaped shell while the creator loads", () => {
  const loadingFile = appSeg("agents", "new", "loading.tsx");
  assert.ok(existsSync(loadingFile), "agents/new/loading.tsx exists");
  const loading = readFileSync(loadingFile, "utf8");
  // Same skeleton the page itself streams inside its Suspense leaf, so the
  // loading boundary and the in-page fallback read as one shell.
  assert.match(loading, /NewAgentSkeleton/);
  assert.match(loading, /page-skeletons/);
});

test("settings sections stream a shaped shell while the tab loads", () => {
  const loadingFile = appSeg("settings", "[tab]", "loading.tsx");
  assert.ok(existsSync(loadingFile), "settings/[tab]/loading.tsx exists");
  const loading = readFileSync(loadingFile, "utf8");
  // No params reach a loading boundary, so this is the dominant section
  // shape (flat form); the layout shell keeps the per-tab skeleton for
  // its own Suspense leaf.
  assert.match(loading, /FlatFormSkeleton/);
  assert.match(loading, /page-skeletons/);
});

test("list mutations keep pending state per item, never one shared boolean", () => {
  // Per-row pending identifiers: acting on one row never disables the rest.
  const jobRow = read("components", "jobs", "job-row.tsx");
  assert.match(jobRow, /pendingAction/);
  assert.match(jobRow, /pending=\{pendingAction === /);
  const recordResults = read("components", "copilot", "record-results.tsx");
  assert.match(recordResults, /pending === match\.ref/);
  const phoneNumbers = read("components", "phone-numbers.tsx");
  assert.match(phoneNumbers, /pendingId/);
  const settingsSections = read("components", "settings-sections.tsx");
  assert.match(settingsSections, /pendingId/);
  // Bulk singles stay on bulk bars (jobs page, campaign queue, leads bar),
  // where one operation genuinely covers the selection — never on rows.
  for (const [file, pattern] of [
    ["app/(dashboard)/jobs/page.tsx", /disabled=\{bulkOp !== null\}/],
    ["components/campaign-queue.tsx", /disabled=\{bulkOp !== null\}/],
    ["components/leads-bulk-bar.tsx", /disabled=\{applying\}/],
  ] as const) {
    assert.match(read(...file.split("/")), pattern, `${file} scopes its shared boolean to the bulk bar`);
  }
  const campaignsList = read("app", "(dashboard)", "campaigns", "page.tsx");
  assert.doesNotMatch(campaignsList, /disabled=\{pending\}/);
  const agentsList = read("app", "(dashboard)", "agents", "page.tsx");
  assert.doesNotMatch(agentsList, /disabled=\{pending\}/);
});

test("CampaignControls single pending stays on the single-action detail page", () => {
  // Single boolean is acceptable on the detail page (one action total) but
  // must not be copied to lists.
  const controls = read("components", "campaign-controls.tsx");
  assert.match(controls, /const \[pending, startTransition\] = useTransition/);
  const detail = read("app", "(dashboard)", "campaigns", "[id]", "page.tsx");
  assert.match(detail, /CampaignControls/);
  const list = read("app", "(dashboard)", "campaigns", "page.tsx");
  assert.doesNotMatch(list, /CampaignControls/);
});

test("delete buttons rely on the dialog confirm (verified, no row-level transition)", () => {
  // Dialog confirm owns pending + inline failure + success toast; the row
  // wrappers stay thin so lists never track delete pending per row.
  for (const file of [
    ["app", "(dashboard)", "agents", "delete-agent-button.tsx"],
    ["app", "(dashboard)", "campaigns", "delete-campaign-button.tsx"],
  ] as const) {
    const source = read(...file);
    assert.match(source, /DeleteConfirmDialog/);
    assert.doesNotMatch(source, /useTransition/);
  }
  const dialog = read("components", "delete-confirm-dialog.tsx");
  assert.match(dialog, /useTransition/);
  assert.match(dialog, /AlertDescription/);
  assert.match(dialog, /toast\.add/);
});

test("every dashboard error boundary renders the shared recoverable surface", () => {
  const boundaries = errorBoundaryFiles(appSeg());
  assert.ok(boundaries.length > 10, `expected dashboard error.tsx coverage, found ${boundaries.length}`);
  for (const file of boundaries) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("RouteError"), `${file} must render the shared RouteError`);
  }
  const routeError = read("components", "route-error.tsx");
  // Retry is always available; 429-style backoffs count down, then re-enable.
  assert.match(routeError, /Try again/);
  assert.match(routeError, /Try again in/);
});

test("every durable job kind keeps a result destination and a retry path", () => {
  const kinds = read("lib", "jobs", "kinds.ts");
  // Result destinations survive navigation and reload: each kind maps to a
  // route that restores its result (?job=, ?search=, or the record page).
  for (const kind of [
    "agent_generation",
    "agent_deployment",
    "integration_test",
    "lead_csv_import",
    "record_search",
  ]) {
    assert.ok(kinds.includes(`"${kind}"`), `JOB_KINDS includes ${kind}`);
  }
  for (const destination of [
    "/agents/new?job=",
    "/agents/${",
    "/jobs?search=",
    "/operator",
    "/campaigns/${",
  ]) {
    assert.ok(kinds.includes(destination), `targetUrlFor routes to ${destination}`);
  }
  // One processor module per long-work kind: generation, deployment,
  // integration tests, CSV imports, and record search all run as durable
  // jobs — never inline in the request path.
  for (const processor of [
    "generation.ts",
    "deployment.ts",
    "integration-test.ts",
    "csv-import.ts",
    "record-search.ts",
  ]) {
    assert.ok(existsSync(src("lib", "jobs", "processors", processor)), `processor ${processor} exists`);
  }
  // Retry stays reachable from the provider, the row, and the bulk bar.
  const provider = read("components", "jobs", "jobs-provider.tsx");
  assert.match(provider, /retryJob/);
  const jobRow = read("components", "jobs", "job-row.tsx");
  assert.match(jobRow, /Retry/);
  const jobsPage = read("app", "(dashboard)", "jobs", "page.tsx");
  assert.match(jobsPage, /bulkJobsAction/);
});
