import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { secret } from "@/lib/env";
import { demoAgents } from "@/lib/db/schema";
import { compileSystemPrompt } from "@/lib/agents/compile";
import { getVoice, VOICE_OUTPUT_VOLUME } from "@/lib/agents/voices";
import { DEMO_VOICE_IDS, VONI_AGENT_ID, voniConfig } from "./voni-agent";
import { toRestTool } from "@/lib/tools/definitions";
import { DEMO_VOICE_TOOLS } from "./demo-tools";
import { TRANSCRIPTION_MODE, buildAgentKeyterms, buildAgentTranscriptionPrompt } from "@/lib/voice/transcription";
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
 * server-side, so the only thing a caller controls is which voice — validated
 * against the demo picker before creating anything.
 *
 * Voni is the only demo agent. One stored agent per voice, created lazily and
 * cached in `demo_agents` (its `persona_id` column always holds `voni`), so
 * a voice costs one API call ever — plus a `:resume` sibling per voice with
 * no greeting, which a fresh transport after a hold return binds to so the
 * only first utterance is the welcome-back, never a re-introduction.
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
 * Demo sessions run agent-mode. The browser relays each tool call to the
 * call-scoped `/api/demo/tools/[name]` route (bearer: the demo call token),
 * so every tool listed here must have a case there: a tool whose calls are
 * never answered stalls the turn.
 */

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type ProvisionResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export function demoAgentName(voiceId: string, resume = false): string {
  return `demo:${VONI_AGENT_ID}:${voiceId}${resume ? ":resume" : ""}`;
}

/**
 * Storage key for the `demo_agents` row. The resume variant is a second
 * stored agent per voice (same prompt and tools, no greeting): it rides the
 * existing (personaId, voiceId) unique index as a `:resume` suffix, so no
 * migration, and the suffix never reaches voice validation or the API.
 */
export function demoAgentStorageKey(voiceId: string, resume = false): string {
  return resume ? `${voiceId}:resume` : voiceId;
}

/** The exact remote body a demo agent runs. Pure: fingerprint + tests pin it. */
export function buildDemoAgentBody(voiceId: string, opts?: { resume?: boolean }) {
  const voice = getVoice(voiceId);
  const config = voniConfig(voiceId);
  const resume = opts?.resume === true;
  return {
    name: demoAgentName(voiceId, resume),
    system_prompt: compileSystemPrompt(config),
    // A hold rejoin opens a fresh transport on the resume variant, which has
    // no greeting: per the platform, an omitted greeting waits silently, and
    // the client's carried context + welcome-back reply becomes the single
    // first utterance instead of a re-introduction stacked on one.
    ...(resume ? {} : { greeting: config.greeting }),
    voice: { voice_id: voiceId },
    // Loudest server level on every voice: native levels differ by ~12 dB,
    // so omitted volume plays each voice at its own level. Client gain in
    // VoiceSession.schedule applies the relative match per voice.
    output: { volume: VOICE_OUTPUT_VOLUME },
    // Each one is answered by /api/demo/tools (see module note). REST
    // shape (no `type`) — see `toRestTool`.
    tools: DEMO_VOICE_TOOLS.map((tool) => toRestTool({ ...tool })),
    input: {
      // Locked to the voice's language: detecting across all 18 languages
      // every turn is slow. Language codes apply at speech-to-text connect,
      // so they live on the stored agent, not in the post-ready preset.
      language_codes: voice ? [voice.languageCode] : [],
      transcription_mode: TRANSCRIPTION_MODE,
      transcription_prompt: buildAgentTranscriptionPrompt(config),
      keyterms: buildAgentKeyterms(config),
      voice_focus: "near-field",
      // Null = adaptive defaults. Any turn_detection object switches off
      // adaptive end-of-turn (ADAPTIVE_TURNS, voice/session.ts); explicit
      // null clears the object older bodies stored.
      turn_detection: null,
    },
  };
}

/**
 * The body, plus which API key (account) the agent lives under: a new key
 * moves the fingerprint, so its cached agents are re-checked (and recreated
 * when that account has never heard of them). Only a hash of the key.
 */
export function demoAgentFingerprint(body: ReturnType<typeof buildDemoAgentBody>, apiKey = ""): string {
  return createHash("sha256").update(stableJson(body)).update(`\0${apiKey}`).digest("hex");
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
  voiceId: string,
  opts?: { resume?: boolean },
): Promise<ProvisionResult> {
  // Validate against the picker first. This is what stops a caller pushing
  // an arbitrary voice id into an outbound API call.
  if (!(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) {
    return { ok: false, error: "Unknown voice." };
  }
  const personaId = VONI_AGENT_ID;
  const resume = opts?.resume === true;
  const storageKey = demoAgentStorageKey(voiceId, resume);

  // Via secret(), not process.env: the key lives in .dev.vars, which Next
  // does not load into process.env. See src/lib/env.ts.
  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) return { ok: false, error: "Voice is not configured." };

  const body = buildDemoAgentBody(voiceId, { resume });
  const fingerprint = demoAgentFingerprint(body, apiKey);

  const cached = await db
    .select({ agentId: demoAgents.assemblyaiAgentId, fingerprint: demoAgents.fingerprint })
    .from(demoAgents)
    .where(
      and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, storageKey)),
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
    // 404: this account has never heard of the agent (the API key moved to
    // another account). Serving it stale made every call fail to connect:
    // recreate it below and repoint the row instead.
    if (!refreshed.ok && refreshed.status !== 404) {
      console.warn(
        `[demo-agent] refresh ${refreshed.status} for ${cached[0].agentId}, serving stale: ${refreshed.detail.slice(0, 200)}`,
      );
      return { ok: true, agentId: cached[0].agentId };
    }
    if (refreshed.ok) {
      await db
        .update(demoAgents)
        .set({ fingerprint })
        .where(
          and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, storageKey)),
        )
        .catch((e: unknown) => console.warn(`[demo-agent] fingerprint write failed, continuing: ${e}`));
      return { ok: true, agentId: cached[0].agentId };
    }
    console.warn(`[demo-agent] ${cached[0].agentId} not found under this API key; recreating`);
  }

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
      .values({ personaId, voiceId: storageKey, assemblyaiAgentId: created.id, fingerprint })
      // A row whose agent was not found is repointed at the new one.
      .onConflictDoUpdate({
        target: [demoAgents.personaId, demoAgents.voiceId],
        set: { assemblyaiAgentId: created.id, fingerprint },
      });
  } catch (e) {
    console.warn(`[demo-agent] cache write failed, continuing: ${e}`);
  }

  return { ok: true, agentId: created.id };
}
