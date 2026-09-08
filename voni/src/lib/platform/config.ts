import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformConfiguration } from "@/lib/db/schema";
import { secret } from "@/lib/env";
import {
  DEFAULT_PLATFORM_CONFIG,
  LLM_PROVIDER_IDS,
  type LlmProviderId,
  type PlatformConfigValues,
} from "./types";

function validOrder(value: unknown): LlmProviderId[] {
  if (!Array.isArray(value)) return [...LLM_PROVIDER_IDS];
  const allowed = new Set<string>(LLM_PROVIDER_IDS);
  const unique = [...new Set(value.filter((item): item is string => typeof item === "string"))]
    .filter((item): item is LlmProviderId => allowed.has(item));
  return unique.length ? unique : [...LLM_PROVIDER_IDS];
}

export async function getPlatformConfig(): Promise<PlatformConfigValues> {
  const [row] = await db
    .select()
    .from(platformConfiguration)
    .where(eq(platformConfiguration.id, "default"))
    .limit(1);
  const base = row
    ? { ...row, llmProviderOrder: validOrder(row.llmProviderOrder) }
    : null;
  return {
    groqModel: base?.groqModel || (await secret("GROQ_MODEL")) || DEFAULT_PLATFORM_CONFIG.groqModel,
    cerebrasModel:
      base?.cerebrasModel || (await secret("CEREBRAS_MODEL")) || DEFAULT_PLATFORM_CONFIG.cerebrasModel,
    geminiModel:
      base?.geminiModel || (await secret("GEMINI_MODEL")) || DEFAULT_PLATFORM_CONFIG.geminiModel,
    openrouterModel:
      base?.openrouterModel ||
      (await secret("OPENROUTER_MODEL")) ||
      DEFAULT_PLATFORM_CONFIG.openrouterModel,
    llmProviderOrder: base?.llmProviderOrder ?? validOrder((await secret("LLM_PROVIDER_ORDER"))?.split(",")),
    telnyxConnectionId: base?.telnyxConnectionId || (await secret("TELNYX_CONNECTION_ID")) || null,
    telnyxCallerNumber: base?.telnyxCallerNumber || (await secret("TELNYX_CALLER_NUMBER")) || null,
    cartesiaVoiceId: base?.cartesiaVoiceId || (await secret("CARTESIA_VOICE_ID")) || null,
    bridgeOrganizationId: base?.bridgeOrganizationId ?? null,
    bridgeAgentId: base?.bridgeAgentId ?? null,
  };
}

export async function savePlatformConfig(values: PlatformConfigValues, userId: string) {
  const now = new Date();
  await db
    .insert(platformConfiguration)
    .values({ id: "default", ...values, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: platformConfiguration.id,
      set: { ...values, updatedBy: userId, updatedAt: now },
    });
  return getPlatformConfig();
}
