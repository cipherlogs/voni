import { z } from "zod";
import { generateText } from "ai";
import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from "@ai-sdk/openai";
import { META_PROVIDER, providerChain, type Provider } from "./providers";
import {
  markAccountFailure,
  markAccountSuccess,
  usableAccounts,
  type UsableLlmAccount,
} from "@/lib/platform/llm-accounts";
import { secret } from "@/lib/env";

/**
 * Meta's environment-backed Responses API is attempted first. If it is absent
 * or fails, the OpenAI-compatible chat client walks the database-managed free
 * provider chain and each provider's operator-added accounts.
 *
 * The contract callers care about: `generateJSON` returns validated, typed data
 * or throws. An account that is rate-limited, erroring, slow, or simply bad at
 * JSON is treated identically — log it, put it on cooldown, move to the next
 * account, and once a provider has none left, move to the next provider. A 200
 * response carrying malformed or schema-violating JSON is a *failure*, not a
 * success, so schema validation happens inside the fallback loop rather than
 * after it — important on free-tier models that sometimes ramble past the JSON.
 */

export class NoProviderAvailableError extends Error {
  constructor(attempts: Attempt[], providers: Provider[]) {
    const detail =
      attempts.length === 0
        ? `No LLM provider is configured. Set META_API_KEY for the environment-only ${META_PROVIDER.label}, or add a free-provider account for one of: ${providers
            .map((p) => p.label)
            .join(", ")} through the server-side operator credential workflow.`
        : `Every configured LLM attempt failed (${attempts.length}):\n` +
          attempts.map((a) => `  - ${a.provider}: ${a.error}`).join("\n");
    super(detail);
    this.name = "NoProviderAvailableError";
  }
}

type Attempt = { provider: string; error: string };

export type GenerateOptions = {
  system: string;
  user: string;
  /** Free-tier models are small; keep this tight or they ramble past the JSON. */
  maxTokens?: number;
  /** Config generation should be reproducible, not creative (default 0.2). */
  temperature?: number;
  /**
   * Separate request budget for the Meta attempt. Meta runs high-effort
   * reasoning that can spend a small shared budget before producing visible
   * text; free providers keep the tight shared budget.
   */
  metaMaxTokens?: number;
  /** Per-provider budget. The chain as a whole can take longer. */
  timeoutMs?: number;
};

export type GenerateResult<T> = {
  data: T;
  /** Which provider actually served it — surfaced in the UI and logs. */
  provider: string;
  model: string;
  latencyMs: number;
};

const DEFAULTS = {
  maxTokens: 2048,
  // Config generation should be reproducible, not creative.
  temperature: 0.2,
  timeoutMs: 30_000,
};

type ResolvedOptions = Required<Omit<GenerateOptions, "metaMaxTokens">> &
  Pick<GenerateOptions, "metaMaxTokens">;

type LlmDependencies = {
  metaApiKey: () => Promise<string | undefined>;
  providerChain: () => Promise<Provider[]>;
  usableAccounts: (provider: Provider["id"]) => Promise<UsableLlmAccount[]>;
  markAccountSuccess: (accountId: string) => Promise<void>;
  markAccountFailure: (accountId: string, reason: string) => Promise<void>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  warn: (message: string) => void;
};

const DEFAULT_DEPENDENCIES: LlmDependencies = {
  metaApiKey: () => secret("META_API_KEY"),
  providerChain,
  usableAccounts,
  markAccountSuccess,
  markAccountFailure,
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
  warn: (message) => console.warn(message),
};

