"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, backgroundJobs } from "@/lib/db/schema";
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
