"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  backgroundJobs,
  calls,
  campaigns,
  phoneNumbers,
  platformConfiguration,
} from "@/lib/db/schema";
import { deleteRemoteAgent } from "@/lib/agents/provision";
import { requireCtx, requireCtxOrRedirect, type Ctx } from "@/lib/session";
import {
  agentConfigSchema,
  normalizeConfig,
  REAL_ESTATE_TEMPLATE,
  type AgentConfig,
} from "@/lib/agents/config";
import {
  CONVERSATION_LANGUAGES,
  type ConversationLanguage,
} from "@/lib/agents/wizard";
import { JobStartError, startJob } from "@/lib/jobs/start";

/**
 * Server actions for the agent compiler (plan Day 3-4).
 *
 * Saves are local-first and fast: the reviewed configuration is written and
 * an agent_deployment job is enqueued, and the caller navigates to the agent
 * page immediately. The previous deployed version keeps serving calls until
 * the new deployment succeeds. Generation runs as an agent_generation job
 * started from /api/jobs (see the new-agent page).
 */

export type SaveResult =
  | {
      ok: true;
      id: string;
      deployment: "ready" | "attention" | "queued";
      jobId?: string;
      deploymentMessage?: string;
    }
  | { ok: false; message: string };

async function enqueueDeployment(
  ctx: Ctx,
  id: string,
  name: string,
  config: AgentConfig,
  configVersion: number,
): Promise<Extract<SaveResult, { ok: true }>> {
  try {
    const { job } = await startJob(
      ctx,
      "agent_deployment",
      { agentId: id, configVersion, name, config },
      { title: `Deploy ${name}`, relatedId: id },
    );
    return { ok: true, id, deployment: "queued", jobId: job.id };
  } catch (error) {
    return {
      ok: true,
      id,
      deployment: "attention",
      deploymentMessage:
        error instanceof JobStartError
          ? error.message
          : "Voice deployment could not be queued. Retry from the agent page.",
    };
  }
}

/** Persist a reviewed config as a new Agent, then enqueue its deployment. */
export async function createAgentAction(
  name: string,
  rawConfig: unknown,
  opts?: { generationJobId?: string },
): Promise<SaveResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to save this agent." };
  }

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the agent a name." };

  const parsed = agentConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Configuration is incomplete: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => i.path.join(".") || "config")
        .join(", ")}`,
    };
  }

  const config = normalizeConfig(parsed.data);

  // Saving over a generation placeholder upgrades it in place instead of
  // leaving a twin row behind. Lookup is by job id (not component state) so
  // ?job= restores and deduped resubmits upgrade the same row.
  if (opts?.generationJobId) {
    const [placeholder] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, ctx.organizationId),
          eq(agents.generationJobId, opts.generationJobId),
          eq(agents.deploymentStatus, "draft"),
        ),
      )
      .limit(1);
    if (placeholder) {
      const updated = await db
        .update(agents)
        .set({
          name: trimmed,
          config,
          generationJobId: null,
          deploymentStatus: "queued",
          configVersion: sql`${agents.configVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agents.id, placeholder.id),
            eq(agents.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: agents.id, configVersion: agents.configVersion });
      const result = await enqueueDeployment(
        ctx,
        updated[0].id,
        trimmed,
        config,
        updated[0].configVersion,
      );
      revalidatePath("/agents");
      revalidatePath(`/agents/${updated[0].id}`);
      return result;
    }
  }

  const [row] = await db
    .insert(agents)
    .values({
      organizationId: ctx.organizationId,
      name: trimmed,
      config,
      deploymentStatus: "queued",
    })
    .returning({ id: agents.id, configVersion: agents.configVersion });

  const result = await enqueueDeployment(ctx, row.id, trimmed, config, row.configVersion);
  revalidatePath("/agents");
  revalidatePath(`/agents/${row.id}`);
  return result;
}

/**
 * Best-effort list row for a generation in flight: /agents/new creates it at
 * Generate time so the list shows the draft while it generates. Idempotent
 * per job id — deduped resubmits find the existing row. Never deployed from
 * here: the config is a stub until the reviewed save upgrades it.
 */
