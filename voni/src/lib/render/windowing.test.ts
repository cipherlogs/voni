import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  WINDOWED_PAGE_SIZE,
  computeWindowedRange,
  nextWindowedCount,
  windowedSlice,
} from "./windowing";

// Ticket 09 (V1): long call/lead lists cull off-screen rows. The window
// helpers below are the seam: bounded rendered output, identical rows in
// identical order, immutable input. The client island renders exactly the
// slice these helpers describe — no reordering, no row rewrite.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

function numbered(total: number): string[] {
  return Array.from({ length: total }, (_, index) => `row-${index}`);
}

test("initial window bounds long lists while keeping row order", () => {
  const rows = numbered(200);
  const visible = windowedSlice(rows, 0, WINDOWED_PAGE_SIZE);
  assert.ok(
    visible.length <= WINDOWED_PAGE_SIZE,
    `200 rows render at most ${WINDOWED_PAGE_SIZE}`,
  );
  assert.ok(visible.length > 0, "the window is never empty for a non-empty list");
  assert.deepEqual(
    visible,
    rows.slice(0, visible.length),
    "visible rows are the list prefix in order",
  );
});

test("growth prefixes stay ordered and jointly cover every row", () => {
  const rows = numbered(200);
  let rendered = Math.min(WINDOWED_PAGE_SIZE, rows.length);
  const seen = new Set<string>();
  for (;;) {
    const visible = windowedSlice(rows, 0, rendered);
    assert.deepEqual(
      visible,
      rows.slice(0, rendered),
      "each step is the list prefix in order",
    );
    for (const row of visible) seen.add(row);
    if (rendered >= rows.length) break;
    const next = nextWindowedCount(rendered, rows.length);
    assert.ok(
      next > rendered && next - rendered <= WINDOWED_PAGE_SIZE,
      "growth is one bounded chunk",
    );
    rendered = next;
  }
  assert.equal(seen.size, rows.length, "every row stays reachable in order");
});

test("window ranges clamp at both ends", () => {
  assert.deepEqual(computeWindowedRange(200, -40, 50, 10), {
    start: 0,
    end: 60,
  });
  assert.deepEqual(computeWindowedRange(200, 190, 50, 10), {
    start: 180,
    end: 200,
  });
  assert.deepEqual(computeWindowedRange(20, 0, 50, 10), {
    start: 0,
    end: 20,
  });
  assert.deepEqual(computeWindowedRange(0, 0, 50, 10), { start: 0, end: 0 });
});

test("short lists render whole (no sentinel, no culling)", () => {
  const rows = numbered(20);
  const { start, end } = computeWindowedRange(rows.length, 0, 50, 10);
  assert.deepEqual(windowedSlice(rows, start, end - start), rows);
  assert.equal(
    nextWindowedCount(20, 20, 50),
    20,
    "a complete list never asks for more",
  );
});

test("growth advances one bounded chunk and caps at the total", () => {
  assert.equal(nextWindowedCount(50, 200, 50), 100);
  assert.equal(nextWindowedCount(180, 200, 50), 200);
  assert.equal(nextWindowedCount(200, 200, 50), 200);
});

test("slicing never mutates the input rows", () => {
  const rows = numbered(10).map((id) => Object.freeze({ id }));
  windowedSlice(rows, 0, 5);
  computeWindowedRange(rows.length, 4, 5, 2);
  assert.deepEqual(
    rows.map((row) => row.id),
    numbered(10),
    "frozen input survives windowing untouched",
  );
});

test("long lists window through the shared island with no row rewrite", () => {
  const island = readRepo("components/windowed.tsx");
  assert.ok(island.includes("nextWindowedCount"), "growth stays chunked");
  assert.ok(island.includes("IntersectionObserver"), "growth follows scroll");
  assert.ok(island.includes('aria-hidden="true"'), "sentinel stays hidden");
  assert.ok(
    island.includes("windowed-sentinel"),
    "sentinel stays addressable",
  );

  const wired = [
    "app/(dashboard)/leads/page.tsx",
    "app/(dashboard)/calls/page.tsx",
    "app/(dashboard)/calls/[id]/page.tsx",
    "app/(dashboard)/leads/[id]/page.tsx",
    "components/campaign-queue.tsx",
  ];
  for (const relative of wired) {
    const source = readRepo(relative);
    assert.ok(
      source.includes("<WindowedRows"),
      `${relative} culls through the shared island`,
    );
  }

  // Same rows and order: the row markup still maps the same source arrays
  // into the same row components — only wrapped.
  assert.ok(
    readRepo("app/(dashboard)/leads/page.tsx").includes("rows={rows.map("),
    "leads keep their row mapping under the window",
  );
  assert.ok(
    readRepo("app/(dashboard)/calls/page.tsx").includes("rows={rows.map("),
    "calls keep their row mapping under the window",
  );
  assert.ok(
    readRepo("components/campaign-queue.tsx").includes("rows={visible.map("),
    "queue keeps its row mapping under the window",
  );
  assert.ok(
    readRepo("app/(dashboard)/calls/page.tsx").includes("Started"),
    "calls keep the Started column (no visual change)",
  );
});
