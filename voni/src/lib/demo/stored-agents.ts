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
import { DEMO_TRANSCRIPTION_MODE, buildAgentKeyterms, buildAgentTranscriptionPrompt } from "@/lib/voice/transcription";
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

/**
 * A bring-your-own OpenAI-compatible LLM for the stored demo agent. Write-only
 * on the agent body (`api_key` is never returned by the platform, and this
 * module never returns it to a caller either). `llm` is an array with at most
 * one entry; `[]` reverts to the managed model.
 */
export type LlmOverride = {
  base_url: string;
  model: string;
  api_key: string;
  /** Disable thinking on models that support it (Gemini 2.5 Flash). */
  reasoning_effort?: string;
};

/** Vercel AI Gateway: the fastest measured tool-calling model (see research 08). */
export const DEMO_LLM_BASE_URL = "https://ai-gateway.vercel.sh/v1";
/** Gemini 2.5 Flash thinks by default; the demo needs the first token fast. */
export const DEMO_LLM_REASONING_EFFORT = "none";
export const DEMO_LLM_MODEL = "google/gemini-2.5-flash";

export type ProvisionResult =
  | {
      ok: true;
      agentId: string;
      /** Hash the cached row stores; the eval reports it as run identity. */
      fingerprint: string;
      /** The override model in force, or null for the managed default. */
      llmModel: string | null;
      /** A refresh failed and the cached remote copy is stale (served anyway). */
      stale?: true;
    }
  | { ok: false; error: string };

/**
 * The fast-LLM override, when the deployment has an AI Gateway key.
 *
 * The landing demo's reply latency is dominated by the managed model's think
 * time (measured ~1.26s), so a demo agent runs on a faster one when the key
 * exists. Absent key = no override at all, and the body stays byte-identical
 * to the managed default (so no stored agent is refreshed just by shipping
 * this). Both settings are read through `secret()` so `.dev.vars`, plain
 * Node/CI, and the deployed Worker all agree.
 */
export async function demoLlmOverride(): Promise<LlmOverride[] | null> {
  const apiKey = await secret("AI_GATEWAY_API_KEY");
  if (!apiKey) return null;
  const [baseUrl, model, reasoning] = await Promise.all([
    secret("DEMO_LLM_BASE_URL"),
    secret("DEMO_LLM_MODEL"),
    secret("DEMO_LLM_REASONING_EFFORT"),
  ]);
  return [
    {
      base_url: baseUrl || DEMO_LLM_BASE_URL,
      model: model || DEMO_LLM_MODEL,
      api_key: apiKey,
      ...(reasoning || DEMO_LLM_REASONING_EFFORT
        ? { reasoning_effort: reasoning || DEMO_LLM_REASONING_EFFORT }
        : {}),
    },
  ];
}

/**
 * Which stored body a caller gets. `production` is the demo every visitor
 * binds; `turn-window` is the one stored-agent variant the end-of-turn
 * experiment provisions under its own key. Environment selection defaults to
 * `production`, so a deployment that never asked for the experiment cannot
 * reach the variant.
 */
export const DEMO_AGENT_VARIANTS = ["production", "turn-window"] as const;
export type DemoAgentVariant = (typeof DEMO_AGENT_VARIANTS)[number];

/** The experiment's row/agent suffix, mirroring the `:resume` pattern. */
export const DEMO_AGENT_VARIANT_SUFFIX = ":exp";

/**
 * The only settings the variant may override: the end-of-turn windows. It is
 * one object, not a free-form `turn_detection` pass-through, so a stray
 * object can never reach the production body. Any field may be omitted: ladder
 * rung 3 sets `interruption_delay` alone, with no silence pair.
 */
export type DemoTurnWindows = {
  min_silence?: number;
  max_silence?: number;
  interruption_delay?: number;
};

/** Ladder rung 1, and the defaults when an env var is unset. */
export const DEMO_TURN_WINDOW_DEFAULTS: Readonly<Required<DemoTurnWindows>> = Object.freeze({
  min_silence: 400,
  max_silence: 640,
  interruption_delay: 0,
});

/** Explicit environment selection. Absent/empty means `production`. */
export const DEMO_AGENT_VARIANT = "DEMO_AGENT_VARIANT";
export const DEMO_TURN_MIN_SILENCE = "DEMO_TURN_MIN_SILENCE";
export const DEMO_TURN_MAX_SILENCE = "DEMO_TURN_MAX_SILENCE";
export const DEMO_TURN_INTERRUPTION_DELAY = "DEMO_TURN_INTERRUPTION_DELAY";

function isDemoAgentVariant(value: string): value is DemoAgentVariant {
  return (DEMO_AGENT_VARIANTS as readonly string[]).includes(value);
}

/**
 * Parse an environment selection. Unset/empty is production; anything else
 * must be a known variant — a typo fails loudly rather than silently measuring
 * production under the experiment's name.
 */
