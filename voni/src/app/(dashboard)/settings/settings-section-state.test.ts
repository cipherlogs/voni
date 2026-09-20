import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServiceReadiness } from "@/lib/settings-badges";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");
const repoFile = (...parts: string[]) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

test("each settings section streams a skeleton shaped to its real layout", () => {
  const skeletons = repoFile("components", "page-skeletons.tsx");
  // One skeleton per section shape — never a single generic fallback for all.
  for (const name of [
    "SettingsAccountSkeleton",
    "SettingsVoiceSkeleton",
    "SettingsWorkspaceSkeleton",
    "SettingsServicesSkeleton",
    "SettingsAppearanceSkeleton",
  ]) {
    assert.match(skeletons, new RegExp(`export function ${name}`), `${name} exists`);
  }
  // The section shell picks the skeleton by tab so heading + matching
  // skeleton persist across section navigation.
  const layout = source("[tab]/layout.tsx");
  assert.match(layout, /SettingsSectionSkeleton|SettingsAccountSkeleton/);
  assert.match(layout, /tab/);
});

test("a section failure renders a section-scoped error with retry", () => {
  const errorPath = join(here, "[tab]", "error.tsx");
  assert.ok(existsSync(errorPath), "[tab]/error.tsx exists");
  const error = source("[tab]/error.tsx");
  assert.match(error, /"use client"/);
  assert.match(error, /RouteError/);
  assert.match(error, /retry/);
});

test("voice and workspace forms make dirty state explicit", () => {
  const sections = repoFile("components", "settings-sections.tsx");
  // Dirty tracking per editable form (voice prefs + workspace settings).
  assert.match(sections, /isDirty|isVoiceDirty|isWorkspaceDirty|dirty/);
  // Reload/close warns while dirty instead of silently discarding — via the
  // shared guard hook (the literal beforeunload listener lives in the draft
  // module, pinned by its own test).
  assert.match(sections, /useBeforeUnloadGuard|beforeunload/);
  const draft = repoFile("components", "settings-draft.ts");
  assert.match(draft, /beforeunload/);
  // Draft retention keeps unfinished edits across the route split.
  assert.match(sections, /readSettingsDraft|writeSettingsDraft|settingsDraftKey/);
  // The dirty state is announced, not invisible.
  assert.match(sections, /Unsaved changes|unsaved/i);
});

test("workspace owner-gating survives the route split", () => {
  const sections = repoFile("components", "settings-sections.tsx");
  assert.match(sections, /Owner access required/);
  assert.match(sections, /canEdit/);
  const page = source("[tab]/page.tsx");
  assert.match(page, /canEdit/);
  assert.match(page, /role.*owner|owner.*role/i);
});

/** Count the Skeleton bars a skeleton component renders (its own source only). */
function skeletonBars(skeletons: string, name: string): number {
  const start = skeletons.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = skeletons.slice(start);
  const next = rest.indexOf("export function", 1);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return body.split("<Skeleton").length - 1;
}

test("service skeletons derive counts from the real sources", () => {
  const skeletons = repoFile("components", "page-skeletons.tsx");
  // Provider cards come from the catalog on both sides — a new provider
  // can never stream the wrong card count, and per-card tool rows follow
  // each provider's own tool list.
  assert.match(skeletons, /PROVIDER_CATALOG/);
  // Readiness rows come from the shared helper's row shape on both sides.
  assert.match(skeletons, /buildServiceReadiness/);
  assert.equal(
    buildServiceReadiness({
      assemblyaiConfigured: false,
      telnyxConfigured: false,
      telnyxConnectionId: null,
      telnyxCallerNumber: null,
      llmConfigured: false,
      cartesiaConfigured: false,
      cartesiaVoiceId: null,
    }).length,
    4,
  );
});

test("skeleton bar counts match each section's first-paint elements", () => {
  const skeletons = repoFile("components", "page-skeletons.tsx");
  // Account: avatar + name + email + sign-out (frame title/desc ride along).
  assert.equal(skeletonBars(skeletons, "SettingsAccountSkeleton"), 4);
  // Voice: two label+select pairs + one help line + save.
  assert.equal(skeletonBars(skeletons, "SettingsVoiceSkeleton"), 6);
  // Workspace: three label+control pairs + transfer help + save.
  assert.equal(skeletonBars(skeletons, "SettingsWorkspaceSkeleton"), 8);
  // Appearance: the theme control is one icon-only toggle, not a wide row.
  assert.equal(skeletonBars(skeletons, "SettingsAppearanceSkeleton"), 1);
});

test("landing streams a bento-grid skeleton, not the generic fallback", () => {
  const skeletons = repoFile("components", "page-skeletons.tsx");
  assert.match(skeletons, /export function SettingsLandingSkeleton/);
  // Tile frames follow the registry (order + hero spans) on both sides.
  assert.match(skeletons, /SETTINGS_TILES/);
  const loading = source("loading.tsx");
  assert.match(loading, /SettingsLandingSkeleton/);
  assert.doesNotMatch(loading, /DetailSkeleton/);
});
