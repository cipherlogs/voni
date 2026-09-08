// LLM provider keys (groq/cerebras/gemini/openrouter) are NOT here — they use
// the multi-account rotation system in `./llm-accounts.ts` instead of a single
// value per name. This list is for the remaining single-account services.
export const CREDENTIAL_NAMES = [
  "assemblyai_api_key",
  "telnyx_api_key",
  "cartesia_api_key",
] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];
export type CredentialSource = "database" | "environment" | "missing";

export const CREDENTIAL_ENV: Record<CredentialName, string> = {
  assemblyai_api_key: "ASSEMBLYAI_API_KEY",
  telnyx_api_key: "TELNYX_API_KEY",
  cartesia_api_key: "CARTESIA_API_KEY",
};

export const LLM_PROVIDER_IDS = ["groq", "cerebras", "gemini", "openrouter"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export type ResolvedCredential = {
  value?: string;
  source: CredentialSource;
  keyVersion?: number;
  updatedBy?: string;
  updatedAt?: Date;
};

export type CredentialSummary = Omit<ResolvedCredential, "value"> & {
  configured: boolean;
  maskedPreview?: string;
};

export type PlatformConfigValues = {
  groqModel: string;
  cerebrasModel: string;
  geminiModel: string;
  openrouterModel: string;
  llmProviderOrder: LlmProviderId[];
  telnyxConnectionId: string | null;
  telnyxCallerNumber: string | null;
  cartesiaVoiceId: string | null;
  bridgeOrganizationId: string | null;
  bridgeAgentId: string | null;
};

export const DEFAULT_PLATFORM_CONFIG: PlatformConfigValues = {
  groqModel: "llama-3.3-70b-versatile",
  cerebrasModel: "llama-3.3-70b",
  geminiModel: "gemini-2.0-flash",
  openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
  llmProviderOrder: [...LLM_PROVIDER_IDS],
  telnyxConnectionId: null,
  telnyxCallerNumber: null,
  cartesiaVoiceId: null,
  bridgeOrganizationId: null,
  bridgeAgentId: null,
};

export function isCredentialName(value: string): value is CredentialName {
  return (CREDENTIAL_NAMES as readonly string[]).includes(value);
}
