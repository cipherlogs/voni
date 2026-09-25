import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { deleteRemoteAgent, deploymentFingerprint, provisionAgent } from "@/lib/agents/provision";
import { CancelledJobError, throwIfCancelled } from "../processor";
import { isCancelRequested, sanitizeJobError, type JobRow } from "../store";
import type { JobInput } from "../kinds";

/**
 * agent_deployment: publish a reviewed local config to AssemblyAI.
 *
 * The previous deployed version keeps serving calls until the new PUT
 * succeeds — the local `assemblyai_agent_id` is only overwritten on success.
 * The per-agent lease plus the config-version guard mean an older save can
 * never overwrite a newer configuration, and two deployment jobs for one
 * agent cannot publish concurrently.
 */
export async function runDeploymentJob(
  job: JobRow,
  input: JobInput<"agent_deployment">,
) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.organizationId, job.organizationId),
      ),
    )
    .limit(1);
  if (!agent) throw new Error("Agent not found.");
  if (agent.configVersion !== input.configVersion) {
    throw new Error(
      "A newer configuration was saved after this deployment was queued (stale version).",
    );
  }

  // Single-flight publish per agent: only an unheld lease at the expected
  // version can be taken.
  const [leased] = await db
    .update(agents)
    .set({
      deploymentLease: job.id,
      deploymentStatus: "deploying",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.configVersion, input.configVersion),
        isNull(agents.deploymentLease),
      ),
    )
    .returning({ id: agents.id });
  if (!leased) {
    const [current] = await db
      .select({
        lease: agents.deploymentLease,
        version: agents.configVersion,
      })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!current || current.version !== input.configVersion) {
      throw new Error(
        "A newer configuration was saved after this deployment was queued (stale version).",
      );
    }
    // Our own lease survived a crash and the sweeper requeued us: carry on.
    if (current.lease !== job.id) {
      throw new Error("Another deployment is already running for this agent.");
    }
    await db
      .update(agents)
      .set({ deploymentStatus: "deploying", updatedAt: new Date() })
      .where(eq(agents.id, input.agentId));
  }

  const releaseLease = async (patch: Partial<typeof agents.$inferInsert>) => {
    await db
      .update(agents)
      .set({ ...patch, deploymentLease: null, updatedAt: new Date() })
      .where(and(eq(agents.id, input.agentId), eq(agents.deploymentLease, job.id)));
  };

  try {
    await throwIfCancelled(job.id);
    const deployed = await provisionAgent(input.name, input.config, agent.assemblyaiAgentId);
    if (!deployed.ok) throw new Error(deployed.error);
    // A delete during provision would be orphaned: the row is already gone,
    // so throwIfCancelled's CancelledJobError path just releases the lease and
    // propagates — the just-provisioned remote agent would keep serving with
    // no local owner. Tear it down before converging to cancelled.
    if (await isCancelRequested(job.id)) {
      await deleteRemoteAgent(deployed.agentId).catch(() => undefined);
      throw new CancelledJobError();
    }
    const deployedAt = new Date();
    await releaseLease({
      assemblyaiAgentId: deployed.agentId,
      deploymentStatus: "ready",
      deploymentError: null,
      lastDeployedAt: deployedAt,
      // What the remote now runs, byte-for-byte. The platform-refresh
      // check recomputes this locally: a mismatch (or a pre-fingerprint
      // null) means the platform moved under a deployed agent and it is
      // owed a redeploy — noticed with zero server round trips.
      deployedFingerprint: deploymentFingerprint(input.name, input.config),
    });
    return {
      agentId: input.agentId,
      remoteAgentId: deployed.agentId,
      deployedAt: deployedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof CancelledJobError) {
      // Leave the last live version exactly as it was.
      await releaseLease({
        deploymentStatus: agent.assemblyaiAgentId ? "ready" : "draft",
      });
      throw error;
    }
    await releaseLease({
      deploymentStatus: "failed",
      deploymentError: sanitizeJobError(error),
    });
    throw error;
  }
}
