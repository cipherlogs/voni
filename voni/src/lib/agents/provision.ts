import type { AgentConfig } from "./config";
import { compileVoiceTools, toRestTool } from "@/lib/tools/definitions";
import {
  buildStoredAgent,
  type AgentProfile,
  type StoredAgentBody,
  type StoredAudioFormat,
} from "./body";
import { agentBodyFingerprint, readBackAgentBody } from "./fingerprint";
import { resolveCredential } from "@/lib/platform/credentials";

export { stableJson } from "./body";

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type AgentDeploymentResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

/** Every tenant deployment is a phone call: the platform's μ-law, 8 kHz. */
export const TENANT_AUDIO_FORMAT: StoredAudioFormat = {
  encoding: "audio/pcmu",
  sample_rate: 8000,
};

/**
 * The tenant's persona/platform profile: the one visible line where a tenant
 * differs from the demo. Everything else — rules, turn-taking, recognition
 * vocabulary, language policy — comes from `buildStoredAgent` (ADR-0006).
 */
export function tenantAgentProfile(config: AgentConfig): AgentProfile {
  return {
    persona: "tenant",
    platform: "phone",
    format: TENANT_AUDIO_FORMAT,
    // PSTN callers are on handsets/speakerphone, so far-field isolation fits
    // the mic.
    microphoneFocus: { mode: "far-field", threshold: 0.8 },
    // REST shape (no `type`): the Agents API tool object has no such field —
    // sending it risks the tool being dropped while the prompt still
    // mentions it. See `toRestTool`.
    tools: compileVoiceTools(config).map(toRestTool),
  };
}

export function storedAgentBody(name: string, config: AgentConfig): StoredAgentBody {
  return buildStoredAgent({ name, config, profile: tenantAgentProfile(config) });
}

/**
 * The tenant deployment fingerprint: the whole stored body, hashed by the one
 * function the demo refresh also uses (voice-parity ticket 62).
 *
 * Everything the body carries is covered, including the per-voice level and
 * the model override the old field subset omitted. A mismatch — or a
 * pre-fingerprint null — means the remote copy is stale and is owed a redeploy.
 */
export function deploymentFingerprint(name: string, config: AgentConfig): string {
  return agentBodyFingerprint(storedAgentBody(name, config));
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
  const expected = agentBodyFingerprint(
    readBackAgentBody(storedAgentBody(name, config)),
  );
  for (const candidate of candidates) {
    const response = await fetch(`${AGENTS_URL}/${encodeURIComponent(candidate.id)}`, {
      headers: { Authorization: authorization },
    });
    if (!response.ok) continue;
    const remote = (await response.json()) as Record<string, unknown>;
    const actual = agentBodyFingerprint(readBackAgentBody(remote));
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