export function resolveDemoAgentVariant(raw: string | null | undefined): DemoAgentVariant {
  const value = raw?.trim().toLowerCase();
  if (!value) return "production";
  if (isDemoAgentVariant(value)) return value;
  throw new Error(
    `Unknown DEMO_AGENT_VARIANT "${raw}"; use one of ${DEMO_AGENT_VARIANTS.join(", ")}.`,
  );
}

/**
 * The deployment's selection, read through `secret()` like the LLM override so
 * `.dev.vars`, plain Node/CI and the Worker agree. Never defaults to the
 * experiment: only an explicit `DEMO_AGENT_VARIANT=turn-window` selects it.
 */
export async function demoAgentVariantFromEnv(): Promise<DemoAgentVariant> {
  return resolveDemoAgentVariant(await secret(DEMO_AGENT_VARIANT));
}

function windowMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

/** The rung's windows, with ladder rung 1 filling any unset/invalid knob. */
export async function demoTurnWindowsFromEnv(): Promise<DemoTurnWindows> {
  const [minSilence, maxSilence, interruptionDelay] = await Promise.all([
    secret(DEMO_TURN_MIN_SILENCE),
    secret(DEMO_TURN_MAX_SILENCE),
    secret(DEMO_TURN_INTERRUPTION_DELAY),
  ]);
  return {
    min_silence: windowMs(minSilence, DEMO_TURN_WINDOW_DEFAULTS.min_silence),
    max_silence: windowMs(maxSilence, DEMO_TURN_WINDOW_DEFAULTS.max_silence),
    interruption_delay: windowMs(
      interruptionDelay,
      DEMO_TURN_WINDOW_DEFAULTS.interruption_delay,
    ),
  };
}

export function demoAgentName(
  voiceId: string,
  resume = false,
  variant: DemoAgentVariant = "production",
): string {
  const base = `demo:${VONI_AGENT_ID}:${voiceId}${resume ? ":resume" : ""}`;
  return variant === "production" ? base : `${base}${DEMO_AGENT_VARIANT_SUFFIX}`;
}

/**
 * Storage key for the `demo_agents` row. The resume variant is a second
 * stored agent per voice (same prompt and tools, no greeting): it rides the
 * existing (personaId, voiceId) unique index as a `:resume` suffix, so no
 * migration, and the suffix never reaches voice validation or the API.
 *
 * The experimental variant is a third row under an `:exp` suffix for the same
 * reason: provisioning it can never touch the production row or its remote
 * agent.
 */
export function demoAgentStorageKey(
  voiceId: string,
  resume = false,
  variant: DemoAgentVariant = "production",
): string {
  const key = resume ? `${voiceId}:resume` : voiceId;
  return variant === "production" ? key : `${key}${DEMO_AGENT_VARIANT_SUFFIX}`;
}

/** The exact remote body a demo agent runs. Pure: fingerprint + tests pin it. */
export function buildDemoAgentBody(
  voiceId: string,
  opts?: {
    resume?: boolean;
    llm?: LlmOverride[];
    variant?: DemoAgentVariant;
    turnWindows?: DemoTurnWindows;
  },
) {
  const voice = getVoice(voiceId);
  const config = voniConfig(voiceId);
  const resume = opts?.resume === true;
  const variant = opts?.variant ?? "production";
  const windows = opts?.turnWindows ?? DEMO_TURN_WINDOW_DEFAULTS;
  const turnDetection = {
    ...(windows.min_silence !== undefined ? { min_silence: windows.min_silence } : {}),
    ...(windows.max_silence !== undefined ? { max_silence: windows.max_silence } : {}),
    ...(windows.interruption_delay !== undefined
      ? { interruption_delay: windows.interruption_delay }
      : {}),
  };
  if (variant === "turn-window" && Object.keys(turnDetection).length === 0) {
    throw new Error("turn-window variant needs at least one configured window");
  }
  return {
    name: demoAgentName(voiceId, resume, variant),
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
    // Absent unless an override is supplied: the managed default body must
    // stay byte-identical, so no cached demo agent refreshes for nothing.
    ...(opts?.llm ? { llm: opts.llm } : {}),
    input: {
      // Locked to the voice's language: detecting across all 18 languages
      // every turn is slow. Language codes apply at speech-to-text connect,
      // so they live on the stored agent, not in the post-ready preset.
      language_codes: voice ? [voice.languageCode] : [],
      transcription_mode: DEMO_TRANSCRIPTION_MODE,
      transcription_prompt: buildAgentTranscriptionPrompt(config),
      keyterms: buildAgentKeyterms(config),
      voice_focus: "near-field",
      // Null = adaptive defaults. Any turn_detection object switches off
      // adaptive end-of-turn (ADAPTIVE_TURNS, voice/session.ts); explicit
      // null clears the object older bodies stored. Production always sends
      // null; only the `:exp` experiment body carries windows, and it is
      // built from exactly these three fields.
      turn_detection:
        variant === "turn-window"
          ? turnDetection
          : null,
    },
  };
}

