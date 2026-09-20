import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
