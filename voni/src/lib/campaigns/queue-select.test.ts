import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  countQueuedMembers,
  selectActionableIds,
  summarizeQueueSelection,
} from "./queue-select";
import {
  getDashboardSetupSteps,
  summarizeSetupSteps,
} from "@/lib/dashboard/setup";

// Ticket 09 (J1): combinable passes collapse to one loop each, membership
// goes through Set.has (the queueBulkAction model), and array ops never
// mutate their input. Same values out — fewer passes to get them.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("queued count matches filter-length without a second pass", () => {
  const members = [
    { status: "queued" },
    { status: "dialing" },
    { status: "queued" },
    { status: "reached" },
  ];
  assert.equal(countQueuedMembers(members), 2);
  assert.equal(countQueuedMembers([]), 0);
});

test("selection summary resolves all/some-selected in one pass", () => {
  const visible = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(summarizeQueueSelection(visible, new Set(["a", "b", "c"])), {
    allSelected: true,
    someSelected: true,
  });
  assert.deepEqual(summarizeQueueSelection(visible, new Set(["b"])), {
    allSelected: false,
    someSelected: true,
  });
  assert.deepEqual(summarizeQueueSelection(visible, new Set()), {
    allSelected: false,
    someSelected: false,
  });
  assert.deepEqual(summarizeQueueSelection([], new Set(["a"])), {
    allSelected: false,
    someSelected: false,
  });
});

test("actionable ids keep visible order via Set membership, input untouched", () => {
  const visible = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const frozen = Object.freeze(
    visible.map((row) => Object.freeze({ ...row })),
  );
  const ids = selectActionableIds(frozen, new Set(["c", "a"]));
  assert.deepEqual(ids, ["a", "c"]);
  assert.deepEqual(
    frozen.map((row) => row.id),
    ["a", "b", "c"],
    "input order and contents unchanged",
  );
});

test("setup summary counts completed and names the next open step at once", () => {
  const steps = getDashboardSetupSteps(
    { agentCreated: true, leadsImported: false, campaignActivated: false },
    [{ id: "campaign-1", name: "September outreach" }],
  );
  assert.deepEqual(summarizeSetupSteps(steps), {
    completed: 1,
    total: 3,
    nextIncompleteTitle: "Import leads into September outreach",
  });
  const done = getDashboardSetupSteps(
    { agentCreated: true, leadsImported: true, campaignActivated: true },
    [],
  );
  assert.deepEqual(summarizeSetupSteps(done), {
    completed: 3,
    total: 3,
    nextIncompleteTitle: "done",
  });
});

test("multi-pass array work collapses to the single-pass helpers", () => {
  const dashboard = readRepo("app/(dashboard)/dashboard/page.tsx");
  assert.ok(
    dashboard.includes("summarizeSetupSteps"),
    "dashboard brief uses the single-pass summary",
  );
  assert.doesNotMatch(
    dashboard,
    /setupSteps\.filter\(/,
    "no separate filter pass over setup steps",
  );
  assert.doesNotMatch(
    dashboard,
    /setupSteps\.find\(/,
    "no separate find pass over setup steps",
  );

  const campaign = readRepo("app/(dashboard)/campaigns/[id]/page.tsx");
  assert.ok(
    campaign.includes("countQueuedMembers"),
    "campaign detail counts queued in one pass",
  );
  assert.doesNotMatch(
    campaign,
    /\.filter\(\(m\) =>/,
    "no filter-then-count over members",
  );

  const queue = readRepo("components/campaign-queue.tsx");
  assert.ok(
    queue.includes("summarizeQueueSelection"),
    "queue resolves all/some-selected together",
  );
  assert.ok(
    queue.includes("selectActionableIds"),
    "queue collects actionable ids in one pass",
  );
  assert.ok(queue.includes(".has("), "membership stays Set-based");
  assert.doesNotMatch(
    queue,
    /visible\.every\(/,
    "no standalone every pass over visible rows",
  );
  assert.doesNotMatch(
    queue,
    /visible\.some\(/,
    "no standalone some pass over visible rows",
  );
  assert.doesNotMatch(
    queue,
    /visible\.filter\([^)]*\)\.map\(/,
    "no filter-then-map over visible rows",
  );
});

test("lead activity reversal stays immutable", () => {
  const lead = readRepo("app/(dashboard)/leads/[id]/page.tsx");
  assert.ok(
    lead.includes("[...activity].reverse()"),
    "activity copies before reversing",
  );
  assert.doesNotMatch(
    lead,
    /[^.]activity\.reverse\(\)/,
    "no in-place reverse of the query rows",
  );
});