export async function ensureGenerationPlaceholderAction(input: {
  jobId: string;
  name: string;
  voiceId: string;
  languageCode: string;
  goals?: string[];
  tasks?: string[];
  styleTraits?: string[];
}): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to save this agent." };
  }
  if (!input.jobId) return { ok: false, message: "Missing job id." };
  const trimmed = input.name.trim().slice(0, 120) || "Untitled agent";

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, ctx.organizationId),
        eq(agents.generationJobId, input.jobId),
      ),
    )
    .limit(1);
  if (existing) return { ok: true, id: existing.id };

  // A retry supersedes earlier attempts: demote placeholders whose jobs are
  // terminal (or gone) to plain drafts so failed rows don't twin the new one.
  // Placeholders with still-active jobs keep their badges.
  await db.execute(sql`UPDATE ${agents} SET generation_job_id = NULL, updated_at = NOW()
    WHERE organization_id = ${ctx.organizationId}
    AND deployment_status = 'draft'
    AND generation_job_id IS NOT NULL
    AND generation_job_id <> ${input.jobId}
    AND NOT EXISTS (SELECT 1 FROM ${backgroundJobs}
      WHERE ${backgroundJobs.id}::text = ${agents.generationJobId}
      AND ${backgroundJobs.status} IN ('queued', 'running'))`);

  const stub: AgentConfig = {
    mission: "Generating…",
    identity: { name: trimmed, role: "Generating…", company: "" },
    detect: [],
    intents: [],
    blockers: [],
    tools: [],
    knowledge: [],
    successCondition: "Generating…",
    fallback: "Generating…",
    followUpPolicy: "",
    channels: ["phone"],
    voiceId: input.voiceId,
    languageCodes: [input.languageCode],
    greeting: "Hi.",
    goals: input.goals?.slice(0, 3),
    tasks: input.tasks?.slice(0, 12),
    styleTraits: input.styleTraits?.slice(0, 5),
    conversationLanguage: (
      CONVERSATION_LANGUAGES as readonly string[]
    ).includes(input.languageCode)
      ? (input.languageCode as ConversationLanguage)
      : "en",
  };
  const [row] = await db
    .insert(agents)
    .values({
      organizationId: ctx.organizationId,
      name: trimmed,
      config: stub,
      deploymentStatus: "draft",
      generationJobId: input.jobId,
    })
    .returning({ id: agents.id });
  revalidatePath("/agents");
  return { ok: true, id: row.id };
}

export type GenerationPlaceholder = {
  name: string;
  voiceId: string;
  languageCode: string;
  conversationLanguage: ConversationLanguage;
  goals: string[];
  tasks: string[];
  styleTraits: string[];
};

/**
 * Wizard state snapshot for a ?job= return: what the user submitted, so the
 * review screen keeps their name, voice, and language after navigating away.
 * Null when there is no placeholder (older jobs, direct links).
 */
export async function getGenerationPlaceholderAction(
  jobId: string,
): Promise<GenerationPlaceholder | null> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return null;
  }
  if (!jobId) return null;
  const [row] = await db
    .select({ name: agents.name, config: agents.config })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, ctx.organizationId),
        eq(agents.generationJobId, jobId),
        eq(agents.deploymentStatus, "draft"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const config = row.config as Partial<AgentConfig> & {
    languageCodes?: unknown;
  };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const languageCode =
    Array.isArray(config.languageCodes) && typeof config.languageCodes[0] === "string"
      ? (config.languageCodes[0] as string)
      : "en";
  return {
    name: row.name,
    voiceId: typeof config.voiceId === "string" ? config.voiceId : "anna",
    languageCode,
    conversationLanguage: (
      CONVERSATION_LANGUAGES as readonly string[]
    ).includes(languageCode)
      ? (languageCode as ConversationLanguage)
      : "en",
    goals: strings(config.goals).slice(0, 3),
    tasks: strings(config.tasks).slice(0, 12),
    styleTraits: strings(config.styleTraits).slice(0, 5),
  };
}

