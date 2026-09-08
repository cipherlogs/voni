/**
 * The environment-only premium provider. It deliberately does not implement
 * `Provider`: `Provider.id` is restricted to database-managed account types,
 * while Meta is always attempted first when `META_API_KEY` exists.
 */
export const META_PROVIDER = {
  id: "meta",
  label: "Meta Model API",
  baseUrl: "https://api.meta.ai/v1",
  model: "muse-spark-1.3-contributor",
  contextLimit: 1_048_576,
  outputLimit: 131_072,
  input: ["text", "image", "pdf", "video"],
  output: ["text"],
  reasoning: {
    enabled: true,
    effort: "high",
    summary: "auto",
    include: ["reasoning.encrypted_content"],
  },
} as const;

/**
 * Database-managed free-tier LLM providers, tried in order until one answers.
 *
 * Every provider here exposes an OpenAI-compatible `/chat/completions`, so the
 * client in `./index.ts` is one code path rather than four SDKs. That
 * compatibility is also why this list can later serve the voice agent's custom
 * `llm` field (AssemblyAI accepts any OpenAI-compatible base_url + model),
 * which is the only real lever on the 1.26s think-time measured in HANDOFF (1x).
 *
 * Ordering is deliberate — fastest and most generous free tier first:
 *
 *  1. Groq      — the fastest inference of the four; generous free tier.
 *  2. Cerebras  — comparable speed, smaller free quota, good second opinion.
 *  3. Gemini    — largest free tier of the four, strongest at strict JSON.
 *  4. OpenRouter— aggregator backstop: if the three above are rate-limited or
 *                 down, its free model pool is the widest net we can cast.
 *
 * A provider with no usable account (none added yet, or all currently in
 * cooldown) is skipped silently, so operators can add accounts one at a time
 * and the chain just gets longer. If none are configured, callers get a clear
 * error naming every provider that would fix it. Within a provider, multiple
 * operator-added accounts (see `@/lib/platform/llm-accounts`) rotate with
 * sticky failover — see that module for the policy.
 */

export type Provider = {
  /** Stable id used in logs, in `LLM_PROVIDER_ORDER`, and as the account rotation key. */
  id: import("@/lib/platform/types").LlmProviderId;
  label: string;
  /** OpenAI-compatible base, without a trailing slash. */
  baseUrl: string;
  /** Free-tier model with the best instruction-following of what's offered. */
  model: string;
  /**
   * Whether the provider honours `response_format: { type: "json_object" }`.
   * When false we fall back to prompt-level JSON coercion plus parsing, which
   * is why `generateJSON` validates and re-tries down the chain on bad output.
   */
  supportsJsonMode: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    supportsJsonMode: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    supportsJsonMode: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    // Google ships an OpenAI-compatibility shim at this path; the native
    // endpoint has a different request shape and is deliberately not used.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    supportsJsonMode: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    supportsJsonMode: false,
  },
];

/**
 * The chain to walk, honouring an optional `LLM_PROVIDER_ORDER` override
 * (comma-separated ids, e.g. "gemini,groq"). Unknown ids are ignored rather
 * than throwing, so a typo degrades to the default order instead of taking the
 * feature down.
 */
export async function providerChain(): Promise<Provider[]> {
  const { getPlatformConfig } = await import("@/lib/platform/config");
  const config = await getPlatformConfig();
  const models = {
    groq: config.groqModel,
    cerebras: config.cerebrasModel,
    gemini: config.geminiModel,
    openrouter: config.openrouterModel,
  };
  const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
  const ordered = config.llmProviderOrder
    .map((id) => byId.get(id))
    .filter((p): p is Provider => Boolean(p));
  return (ordered.length > 0 ? ordered : PROVIDERS).map((provider) => ({
    ...provider,
    model: models[provider.id as keyof typeof models],
  }));
}
