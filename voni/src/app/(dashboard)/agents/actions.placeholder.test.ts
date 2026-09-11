import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "actions.ts"),
  "utf8",
);

test("generation placeholders link the list to the wizard by job id", () => {
  // Column, idempotent ensure, upgrade-by-job-id on save, live badge query.
  assert.ok(source.includes("generationJobId"));
  assert.ok(source.includes("ensureGenerationPlaceholderAction"));
  assert.ok(source.includes("getGenerationPlaceholderAction"));
  assert.ok(source.includes("listAgentsWithGeneration"));
  assert.ok(source.includes("generationStatus"));
});

test("retries demote terminal placeholders instead of twinning rows", () => {
  // Demote SQL in ensureGenerationPlaceholderAction stays; the upgrade path
  // lives only in updateAgentAction (detail-page save upgrades by job id).
  assert.ok(source.includes("generation_job_id = NULL"));
  assert.ok(source.includes("NOT EXISTS"));
  assert.ok(source.includes("IN ('queued', 'running')"));
  assert.ok(source.includes("updateAgentAction"));
  // Single upgrade path: exactly one by-job-id upgrade lookup (update's), so
  // a stale ?job= save through create cannot twin rows via a second path.
  assert.equal(
    source.split("eq(agents.generationJobId, opts.generationJobId)").length - 1,
    1,
  );
  const createFn = source.slice(
    source.indexOf("export async function createAgentAction"),
    source.indexOf("export async function ensureGenerationPlaceholderAction"),
  );
  assert.ok(
    !createFn.includes("eq(agents.generationJobId"),
    "create must not look up placeholders by job id",
  );
  assert.ok(
    !createFn.includes("generationJobId: null"),
    "create must not clear job ids",
  );
  // Lost-update races report not-found instead of throwing on row[0].
  const updateFn = source.slice(
    source.indexOf("export async function updateAgentAction"),
  );
  assert.ok(updateFn.includes("upgraded.length === 0"));
  assert.ok(updateFn.includes("updated.length === 0"));
  assert.ok(updateFn.includes("Agent not found"));
  assert.ok(source.includes("deleteAgentAction"));
  assert.ok(source.includes("delete(backgroundJobs)"));
  assert.ok(source.includes("delete(agents)"));
});