export async function updateAgentAction(
  id: string,
  name: string,
  rawConfig: unknown,
): Promise<SaveResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to save this agent." };
  }

  const parsed = agentConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return { ok: false, message: "Configuration is incomplete." };
  }

  const config = normalizeConfig(parsed.data);
  // The version bump and the deployment job are one logical save: the job
  // carries the version it was created for, and the processor refuses to
  // publish anything older than the row's current version.
  const updated = await db
    .update(agents)
    .set({
      name: name.trim(),
      config,
      configVersion: sql`${agents.configVersion} + 1`,
      updatedAt: new Date(),
    })
    // org_id in the WHERE, not just the id: without it any signed-in user
    // could edit another org's agent by guessing a uuid.
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)))
    .returning({ id: agents.id, configVersion: agents.configVersion });

  if (updated.length === 0) return { ok: false, message: "Agent not found." };

  const result = await enqueueDeployment(
    ctx,
    id,
    name.trim(),
    config,
    updated[0].configVersion,
  );
  revalidatePath("/agents");
  revalidatePath(`/agents/${id}`);
  return result;
}

/** Queue a fresh deployment job for the agent's current saved version. */
export async function retryAgentDeploymentAction(id: string): Promise<SaveResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to deploy this agent." };
  }
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)))
    .limit(1);
  if (!agent) return { ok: false, message: "Agent not found." };
  const parsed = agentConfigSchema.safeParse(agent.config);
  if (!parsed.success) return { ok: false, message: "Configuration is incomplete." };
  const result = await enqueueDeployment(
    ctx,
    agent.id,
    agent.name,
    normalizeConfig(parsed.data),
    agent.configVersion,
  );
  revalidatePath(`/agents/${id}`);
  return result;
}

export type DeleteResult = { ok: true } | { ok: false; message: string };

/**
 * Delete an agent and clean up everything it leaves behind, in this order:
 *
 *   1. Refuse when a campaign references the agent (campaigns.agent_id is NOT
 *      NULL with no cascade — deleting the row would fail or strand work).
 *   2. Cancel in-flight generation/deployment jobs first, so workers converge
 *      instead of failing on a row that disappears mid-run.
 *   3. Delete the remote AssemblyAI stored agent (DELETE /v1/agents/{id} ->
 *      204; 404 means already gone and is fine). Any other remote failure
 *      aborts before local data is touched, so the delete is safe to retry.
 *   4. Null the nullable FKs (calls keep their history, numbers park
 *      unbound). The bridge default stays null-safe via onDelete: set null.
 *   5. Delete linked job rows (never by title — names are not unique), then
 *      the agent row itself.
 */
