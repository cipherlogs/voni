import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backgroundJobs } from "@/lib/db/schema";
import type { JobErrorCode, JobKind } from "./kinds";

export type JobDb = typeof db;

export type JobRow = typeof backgroundJobs.$inferSelect;

export type CreateJobParams = {
  organizationId: string;
  creatorId: string;
  kind: JobKind;
  title: string;
  targetUrl?: string;
  idempotencyKey: string;
  relatedId?: string;
  input: unknown;
};

/**
 * Persistence for durable background jobs. Postgres is the source of truth;
 * every mutating transition is a single conditional statement so duplicate
 * queue deliveries and concurrent workers converge instead of corrupting.
 *
 * All functions accept an optional database handle so unit tests can inject a
 * fake; production call sites omit it.
 */

/** Insert, or return the existing row when the idempotency key repeats. */
export async function createJob(
  params: CreateJobParams,
  database: JobDb = db,
): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await database
    .insert(backgroundJobs)
    .values({
      organizationId: params.organizationId,
      creatorId: params.creatorId,
      kind: params.kind,
      title: params.title,
      targetUrl: params.targetUrl,
      idempotencyKey: params.idempotencyKey,
      relatedId: params.relatedId,
      input: params.input as Record<string, unknown>,
    })
    .onConflictDoNothing({
      target: [
        backgroundJobs.organizationId,
        backgroundJobs.creatorId,
        backgroundJobs.idempotencyKey,
      ],
    })
    .returning();
  if (inserted.length > 0) return { job: inserted[0], created: true };

  const [existing] = await database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, params.organizationId),
        eq(backgroundJobs.creatorId, params.creatorId),
        eq(backgroundJobs.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);
  // onConflictDoNothing only skips on the matching unique index, so the row
  // the conflict reported must be this lookup. Throw loudly if it is not —
  // silently returning someone else's job would leak across creators.
  if (!existing) throw new Error("Job insert was skipped but no job exists.");
  return { job: existing, created: false };
}

export async function getJob(
  organizationId: string,
  creatorId: string,
  id: string,
  database: JobDb = db,
): Promise<JobRow | null> {
  const [row] = await database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.id, id),
        eq(backgroundJobs.organizationId, organizationId),
        eq(backgroundJobs.creatorId, creatorId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getJobById(
  id: string,
  database: JobDb = db,
): Promise<JobRow | null> {
  const [row] = await database
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Creator-scoped idempotency lookup for voice reconciliation: after an
 * uncertain submission, adopt the existing row instead of duplicating work.
 * Scoped exactly like the insert conflict target (org + creator + key).
 */
export async function getJobByIdempotencyKey(
  organizationId: string,
  creatorId: string,
  key: string,
  database: JobDb = db,
): Promise<JobRow | null> {
  const [row] = await database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, organizationId),
        eq(backgroundJobs.creatorId, creatorId),
        eq(backgroundJobs.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Creator's jobs, newest first. Dismissed jobs stay out unless asked for. */
export async function listJobs(
  organizationId: string,
  creatorId: string,
  database: JobDb = db,
  options: { limit?: number; includeDismissed?: boolean } = {},
): Promise<JobRow[]> {
  const { limit = 50, includeDismissed = false } = options;
  return database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, organizationId),
        eq(backgroundJobs.creatorId, creatorId),
        includeDismissed ? undefined : isNull(backgroundJobs.dismissedAt),
      ),
    )
    .orderBy(desc(backgroundJobs.createdAt))
    .limit(limit);
}

/**
 * Claim a queued job for execution. The `status = 'queued'` predicate makes
 * this safe under duplicate queue delivery: only one worker wins, the rest
 * get null and ignore the message.
 */
export async function claimJob(
  id: string,
  leaseMs: number,
  database: JobDb = db,
): Promise<JobRow | null> {
  const now = new Date();
  const claimed = await database
    .update(backgroundJobs)
    .set({
      status: "running",
      startedAt: sql`COALESCE(${backgroundJobs.startedAt}, ${now})`,
      attemptCount: sql`${backgroundJobs.attemptCount} + 1`,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "queued")))
    .returning();
  return claimed[0] ?? null;
}

