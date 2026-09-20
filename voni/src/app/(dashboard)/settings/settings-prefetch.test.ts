import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoFile = (...parts: string[]) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

test("intent link restores default prefetch only on hover/focus intent", () => {
  const island = repoFile("components", "settings-bento", "hover-prefetch-link.tsx");
  assert.match(island, /"use client"/);
  // Canonical docs pattern: dead at rest (no viewport avalanche), default
  // static prefetch once the user shows intent.
  assert.match(island, /active \? null : false/);
  assert.match(island, /onMouseEnter=\{\(\) => setActive\(true\)\}/);
  // Keyboard focus prefetches exactly like hover (ticket 06 checkbox).
  assert.match(island, /onFocus=\{\(\) => setActive\(true\)\}/);
  // Native Link prefetching — never a hand-rolled router.prefetch island
  // (docs "proceed with caution": no self-maintained invalidation).
  assert.doesNotMatch(island, /useRouter/);
  assert.doesNotMatch(island, /router\.prefetch/);
});

test("intent link can be disabled for prefetch-silent venues", () => {
  const island = repoFile("components", "settings-bento", "hover-prefetch-link.tsx");
  assert.match(island, /enabled = true/);
  assert.match(island, /prefetch=\{enabled \? \(active \? null : false\) : false\}/);
});

test("production tile prefetches on intent; throwaway gallery is gone", () => {
  const tile = repoFile("components", "settings-bento", "bento-tile.tsx");
  assert.match(tile, /HoverPrefetchLink/);
  assert.doesNotMatch(tile, /from "next\/link"/);
  assert.match(tile, /prefetchOnIntent = true/);
  assert.match(tile, /enabled=\{prefetchOnIntent\}/);
  // Link contract preserved through the island: real href, accessible
  // name, no nested-link CTA changes.
  assert.match(tile, /href=\{tile\.href\}/);
  assert.match(tile, /ariaLabel=\{/);
  const island = repoFile("components", "settings-bento", "hover-prefetch-link.tsx");
  assert.match(island, /aria-label=\{ariaLabel\}/);
  // Throwaway gallery (ticket 08): route files deleted, no dead imports.
  assert.equal(existsSync(join(here, "..", "..", "..", "app", "prototypes", "settings-gallery")), false);
});
