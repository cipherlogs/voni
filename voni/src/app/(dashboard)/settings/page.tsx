import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSettings,
} from "@/lib/db/schema";
import { organization } from "@/lib/db/auth-schema";
import { requireCtxOrRedirect } from "@/lib/session";
import { getPlatformConfig } from "@/lib/platform/config";
import { credentialSummary } from "@/lib/platform/credentials";
import { listAccounts } from "@/lib/platform/llm-accounts";
import {
  CREDENTIAL_NAMES,
  LLM_PROVIDER_IDS,
  type CredentialName,
  type CredentialSummary,
} from "@/lib/platform/types";
import { SettingsView } from "@/components/settings-view";
import { CardListSkeleton, PageHeaderSkeleton } from "@/components/page-skeletons";
import { PROVIDER_CATALOG } from "@/lib/providers/registry";
import { getConnectedProviderIds } from "@/lib/providers/store";
import { getCopilotVoicePrefs } from "./actions";

/**
 * Structural shell: heading + skeleton prerender without awaiting any data
 * (page-skeletons pieces per DESIGN.md §4 — one canonical composition).
 * The tab structure arrives with the resolved view; the skeleton holds the
 * layout until the single data leaf below resolves (Task 8 contract).
 */
function SettingsShellFallback() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <PageHeaderSkeleton />
      <CardListSkeleton rows={3} />
    </div>
  );
}

/**
 * Authorized data leaf: every read stays fresh behind this single boundary.
 * One boundary (not per-section) so unrelated service readiness resolving
 * never remounts the form and dirty inputs survive.
 */
async function SettingsData() {
  const ctx = await requireCtxOrRedirect("/settings");
  const [[workspace], [settings], voicePrefs, connectedProviderIds] = await Promise.all([
    db.select({ name: organization.name }).from(organization).where(eq(organization.id, ctx.organizationId)).limit(1),
    db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, ctx.organizationId)).limit(1),
    getCopilotVoicePrefs(),
    getConnectedProviderIds(ctx.organizationId),
  ]);

  const summaries = await Promise.all(CREDENTIAL_NAMES.map(async (name) => [name, await credentialSummary(name)] as const));
  const summaryMap = Object.fromEntries(
    summaries.map(([name, value]) => [name, { ...value, updatedAt: value.updatedAt?.toISOString() }]),
  ) as Record<CredentialName, CredentialSummary & { updatedAt?: string }>;
  const llmAccountLists = await Promise.all(LLM_PROVIDER_IDS.map((id) => listAccounts(id)));
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

  return (
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
      providerCatalog={PROVIDER_CATALOG}
      connectedProviderIds={connectedProviderIds}
    />
  );
}

export default function SettingsPage() {
  return (
    <div data-testid="settings-shell" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account, workspace, and service readiness.</p>
      </div>
      <Suspense fallback={<SettingsShellFallback />}>
        <SettingsData />
      </Suspense>
    </div>
  );
}
