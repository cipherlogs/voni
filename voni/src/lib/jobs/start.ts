import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, backgroundJobs, campaigns } from "@/lib/db/schema";
import type { Ctx } from "@/lib/session";
import {
  JOB_INPUT_SCHEMAS,
  targetUrlFor,
  type JobKind,
} from "./kinds";
import { enqueueJobMessage } from "./queue";
import type { DispatchResult } from "./contracts";
import {
  createJob,
  findActiveJobs,
  findGenerationPlaceholderId,
  getJobByIdempotencyKey,
  type JobRow,
} from "./store";

export class JobStartError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "JobStartError";
    this.status = status;
  }
}

export type StartJobOptions = {
  title?: string;
  /** Client-generated; resubmitting the same key returns the existing job. */
  idempotencyKey?: string;
  relatedId?: string;
};

export type StartedJob = {
  job: JobRow;
  created: boolean;
  dispatch: DispatchResult | null;
};

function defaultTitle(kind: JobKind, input: Record<string, unknown>): string {
  switch (kind) {
    case "record_search":
      return `Search ${input.kind}: ${input.query}`;
    case "agent_generation":
      return "Generate agent draft";
    case "agent_deployment":
      return `Deploy ${(input.name as string) ?? "agent"}`;
    case "integration_test":
      return `Test ${(input.service as string) ?? "connection"}`;
    case "lead_csv_import":
      return `Import ${(input.fileName as string) ?? "CSV"}`;
  }
}

/**
 * Validate, authorize, persist, and enqueue one job. Shared by the
 * /api/jobs routes and the server actions that start work (agent saves),
 * so both paths enforce identical guards.
 *
 * Always resolves with the job — duplicates return the existing row rather
 * than starting new work. Callers send 202 Accepted immediately after this
 * returns; the queue consumer (or dev dispatcher) does the slow part.
 */
export async function startJob(
  ctx: Ctx,
  kind: JobKind,
  rawInput: unknown,
  options: StartJobOptions = {},
): Promise<StartedJob> {
  const schema = JOB_INPUT_SCHEMAS[kind];
  if (!schema) throw new JobStartError(`Unknown job kind: ${kind}.`);
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    throw new JobStartError(
      parsed.error.issues[0]?.message ?? "Invalid job input.",
    );
  }
  const input = parsed.data as Record<string, unknown>;

  if (kind === "agent_deployment") {
    const agentId = input.agentId as string;
    const [agent] = await db
      .select({ id: agents.id, configVersion: agents.configVersion })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!agent) throw new JobStartError("Agent not found.", 404);
    if (agent.configVersion !== (input.configVersion as number)) {
      throw new JobStartError(
        "A newer configuration was saved. Refresh and save again.",
        409,
      );
    }
    // An older save must not queue behind (or beside) a newer deployment.
    const active = await findActiveJobs(
      ctx.organizationId,
      ctx.userId,
      "agent_deployment",
    );
    const duplicate = active.find(
      (j) =>
        (j.input as { agentId?: string; configVersion?: number }).agentId ===
          agentId &&
        (j.input as { configVersion?: number }).configVersion ===
          input.configVersion,
    );
    if (duplicate) return { job: duplicate, created: false, dispatch: null };
    await db
      .update(agents)
      .set({
        deploymentStatus: "queued",
        deploymentError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, ctx.organizationId)));
  }

  if (kind === "integration_test") {
    // One active test per user + service + credential: a second click while
    // the first is still running returns the running test.
    const active = await findActiveJobs(
      ctx.organizationId,
      ctx.userId,
      "integration_test",
    );
    const duplicate = active.find((j) => {
      const prev = j.input as { service?: string; accountId?: string };
      return (
        prev.service === (input.service as string) &&
        (prev.accountId ?? null) === ((input.accountId as string) ?? null)
      );
    });
    if (duplicate) return { job: duplicate, created: false, dispatch: null };
  }

  if (kind === "agent_generation") {
    // One active generation per creator: a second submit while the first is
    // still queued/running returns the running job. Same-brief resubmits are
    // already deduped by the stable idempotency key in createJob; this covers
    // a *different* brief submitted mid-flight. The wizard's "already running"
    // toast covers the UX.
    const active = await findActiveJobs(
      ctx.organizationId,
      ctx.userId,
      "agent_generation",
    );
    if (active.length > 0) {
      return { job: active[0], created: false, dispatch: null };
    }
    // Terminal rows never replay: when the incoming key maps to a finished
    // (succeeded/failed/cancelled) generation, drop the replay and fall
    // through to a fresh submission below. A retry is new work that starts
    // clean — replaying the terminal row would strand the caller watching a
    // job that can never transition again.
    const incomingKey = options.idempotencyKey?.trim();
    if (incomingKey) {
      const prior = await getJobByIdempotencyKey(
        ctx.organizationId,
        ctx.userId,
        incomingKey,
      ).catch(() => null);
      if (
        prior &&
        (prior.status === "succeeded" ||
          prior.status === "failed" ||
          prior.status === "cancelled")
      ) {
        options = { ...options, idempotencyKey: crypto.randomUUID() };
      }
    }
  }

  if (kind === "lead_csv_import") {    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, input.campaignId as string),
          eq(campaigns.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!campaign) throw new JobStartError("Campaign not found.", 404);
  }

  const idempotencyKey =
    options.idempotencyKey?.trim() || crypto.randomUUID();
  const { job, created } = await createJob({
    organizationId: ctx.organizationId,
    creatorId: ctx.userId,
    kind,
    title: options.title ?? defaultTitle(kind, input),
    idempotencyKey,
    relatedId: options.relatedId,
    input,
  });
  // created=false means a resubmission: the original is already queued or
  // running, so there is nothing new to enqueue.
  let dispatch: DispatchResult | null = null;
  if (created) {
    // Finished generation jobs land on the placeholder detail page. The
    // placeholder row may already exist (deduped resubmit restoring ?job=);
    // otherwise the ?job= URL stands until completion resolves it.
    let targetUrl = targetUrlFor(kind, job.id, input as never);
    if (kind === "agent_generation") {
      const placeholderId = await findGenerationPlaceholderId(job.id).catch(
        () => null,
      );
      if (placeholderId) targetUrl = `/agents/${placeholderId}`;
    }
    await db
      .update(backgroundJobs)
      .set({ targetUrl, updatedAt: new Date() })
      .where(eq(backgroundJobs.id, job.id));
    job.targetUrl = targetUrl;
    dispatch = await enqueueJobMessage({ jobId: job.id, kind });
  }
  return { job, created, dispatch };
}
