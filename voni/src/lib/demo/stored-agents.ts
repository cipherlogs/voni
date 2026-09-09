import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { secret } from "@/lib/env";
import { demoAgents } from "@/lib/db/schema";
import { compileSystemPrompt } from "@/lib/agents/compile";
import { getPersona, personaConfig } from "@/lib/agents/personas";
import { getVoice } from "@/lib/agents/voices";

/**
 * Provision (and cache) the AssemblyAI stored agent behind a public demo.
 *
 * ── Why stored agents at all ───────────────────────────────────────────────
 * A session can be configured two ways: inline, where the browser sends the
 * `system_prompt`, or bound, where it sends only an `agent_id`. Inline is fine
 * behind auth. On a public endpoint it is a hole: whoever holds a token decides
 * what the model does, which is free LLM inference on our account for anyone
 * who reads the network tab. Binding to a stored agent moves the prompt
 * server-side, so the only thing a caller controls is which persona and voice —
 * both of which we validate against our own lists before creating anything.
 *
 * Agents are created lazily per (persona, voice) and cached in `demo_agents`,
 * so a combination costs one API call ever. The upper bound is small and known:
 * personas × voices.
 */

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type ProvisionResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export async function getOrCreateDemoAgent(
  personaId: string,
  voiceId: string,
): Promise<ProvisionResult> {
  // Validate against our own catalogs first. This is what stops a caller
  // pushing an arbitrary voice or persona id into an outbound API call.
  const persona = getPersona(personaId);
  if (!persona) return { ok: false, error: "Unknown scenario." };
  const voice = getVoice(voiceId);
  if (!voice) return { ok: false, error: "Unknown voice." };

  const cached = await db
    .select({ agentId: demoAgents.assemblyaiAgentId })
    .from(demoAgents)
    .where(
      and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, voiceId)),
    )
    .limit(1);
  if (cached.length > 0) return { ok: true, agentId: cached[0].agentId };

  // Via secret(), not process.env: the key lives in .dev.vars, which Next
  // does not load into process.env. See src/lib/env.ts.
  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) return { ok: false, error: "Voice is not configured." };

  // personaConfig, not a manual spread: it also resolves the greeting to the
  // voice's own language, so a Spanish voice doesn't open in English.
  const config = personaConfig(persona, voiceId);

  const res = await fetch(AGENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `demo:${personaId}:${voiceId}`,
      system_prompt: compileSystemPrompt(config),
      greeting: config.greeting,
      voice: { voice_id: voiceId },
      // Omitted when empty: absent means automatic detection across all 18
      // recognised languages, which is what a public demo wants — a visitor
      // may open in any language and the agent should follow.
      ...(config.languageCodes.length > 0
        ? { input: { language_codes: config.languageCodes } }
        : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[demo-agent] create failed ${res.status}: ${body.slice(0, 300)}`,
    );
    return { ok: false, error: "Could not prepare the demo agent." };
  }

  const { id } = (await res.json()) as { id: string };

  // Another request may have provisioned the same pair concurrently. The unique
  // index makes that safe; swallow the conflict and use whichever row won
  // rather than failing a call the caller did nothing wrong in.
  try {
    await db
      .insert(demoAgents)
      .values({ personaId, voiceId, assemblyaiAgentId: id })
      .onConflictDoNothing();
  } catch (e) {
    console.warn(`[demo-agent] cache write failed, continuing: ${e}`);
  }

  return { ok: true, agentId: id };
}
