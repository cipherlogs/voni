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
const deploymentSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "lib",
    "jobs",
    "processors",
    "deployment.ts",
  ),
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

test("delete keeps running job rows so workers see the cancel signal", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  // Hard-delete is terminal-only: queued/running rows (with cancelRequested
  // set above) survive so throwIfCancelled / isCancelRequested still fire.
  const cleanup = fn.slice(
    fn.indexOf("delete(backgroundJobs)"),
    fn.indexOf("resweepRows"),
  );
  assert.ok(cleanup.includes('"cancelled"'), "cancelled tombstones are deletable");
  assert.ok(cleanup.includes('"succeeded"'), "succeeded rows are deletable");
  assert.ok(cleanup.includes('"failed"'), "failed rows are deletable");
  assert.ok(
    !cleanup.includes('"running"') && !cleanup.includes('"queued"'),
    "running/queued rows must not be hard-deleted",
  );
});

test("delete catches a claim between select and queued-cancel", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  const cancel = fn.slice(fn.indexOf("cancelOneLinkedJob"));
  // The queued-cancel update is guarded on status='queued'; it must read back
  // affected rows (.returning) so a claimJob that flipped the row to running
  // is detected instead of silently escaping with no cancelRequested flag.
  assert.ok(
    cancel.includes(".returning("),
    "queued-cancel must check affected rows",
  );
  assert.ok(
    cancel.includes('"running"') && cancel.includes("cancelRequested"),
    "zero affected rows must fall back to flagging the now-running row",
  );
});

test("delete re-discovers linked jobs by relatedId before removing the agent row", () => {
  const fn = source.slice(source.indexOf("export async function deleteAgentAction"));
  // The remote delete can take seconds — a worker can claim a still-queued
  // job during it, or a concurrent save/retry can enqueue a brand-new job
  // with relatedId == id while the agent row still exists. A fresh discovery
  // sweep (not the frozen pre-remote id set) must run after the remote call
  // and before the agent row disappears.
  const remoteIdx = fn.indexOf("deleteRemoteAgent(agent.assemblyaiAgentId)");
  const sweepIdx = fn.indexOf("freshRows");
  const agentDeleteIdx = fn.indexOf("delete(agents)");
  assert.ok(sweepIdx > remoteIdx, "sweep must run after the remote delete");
  assert.ok(sweepIdx < agentDeleteIdx, "sweep must run before the agent row is deleted");
  const sweep = fn.slice(sweepIdx, agentDeleteIdx);
  assert.ok(
    sweep.includes("eq(backgroundJobs.relatedId, id)"),
    "sweep must re-discover by relatedId, not the frozen id set",
  );
  assert.ok(
    sweep.includes("freshAgent"),
    "sweep must re-read generationJobId fresh",
  );
  assert.ok(sweep.includes('"queued"'), "sweep must re-cancel still-queued jobs");
  assert.ok(sweep.includes("cancelRequested"), "sweep must flag unflagged running jobs");
  // Terminal hard-delete runs over the union after the cancel pass — the old
  // frozen-inArray-only resweep shape is gone.
  const hardDeleteIdx = sweep.indexOf("delete(backgroundJobs)");
  const cancelIdx = sweep.indexOf("cancelOneLinkedJob");
  assert.ok(
    hardDeleteIdx > cancelIdx,
    "terminal hard-delete must run after the fresh cancel pass",
  );
});

test("deployment tears down a just-provisioned remote agent on mid-deploy cancel", () => {
  assert.ok(
    deploymentSource.includes("deleteRemoteAgent"),
    "deployment must import the remote teardown",
  );
  const afterProvision = deploymentSource.slice(
    deploymentSource.indexOf("provisionAgent(input.name"),
  );
  assert.ok(
    afterProvision.includes("isCancelRequested"),
    "cancel must be re-checked after provisionAgent returns",
  );
  assert.ok(
    afterProvision.indexOf("deleteRemoteAgent") <
      afterProvision.indexOf("new CancelledJobError"),
    "the orphaned remote agent is deleted before converging to cancelled",
  );
});