export async function heartbeatJob(
  id: string,
  leaseMs: number,
  database: JobDb = db,
  progress?: { stage?: string; progressTotal?: number; progressDone?: number },
): Promise<void> {
  const now = new Date();
  await database
    .update(backgroundJobs)
    .set({
      ...(progress?.stage !== undefined ? { stage: progress.stage } : {}),
      ...(progress?.progressTotal !== undefined
        ? { progressTotal: progress.progressTotal }
        : {}),
      ...(progress?.progressDone !== undefined
        ? { progressDone: progress.progressDone }
        : {}),
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "running")));
}

/** Record queue-dispatch state without adding a provider-specific DB field. */
export async function markQueuedStage(
  id: string,
  stage: "waiting-for-worker" | "recovery-started",
  database: JobDb = db,
): Promise<boolean> {
  const updated = await database
    .update(backgroundJobs)
    .set({ stage, updatedAt: new Date() })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "queued")))
    .returning({ id: backgroundJobs.id });
  return updated.length > 0;
}

/** Terminal success. Guarded on `running` so a duplicate delivery cannot
 * overwrite a job that was already retried, cancelled, or finished. */
export async function completeJob(
  id: string,
  result: unknown,
  database: JobDb = db,
  targetUrl?: string,
): Promise<boolean> {
  const now = new Date();
  const updated = await database
    .update(backgroundJobs)
    .set({
      status: "succeeded",
      result: result as Record<string, unknown>,
      ...(targetUrl !== undefined ? { targetUrl } : {}),
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "running")))
    .returning({ id: backgroundJobs.id });
  return updated.length > 0;
}

/** Terminal failure with a sanitized, user-safe message. Same guard. */
export async function failJob(
  id: string,
  code: JobErrorCode,
  message: string,
  database: JobDb = db,
): Promise<boolean> {
  const now = new Date();
  const updated = await database
    .update(backgroundJobs)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "running")))
    .returning({ id: backgroundJobs.id });
  return updated.length > 0;
}

/** Requeue a running job after a transient failure (attempt count kept). */
export async function requeueJob(id: string, database: JobDb = db): Promise<boolean> {
  const updated = await database
    .update(backgroundJobs)
    .set({
      status: "queued",
      leaseExpiresAt: null,
      cancelRequested: false,
      updatedAt: new Date(),
    })
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "running")))
    .returning({ id: backgroundJobs.id });
  return updated.length > 0;
}

/**
 * Cancel: queued work stops immediately; running work is flagged and the
 * processor checks between external attempts.
 */
export async function requestCancel(
  organizationId: string,
  creatorId: string,
  id: string,
  database: JobDb = db,
): Promise<JobRow | null> {
  const job = await getJob(organizationId, creatorId, id, database);
  if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
    return job;
  }
  const now = new Date();
  if (job.status === "queued") {
    const [updated] = await database
      .update(backgroundJobs)
      .set({
        status: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled before it started.",
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "queued")))
      .returning();
    return updated ?? job;
  }
  const [updated] = await database
    .update(backgroundJobs)
    .set({ cancelRequested: true, updatedAt: now })
    .where(eq(backgroundJobs.id, id))
    .returning();
  return updated ?? job;
}

/** Mark a running job cancelled once its processor observes the request. */
export async function markCancelled(id: string, database: JobDb = db): Promise<void> {
  const now = new Date();
  await database
    .update(backgroundJobs)
    .set({
      status: "cancelled",
      errorCode: "cancelled",
      errorMessage: "Cancelled.",
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(backgroundJobs.id, id));
}

/** Retry a failed or cancelled job: same row, fresh attempt, cleared errors. */
export async function retryJob(
  organizationId: string,
  creatorId: string,
  id: string,
  database: JobDb = db,
): Promise<JobRow | null> {
  const job = await getJob(organizationId, creatorId, id, database);
  if (!job || (job.status !== "failed" && job.status !== "cancelled")) return job;
  const [updated] = await database
    .update(backgroundJobs)
    .set({
      status: "queued",
      result: null,
      errorCode: null,
      errorMessage: null,
      stage: null,
      progressTotal: null,
      progressDone: null,
      cancelRequested: false,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(backgroundJobs.id, id))
    .returning();
  return updated ?? null;
}

export async function markSeen(
  organizationId: string,
  creatorId: string,
  id: string,
  database: JobDb = db,
): Promise<void> {
  const job = await getJob(organizationId, creatorId, id, database);
  if (!job || job.seenAt) return;
  await database
    .update(backgroundJobs)
    .set({ seenAt: new Date(), updatedAt: new Date() })
    .where(eq(backgroundJobs.id, id));
}

export async function markDismissed(
  organizationId: string,
  creatorId: string,
  id: string,
  database: JobDb = db,
): Promise<void> {
  const job = await getJob(organizationId, creatorId, id, database);
  if (!job || job.dismissedAt) return;
  const now = new Date();
  await database
    .update(backgroundJobs)
    .set({ dismissedAt: now, seenAt: job.seenAt ?? now, updatedAt: now })
    .where(eq(backgroundJobs.id, id));
}

export async function isCancelRequested(
  id: string,
  database: JobDb = db,
): Promise<boolean> {
  const [row] = await database
    .select({ cancelRequested: backgroundJobs.cancelRequested })
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, id))
    .limit(1);
  return row?.cancelRequested ?? false;
}

