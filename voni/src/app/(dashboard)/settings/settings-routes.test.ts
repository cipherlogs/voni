import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");
const repoFile = (...parts: string[]) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

test("landing maps the registry to real links with admin gating", () => {
  const landing = source("page.tsx");
  // Registry-driven: every tile renders through the production SettingsCard.
  assert.match(landing, /SETTINGS_TILES/);
  assert.match(landing, /SettingsCard/);
  // Real shareable URLs come from the tile itself, never a mock href.
  assert.match(landing, /tile={tile}/);
  assert.doesNotMatch(landing, /galleryHref/);
  assert.doesNotMatch(landing, /MOCK/);
  const tile = repoFile("components", "settings-card.tsx");
  assert.match(tile, /href={tile\.href}/);
  // Intent prefetch (ticket 06): dead at rest so viewport entry never
  // avalanches; hover/focus intent restores default prefetch per tile.
  assert.match(tile, /HoverPrefetchLink/);
  assert.match(tile, /enabled=\{prefetchOnIntent\}/);
  const intent = repoFile("components", "hover-prefetch-link.tsx");
  assert.match(intent, /prefetch=\{enabled \? \(active \? null : false\) : false\}/);
  // The operator tile honors the registry's adminOnly flag.
  assert.match(landing, /adminOnly/);
  assert.match(landing, /isPlatformAdmin/);
  // Single column on mobile.
  assert.match(landing, /grid-cols-1/);
  // Legacy hashes redirect client-side (fragments never reach the server).
  assert.match(landing, /SettingsHashRedirect/);
  const island = source("settings-hash-redirect.tsx");
  assert.match(island, /settingsHashTarget/);
  assert.match(island, /router\.replace/);
});

test("old tab state machine is gone from the settings path", () => {
  assert.equal(existsSync(join(here, "..", "..", "..", "components", "settings-view.tsx")), false);
  const sections = repoFile("components", "settings-sections.tsx");
  assert.doesNotMatch(sections, /Tabs/);
  assert.doesNotMatch(sections, /activeTab/);
  assert.doesNotMatch(sections, /role=.tab/);
  for (const name of ["AccountSection", "VoiceSection", "WorkspaceSection", "ServicesSection", "AppearanceSection"]) {
    assert.match(sections, new RegExp(`export function ${name}`));
  }
});

test("dynamic section route serves static params and 404s the rest", () => {
  const page = source("[tab]/page.tsx");
  // Static params from the tab source; unknown values 404 via explicit
  // guards (no `dynamicParams = false` — rejected under cacheComponents).
  assert.match(page, /generateStaticParams/);
  assert.match(page, /SETTINGS_TABS/);
  assert.doesNotMatch(page, /export const dynamicParams/);
  assert.match(page, /notFound\(\)/);
  // One data leaf per tab; the shell's boundary streams them.
  for (const leaf of ["AccountData", "VoiceData", "WorkspaceData", "ServicesData", "AppearanceData"]) {
    assert.match(page, new RegExp(leaf));
  }
  // Per-route voice briefs ride with the leaf that owns the data.
  assert.match(page, /RouteBrief route="\/settings\/account"/);
  assert.match(page, /RouteBrief route="\/settings\/voice"/);
  assert.match(page, /RouteBrief route="\/settings\/workspace"/);
  assert.match(page, /RouteBrief route="\/settings\/services"/);
  assert.match(page, /RouteBrief route="\/settings\/appearance"/);
});

test("per-route voice briefs describe their section accurately", () => {
  const page = source("[tab]/page.tsx");
  // Account names the session and the sign-out action it owns.
  assert.match(page, /Signed in as/);
  assert.match(page, /Sign out here/);
  // Voice names the live prefs and the confirmed-edits-then-save contract.
  assert.match(page, /Settings · Voice copilot\. Voice /);
  assert.match(page, /confirmed edits and a confirmed save/);
  // Workspace names the org and the owner gate (allowed vs disabled).
  assert.match(page, /Workspace edits \$\{canEdit \? "allowed" : "disabled"\}/);
  // Services names readiness counts and the operator boundary.
  assert.match(page, /services configured/);
  assert.match(page, /providers connected/);
  assert.match(page, /operator-managed/);
  // Appearance names the three options.
  assert.match(page, /light, dark, or the system setting/);
});

test("shared section shell carries back-link, heading, skeleton, and tab validation", () => {
  const layout = source("[tab]/layout.tsx");
  assert.match(layout, /BackLink href="\/settings"/);
  assert.match(layout, /tile\.label/);
  assert.match(layout, /tile\.description/);
  assert.match(layout, /notFound\(\)/);
  assert.match(layout, /<Suspense/);
  // Ticket 03: one skeleton per section shape, picked by tab — never a
  // single generic fallback for all sections.
  assert.match(layout, /SettingsSectionSkeleton/);
  assert.doesNotMatch(layout, /DetailSkeleton/);
  assert.match(layout, /{children}/);
  // Layout and page validate through one shared lookup — heading and
  // content can never disagree on what exists.
  assert.match(layout, /settingsSectionTile/);
  const page = source("[tab]/page.tsx");
  assert.match(page, /settingsSectionTile/);
  // Instant insight opt-out: most section leaves read per-session data
  // (headers + org-scoped queries) and the page itself reads params, so the
  // blocking-prerender validation allows these routes to block instead of
  // flagging each data leaf. Lives on the page (lowest segment) — pinned
  // absent from the layout — so the rest of the app keeps validating.
  assert.match(page, /export const instant = false/);
  assert.doesNotMatch(layout, /export const instant/);
});

test("unknown sections land on a settings-scoped not-found page", () => {
  const missing = source("not-found.tsx");
  assert.match(missing, /Unknown settings section/);
  assert.match(missing, /href="\/settings"/);
});
