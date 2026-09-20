import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoFile = (...parts: string[]) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

test("tile scenes skip offscreen rendering, keep looping onscreen at rest", () => {
  const tile = repoFile("components", "settings-bento", "bento-tile.tsx");
  // The decorative scene wrapper carries the offscreen-skip hook so
  // offscreen tiles skip scene rendering; onscreen tiles keep the
  // V01-reviewed rest-playing loops (ticket 05 rest-playing decision).
  assert.match(tile, /bento-scene-viewport/);
  const css = repoFile("app", "globals.css");
  assert.match(css, /\.bento-scene-viewport/);
  assert.match(css, /content-visibility:\s*auto/);
  assert.match(css, /contain-intrinsic-size/);
  // Rest-playing: no paused play-state at rest — loops run onscreen,
  // reduced-motion plus offscreen skip are the only stops.
  assert.doesNotMatch(css, /animation-play-state:\s*paused/);
});

test("every surviving scene loop keeps its reduced-motion stop", () => {
  const css = repoFile("app", "globals.css");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.notEqual(css.indexOf("@media (prefers-reduced-motion: reduce)"), -1);
  for (const family of [
    "bento-node-ping",
    "bento-branch-cycle",
    "bento-lane",
    "bento-spine-dot",
    "bento-scan-flare",
    "bento-packet-x",
    "bento-point-breathe",
    "bento-shuttle-x",
    "bento-pulse-alt",
    "bento-pulse-alt-delay",
    "bento-descend-seal",
  ]) {
    assert.match(reduced, new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("ticket 06 keeps the intent-prefetch boundary and records its amendment", () => {
  const tile = repoFile("components", "settings-bento", "bento-tile.tsx");
  // Hover-intent prefetch (ticket 06): dead at rest — the landing never
  // fetch-avalanches sections on viewport entry; intent arms per tile.
  assert.match(tile, /HoverPrefetchLink/);
  assert.match(tile, /prefetchOnIntent = true/);
  const design = repoFile("..", "DESIGN.md");
  assert.match(design, /ticket 05/i);
  assert.match(design, /content-visibility/);
});
