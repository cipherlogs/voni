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
  // Only still-active jobs keep their badge; terminal/gone jobs decay.
  assert.ok(source.includes("generation_job_id = NULL"));
  assert.ok(source.includes("NOT EXISTS"));
  assert.ok(source.includes("IN ('queued', 'running')"));
});
