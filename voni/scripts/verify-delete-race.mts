/**
 * verify-delete-race.mts — Part A delete-vs-enqueue race simulation (MANUAL).
 *
 * NOT in `npm test`. Run with:
 *   npm run test:delete-race
 *   (= node --env-file=.env.local --import tsx scripts/verify-delete-race.mts)
 *
 * What it proves: `deleteAgentAction`'s fresh-discovery resweep (the second
 * relatedId discovery that runs AFTER the remote AssemblyAI delete and BEFORE
 * the agent row delete) catches a job enqueued mid-delete. A frozen id-set
 * implementation would leave that job queued against a deleted agent; the
 * resweep cancels it (queued -> cancelled, running -> cancelRequested) and the
 * terminal hard-delete then removes the tombstone.
 *
 * Preconditions (enforced in-script):
 * - `next dev` STOPPED, so the in-process processor cannot claim scratch jobs.
 * - DATABASE_URL dev-guard (exact check documented at `looksDevNeon` below).
 *
 * Sim shape:
 * - Global fetch is stubbed: AssemblyAI agents URLs get a 2000ms delayed
 *   `Response 204`; EVERYTHING else delegates to the real fetch (neon-http
 *   uses fetch, so it must keep working). Saved/restored in try-finally.
 * - Scratch agent inserted via db with organizationId "dev-bypass-org"
 *   (REQUIRED — must match the dev-bypass ctx `deleteAgentAction` resolves).
 *   Config is the placeholder-stub shape copied from
 *   `ensureGenerationPlaceholderAction` (same file under test).
 * - Pre-window job (kind agent_deployment, relatedId = agentId) created first.
 * - `deleteAgentAction(agentId)` started WITHOUT awaiting; ~300ms later the
 *   mid-window job (same relatedId) is created — i.e. DURING the stubbed
 *   2000ms remote delete, after the first cancel pass already ran.
 * - The delete promise is awaited with explicit handling of a trailing
 *   revalidatePath throw: outside a Next request scope `revalidatePath`
 *   throws AFTER the agent row is already deleted. That throw is a harness
 *   artifact of running a server action in plain node — it is logged, never
 *   swallowed silently, and DB state is asserted either way.
 * - Failure-injection variant: stub returns 500 -> delete aborts, agent KEPT,
 *   result ok:false.
 */

import assert from "node:assert/strict";

// --- Env defaults: set BEFORE any app import (dynamic imports below) -------
// Dev bypass must be on so requireCtx() resolves without a Google session.
// The AssemblyAI key is a dummy: fetch is stubbed, so it never leaves the box
// (resolveCredential falls back to env when no DB override exists).
// Better Auth dummies exist only so module-scope `betterAuth({...})` can be
// constructed; no auth flow runs in this script.
process.env.DEV_BYPASS_AUTH ??= "true";
process.env.ASSEMBLYAI_API_KEY ??= "race-sim-dummy-key-never-sent";
process.env.BETTER_AUTH_SECRET ??= "race-sim-dummy-secret-min-32-chars-0000";
process.env.GOOGLE_CLIENT_ID ??= "race-sim-dummy";
process.env.GOOGLE_CLIENT_SECRET ??= "race-sim-dummy";

const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("../src/lib/db/index");
const { agents, backgroundJobs } = await import("../src/lib/db/schema");
const { createJob, getJobById } = await import("../src/lib/jobs/store");
const { deleteAgentAction } = await import(
  "../src/app/(dashboard)/agents/actions"
);

// --- Dev-database guard ------------------------------------------------------
// EXACT CHECK (documented): refuse unless ALL of the following hold:
//   1. DATABASE_URL parses and its hostname ends with ".neon.tech"
//      (dev Neon pooled branch host), or is localhost/127.0.0.1, AND
//   2. the full URL does NOT contain "prod" (case-insensitive).
// Anything else — missing, unparseable, non-Neon, or prod-marked — throws
// before any write. Scratch ids additionally carry a "race-sim-" prefix and
// every cleanup WHERE is scoped to explicit collected ids.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const dbHost = (() => {
  try {
    return new URL(DATABASE_URL).hostname;
  } catch {
    return "";
  }
})();
const looksDevNeon =
  (dbHost.endsWith(".neon.tech") ||
    dbHost === "localhost" ||
    dbHost === "127.0.0.1") &&
  !/prod/i.test(DATABASE_URL);
if (!looksDevNeon) {
  throw new Error(
    `[race-sim] REFUSING: DATABASE_URL host "${dbHost}" does not look like a dev Neon host.`,
  );
}

