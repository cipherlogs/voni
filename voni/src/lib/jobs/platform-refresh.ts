import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import type { Ctx } from "@/lib/session";
import { agentConfigSchema, type AgentConfig } from "@/lib/agents/config";
import { deploymentFingerprint } from "@/lib/agents/provision";
import { startJob } from "./start";

/**
 * Platform refresh: heal dashboard agents the platform moved under.
 *
 * Every deployment publishes `deploymentFingerprint(name, config)`, which
 * covers everything platform-derived (toolset, prompt rules, STT tuning).
 * Recomputing it locally detects drift with zero AssemblyAI round trips:
 * a mismatch — or a pre-fingerprint null — means the server copy is stale
 * and the agent is owed a redeploy.
 *
 * Runs on dashboard visits (user ctx present, so the queued jobs are visible
 * to the operator who triggered them — never an invisible system job), never
 * on the live-call hot path. Repeats are safe no-ops: the idempotency key
 * (`deployment:<id>:v<version>`) and the active-job check dedupe, and healed
 * agents compare equal on the next visit.
 */

export type RefreshOutcome = {
  checked: number;
  healed: string[];
  skippedActive: string[];
};

export function isAgentStale(
  stored: string | null,
  name: string,
  config: AgentConfig,
): boolean {
  return stored !== deploymentFingerprint(name, config);
}

export async function healStaleDeployments(ctx: Ctx): Promise<RefreshOutcome> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      config: agents.config,
      configVersion: agents.configVersion,
      deployedFingerprint: agents.deployedFingerprint,
    })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, ctx.organizationId),
        isNotNull(agents.assemblyaiAgentId),
      ),
    )
    .limit(200);
  const outcome: RefreshOutcome = { checked: rows.length, healed: [], skippedActive: [] };
  for (const row of rows) {
    const parsed = agentConfigSchema.safeParse(row.config);
    if (!parsed.success) continue;
    if (!isAgentStale(row.deployedFingerprint, row.name, parsed.data)) continue;
    try {
      const started = await startJob(
        ctx,
        "agent_deployment",
        { agentId: row.id, configVersion: row.configVersion, name: row.name, config: parsed.data },
        {
          title: `Refresh ${row.name} to the latest platform`,
          relatedId: row.id,
          idempotencyKey: `deployment:${row.id}:v${row.configVersion}`,
        },
      );
      if (started.created) outcome.healed.push(row.id);
      else outcome.skippedActive.push(row.id);
    } catch {
      // A newer save racing us, or validation: the normal save flow owns
      // this agent now. Skip rather than fight it.
      outcome.skippedActive.push(row.id);
    }
  }
  return outcome;
}