function sanitizeErrorText(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const sensitive of secrets) {
    if (sensitive) sanitized = sanitized.split(sensitive).join("[redacted]");
  }
  sanitized = sanitized
    .replace(
      /((?:\\?["'])?(?:(?:reasoning\.)?encrypted_content|encryptedContent)(?:\\?["'])?)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.slice(0, 500);
}

function failureReason(error: unknown, secrets: string[] = []): string {
  if (error instanceof z.ZodError) {
    const fields = error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");
    return `returned JSON that failed validation${fields ? ` (${fields})` : ""}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorText(message, secrets);
}

async function callMetaProvider(
  apiKey: string,
  opts: ResolvedOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const meta = createOpenAI({
    name: META_PROVIDER.id,
    baseURL: META_PROVIDER.baseUrl,
    apiKey,
    fetch: fetchImpl,
  });
  // Unset means "same as the shared budget": callers that never heard of
  // metaMaxTokens behave exactly as before it existed.
  const metaBudget = opts.metaMaxTokens ?? opts.maxTokens;
  const { text, finishReason } = await generateText({
    model: meta.responses(META_PROVIDER.model),
    system: opts.system,
    prompt: opts.user,
    maxOutputTokens: Math.min(metaBudget, META_PROVIDER.outputLimit),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(opts.timeoutMs),
    providerOptions: {
      openai: {
        forceReasoning: META_PROVIDER.reasoning.enabled,
        reasoningEffort: META_PROVIDER.reasoning.effort,
        reasoningSummary: META_PROVIDER.reasoning.summary,
        include: [...META_PROVIDER.reasoning.include],
      } satisfies OpenAIResponsesProviderOptions,
    },
  });
  if (!text) {
    // A length stop with high-effort reasoning means the budget went to
    // thinking, not to output — report that specifically instead of the
    // generic "no text content", so the operator knows to retry rather than
    // reword the brief.
    if (finishReason === "length") {
      throw new Error(
        "Meta spent its reasoning budget before producing output. Retry — the next attempt starts fresh.",
      );
    }
    throw new Error("response had no text content");
  }
  return text;
}

/**
 * Ask one provider account for a chat completion. Throws on any non-2xx or timeout.
 */
async function callProvider(
  provider: Provider,
  account: UsableLlmAccount,
  opts: ResolvedOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  // AbortSignal.timeout is the reason there's no manual clearTimeout dance;
  // it's supported on Workers, Node 18+, and the Next dev server alike.
  const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      ...(provider.supportsJsonMode
        ? { response_format: { type: "json_object" } }
        : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    if (json.choices?.[0]?.finish_reason === "length") {
      throw new Error("response was cut off at the token limit");
    }
    throw new Error("response had no message content");
  }
  return content;
}

/**
 * Pull a JSON object out of a model response.
 *
 * Providers without real JSON mode (OpenRouter's free pool, notably) wrap the
 * object in prose or a ```json fence even when told not to. Slicing to the
 * outermost braces recovers those instead of spending a fallback hop on a
 * response that was substantively correct.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("no JSON object found in response");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Generate a JSON value matching `schema`, falling through the provider chain.
 *
 * Throws `NoProviderAvailableError` only once every configured provider has
 * been tried, with each one's reason attached — so the failure message says
 * what to fix rather than just "generation failed".
 */
export async function generateJSON<T>(
  schema: z.ZodType<T>,
  opts: GenerateOptions,
): Promise<GenerateResult<T>> {
  return generateJSONWithDependencies(schema, opts, DEFAULT_DEPENDENCIES);
}

async function generateJSONWithDependencies<T>(
  schema: z.ZodType<T>,
  opts: GenerateOptions,
  dependencies: LlmDependencies,
): Promise<GenerateResult<T>> {
  const settings: ResolvedOptions = { ...DEFAULTS, ...opts };
  const attempts: Attempt[] = [];
  const metaApiKey = await dependencies.metaApiKey();

  if (metaApiKey) {
    const startedAt = dependencies.now();
    try {
      const raw = await callMetaProvider(
        metaApiKey,
        settings,
        dependencies.fetch,
      );
      return {
        data: schema.parse(extractJson(raw)),
        provider: META_PROVIDER.label,
        model: META_PROVIDER.model,
        latencyMs: dependencies.now() - startedAt,
      };
    } catch (error) {
      const reason = failureReason(error, [metaApiKey]);
      attempts.push({ provider: META_PROVIDER.label, error: reason });
      dependencies.warn(
        `[llm] ${META_PROVIDER.label} failed, falling through: ${reason}`,
      );
    }
  }

  const providers = await dependencies.providerChain();

  for (const provider of providers) {
    const accounts = await dependencies.usableAccounts(provider.id);
    if (accounts.length === 0) {
      // Not an error worth reporting — no account added yet, or all are
      // currently cooling down; either way there's nothing else to try here.
      continue;
    }

    for (const account of accounts) {
      const label = `${provider.label} (${account.label})`;
      const startedAt = dependencies.now();
      try {
        const raw = await callProvider(
          provider,
          account,
          settings,
          dependencies.fetch,
        );
        const parsed = schema.parse(extractJson(raw));
        await dependencies.markAccountSuccess(account.id);
        return {
          data: parsed,
          provider: label,
          model: provider.model,
          latencyMs: dependencies.now() - startedAt,
        };
      } catch (error) {
        const reason = failureReason(error, [account.value]);
        attempts.push({ provider: label, error: reason });
        dependencies.warn(`[llm] ${label} failed, falling through: ${reason}`);
        await dependencies.markAccountFailure(account.id, reason);
      }
    }
  }

  throw new NoProviderAvailableError(attempts, providers);
}

export const __llmTest = {
  generateJSONWithDependencies,
};
