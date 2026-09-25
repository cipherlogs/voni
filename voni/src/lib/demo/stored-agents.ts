import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { secret } from "@/lib/env";
import { demoAgents } from "@/lib/db/schema";
import { compileSystemPrompt } from "@/lib/agents/compile";
import { getPersona, personaConfig, type Persona } from "@/lib/agents/personas";
import { getVoice } from "@/lib/agents/voices";
import { END_CALL_VOICE_TOOL, toRestTool } from "@/lib/tools/definitions";
import { buildAgentKeyterms, buildAgentTranscriptionPrompt } from "@/lib/voice/transcription";
import { stableJson } from "@/lib/agents/provision";

/**
 * Provision (and refresh) the AssemblyAI stored agent behind a public demo.
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
 *
 * ── Refresh, not just cache ────────────────────────────────────────────────
 * The cache used to be write-once: a platform upgrade (new tools, prompt
 * rules, tuning) never reached already-provisioned demo agents, so the demo
 * silently ran stale — including shipping no tools at all while the prompt
 * assumed them. The stored fingerprint fixes that: every token request
 * recomputes it, and a mismatch PUT-updates the cached agent in place before
 * minting the token. Demos heal themselves; no row wipe needed.
 *
 * ── Tools on demo ──────────────────────────────────────────────────────────
 * Demo sessions run agent-mode, where the browser executes no tools
 * client-side — except call control (`end_call` is answered locally by the
 * session, see `VoiceSession.answerAgentModeEndCall`). Business tools ship
 * in NEITHER the demo body NOR execution: handing the model tools whose
 * calls are never answered stalls the turn. The prompt's tool-use sections
 * predate this and are unchanged.
 */

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type ProvisionResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export function demoAgentName(personaId: string, voiceId: string): string {
  return `demo:${personaId}:${voiceId}`;
}

/** The exact remote body a demo agent runs. Pure: fingerprint + tests pin it. */
export function buildDemoAgentBody(persona: Persona, voiceId: string) {
  const voice = getVoice(voiceId);
  const config = personaConfig(persona, voiceId);
  return {
    name: demoAgentName(persona.id, voiceId),
    system_prompt: compileSystemPrompt(config),
    greeting: config.greeting,
    voice: { voice_id: voiceId },
    // Call control only (see module note): the only tool with client-side
    // execution in agent-mode sessions. REST shape (no `type`) — see
    // `toRestTool`.
    tools: [toRestTool({ ...END_CALL_VOICE_TOOL })],
    input: {
      // Locked to the voice's language: detecting across all 18 languages
      // every turn is slow. Language codes apply at speech-to-text connect,
      // so they live on the stored agent, not in the post-ready preset.
      language_codes: voice ? [voice.languageCode] : [],
      transcription_mode: "balanced",
      transcription_prompt: buildAgentTranscriptionPrompt(config),
      keyterms: buildAgentKeyterms(config),
      voice_focus: "near-field",
      turn_detection: {
        min_silence: 100,
        max_silence: 1000,
        interrupt_response: true,
        interruption_delay: 500,
      },
    },
  };
}

export function demoAgentFingerprint(body: ReturnType<typeof buildDemoAgentBody>): string {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

async function remoteCall(
  apiKey: string,
  method: "POST" | "PUT",
  body: ReturnType<typeof buildDemoAgentBody>,
  agentId?: string,
): Promise<{ ok: true; id: string } | { ok: false; status: number; detail: string }> {
  const url = agentId ? `${AGENTS_URL}/${encodeURIComponent(agentId)}` : AGENTS_URL;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : "transport failed",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      detail: await res.text().catch(() => ""),
    };
  }
  const { id } = (await res.json()) as { id: string };
  return { ok: true, id };
}

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

  // Via secret(), not process.env: the key lives in .dev.vars, which Next
  // does not load into process.env. See src/lib/env.ts.
  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) return { ok: false, error: "Voice is not configured." };

  const body = buildDemoAgentBody(persona, voiceId);
  const fingerprint = demoAgentFingerprint(body);

  const cached = await db
    .select({ agentId: demoAgents.assemblyaiAgentId, fingerprint: demoAgents.fingerprint })
    .from(demoAgents)
    .where(
      and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, voiceId)),
    )
    .limit(1);
  if (cached.length > 0 && cached[0].fingerprint === fingerprint) {
    return { ok: true, agentId: cached[0].agentId };
  }

  if (cached.length > 0) {
    // Stale cache: the platform moved under this demo agent. Update in
    // place — same remote id, so in-flight token minting keeps working.
    // A failed refresh falls back to the stale agent (a working demo that
    // cannot hang up beats no demo), and the next request retries.
    const refreshed = await remoteCall(apiKey, "PUT", body, cached[0].agentId);
    if (!refreshed.ok) {
      console.warn(
        `[demo-agent] refresh ${refreshed.status} for ${cached[0].agentId}, serving stale: ${refreshed.detail.slice(0, 200)}`,
      );
      return { ok: true, agentId: cached[0].agentId };
    }
    await db
      .update(demoAgents)
      .set({ fingerprint })
      .where(
        and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, voiceId)),
      )
      .catch((e: unknown) => console.warn(`[demo-agent] fingerprint write failed, continuing: ${e}`));
    return { ok: true, agentId: cached[0].agentId };
  }

  // personaConfig, not a manual spread: it also resolves the greeting to the
  // voice's own language, so a Spanish voice doesn't open in English.
  const created = await remoteCall(apiKey, "POST", body);
  if (!created.ok) {
    console.error(`[demo-agent] create failed ${created.status}: ${created.detail.slice(0, 300)}`);
    return { ok: false, error: "Could not prepare the demo agent." };
  }

  // Another request may have provisioned the same pair concurrently. The unique
  // index makes that safe; swallow the conflict and use whichever row won
  // rather than failing a call the caller did nothing wrong in.
  try {
    await db
      .insert(demoAgents)
      .values({ personaId, voiceId, assemblyaiAgentId: created.id, fingerprint })
      .onConflictDoNothing();
  } catch (e) {
    console.warn(`[demo-agent] cache write failed, continuing: ${e}`);
  }

  return { ok: true, agentId: created.id };
}
