import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/index";
import { backgroundJobs } from "../src/lib/db/schema";
import {
  claimJob,
  completeJob,
  createJob,
  deleteTerminalJobsOlderThan,
  failJob,
  findAbandonedJobs,
  findActiveJobs,
  findMissedJobs,
  getJob,
  isCancelRequested,
  listJobs,
  markDismissed,
  markSeen,
  recoverAbandonedJob,
  requeueJob,
  requestCancel,
  retryJob,
} from "../src/lib/jobs/store";
import { isJobQueued, runJob } from "../src/lib/jobs/processor";
import { consumeMessage } from "../src/lib/jobs/consumer";
import { sweepJobs } from "../src/lib/jobs/sweep";

/**
 * Integration check for durable background jobs.
 *
 * Claim/complete/cancel/retry are all single-statement conditional updates
 * whose correctness decides whether duplicate queue deliveries double-run
 * work or creators see each other's jobs. So they run against the real
 * database, in a throwaway organization that is deleted in `finally`.
 */

const organizationId = `jobs-test-${crypto.randomUUID()}`;
const creatorId = `user-${crypto.randomUUID()}`;
const otherCreatorId = `user-${crypto.randomUUID()}`;

async function cleanup() {
  await db.delete(backgroundJobs).where(eq(backgroundJobs.organizationId, organizationId));
}

