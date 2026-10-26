import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatAbsoluteCallTime } from "./absolute-time";

// Ticket 09 (V3/J1): the two per-row `new Intl.DateTimeFormat` hot spots
// (calls index + call detail, plus the queue's copy) hoist to one
// module-scope formatter. Behavior is byte-identical — only the
// construction cost moves out of the row render.
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("absolute call time matches the inlined en-GB medium/short rendering", () => {
  const value = new Date("2026-03-04T15:30:00.000Z");
  const expected = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
  assert.equal(formatAbsoluteCallTime(value), expected);
});

test("absolute call time renders an em dash for missing timestamps", () => {
  assert.equal(formatAbsoluteCallTime(null), "—");
});

test("call lists reuse the shared formatter (no per-row construction)", () => {
  for (const relative of [
    "app/(dashboard)/calls/page.tsx",
    "app/(dashboard)/calls/[id]/page.tsx",
    "components/campaign-queue.tsx",
  ]) {
    const source = readRepo(relative);
    assert.ok(
      source.includes("formatAbsoluteCallTime"),
      `${relative} uses the shared formatter`,
    );
    assert.doesNotMatch(
      source,
      /new Intl\.DateTimeFormat/,
      `${relative} builds no formatter per row`,
    );
  }
});
