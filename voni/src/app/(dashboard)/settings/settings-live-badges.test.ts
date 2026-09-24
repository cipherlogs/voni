import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");
const repoFile = (...parts: string[]) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

test("landing feeds every tile a live badge from one batched round", () => {
  const landing = source("page.tsx");
  // Pure derivation lives in lib — the landing fetches, never invents text.
  assert.match(landing, /settingsTileBadges/);
  assert.match(landing, /buildServiceReadiness/);
  // One batched round: voice prefs, providers, platform summaries, numbers.
  assert.match(landing, /Promise\.all/);
  assert.match(landing, /getCopilotVoicePrefs|getConnectedProviderIds/);
  assert.match(landing, /credentialSummary/);
  assert.match(landing, /phoneNumbers/);
  // Badges reach the production tile — never mock text on the landing.
  assert.match(landing, /badge={/);
  assert.doesNotMatch(landing, /MOCK/);
  // The operator tile keeps its admin gate (hidden, never a dead end).
  assert.match(landing, /adminOnly/);
  assert.match(landing, /isPlatformAdmin/);
});

test("landing and services section share one readiness source", () => {
  const section = source("[tab]/page.tsx");
  assert.match(section, /buildServiceReadiness/);
  const badges = repoFile("lib", "settings-badges.ts");
  assert.match(badges, /export function buildServiceReadiness/);
  assert.match(badges, /export function settingsTileBadges/);
});

test("badge status stays part of the link announcement", () => {
  const tile = repoFile("components", "settings-card.tsx");
  assert.match(tile, /Status: /);
  // Since ticket 06 the accessible name travels as the island's ariaLabel
  // prop; the island renders it as the link's aria-label.
  assert.match(tile, /ariaLabel=\{/);
  const island = repoFile("components", "hover-prefetch-link.tsx");
  assert.match(island, /aria-label=\{ariaLabel\}/);
});

test("appearance badge is client-live, never a server mock", () => {
  const landing = source("page.tsx");
  assert.match(landing, /AppearanceTile/);
  const island = source("appearance-tile.tsx");
  assert.match(island, /"use client"/);
  assert.match(island, /useTheme/);
  assert.match(island, /SettingsCard/);
  assert.match(island, /badge/);
  // No pre-hydration placeholder: the badge renders after mount so the link
  // never announces the default as the user's live preference.
  assert.match(island, /mounted/);
});
