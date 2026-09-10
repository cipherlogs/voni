"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { requireCtx, requireCtxOrRedirect, type Ctx } from "@/lib/session";
import {
  agentConfigSchema,
  normalizeConfig,
  REAL_ESTATE_TEMPLATE,
  type AgentConfig,
} from "@/lib/agents/config";
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
