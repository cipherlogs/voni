import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { generateAgentConfig } from "@/lib/agents/generate";
import { normalizeConfig, type AgentConfig } from "@/lib/agents/config";
import { throwIfCancelled } from "../processor";
import type { JobInput } from "../kinds";
import type { JobRow } from "../store";

/**
 * agent_generation: NL brief -> validated config.
 *
 * Draft-first flow (input.agentId): the agent row already exists as a local
 * placeholder draft, so the result is written straight into it — the author
 * never waits on this page. The write is conditional on configVersion 1: if
 * the author saved edits mid-flight, their version wins and the result stays
 * on the job for an explicit "load generated values" choice instead of
 * silently clobbering newer work. Legacy brief-only jobs (no agentId) keep
 * the old behavior: result restores as an editable draft on /agents/new.
 */
export async function runGenerationJob(
  job: JobRow,
  input: JobInput<"agent_generation">,
) {
  await throwIfCancelled(job.id);
  // The provider chain makes several external attempts internally; the
  // cancel boundary available here is before and after the run.
  const generated = await generateAgentConfig(input.brief);
  await throwIfCancelled(job.id);

  let config: AgentConfig = generated.config;
  const draft = input.wizardDraft;
  if (draft) {
    // The wizard is the source of truth for voice + language + tags: the
    // generated draft's voice is overwritten, never merged.
    config = normalizeConfig({
      ...generated.config,
      voiceId: draft.voiceId,
      languageCodes: [draft.conversationLanguage],
      goals: [...draft.goals],
      tasks: [...draft.tasks],
      styleTraits: [...draft.styleTraits],
      conversationLanguage: draft.conversationLanguage,
    });
  }

  if (!input.agentId) {
    return {
      config,
      provider: generated.provider,
      model: generated.model,
      latencyMs: generated.latencyMs,
      wizardDraft: draft,
    };
  }

  // Still the untouched placeholder (version 1): fill it in place.
  const [written] = await db
    .update(agents)
    .set({ config, updatedAt: new Date() })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.organizationId, job.organizationId),
        eq(agents.configVersion, 1),
      ),
    )
    .returning({ id: agents.id });
  const applied = written !== undefined;
  return {
    config,
    provider: generated.provider,
    model: generated.model,
    latencyMs: generated.latencyMs,
    wizardDraft: draft,
    agentId: input.agentId,
    applied,
  };
}