try {
  // Idempotent creation: the same key returns the same job, no duplicate.
  const first = await createJob({
    organizationId,
    creatorId,
    kind: "agent_generation",
    title: "Generate agent draft",
    idempotencyKey: "key-1",
    input: { brief: "Call new property leads every evening." },
  });
  assert.ok(first.created);
  const second = await createJob({
    organizationId,
    creatorId,
    kind: "agent_generation",
    title: "Generate agent draft",
    idempotencyKey: "key-1",
    input: { brief: "Call new property leads every evening." },
  });
  assert.ok(!second.created);
  assert.equal(second.job.id, first.job.id);

  // Creator isolation: another creator cannot read, list, or cancel it.
  assert.equal(await getJob(organizationId, otherCreatorId, first.job.id), null);
  assert.deepEqual(await listJobs(organizationId, otherCreatorId), []);
  const foreignCancel = await requestCancel(organizationId, otherCreatorId, first.job.id);
  assert.equal(foreignCancel, null);

  // Claiming is single-winner: the second claim (duplicate delivery) loses.
  const claimed = await claimJob(first.job.id, 60_000);
  assert.ok(claimed);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attemptCount, 1);
  assert.equal(await claimJob(first.job.id, 60_000), null);
  assert.ok(await isJobQueued(first.job.id) === false);

  // Cancel a running job flags it; the processor would observe the flag.
  await requestCancel(organizationId, creatorId, first.job.id);
  assert.ok(await isCancelRequested(first.job.id));

  // Terminal guards: completing a cancelled-via-flag job still requires the
  // running state, and failing a non-running job is a no-op.
  assert.ok(await completeJob(first.job.id, { ok: true }));
  assert.ok(!(await failJob(first.job.id, "unknown", "late failure")));

  // Retry resets a failed job to queued with cleared errors.
  const failed = await createJob({
    organizationId,
    creatorId,
    kind: "integration_test",
    title: "Test groq",
    idempotencyKey: "key-2",
    input: { service: "groq" },
  });
  await claimJob(failed.job.id, 60_000);
  await failJob(failed.job.id, "transport", "fetch failed");
  const retried = await retryJob(organizationId, creatorId, failed.job.id);
  assert.ok(retried);
  assert.equal(retried.status, "queued");
  assert.equal(retried.errorCode, null);
  assert.equal(retried.attemptCount, 1);

  // Queued cancellation is immediate and terminal.
  const queued = await createJob({
    organizationId,
    creatorId,
    kind: "integration_test",
    title: "Test telnyx",
    idempotencyKey: "key-3",
    input: { service: "telnyx" },
  });
  const cancelled = await requestCancel(organizationId, creatorId, queued.job.id);
  assert.equal(cancelled?.status, "cancelled");

  // runJob on a cancelled job does nothing (duplicate delivery after cancel).
  await runJob(queued.job.id);
  assert.equal((await getJob(organizationId, creatorId, queued.job.id))?.status, "cancelled");

  // runJob rejects unknown input permanently without throwing.
  const badInput = await createJob({
    organizationId,
    creatorId,
    kind: "agent_generation",
    title: "bad",
    idempotencyKey: "key-4",
    input: {},
  });
  await runJob(badInput.job.id);
  const badRow = await getJob(organizationId, creatorId, badInput.job.id);
  assert.equal(badRow?.status, "failed");
  assert.equal(badRow?.errorCode, "invalid-input");

  // Seen/dismissed timestamps stick.
  await markSeen(organizationId, creatorId, badInput.job.id);
  await markDismissed(organizationId, creatorId, badInput.job.id);
  const seenRow = await getJob(organizationId, creatorId, badInput.job.id);
  assert.ok(seenRow?.seenAt);
  assert.ok(seenRow?.dismissedAt);
  assert.deepEqual(
    (await listJobs(organizationId, creatorId)).map((j) => j.id).includes(badInput.job.id),
    false,
  );

  // Active-job finder backs the duplicate-submission guards.
  const active = await findActiveJobs(organizationId, creatorId, "integration_test");
  assert.ok(active.some((j) => j.id === retried.id));

  // Missed messages: old queued jobs are direct recovery candidates.
  const missedInvalid = await createJob({
    organizationId,
    creatorId,
    kind: "agent_generation",
    title: "missed invalid",
    idempotencyKey: "key-missed-invalid",
    input: {},
  });
  await db
    .update(backgroundJobs)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(backgroundJobs.id, missedInvalid.job.id));
  const missed = await findMissedJobs(45_000);
  assert.ok(missed.some((j) => j.id === missedInvalid.job.id));
  const swept = await sweepJobs();
  assert.ok(swept.started >= 1);
  assert.equal(
    (await getJob(organizationId, creatorId, missedInvalid.job.id))?.errorCode,
    "invalid-input",
  );

  // Abandoned leases: takeover is single-winner and exhausts with attempts.
  await claimJob(retried.id, 60_000);
  await db
    .update(backgroundJobs)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(backgroundJobs.id, retried.id));
  assert.ok((await findAbandonedJobs()).some((j) => j.id === retried.id));
  // attemptCount is 2 now (claim #1, retry reset kept it, claim #2), so the
  // abandoned attempt is already exhausted and recovery must not count twice.
  let outcome: string | null = null;
  outcome = await recoverAbandonedJob(retried.id, 60_000, 2);
  assert.equal(outcome, "exhausted");
  const exhausted = await getJob(organizationId, creatorId, retried.id);
  assert.equal(exhausted?.status, "failed");
  assert.equal(exhausted?.errorCode, "lease-exhausted");
  void outcome;

  // A recoverable abandonment requeues instead.
  const revivable = await createJob({
    organizationId,
    creatorId,
    kind: "integration_test",
    title: "revivable",
    idempotencyKey: "key-5",
    input: { service: "cartesia" },
  });
  await claimJob(revivable.job.id, 60_000);
  await db
    .update(backgroundJobs)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(backgroundJobs.id, revivable.job.id));
  assert.equal(await recoverAbandonedJob(revivable.job.id, 60_000, 5), "requeued");
  assert.equal((await getJob(organizationId, creatorId, revivable.job.id))?.status, "queued");

  // Retention deletes only old terminal jobs.
  await db
    .update(backgroundJobs)
    .set({ completedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    .where(eq(backgroundJobs.id, exhausted!.id));
  const deleted = await deleteTerminalJobsOlderThan(30 * 24 * 60 * 60 * 1000);
  assert.ok(deleted >= 1);
  assert.equal(await getJob(organizationId, creatorId, exhausted!.id), null);
  // The still-queued revivable job survives retention.
  assert.ok(await getJob(organizationId, creatorId, revivable.job.id));

  // Requeue helper flips running back to queued.
  await claimJob(revivable.job.id, 60_000);
  assert.ok(await requeueJob(revivable.job.id));
  assert.equal((await getJob(organizationId, creatorId, revivable.job.id))?.status, "queued");

  // Queue-consumer smoke test: malformed and duplicate messages ack without
  // work; a queued message with invalid input fails permanently, no throw.
  assert.equal(await consumeMessage(null), "ignored");
  assert.equal(await consumeMessage({ jobId: 42, kind: "agent_generation" }), "ignored");
  assert.equal(
    await consumeMessage({ jobId: exhausted!.id, kind: "integration_test" }),
    "ignored",
  );
  const smoke = await createJob({
    organizationId,
    creatorId,
    kind: "agent_generation",
    title: "smoke",
    idempotencyKey: "key-smoke",
    input: {},
  });
  assert.equal(
    await consumeMessage({ jobId: smoke.job.id, kind: "agent_generation" }),
    "processed",
  );
  const smoked = await getJob(organizationId, creatorId, smoke.job.id);
  assert.equal(smoked?.status, "failed");
  assert.equal(smoked?.errorCode, "invalid-input");

  console.log("verify-jobs: all scenarios passed");
} finally {
  await cleanup();
}
