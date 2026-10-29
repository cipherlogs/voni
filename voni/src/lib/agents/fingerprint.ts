import { createHash } from "node:crypto";
import { stableJson, type StoredAgentBody } from "./body";

/**
 * The one stored-agent fingerprint (voice-parity ticket 62, ADR-0006).
 *
 * ── One function, two refresh paths ───────────────────────────────────────
 * The demo refresh (`demoAgentFingerprint`) and the tenant deployment
 * (`deploymentFingerprint`) both call this. Before 62 the demo hashed its whole
 * body while the tenant hashed a field subset that predated the model
 * override: a tenant's `llm` could change and its stored fingerprint would not,
 * so the remote agent kept running the old model until something else moved.
 * A fix landed on one path and stopped. There is now one input shape — the
 * `StoredAgentBody` the single builder returns — so a body difference is a
 * fingerprint difference on both paths or on neither.
 *
 * ── What is covered ───────────────────────────────────────────────────────
 * Everything on the body, because the body is hashed whole: `name`,
 * `system_prompt`, greeting presence and text, `voice.voice_id`, the
 * per-voice `output.volume` and optional output `voice`/`format`, `tools`
 * (every field), the `llm` model override, and every `input` field — format,
 * language codes, transcription mode and prompt, keyterms, microphone focus
 * and threshold, turn detection. Nothing is projected out first.
 *
 * `llm` present, `[]` (the documented revert) and absent are three different
 * bodies, so they fingerprint differently. That is the seam ticket 63 uses:
 * the removal path changes what body is sent when an override is absent, and
 * this function needs no change for it — it hashes whatever is sent.
 *
 * ── Canonical form ────────────────────────────────────────────────────────
 * `stableJson` sorts keys and drops `undefined`, so a wire-order difference or
 * an explicitly-`undefined` field never moves the fingerprint; only content
 * does.
 */
export function agentBodyFingerprint(
  body: StoredAgentBody,
  /**
   * The credential (account) the agent is stored under. A stored agent is
   * account-scoped: the same body under another API key is a different remote
   * agent, so the demo path mixes the key in. Tenants pass nothing today.
   */
  account = "",
): string {
  return createHash("sha256")
    .update(stableJson(body))
    .update(`\0${account}`)
    .digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Read responses return tool ids and `last_set_at`, never authored fields. */
function readBackTool(tool: unknown): unknown {
  if (tool === null || typeof tool !== "object") return tool;
  const { id: _id, last_set_at: _lastSetAt, ...rest } = tool as Record<string, unknown>;
  void _id;
  void _lastSetAt;
  return rest;
}

/** `llm.api_key` is write-only: the platform never returns it. */
function readBackLlm(llm: unknown): unknown {
  if (llm === null || typeof llm !== "object") return llm;
  const { api_key: _apiKey, ...rest } = llm as Record<string, unknown>;
  void _apiKey;
  return rest;
}

/**
 * The shape a stored body takes when read back from the platform, used only
 * for the ambiguous-create check in `reconcileRecentAgent` — never as a
 * fingerprint input. That check compares the read-back copy with the body that
 * was sent, and the platform assigns ids/timestamps and never returns write-only
 * values, so those are the only fields removed here. Every authored field is
 * projected, which is what the pre-62 subset got wrong: it was this read-back
 * projection and it dropped `llm` from the deployment fingerprint too.
 */
export function readBackAgentBody(
  value: Record<string, unknown>,
): StoredAgentBody {
  const voice = asRecord(value.voice);
  const input = asRecord(value.input);
  const output = asRecord(value.output);
  const llm = Array.isArray(value.llm) ? value.llm.map(readBackLlm) : undefined;
  return {
    name: value.name,
    system_prompt: value.system_prompt,
    ...(value.greeting !== undefined ? { greeting: value.greeting } : {}),
    voice: { voice_id: voice.voice_id },
    input: {
      format: input.format,
      language_codes: input.language_codes,
      transcription_mode: input.transcription_mode,
      transcription_prompt: input.transcription_prompt,
      keyterms: input.keyterms,
      voice_focus: input.voice_focus,
      voice_focus_threshold: input.voice_focus_threshold,
      turn_detection: input.turn_detection,
    },
    output: {
      voice: output.voice,
      format: output.format,
      volume: output.volume,
    },
    tools: Array.isArray(value.tools) ? value.tools.map(readBackTool) : [],
    ...(llm !== undefined ? { llm } : {}),
  } as StoredAgentBody;
}

/*
 * Compile-time guards: a new field on the body must be projected here (or the
 * guard must be edited deliberately). The 62 bug was a projection that
 * silently omitted a field, so a new field may not slip out the same way.
 */
const _topLevelCovered: Record<
  Exclude<
    keyof StoredAgentBody,
    "name" | "system_prompt" | "greeting" | "voice" | "input" | "output" | "tools" | "llm"
  >,
  never
> = {};
const _inputCovered: Record<
  Exclude<
    keyof StoredAgentBody["input"],
    | "format"
    | "language_codes"
    | "transcription_mode"
    | "transcription_prompt"
    | "keyterms"
    | "voice_focus"
    | "voice_focus_threshold"
    | "turn_detection"
  >,
  never
> = {};
const _outputCovered: Record<
  Exclude<keyof StoredAgentBody["output"], "voice" | "format" | "volume">,
  never
> = {};
void _topLevelCovered;
void _inputCovered;
void _outputCovered;
