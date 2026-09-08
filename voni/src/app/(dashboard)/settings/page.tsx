import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  integrationChecks,
  organizationSettings,
} from "@/lib/db/schema";
import { organization } from "@/lib/db/auth-schema";
import { secret } from "@/lib/env";
import { requireCtxOrRedirect } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/platform/admin";
import { getPlatformConfig } from "@/lib/platform/config";
import { credentialSummary } from "@/lib/platform/credentials";
import { listAccounts, type LlmAccountSummary } from "@/lib/platform/llm-accounts";
import {
  CREDENTIAL_NAMES,
  LLM_PROVIDER_IDS,
  type CredentialName,
  type CredentialSummary,
  type LlmProviderId,
} from "@/lib/platform/types";
import { SettingsView } from "@/components/settings-view";
import { getCopilotVoicePrefs } from "./actions";

export default async function SettingsPage() {
  const ctx = await requireCtxOrRedirect("/settings");
  const [[workspace], [settings], admin, voicePrefs] = await Promise.all([
    db.select({ name: organization.name }).from(organization).where(eq(organization.id, ctx.organizationId)).limit(1),
    db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, ctx.organizationId)).limit(1),
    isPlatformAdmin(ctx.email),
    getCopilotVoicePrefs(),
  ]);

  const summaries = await Promise.all(CREDENTIAL_NAMES.map(async (name) => [name, await credentialSummary(name)] as const));
  const summaryMap = Object.fromEntries(
    summaries.map(([name, value]) => [name, { ...value, updatedAt: value.updatedAt?.toISOString() }]),
  ) as Record<CredentialName, CredentialSummary & { updatedAt?: string }>;
  const llmAccountLists = await Promise.all(LLM_PROVIDER_IDS.map((id) => listAccounts(id)));
  const serializeAccount = (account: LlmAccountSummary) => ({
    ...account,
    cooldownUntil: account.cooldownUntil?.toISOString() ?? null,
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    updatedAt: account.updatedAt.toISOString(),
  });
  const llmAccounts = Object.fromEntries(
    LLM_PROVIDER_IDS.map((id, index) => [id, llmAccountLists[index].map(serializeAccount)]),
  ) as Record<LlmProviderId, ReturnType<typeof serializeAccount>[]>;
  const llmConfigured = llmAccountLists.some((accounts) => accounts.some((account) => account.enabled));
  const platformConfig = await getPlatformConfig();
  const services = [
    { id: "voice", label: "Voice agents", configured: summaryMap.assemblyai_api_key.configured },
    {
      id: "phone",
      label: "Phone calls",
      configured:
        summaryMap.telnyx_api_key.configured &&
        Boolean(platformConfig.telnyxConnectionId && platformConfig.telnyxCallerNumber),
    },
    { id: "llm", label: "AI generation", configured: llmConfigured },
    {
      id: "voice-note",
      label: "Voice notes",
      configured: summaryMap.cartesia_api_key.configured && Boolean(platformConfig.cartesiaVoiceId),
    },
  ];

  let platform = null;
  if (admin) {
    const [checks, organizations, savedAgents, bootstrap] = await Promise.all([
      db.select().from(integrationChecks).orderBy(desc(integrationChecks.testedAt)).limit(50),
      db.select({ id: organization.id, name: organization.name }).from(organization),
      db
        .select({ id: agents.id, name: agents.name, organizationId: agents.organizationId })
        .from(agents)
        .where(isNotNull(agents.assemblyaiAgentId)),
      Promise.all(
        [
          "DATABASE_URL",
          "BETTER_AUTH_SECRET",
          "BETTER_AUTH_URL",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "VONI_ADMIN_EMAILS",
          "VONI_CREDENTIALS_ENCRYPTION_KEY",
          "VONI_API_URL",
          "VONI_TOOL_SECRET",
          "PUBLIC_HOST",
        ].map(
          async (name) => ({ name, configured: Boolean(await secret(name)) }),
        ),
      ),
    ]);
    const latestChecks = Object.values(
      checks.reduce<Record<string, (typeof checks)[number]>>((result, check) => {
        if (!result[check.service]) result[check.service] = check;
        return result;
      }, {}),
    ).map((check) => ({ ...check, testedAt: check.testedAt.toISOString() }));
    platform = {
      credentials: summaryMap,
      llmAccounts,
      config: platformConfig,
      checks: latestChecks,
      organizations,
      agents: savedAgents,
      bootstrap,
    };
  }

  return (
    <>
      <SettingsView
      user={{ name: ctx.name, email: ctx.email, image: ctx.image }}
      workspace={{
        name: workspace?.name ?? "Workspace",
        timezone: settings?.timezone ?? "Asia/Dubai",
        humanTransferNumber: settings?.humanTransferNumber ?? "",
        canEdit: ctx.role === "owner",
      }}
      services={services}
      voicePrefs={voicePrefs}
      platform={platform}
    />
    </>
  );
}
