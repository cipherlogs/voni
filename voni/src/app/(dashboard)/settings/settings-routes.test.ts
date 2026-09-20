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
  // Registry-driven: every tile renders through the production BentoTile.
  assert.match(landing, /SETTINGS_TILES/);
  assert.match(landing, /BentoTile/);
  // Real shareable URLs come from the tile itself, never a mock href.
  assert.match(landing, /tile={tile}/);
  assert.doesNotMatch(landing, /galleryHref/);
  assert.doesNotMatch(landing, /MOCK/);
  const tile = repoFile("components", "settings-bento", "bento-tile.tsx");
  assert.match(tile, /href={tile\.href}/);
  // Prefetch stays off until ticket 06 wires hover/focus intent prefetch.
  assert.match(tile, /prefetch={false}/);
  // The operator tile honors the registry's adminOnly flag.
  assert.match(landing, /adminOnly/);
  assert.match(landing, /isPlatformAdmin/);
  // Single column on mobile, heroes span two on desktop.
  assert.match(landing, /grid-cols-1/);
  assert.match(landing, /lg:col-span-2/);
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

test("shared section shell carries back-link, heading, skeleton, and tab validation", () => {
  const layout = source("[tab]/layout.tsx");
  assert.match(layout, /BackLink href="\/settings"/);
  assert.match(layout, /tile\.label/);
  assert.match(layout, /tile\.description/);
  assert.match(layout, /notFound\(\)/);
  assert.match(layout, /<Suspense/);
  assert.match(layout, /DetailSkeleton/);
  assert.match(layout, /{children}/);
  // Layout and page validate through one shared lookup — heading and
  // content can never disagree on what exists.
  assert.match(layout, /settingsSectionTile/);
  const page = source("[tab]/page.tsx");
  assert.match(page, /settingsSectionTile/);
});

test("unknown sections land on a settings-scoped not-found page", () => {
  const missing = source("not-found.tsx");
  assert.match(missing, /Unknown settings section/);
  assert.match(missing, /href="\/settings"/);
});
