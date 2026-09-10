/**
 * One-off cleanup for the next-dev-loop test artifact ("Loop Test Agent").
 *
 * Removes, per matching agents row:
 *   1. The remote AssemblyAI voice agent (DELETE /v1/agents/{id} -> 204;
 *      404 means already gone and is fine).
 *   2. Nullable FK references (calls.agent_id, phone_numbers.agent_id -> NULL,
 *      matching the schema's park-don't-delete intent for numbers).
 *   3. Linked background jobs (relatedId = agent id, generationJobId, or the
 *      agent name in the title).
 *   4. The agents row itself.
 *
 * Refuses to run when a campaign references the agent (campaigns.agent_id is
 * NOT NULL with no cascade — deleting a campaign is out of scope).
 *
 * Run from voni/:
 *   node --env-file=.env.local --env-file-if-exists=.dev.vars \
 *     --import tsx scripts/cleanup-loop-test-agent.mts
 */
import { eq, ilike, or } from "drizzle-orm";
import { db } from "../src/lib/db/index";
import {
  agents,
  backgroundJobs,
  calls,
  campaigns,
  phoneNumbers,
} from "../src/lib/db/schema";
import { resolveCredential } from "../src/lib/platform/credentials";

const NAME = "Loop Test Agent";
const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

const rows = await db.select().from(agents).where(eq(agents.name, NAME));
if (rows.length === 0) {
  console.log(`No agents named "${NAME}" — nothing to do.`);
  process.exit(0);
}

for (const agent of rows) {
  console.log(
    `Agent ${agent.id} org=${agent.organizationId} remote=${agent.assemblyaiAgentId ?? "none"}`,
  );

  const [camp] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.agentId, agent.id))
    .limit(1);
  if (camp) {
    throw new Error(
      `Agent ${agent.id} owns campaign ${camp.id} — refusing to delete. Remove the campaign first.`,
    );
  }

  if (agent.assemblyaiAgentId) {
    const { value: apiKey } = await resolveCredential("assemblyai_api_key");
    if (!apiKey) {
      console.log("  AssemblyAI key missing — skipping remote delete.");
    } else {
      const res = await fetch(
        `${AGENTS_URL}/${encodeURIComponent(agent.assemblyaiAgentId)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
      );
      console.log(
        `  remote DELETE -> ${res.status}${res.status === 404 ? " (already gone)" : ""}`,
      );
      if (![200, 204, 404].includes(res.status)) {
        throw new Error(
          `Remote delete failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
    }
  }

  await db.update(calls).set({ agentId: null }).where(eq(calls.agentId, agent.id));
  await db
    .update(phoneNumbers)
    .set({ agentId: null })
    .where(eq(phoneNumbers.agentId, agent.id));

  const jobIds = new Set<string>();
  if (agent.generationJobId) jobIds.add(agent.generationJobId);
  const linked = await db
    .select({ id: backgroundJobs.id, title: backgroundJobs.title })
    .from(backgroundJobs)
    .where(
      or(eq(backgroundJobs.relatedId, agent.id), ilike(backgroundJobs.title, `%${NAME}%`)),
    );
  for (const job of linked) jobIds.add(job.id);
  for (const jobId of jobIds) {
    await db.delete(backgroundJobs).where(eq(backgroundJobs.id, jobId));
    console.log(`  deleted job ${jobId}`);
  }

  await db.delete(agents).where(eq(agents.id, agent.id));
  console.log(`  deleted agent ${agent.id}`);
}

console.log("done");