export type DemoAgentProvisionPlan = {
  variant: DemoAgentVariant;
  /** `demo_agents.voice_id`: the variant is its own row, never the production one. */
  storageKey: string;
  body: ReturnType<typeof buildDemoAgentBody>;
};

/**
 * The row key and body a provisioning request resolves to. Pure, so the
 * variant contract (own key, own windows, production untouched) is testable
 * without a database or the Agents API.
 */
export function planDemoAgent(
  voiceId: string,
  opts?: {
    resume?: boolean;
    llm?: LlmOverride[];
    variant?: DemoAgentVariant;
    turnWindows?: DemoTurnWindows;
  },
): DemoAgentProvisionPlan {
  const variant = resolveDemoAgentVariant(opts?.variant);
  return {
    variant,
    storageKey: demoAgentStorageKey(voiceId, opts?.resume === true, variant),
    body: buildDemoAgentBody(voiceId, {
      resume: opts?.resume === true,
      ...(opts?.llm ? { llm: opts.llm } : {}),
      variant,
      ...(variant === "turn-window" && opts?.turnWindows
        ? { turnWindows: opts.turnWindows }
        : {}),
    }),
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
  // Updates never clear an absent field: a previously-set `llm` override
  // survives a PUT whose body omits it (seen live: gateway model the account
  // can't access kept failing turns after the override was removed from the
  // body). Send the documented revert (`"llm": []` → managed model) so a
  // refresh always converges instead of stranding the stale override.
  const payload =
    method === "PUT" && !("llm" in body) ? { ...body, llm: [] } : { ...body };
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
  opts?: { resume?: boolean; variant?: DemoAgentVariant; turnWindows?: DemoTurnWindows },
): Promise<ProvisionResult> {
  // Validate against the picker first. This is what stops a caller pushing
  // an arbitrary voice id into an outbound API call.
  if (!(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) {
    return { ok: false, error: "Unknown voice." };
  }
  const personaId = VONI_AGENT_ID;
  const resume = opts?.resume === true;

  // The visitor path passes no variant, so this is the one gate that keeps
  // the experiment off production calls: only an explicit environment (or an
  // explicit caller, i.e. the eval) selects it. A typo fails loudly instead
  // of silently provisioning production under the experiment's name.
  let variant: DemoAgentVariant;
  try {
    variant = resolveDemoAgentVariant(opts?.variant ?? (await demoAgentVariantFromEnv()));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Demo agent variant is not configured.",
    };
  }

  // Via secret(), not process.env: the key lives in .dev.vars, which Next
  // does not load into process.env. See src/lib/env.ts.
  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) return { ok: false, error: "Voice is not configured." };

  // A faster LLM when the gateway key is configured (the landing demo and the
  // eval then run the same stored body). The key rides the body, never a
  // client response; the fingerprint below covers the whole body, so a model
  // change refreshes the agent exactly like a prompt change.
  const llm = await demoLlmOverride();
  const turnWindows =
    variant === "turn-window"
      ? (opts?.turnWindows ?? (await demoTurnWindowsFromEnv()))
      : undefined;
  const { storageKey, body } = planDemoAgent(voiceId, {
    resume,
    variant,
    ...(turnWindows ? { turnWindows } : {}),
    ...(llm ? { llm } : {}),
  });
  const fingerprint = demoAgentFingerprint(body, apiKey);
  const llmModel = llm?.[0]?.model ?? null;

  const cached = await db
    .select({ agentId: demoAgents.assemblyaiAgentId, fingerprint: demoAgents.fingerprint })
    .from(demoAgents)
    .where(
      and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, storageKey)),
    )
    .limit(1);
  if (cached.length > 0 && cached[0].fingerprint === fingerprint) {
    return { ok: true, agentId: cached[0].agentId, fingerprint, llmModel };
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
      return {
        ok: true,
        agentId: cached[0].agentId,
        // The cached row's hash is the last body known to have been applied;
        // never claim the intended one for a remote copy that did not take it.
        // (A pre-fingerprint row has none; `stale` marks the identity unusable.)
        fingerprint: cached[0].fingerprint ?? fingerprint,
        llmModel,
        stale: true,
      };
    }
    if (refreshed.ok) {
      await db
        .update(demoAgents)
        .set({ fingerprint })
        .where(
          and(eq(demoAgents.personaId, personaId), eq(demoAgents.voiceId, storageKey)),
        )
        .catch((e: unknown) => console.warn(`[demo-agent] fingerprint write failed, continuing: ${e}`));
      return { ok: true, agentId: cached[0].agentId, fingerprint, llmModel };
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

  return { ok: true, agentId: created.id, fingerprint, llmModel };
}