export async function deleteAgentAction(id: string): Promise<DeleteResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to delete this agent." };
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)))
    .limit(1);
  if (!agent) return { ok: false, message: "Agent not found." };

  // Campaigns require an agent — deleting one that owns a campaign is out of
  // scope, so refuse with the reason rather than stranding the campaign.
  const [camp] = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.agentId, id))
    .limit(1);
  if (camp) {
    return {
      ok: false,
      message: `${agent.name} is used by the campaign “${camp.name}”. Remove the campaign first, then delete the agent.`,
    };
  }

  // In-flight jobs reference the row (generation placeholder, deployment
  // lease, relatedId). Cancel queued/running ones so their processors see the
  // cancellation and converge instead of failing on a missing agent.
  const linkedJobs = await db
    .select({ id: backgroundJobs.id, status: backgroundJobs.status })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, ctx.organizationId),
        or(
          eq(backgroundJobs.relatedId, id),
          ...(agent.generationJobId
            ? [eq(backgroundJobs.id, agent.generationJobId)]
            : []),
        ),
      ),
    );
  for (const job of linkedJobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    if (job.status === "queued") {
      await db
        .update(backgroundJobs)
        .set({
          status: "cancelled",
          errorCode: "cancelled",
          errorMessage: "Cancelled: the agent was deleted.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(backgroundJobs.id, job.id), eq(backgroundJobs.status, "queued")),
        );
    } else {
      await db
        .update(backgroundJobs)
        .set({ cancelRequested: true, updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
    }
  }

  // Remote first: a failed remote delete keeps the local row so retry repairs
  // the state instead of orphaning a live AssemblyAI agent.
  if (agent.assemblyaiAgentId) {
    const remote = await deleteRemoteAgent(agent.assemblyaiAgentId);
    if (!remote.ok) {
      if (remote.reason === "missing-key") {
        console.warn(
          `[agent-delete] AssemblyAI key missing — deleting local agent ${id} only.`,
        );
      } else {
        return {
          ok: false,
          message:
            remote.status === 401
              ? "AssemblyAI refused the delete (check the API key), so nothing was removed. Fix the key and try again."
              : "The voice agent could not be removed from AssemblyAI, so nothing was removed. Try again — the saved configuration is safe.",
        };
      }
    }
  }

  // Preserve call history and registered numbers; they just lose the binding.
  await db.update(calls).set({ agentId: null }).where(eq(calls.agentId, id));
  await db
    .update(phoneNumbers)
    .set({ agentId: null })
    .where(eq(phoneNumbers.agentId, id));

  // Warn-shaped, not blocking: platform_configuration.bridge_agent_id has
  // onDelete set null, so the DB clears it with the row — but the bridge then
  // has no agent and its config route reports it missing.
  const [bridge] = await db
    .select({ bridgeAgentId: platformConfiguration.bridgeAgentId })
    .from(platformConfiguration)
    .limit(1);
  const wasBridgeAgent = bridge?.bridgeAgentId === id;

  // Linked job rows by id (relatedId + generation placeholder). Never by
  // title — agent names are not unique, so a title match could erase another
  // agent's jobs.
  const jobIds = new Set(linkedJobs.map((job) => job.id));
  if (agent.generationJobId) jobIds.add(agent.generationJobId);
  for (const jobId of jobIds) {
    await db
      .delete(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(backgroundJobs.organizationId, ctx.organizationId),
        ),
      );
  }

  await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)));

  revalidatePath("/agents");
  revalidatePath(`/agents/${id}`);

  if (wasBridgeAgent) {
    console.warn(
      `[agent-delete] deleted agent ${id} was the bridge default — Settings → Platform needs a new bridge agent.`,
    );
  }
  return { ok: true };
}

export async function listAgents() {
  const ctx = await requireCtxOrRedirect();
  return db
    .select()
    .from(agents)
    .where(eq(agents.organizationId, ctx.organizationId))
    .orderBy(desc(agents.updatedAt));
}

export type AgentListRow = Awaited<ReturnType<typeof listAgents>>[number] & {
  /** Live generation job status for placeholder rows; null otherwise (or when
   * the job aged out — abandoned placeholders read as plain drafts). */
  generationStatus: string | null;
};

/** List rows plus live generation state for placeholder badges/links. */
export async function listAgentsWithGeneration(): Promise<AgentListRow[]> {
  const ctx = await requireCtxOrRedirect();
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.organizationId, ctx.organizationId))
    .orderBy(desc(agents.updatedAt));
  const jobIds = rows
    .map((r) => r.generationJobId)
    .filter((id): id is string => id !== null);
  const statusByJob = new Map<string, string>();
  if (jobIds.length > 0) {
    const jobs = await db
      .select({ id: backgroundJobs.id, status: backgroundJobs.status })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.organizationId, ctx.organizationId),
          inArray(backgroundJobs.id, jobIds),
        ),
      );
    for (const job of jobs) statusByJob.set(job.id, job.status);
  }
  return rows.map((row) => ({
    ...row,
    generationStatus: row.generationJobId
      ? (statusByJob.get(row.generationJobId) ?? null)
      : null,
  }));
}

export async function getAgent(id: string) {
  const ctx = await requireCtxOrRedirect();
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The pre-built fallback, offered whenever generation is unavailable. */
export async function getTemplate(): Promise<AgentConfig> {
  return REAL_ESTATE_TEMPLATE;
}
