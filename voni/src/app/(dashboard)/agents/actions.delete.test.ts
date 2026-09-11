import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Same approach as actions.placeholder.test.ts and wizard-timeline.test.tsx:
// the repo has no jsdom/component-render setup, so hygiene order and guard
// rails are asserted on the real server-action source text.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "actions.ts"),
  "utf8",
);

test("delete refuses when a campaign owns the agent", () => {
  assert.ok(source.includes("deleteAgentAction"));
  assert.ok(source.includes("campaigns.agentId"));
  assert.ok(source.includes("Remove the campaign first"));
});

test("delete cancels in-flight jobs before touching anything remote", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  assert.ok(fn.includes("cancelRequested"));
  assert.ok(fn.includes("relatedId"));
  assert.ok(fn.includes("generationJobId"));
  // Cancel-before-remote ordering: the job-cancel block precedes deleteRemoteAgent.
  assert.ok(
    fn.indexOf("cancelRequested") < fn.indexOf("deleteRemoteAgent"),
    "jobs must be cancelled before the remote delete",
  );
});

test("remote failure keeps the local row (retry-safe)", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  assert.ok(fn.includes("deleteRemoteAgent"));
  assert.ok(fn.includes("so nothing was removed"));
  assert.ok(fn.includes("401"));
});

test("local hygiene nulls FKs, never deletes history or numbers", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  assert.ok(fn.includes("update(calls)"));
  assert.ok(fn.includes("update(phoneNumbers)"));
  assert.ok(fn.includes("agentId: null"));
  assert.ok(!fn.includes("delete(calls)"), "call history must survive");
  assert.ok(!fn.includes("delete(phoneNumbers)"), "numbers park, not delete");
});

test("job cleanup is by id, never by title", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  assert.ok(fn.includes("delete(backgroundJobs)"));
  assert.ok(!fn.includes("ilike"), "title-ILIKE would erase other agents' jobs");
});

test("delete is org-scoped and revalidates both routes", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  assert.ok(fn.includes("eq(agents.organizationId, ctx.organizationId)"));
  assert.ok(fn.includes('revalidatePath("/agents")'));
  assert.ok(fn.includes("revalidatePath(`/agents/${id}`)"));
});
