import { db } from "@/lib/db";
import { integrationChecks } from "@/lib/db/schema";
import { getPlatformConfig } from "./config";
import { resolveCredential } from "./credentials";
import { getAccountValue, usableAccounts } from "./llm-accounts";
import type { LlmProviderId, PlatformConfigValues } from "./types";

export type IntegrationService =
  | LlmProviderId
  | "assemblyai"
  | "telnyx"
  | "cartesia";

type Fetch = typeof fetch;

const LLM_ENDPOINTS: Record<LlmProviderId, string> = {
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
};

function isLlmService(service: IntegrationService): service is LlmProviderId {
  return service === "groq" || service === "cerebras" || service === "gemini" || service === "openrouter";
}

function safeError(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") return "The request timed out.";
  if (error instanceof Error && /^Service returned HTTP \d{3}\.$/.test(error.message)) {
    return error.message;
  }
  return "The service could not be reached.";
}

async function expectJson(response: Response) {
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function runLlmProbe(
  provider: LlmProviderId,
  credential: string,
  config: PlatformConfigValues,
  fetcher: Fetch,
) {
  const model = config[`${provider}Model` as keyof typeof config] as string;
  const response = await fetcher(`${LLM_ENDPOINTS[provider]}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply OK" }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await expectJson(response)) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof body.choices?.[0]?.message?.content !== "string") {
    throw new Error("The service returned an unexpected response.");
  }
}

export async function probeIntegration(
  service: IntegrationService,
  credential: string,
  config: PlatformConfigValues,
  fetcher: Fetch = fetch,
) {
  if (!credential) throw new Error("Service returned HTTP 503.");
  if (isLlmService(service)) {
    return runLlmProbe(service, credential, config, fetcher);
  }

  if (service === "assemblyai") {
    const body = (await expectJson(
      await fetcher("https://agents.assemblyai.com/v1/agents", {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(10_000),
      }),
    )) as { items?: unknown[] };
    if (!Array.isArray(body.items)) throw new Error("The service returned an unexpected response.");
    return;
  }

  if (service === "telnyx") {
    const headers = { Authorization: `Bearer ${credential}` };
    await expectJson(
      await fetcher("https://api.telnyx.com/v2/balance", {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!config.telnyxConnectionId) throw new Error("Service returned HTTP 422.");
    const application = (await expectJson(
      await fetcher(
        `https://api.telnyx.com/v2/call_control_applications/${encodeURIComponent(config.telnyxConnectionId)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      ),
    )) as { data?: { id?: unknown } };
    if (typeof application.data?.id !== "string") {
      throw new Error("The service returned an unexpected response.");
    }
    return;
  }

  const body = (await expectJson(
    await fetcher("https://api.cartesia.ai/voices?limit=1", {
      headers: {
        "X-API-Key": credential,
        "Cartesia-Version": "2025-04-16",
      },
      signal: AbortSignal.timeout(10_000),
    }),
  )) as { data?: unknown[] };
  if (!Array.isArray(body.data)) throw new Error("The service returned an unexpected response.");
}

async function runServiceCheck(service: IntegrationService, fetcher: Fetch, accountId?: string) {
  const config = await getPlatformConfig();
  if (isLlmService(service)) {
    const credential = accountId
      ? (await getAccountValue(accountId))?.value
      : (await usableAccounts(service))[0]?.value;
    return probeIntegration(service, credential ?? "", config, fetcher);
  }

  if (service === "assemblyai") {
    const credential = await resolveCredential("assemblyai_api_key");
    return probeIntegration(service, credential.value ?? "", config, fetcher);
  }

  if (service === "telnyx") {
    const credential = await resolveCredential("telnyx_api_key");
    return probeIntegration(service, credential.value ?? "", config, fetcher);
  }

  const credential = await resolveCredential("cartesia_api_key");
  return probeIntegration(service, credential.value ?? "", config, fetcher);
}

export async function testIntegration(
  service: IntegrationService,
  userId: string,
  fetcher: Fetch = fetch,
  accountId?: string,
) {
  const startedAt = Date.now();
  let status: "passed" | "failed" = "passed";
  let error: string | null = null;
  try {
    await runServiceCheck(service, fetcher, accountId);
  } catch (cause) {
    status = "failed";
    error = safeError(cause);
  }
  const result = { service, status, latencyMs: Date.now() - startedAt, error, testedAt: new Date() };
  try {
    await db.insert(integrationChecks).values({
      service,
      status,
      latencyMs: result.latencyMs,
      error,
      testedBy: userId,
      testedAt: result.testedAt,
    });
  } catch (cause) {
    // History is observability, not the verdict: a failed write must not
    // turn a completed probe into a crashed test. The job row still carries
    // the full result.
    console.warn(`[platform] connection-test history write failed for ${service}`, cause);
  }
  return result;
}
