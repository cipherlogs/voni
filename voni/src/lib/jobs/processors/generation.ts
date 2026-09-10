import { generateAgentConfig } from "@/lib/agents/generate";
import { throwIfCancelled } from "../processor";
import type { JobInput } from "../kinds";
import type { JobRow } from "../store";

/**
 * agent_generation: NL brief -> validated config. Never persists — the
 * result restores as an editable draft on /agents/new?job=<id>, and the
 * mandatory review step means generation never creates an agent by itself.
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
  return {
    config: generated.config,
    provider: generated.provider,
    model: generated.model,
    latencyMs: generated.latencyMs,
    // Echo the submitted snapshot so ?job= restores can seed the wizard even
    // when the best-effort placeholder write failed (PR4).
    ...(input.wizardDraft ? { wizardDraft: input.wizardDraft } : {}),
  };
}