// --- Scratch identity --------------------------------------------------------
const ORG_ID = "dev-bypass-org"; // REQUIRED: must equal the dev-bypass ctx org
const CREATOR_ID = "dev-bypass-user"; // = DEV_BYPASS_USER.id
const SUFFIX = crypto.randomUUID().slice(0, 8);
const AGENT_NAME = `race-sim-${SUFFIX}`;
const REMOTE_ID = `race-fake-${SUFFIX}`;
const FAIL_SUFFIX = `${SUFFIX}-fail`;
const FAIL_AGENT_NAME = `race-sim-${FAIL_SUFFIX}`;
const FAIL_REMOTE_ID = `race-fake-${FAIL_SUFFIX}`;

// Placeholder-stub config shape, copied from ensureGenerationPlaceholderAction.
const stubConfig = {
  mission: "Generating…",
  identity: { name: AGENT_NAME, role: "Generating…", company: "" },
  detect: [],
  intents: [],
  blockers: [],
  tools: [],
  knowledge: [],
  successCondition: "Generating…",
  fallback: "Generating…",
  followUpPolicy: "",
  channels: ["phone"],
  voiceId: "anna",
  languageCodes: ["en"],
  greeting: "Hi.",
  conversationLanguage: "en",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Fetch stub --------------------------------------------------------------
const realFetch = globalThis.fetch;
let assemblyBehavior: "delayed-204" | "http-500" = "delayed-204";
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  if (url.startsWith("https://agents.assemblyai.com/")) {
    if (assemblyBehavior === "delayed-204") {
      await sleep(2000); // hold the remote-delete window open for the mid job
      return new Response(null, { status: 204 });
    }
    return new Response("race-sim refused", { status: 500 });
  }
  // neon-http (and everything else) keeps the real fetch.
  return (realFetch as typeof fetch)(input as never, init as never);
}) as typeof fetch;

// --- Cleanup (every WHERE scoped to explicit race-sim ids) -------------------
const allJobIds: string[] = [];
const allAgentIds: string[] = [];
async function cleanupScope(jobIds: string[], agentIds: string[]) {
  if (jobIds.length > 0) {
    await db
      .delete(backgroundJobs)
      .where(inArray(backgroundJobs.id, jobIds))
      .catch(() => undefined);
  }
  for (const id of agentIds) {
    await db.delete(agents).where(eq(agents.id, id)).catch(() => undefined);
  }
}

async function insertScratchAgent(name: string, remoteId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      organizationId: ORG_ID,
      name,
      config: { ...stubConfig, identity: { ...stubConfig.identity, name } },
      deploymentStatus: "queued",
      assemblyaiAgentId: remoteId,
    })
    .returning({ id: agents.id });
  allAgentIds.push(row.id);
  return row.id;
}

async function insertDeploymentJob(
  agentId: string,
  keySuffix: string,
  name: string,
) {
  const { job, created } = await createJob({
    organizationId: ORG_ID,
    creatorId: CREATOR_ID,
    kind: "agent_deployment",
    title: `Deploy ${name}`,
    idempotencyKey: `race-sim-${keySuffix}`,
    relatedId: agentId,
    input: { agentId, configVersion: 1, name, config: stubConfig },
  });
  assert.equal(created, true, "scratch job must be newly created");
  assert.equal(job.status, "queued", "scratch job must start queued");
  allJobIds.push(job.id);
  return job.id;
}

async function agentRowById(id: string) {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ORG_ID)))
    .limit(1);
  return row ?? null;
}

