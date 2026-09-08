import { compileSystemPrompt } from "./compile";
import type { AgentConfig } from "./config";
import { compileVoiceTools } from "@/lib/tools/definitions";
import { resolveCredential } from "@/lib/platform/credentials";

const AGENTS_URL = "https://agents.assemblyai.com/v1/agents";

export type AgentDeploymentResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

function storedAgentBody(name: string, config: AgentConfig) {
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
    if (!remoteId) return requestAgent("POST", name, config);
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