/** Active (queued or running) jobs of one kind for duplicate-submission guards. */
export async function findActiveJobs(
  organizationId: string,
  creatorId: string,
  kind: string,
  database: JobDb = db,
): Promise<JobRow[]> {
  return database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, organizationId),
        eq(backgroundJobs.creatorId, creatorId),
        eq(backgroundJobs.kind, kind),
        or(
          eq(backgroundJobs.status, "queued"),
          eq(backgroundJobs.status, "running"),
        ),
      ),
    )
    .orderBy(desc(backgroundJobs.createdAt));
}

/** Queued jobs that never got a queue message (or lost it) and are old enough
 * to be genuinely missed rather than just created. The scheduled worker
 * directly executes returned rows; claiming stays idempotent. */
export async function findMissedJobs(
  olderThanMs: number,
  database: JobDb = db,
  limit = 100,
): Promise<JobRow[]> {
  return database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.status, "queued"),
        lt(backgroundJobs.createdAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .orderBy(backgroundJobs.createdAt)
    .limit(limit);
}

/** Running jobs whose lease lapsed — the worker died mid-flight. */
export async function findAbandonedJobs(database: JobDb = db, limit = 100): Promise<JobRow[]> {
  return database
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.status, "running"),
        lt(backgroundJobs.leaseExpiresAt, new Date()),
      ),
    )
    .orderBy(backgroundJobs.leaseExpiresAt)
    .limit(limit);
}

/**
 * Take over one abandoned lease atomically (a second overlapping sweep gets
 * null). The failed claim already counted as an attempt; the next claim will
 * count the retry, so recovery must not increment twice.
 */
export async function recoverAbandonedJob(
  id: string,
  leaseMs: number,
  maxAttempts: number,
  database: JobDb = db,
): Promise<"requeued" | "exhausted" | null> {
  const now = new Date();
  const taken = await database
    .update(backgroundJobs)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(backgroundJobs.id, id),
        eq(backgroundJobs.status, "running"),
        lt(backgroundJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ attemptCount: backgroundJobs.attemptCount });
  if (!taken[0]) return null;
  if (taken[0].attemptCount >= maxAttempts) {
    await failJob(id, "lease-exhausted", "The job stalled and ran out of attempts.", database);
    return "exhausted";
  }
  await requeueJob(id, database);
  return "requeued";
}

/** Hard-delete terminal jobs past retention (30 days). Returns row count. */
export async function deleteTerminalJobsOlderThan(
  olderThanMs: number,
  database: JobDb = db,
): Promise<number> {
  const deleted = await database
    .delete(backgroundJobs)
    .where(
      and(
        or(
          eq(backgroundJobs.status, "succeeded"),
          eq(backgroundJobs.status, "failed"),
          eq(backgroundJobs.status, "cancelled"),
        ),
        lt(backgroundJobs.completedAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .returning({ id: backgroundJobs.id });
  return deleted.length;
}

/**
 * Strip anything that must never be stored or logged: API keys, bearer
 * tokens, CSV contents, provider response bodies, encrypted reasoning blobs.
 */
export function sanitizeJobError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  // Neon/database driver errors embed the full SQL statement and bound
  // params — schema details that are noise to an operator and must never
  // reach a failure banner. Collapse the whole blob to one sentence.
  if (/^\s*Failed query:/i.test(raw)) return "A database request failed.";
  return raw
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*['"]?)[^'"\s,}]+/gi, "$1[redacted]")
    .replace(
      /((?:\\?["'])?(?:(?:reasoning\.)?encrypted_content|encryptedContent)(?:\\?["'])?)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