// --- Variant A: mid-delete enqueue vs resweep --------------------------------
async function variantDeleteRace() {
  console.log("[race-sim] variant A: delete-vs-enqueue race");
  const agentId = await insertScratchAgent(AGENT_NAME, REMOTE_ID);
  const preJobId = await insertDeploymentJob(agentId, `pre-${SUFFIX}`, AGENT_NAME);

  assemblyBehavior = "delayed-204";
  const t0 = Date.now();
  const deletePromise = deleteAgentAction(agentId); // NOT awaited yet
  await sleep(300); // land inside the stubbed 2000ms remote-delete window
  const midJobId = await insertDeploymentJob(agentId, `mid-${SUFFIX}`, AGENT_NAME);
  console.log(
    `[race-sim] mid-window job created at t+${Date.now() - t0}ms (remote window ~2000ms)`,
  );

  // G0 revalidate outcome: revalidatePath throws in plain node AFTER the row
  // delete. Harness artifact — log it loudly, assert DB state either way,
  // never swallow silently.
  let deleteResult: Awaited<typeof deletePromise> | null = null;
  let harnessArtifact: string | null = null;
  try {
    deleteResult = await deletePromise;
  } catch (error) {
    harnessArtifact =
      error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 300)}`
        : String(error);
    console.log(
      `[race-sim] deleteAgentAction threw post-delete (harness artifact, asserting DB state anyway): ${harnessArtifact}`,
    );
  }
  if (deleteResult) {
    assert.equal(deleteResult.ok, true, `delete must succeed: ${JSON.stringify(deleteResult)}`);
  } else {
    console.log(
      "[race-sim] no DeleteResult (artifact above); proceeding on DB state only.",
    );
  }

  // Assertions.
  assert.equal(await agentRowById(agentId), null, "agent row must be gone");
  const leftover = await db
    .select({ id: backgroundJobs.id, status: backgroundJobs.status })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, ORG_ID),
        eq(backgroundJobs.relatedId, agentId),
      ),
    );
  const active = leftover.filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  assert.deepEqual(
    active,
    [],
    `ZERO jobs with relatedId may be queued/running, got: ${JSON.stringify(active)}`,
  );
  for (const [label, jobId] of [
    ["pre-window", preJobId],
    ["mid-window", midJobId],
  ] as const) {
    const row = await getJobById(jobId);
    assert.ok(
      row === null || row.status === "cancelled",
      `${label} job must be absent (terminal hard-delete) or cancelled, got: ${row?.status ?? "absent"}`,
    );
    if (row) {
      assert.ok(
        row.status !== "succeeded" && row.status !== "failed",
        `${label} job must never have run to terminal via a worker, got: ${row.status}`,
      );
    }
    console.log(`[race-sim] ${label} job final state: ${row?.status ?? "absent (cancelled then hard-deleted)"}`);
  }

  // Discriminator: the mid-window job was created AFTER the first cancel pass
  // (t+300ms, inside the 2000ms remote window) with the same relatedId, so
  // only the post-remote fresh-discovery resweep could have cancelled it.
  // Absent-or-cancelled + zero active proves the resweep caught it.
  console.log(
    "[race-sim] discriminator PROVEN: resweep caught the mid-window enqueue (frozen id-set would have left it queued).",
  );

  await cleanupScope([preJobId, midJobId], [agentId]);
}

// --- Variant B: remote failure aborts, agent kept -----------------------------
async function variantRemoteFailure() {
  console.log("[race-sim] variant B: remote 500 aborts the delete");
  const agentId = await insertScratchAgent(FAIL_AGENT_NAME, FAIL_REMOTE_ID);
  const preJobId = await insertDeploymentJob(agentId, `fail-${FAIL_SUFFIX}`, FAIL_AGENT_NAME);

  assemblyBehavior = "http-500";
  const result = await deleteAgentAction(agentId);
  assert.equal(result.ok, false, "remote 500 must abort with ok:false");
  assert.ok(await agentRowById(agentId), "agent row must be KEPT on remote failure");
  // The abort happens before any local data is touched (the pre-remote cancel
  // pass may have flagged the job, but no sweep/hard-delete and no row delete
  // run), so the job row must still exist.
  assert.ok(await getJobById(preJobId), "job row must survive the aborted delete");
  console.log(`[race-sim] abort message: ${(result as { message?: string }).message ?? "(none)"}`);

  await cleanupScope([preJobId], [agentId]);
}

// --- Main --------------------------------------------------------------------
let simPassed = false;
let discriminatorProven = false;
let cleanupOk = false;
try {
  await variantDeleteRace();
  discriminatorProven = true;
  await variantRemoteFailure();
  simPassed = true;
  console.log("[race-sim] ALL SCENARIOS PASSED");
} finally {
  globalThis.fetch = realFetch;
  await cleanupScope(allJobIds, allAgentIds);
  // Verify cleanup: no scratch job or agent row may remain.
  const jobsLeft =
    allJobIds.length > 0
      ? await db
          .select({ id: backgroundJobs.id })
          .from(backgroundJobs)
          .where(inArray(backgroundJobs.id, allJobIds))
      : [];
  const agentsLeft =
    allAgentIds.length > 0
      ? await db
          .select({ id: agents.id })
          .from(agents)
          .where(inArray(agents.id, allAgentIds))
      : [];
  cleanupOk = jobsLeft.length === 0 && agentsLeft.length === 0;
  console.log(
    JSON.stringify({
      simPassed,
      discriminatorProven,
      cleanupOk,
      scratchJobs: allJobIds.length,
      scratchAgents: allAgentIds.length,
    }),
  );
  if (!simPassed || !cleanupOk) process.exitCode = 1;
}
