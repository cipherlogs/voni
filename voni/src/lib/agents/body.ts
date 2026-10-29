import { compileSystemPrompt } from "./compile";
import type { AgentConfig } from "./config";
import { getVoice } from "./voices";
import { voiceOutputVolume } from "./voice-levels";
import type { RestTool } from "@/lib/tools/definitions";
import {
  TRANSCRIPTION_MODE,
  buildAgentKeyterms,
  buildAgentTranscriptionPrompt,
} from "@/lib/voice/transcription";

/**
 * The one stored-agent body builder (voice-parity ticket 60, ADR-0006).
 *
 * ── Why one builder ───────────────────────────────────────────────────────
 * There used to be two: the demo's and a tenant's. They drifted in ways nobody
 * chose — a tenant shipped an explicit turn-detection object the demo had
 * already dropped, its PUT never reverted a model override, and each hashed a
 * different field set. Neither difference was a decision, so neither was
 * reviewable. Every stored agent is now this function's output, and a persona
 * difference is one visible profile line.
 *
 * ── What a profile is ─────────────────────────────────────────────────────
 * A profile is the small set of things a buyer of the product may legitimately
 * differ on: persona (demo or tenant), platform (browser or phone), and the
 * five knobs below — audio format, microphone focus, tool set, greeting
 * presence, and a model override.
 *
 * A profile is NOT where session mechanics live. Rules, turn-taking,
 * recognition vocabulary and language policy are the same on every agent (the
 * product's promises), so the builder owns them from the agent's config and
 * the persona. `assertAllowedAgentProfile` rejects anything else by name
 * before a body exists, let alone before a remote call.
 *
 * ── The seams the following tickets extend ────────────────────────────────
 * - 61: the whitelist above — `FORBIDDEN_PROFILE_FIELDS` + the rejection.
 * - 62: one fingerprint over the whole body — `agentBodyFingerprint` in
 *   `./fingerprint` hashes the `StoredAgentBody` this builder returns, for the
 *   demo refresh and the tenant deployment alike. It replaced the tenant's
 *   field-subset hash (`comparableAgent`), which had omitted the model override.
 *   `stableJson` is its canonical form.
 * - 64/65: `turnDetectionFor` below is the single turn-taking switch. It
 *   returns the Turn preset (`turn_detection: null`) for every persona and
 *   platform; ticket 64 moved tenants off the pre-64 object and ticket 65
 *   removes the leftover constant.
 * - 66/67: `compileSystemPrompt` is the rules owner; the persona-neutral floor
 *   moves into it without this file learning about personas.
 */

export type AgentPersona = "demo" | "tenant";
export type AgentPlatform = "browser" | "phone";

/** A stored-agent audio format, exactly as the platform names it. */
export type StoredAudioFormat = {
  encoding: string;
  sample_rate: number;
};

/** How the recogniser isolates the caller's microphone. */
export type MicrophoneFocus = {
  mode: "near-field" | "far-field";
  /** Isolator confidence; only the phone path sets one today. */
  threshold?: number;
};

/**
 * A bring-your-own OpenAI-compatible LLM for a stored agent. Write-only on the
 * agent body (`api_key` is never returned by the platform, and this module
 * never returns it to a caller either). `llm` is an array with at most one
 * entry; `[]` reverts to the managed model.
 */
export type LlmOverride = {
  base_url: string;
  model: string;
  api_key: string;
  /** Disable thinking on models that support it (Gemini 2.5 Flash). */
  reasoning_effort?: string;
};

/**
 * Everything a profile may choose — and nothing else. The type is the
 * whitelist: an extra field is a compile error here and a named rejection at
 * runtime.
 */
export type AgentProfile = {
  persona: AgentPersona;
  platform: AgentPlatform;
  /** The wire format this agent is provisioned for; absent means the default. */
  format?: StoredAudioFormat | null;
  microphoneFocus: MicrophoneFocus;
  tools: readonly RestTool[];
  /** Whether the body opens with `config.greeting`. Defaults to true. */
  greeting?: boolean;
  /** Absent means the managed model; `[]` is the documented revert. */
  modelOverride?: readonly LlmOverride[] | null;
};

