import { generateJSON } from "@/lib/llm";
import {
  agentConfigSchema,
  normalizeConfig,
  TOOL_REGISTRY,
  type AgentConfig,
} from "./config";

/**
 * The agent compiler: a natural-language brief in, a structured AgentConfig out.
 *
 * Plan Section U calls this differentiator #1 — "an agent compiler ... vs. the
 * category's manual flow-builders". The output is never treated as final: it
 * lands in an editable form (plan Section F), because a small free-tier model
 * writing a business config will get details wrong and the user is the reviewer.
 */

const SYSTEM = `You configure AI phone agents for businesses. You output JSON only.

Given a business owner's description of what they want their phone agent to do,
produce a complete agent configuration.

Rules:
- Output a single JSON object. No prose, no markdown fence.
- "mission" is one sentence describing the business outcome, not the behaviour.
- "identity.name" is the name the agent gives on the phone. Default to "Voni"
  unless the brief names one. "identity.role" is a human job title.
- "detect" lists the facts the agent must learn from the lead. Mark
  "sensitive": true for anything spoken as a sequence that must not be
  interrupted — phone numbers, emails, budgets, dates, reference numbers.
- "tools" may ONLY contain names from this list; omit any that do not apply:
${TOOL_REGISTRY.map((t) => `    ${t.name} — ${t.description}`).join("\n")}
- "greeting" is the first line the agent speaks. Keep it under 12 words and end
  it with a question, so the caller has something easy to answer.
- "channels" is a subset of ["phone", "whatsapp"].
- "knowledge" is one short paragraph of house rules: the hard facts and
  prohibitions the agent must respect. Use "" when the brief states none.
- Keep every string short. These are spoken on a phone call.

JSON shape:
{
  "mission": string,
  "identity": { "name": string, "role": string },
  "detect": [{ "key": string, "label": string, "description": string, "sensitive": boolean }],
  "tools": [string],
  "knowledge": string,
  "channels": [string],
  "voiceId": string,
  "greeting": string
}`;

export type GeneratedAgent = {
  config: AgentConfig;
  /** Which provider in the chain actually served this, for the UI to show. */
  provider: string;
  model: string;
  latencyMs: number;
};

/**
 * Compile a brief into a config. Throws `NoProviderAvailableError` if every
 * configured provider failed — callers should offer the template instead of
 * showing a dead end.
 */
export async function generateAgentConfig(
  brief: string,
): Promise<GeneratedAgent> {
  const result = await generateJSON(agentConfigSchema, {
    system: SYSTEM,
    user: `Business brief:\n\n${brief.trim()}`,
    // Free-tier models ramble past JSON when given room, so they keep the
    // tight 2,048-token budget that makes them hit the wall fast. Meta runs
    // high-effort reasoning that can spend that whole budget thinking — the
    // full dental-receptionist prompt produced reasoning but no visible text
    // at 2,048 — so Meta alone gets 16,384 tokens of headroom.
    maxTokens: 2048,
    metaMaxTokens: 16384,
  });

  return {
    // normalize AFTER validation: the schema guarantees shape, this drops
    // invented tool names the model was told not to use but used anyway.
    config: normalizeConfig(result.data),
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
