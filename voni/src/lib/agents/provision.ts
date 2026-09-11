import { compileSystemPrompt } from "./compile";
import type { AgentConfig } from "./config";
import { compileVoiceTools } from "@/lib/tools/definitions";
import { resolveCredential } from "@/lib/platform/credentials";

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type AgentDeploymentResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export function storedAgentBody(name: string, config: AgentConfig) {
  return {
    name,
    system_prompt: compileSystemPrompt(config),
    greeting: config.greeting,
    voice: { voice_id: config.voiceId },
    input: {
      format: { encoding: "audio/pcmu", sample_rate: 8000 },
      transcription_mode: "min_latency",
      turn_detection: {
        min_silence: 100,
        max_silence: 500,
        interrupt_response: true,
        interruption_delay: 0,
      },
      ...(config.languageCodes.length > 0
        ? { language_codes: config.languageCodes }
        : {}),
    },
    output: {
      voice: config.voiceId,
      format: { encoding: "audio/pcmu", sample_rate: 8000 },
    },
    tools: compileVoiceTools(config),
  };
}

function comparableAgent(value: Record<string, unknown>) {
  const voice = (value.voice ?? {}) as Record<string, unknown>;
  const input = (value.input ?? {}) as Record<string, unknown>;
  const output = (value.output ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(value.tools)
    ? value.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
        const rest = { ...(tool as Record<string, unknown>) };
        delete rest.id;
        return rest;
      })
    : [];
  return {
    name: value.name,
    system_prompt: value.system_prompt,
    greeting: value.greeting ?? null,
    voice: { voice_id: voice.voice_id },
    input: {
      format: input.format,
      transcription_mode: input.transcription_mode,
      turn_detection: input.turn_detection ?? null,
      language_codes: input.language_codes ?? [],
    },
    output: {
      voice: output.voice,
      format: output.format,
      volume: output.volume ?? null,
    },
    tools,
  };
}

function stableJson(value: unknown): string {
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

export function deploymentFingerprint(name: string, config: AgentConfig): string {
  return createHash("sha256")
    .update(stableJson(comparableAgent(storedAgentBody(name, config))))
    .digest("hex");
}

async function reconcileRecentAgent(
  authorization: string,
  name: string,
  config: AgentConfig,
): Promise<string | null> {
  const listResponse = await fetch(AGENTS_URL, {
    headers: { Authorization: authorization },
  });
  if (!listResponse.ok) return null;
  const payload = (await listResponse.json()) as
    | Array<{ id: string; name: string; created_at?: string; deleted_at?: string | null }>
    | { items?: Array<{ id: string; name: string; created_at?: string; deleted_at?: string | null }> };
  const items = Array.isArray(payload) ? payload : (payload.items ?? []);
  const cutoff = Date.now() - 30 * 60 * 1000;
  const candidates = items
    .filter((item) => item.name === name && !item.deleted_at && (!item.created_at || new Date(item.created_at).getTime() >= cutoff))
    .slice(0, 10);
  const expected = deploymentFingerprint(name, config);
  for (const candidate of candidates) {
    const response = await fetch(`${AGENTS_URL}/${encodeURIComponent(candidate.id)}`, {
      headers: { Authorization: authorization },
    });
    if (!response.ok) continue;
    const remote = (await response.json()) as Record<string, unknown>;
    const actual = createHash("sha256")
      .update(stableJson(comparableAgent(remote)))
      .digest("hex");
    if (actual === expected) return candidate.id;
  }
  return null;
}

async function requestAgent(
  method: "POST" | "PUT",
  name: string,
  config: AgentConfig,
  remoteId?: string | null,
) {
  const apiKey = (await resolveCredential("assemblyai_api_key")).value;
  if (!apiKey) {
    return { ok: false as const, error: "AssemblyAI is not configured." };
  }
  const response = await fetch(
    remoteId ? `${AGENTS_URL}/${encodeURIComponent(remoteId)}` : AGENTS_URL,
    {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(storedAgentBody(name, config)),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      `[agent-deployment] ${method} failed ${response.status}: ${detail.slice(0, 500)}`,
    );
    return {
      ok: false as const,
      error: "Voice deployment did not complete. The saved configuration is safe to retry.",
      status: response.status,
      uncertain: response.status >= 500,
    };
  }
  const record = (await response.json()) as { id: string };
  return { ok: true as const, agentId: record.id };
}

export async function provisionAgent(
  name: string,
  config: AgentConfig,
  remoteId?: string | null,
): Promise<AgentDeploymentResult> {
  try {
    if (!remoteId) {
      const apiKey = (await resolveCredential("assemblyai_api_key")).value;
      if (!apiKey) return { ok: false, error: "AssemblyAI is not configured." };
      try {
        const created = await requestAgent("POST", name, config);
        if (created.ok || !("uncertain" in created) || !created.uncertain) return created;
      } catch {
        // The provider may have accepted the POST before the connection failed.
      }
      const reconciled = await reconcileRecentAgent(`Bearer ${apiKey}`, name, config).catch(() => null);
      return reconciled
        ? { ok: true, agentId: reconciled }
        : { ok: false, error: "Voice deployment is unavailable. The saved configuration is safe to retry." };
    }
    const updated = await requestAgent("PUT", name, config, remoteId);
    // A remote agent may have been deleted from the AssemblyAI dashboard. A
    // retry should repair that state instead of failing forever on the stale id.
    if (!updated.ok && "status" in updated && updated.status === 404) {
      return requestAgent("POST", name, config);
    }
    return updated;
  } catch (error) {
    console.error("[agent-deployment] request failed", error);
    return {
      ok: false,
      error: "Voice deployment is unavailable. The saved configuration is safe to retry.",
    };
  }
}
import { createHash } from "node:crypto";

export type RemoteDeleteResult =
  | { ok: true; alreadyGone: boolean }
  | { ok: false; status: number; reason: "missing-key" | "refused" | "transport" };

/**
 * Delete a stored voice agent from AssemblyAI.
 *
 * DELETE /v1/agents/{agent_id} returns 204 with no body; 404 means already
 * gone and is fine. Any other outcome aborts so the local row is kept and
 * the delete is safe to retry.
 * (Docs: /voice-agents/voice-agent-api/api-spec/delete-agent)
 */
export async function deleteRemoteAgent(
  remoteId: string,
  deps?: { apiKey?: string | null; fetchFn?: typeof fetch },
): Promise<RemoteDeleteResult> {
  // `"apiKey" in deps` distinguishes an explicitly injected key (including
  // null for the missing-key path, used by tests) from production, which
  // resolves the credential.
  const apiKey =
    deps && "apiKey" in deps
      ? deps.apiKey
      : (await resolveCredential("assemblyai_api_key")).value;
  if (!apiKey) return { ok: false, status: 0, reason: "missing-key" };
  const fetchFn = deps?.fetchFn ?? fetch;
  try {
    const response = await fetchFn(
      `${AGENTS_URL}/${encodeURIComponent(remoteId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status === 404) return { ok: true, alreadyGone: true };
    if (response.ok) return { ok: true, alreadyGone: false };
    const detail = await response.text().catch(() => "");
    console.error(
      `[agent-deployment] DELETE failed ${response.status}: ${detail.slice(0, 500)}`,
    );
    return { ok: false, status: response.status, reason: "refused" };
  } catch (error) {
    console.error("[agent-deployment] delete request failed", error);
    return { ok: false, status: 0, reason: "transport" };
  }
}