/** The fields a profile may carry, in the order this module documents them. */
export const AGENT_PROFILE_FIELDS = [
  "persona",
  "platform",
  "format",
  "microphoneFocus",
  "tools",
  "greeting",
  "modelOverride",
] as const;

/**
 * Profile keys that would let a caller choose session mechanics. Listed by
 * category so the rejection can name what was attempted: a rule, a turn
 * setting, a recognition word, or a language decision. `AGENT_PROFILE_FIELDS`
 * is the counterpart — anything not whitelisted is refused too. Exported so
 * the whitelist test can prove every forbidden field has a rejection case.
 */
export const FORBIDDEN_PROFILE_FIELDS: Readonly<Record<string, string>> = {
  // Rules — the agent's content, compiled on every body.
  system_prompt: "rules",
  rules: "rules",
  prompt: "rules",
  mission: "rules",
  knowledge: "rules",
  // Turn-taking — the Turn preset is one promise on every agent.
  turn_detection: "turn-taking",
  turnDetection: "turn-taking",
  turn_taking: "turn-taking",
  min_silence: "turn-taking",
  max_silence: "turn-taking",
  interruption_delay: "turn-taking",
  interrupt_response: "turn-taking",
  // Recognition vocabulary — what the agent listens for, per Locale.
  keyterms: "recognition vocabulary",
  transcription_prompt: "recognition vocabulary",
  transcription_mode: "recognition vocabulary",
  recognition: "recognition vocabulary",
  vocabulary: "recognition vocabulary",
  // Language policy — pinned from the voice binding or the agent config.
  language_codes: "language policy",
  languageCodes: "language policy",
  language: "language policy",
  locale: "language policy",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse a profile that carries anything a profile may not choose. TypeScript
 * catches this at compile time; this is the runtime half for an untyped caller
 * (a job payload, a JSON body), and it runs before any body is built or sent.
 *
 * Every rejection names the offending field: a silent extra field is exactly
 * how the two builders drifted apart in the first place.
 */
export function assertAllowedAgentProfile(
  profile: unknown,
): asserts profile is AgentProfile {
  if (!isRecord(profile)) {
    throw new Error("Agent profile must be an object.");
  }
  for (const key of Object.keys(profile)) {
    const category = FORBIDDEN_PROFILE_FIELDS[key];
    if (category) {
      throw new Error(
        `Agent profile may not choose ${category}: "${key}" is session mechanics, not a profile choice.`,
      );
    }
    if (!(AGENT_PROFILE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown agent profile field "${key}"; a profile may choose only ${AGENT_PROFILE_FIELDS.join(", ")}.`,
      );
    }
  }

  const persona = profile.persona;
  if (persona !== "demo" && persona !== "tenant") {
    throw new Error(
      `Agent profile persona must be "demo" or "tenant", got ${JSON.stringify(persona)}.`,
    );
  }
  const platform = profile.platform;
  if (platform !== "browser" && platform !== "phone") {
    throw new Error(
      `Agent profile platform must be "browser" or "phone", got ${JSON.stringify(platform)}.`,
    );
  }
  const focus = profile.microphoneFocus;
  if (
    !isRecord(focus) ||
    (focus.mode !== "near-field" && focus.mode !== "far-field")
  ) {
    throw new Error(
      'Agent profile microphoneFocus must be "near-field" or "far-field".',
    );
  }
  if (!Array.isArray(profile.tools)) {
    throw new Error("Agent profile tools must be an array.");
  }
  if ("greeting" in profile && typeof profile.greeting !== "boolean") {
    throw new Error("Agent profile greeting must be a boolean.");
  }
  if (
    "modelOverride" in profile &&
    profile.modelOverride !== null &&
    !Array.isArray(profile.modelOverride)
  ) {
    throw new Error("Agent profile modelOverride must be an array or null.");
  }
  if (
    "format" in profile &&
    profile.format !== null &&
    profile.format !== undefined &&
    (!isRecord(profile.format) ||
      typeof profile.format.encoding !== "string" ||
      typeof profile.format.sample_rate !== "number")
  ) {
    throw new Error(
      "Agent profile format must be { encoding, sample_rate } or null.",
    );
  }
}

/** The stored `turn_detection` value: null is adaptive (the Turn preset). */
export type StoredTurnDetection = null | Record<string, number | boolean>;

/** The only end-of-turn windows the demo latency experiment may set. */
export type TurnWindowSettings = {
  readonly min_silence?: number;
  readonly max_silence?: number;
  readonly interruption_delay?: number;
};

/**
 * Turn-taking is session mechanics, so it is a builder input — never a
 * profile field. Production callers omit it and get the Turn preset.
 */
export type TurnTaking =
  /** The Turn preset: adaptive end-of-turn, no object on the body. */
  | { readonly kind: "preset" }
  /** The demo latency experiment's explicit windows (`:exp` bodies only). */
  | { readonly kind: "windows"; readonly windows: TurnWindowSettings };

/**
 * The tenant body's pre-64 explicit turn-detection object. Ticket 64 stopped
 * sending it (every body now carries the Turn preset); ticket 65 removes this
 * export and its docs. It is kept only so a test can prove no profile produces
 * it, rather than leaving the absence to a comment.
 */
export const TENANT_LEGACY_TURN_DETECTION = Object.freeze({
  min_silence: 100,
  max_silence: 1000,
  interrupt_response: true,
  interruption_delay: 500,
});

function windowsToTurnDetection(
  windows: TurnWindowSettings,
): Record<string, number> {
  const turnDetection = {
    ...(windows.min_silence !== undefined
      ? { min_silence: windows.min_silence }
      : {}),
    ...(windows.max_silence !== undefined
      ? { max_silence: windows.max_silence }
      : {}),
    ...(windows.interruption_delay !== undefined
      ? { interruption_delay: windows.interruption_delay }
      : {}),
  };
  if (Object.keys(turnDetection).length === 0) {
    throw new Error("turn-window variant needs at least one configured window");
  }
  return turnDetection;
}

/**
 * The single turn-taking switch. Every persona and platform sends the Turn
 * preset (`turn_detection: null`, adaptive meaning-based end-of-turn); the one
 * exception is the demo latency experiment's explicit windows, which stay
 * demo-only and never reach a production body.
 *
 * Ticket 64 moved tenants here from their pre-64 object; ticket 65 removes the
 * leftover constant and its docs.
 */
function turnDetectionFor(
  persona: AgentPersona,
  requested: TurnTaking | undefined,
): StoredTurnDetection {
  if (requested?.kind === "windows") {
    if (persona !== "demo") {
      throw new Error("the turn-window experiment is demo-only");
    }
    return windowsToTurnDetection(requested.windows);
  }
  return null;
}

/**
 * Language policy is the builder's: a demo voice speaks exactly one Locale, so
 * its body pins that Locale (and keeps an empty list for an unknown voice); a
 * tenant pins the languages its owner configured, and sends no field at all
 * when there are none. A profile never supplies this.
 */
function languagePolicy(
  config: AgentConfig,
  persona: AgentPersona,
): string[] | undefined {
  if (persona === "demo") {
    const voice = getVoice(config.voiceId);
    return voice ? [voice.languageCode] : [];
  }
  return config.languageCodes.length > 0 ? [...config.languageCodes] : undefined;
}

/**
 * The key order each persona has always put on the wire. The platform ignores
 * order and both refresh fingerprints canonicalise it, but a body that
 * changes bytes on deploy would churn captured payloads for no reason. Only
 * the order lives here — never content — and ticket 62 removes the need.
 */
const BODY_WIRE_ORDER: Record<AgentPersona, readonly string[]> = {
  demo: ["name", "system_prompt", "greeting", "voice", "output", "tools", "llm", "input"],
  tenant: ["name", "system_prompt", "greeting", "voice", "input", "output", "tools", "llm"],
};

const INPUT_WIRE_ORDER: Record<AgentPersona, readonly string[]> = {
  demo: [
    "language_codes",
    "transcription_mode",
    "transcription_prompt",
    "keyterms",
    "voice_focus",
    "voice_focus_threshold",
    "format",
    "turn_detection",
  ],
  tenant: [
    "format",
    "transcription_mode",
    "transcription_prompt",
    "keyterms",
    "voice_focus",
    "voice_focus_threshold",
    "turn_detection",
    "language_codes",
  ],
};

function inWireOrder<T extends Record<string, unknown>>(
  value: T,
  order: readonly string[],
): T {
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    if (key in value) ordered[key] = value[key];
  }
  for (const key of Object.keys(value)) {
    if (!(key in ordered)) ordered[key] = value[key];
  }
  return ordered as T;
}

/** What every stored agent is: one shape, built once. */
export type StoredAgentBody = {
  name: string;
  system_prompt: string;
  /** Absent when the agent waits silently for the caller's first turn. */
  greeting?: string;
  voice: { voice_id: string };
  /** The voice's measured level, and only that (voice-parity ticket 37). */
  output: {
    volume: number;
    voice?: string;
    format?: StoredAudioFormat;
  };
  tools: RestTool[];
  /** Absent (or `[]` to revert) means the managed model. */
  llm?: LlmOverride[];
  input: {
    format?: StoredAudioFormat;
    /** Absent on a tenant with no configured languages (automatic detection). */
    language_codes?: string[];
    transcription_mode: string;
    transcription_prompt: string;
    keyterms: string[];
    voice_focus: string;
    voice_focus_threshold?: number;
    turn_detection: StoredTurnDetection;
  };
};

export type StoredAgentInput = {
  /** The remote agent's name, owned by the caller (demo row vs tenant row). */
  name: string;
  /** The agent's content: rules, mission, recognition vocabulary, language. */
  config: AgentConfig;
  profile: AgentProfile;
  /**
   * Session mechanics override. Production callers omit it and get the Turn
   * preset; only the demo latency experiment (`:exp`) passes windows.
   */
  turnTaking?: TurnTaking;
};

/**
 * Build the body every stored agent runs. Pure: every caller - the demo's
 * refresh and the tenant deployment job - gets the same shape, and only the
 * profile plus the builder-owned mechanics differ.
 */
export function buildStoredAgent(input: StoredAgentInput): StoredAgentBody {
  const { name, config, profile } = input;
  assertAllowedAgentProfile(profile);

  const greeting = profile.greeting !== false;
  const focus = profile.microphoneFocus;
  const languageCodes = languagePolicy(config, profile.persona);
  const format = profile.format ?? null;

  const body: StoredAgentBody = {
    name,
    system_prompt: compileSystemPrompt(config),
    ...(greeting ? { greeting: config.greeting } : {}),
    voice: { voice_id: config.voiceId },
    input: {
      ...(format ? { format: { ...format } } : {}),
      transcription_mode: TRANSCRIPTION_MODE,
      transcription_prompt: buildAgentTranscriptionPrompt(config),
      keyterms: buildAgentKeyterms(config),
      voice_focus: focus.mode,
      ...(focus.threshold !== undefined
        ? { voice_focus_threshold: focus.threshold }
        : {}),
      turn_detection: turnDetectionFor(profile.persona, input.turnTaking),
      ...(languageCodes ? { language_codes: languageCodes } : {}),
    },
    output: format
      ? {
          voice: config.voiceId,
          format: { ...format },
          volume: voiceOutputVolume(config.voiceId),
        }
      : { volume: voiceOutputVolume(config.voiceId) },
    tools: profile.tools.map((tool) => ({ ...tool })),
    ...(profile.modelOverride ? { llm: profile.modelOverride.map((llm) => ({ ...llm })) } : {}),
  };

  return {
    ...inWireOrder(body, BODY_WIRE_ORDER[profile.persona]),
    input: inWireOrder(body.input, INPUT_WIRE_ORDER[profile.persona]),
  };
}

/**
 * Canonical JSON for a body fingerprint. Sorted keys and trimmed `undefined`,
 * so a fingerprint moves only when the body does. The one fingerprint
 * (`agentBodyFingerprint` in `./fingerprint`) hashes both paths with it.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
