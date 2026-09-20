import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
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
import { RouteBrief } from "@/components/copilot/route-brief";
import { SETTINGS_TABS, type SettingsTabValue } from "@/lib/settings-tabs";
import { settingsSectionTile } from "@/lib/settings-tiles";
import { buildServiceReadiness } from "@/lib/settings-badges";
import {
  AccountSection,
  AppearanceSection,
  ServicesSection,
  VoiceSection,
  WorkspaceSection,
} from "@/components/settings-sections";
import { PROVIDER_CATALOG } from "@/lib/providers/registry";
import { getConnectedProviderIds } from "@/lib/providers/store";
import { getCopilotVoicePrefs } from "../actions";

/**
 * Static params from the tab source (ticket 02): one prerendered route per
 * settings section. Unknown values 404 into `settings/not-found.tsx` via
 * the explicit guards in this page and the section layout — note there is
 * deliberately no lockdown segment config here: `dynamicParams = false` is
 * rejected under `nextConfig.cacheComponents`, and the guards render the
 * scoped not-found UI where a routing-level 404 would not.
 */
export function generateStaticParams() {
  return SETTINGS_TABS.map((tab) => ({ tab: tab.value }));
}

/**
 * Data-leaf split (ticket 02, dirty safety in 03): each section fetches
 * only its own reads behind the shell's Suspense boundary, so one section
 * resolving never remounts another section's form. Navigating across the
 * route split still unmounts the form — the voice/workspace forms retain
 * unfinished edits in a per-section draft (see `settings-draft.ts`) and
 * warn on reload/close while dirty, instead of silently discarding.
 */
async function AccountData() {
  const ctx = await requireCtxOrRedirect("/settings/account");
  return (
    <>
      <RouteBrief route="/settings/account" brief={`Settings · Account. Signed in as ${ctx.name} (${ctx.email}). Sign out here.`} />
      <AccountSection user={{ name: ctx.name, email: ctx.email, image: ctx.image }} />
    </>
  );
}

async function VoiceData() {
  await requireCtxOrRedirect("/settings/voice");
  const voicePrefs = await getCopilotVoicePrefs();
  return (
    <>
      <RouteBrief route="/settings/voice" brief={`Settings · Voice copilot. Voice ${voicePrefs.voiceId}, language ${voicePrefs.language}. Voice and language preferences require confirmed edits and a confirmed save.`} />
      <VoiceSection prefs={voicePrefs} />
    </>
  );
}

async function WorkspaceData() {
  const ctx = await requireCtxOrRedirect("/settings/workspace");
  const [[workspace], [settings]] = await Promise.all([
    db.select({ name: organization.name }).from(organization).where(eq(organization.id, ctx.organizationId)).limit(1),
    db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, ctx.organizationId)).limit(1),
  ]);
  const canEdit = ctx.role === "owner";
  return (
    <>
      <RouteBrief route="/settings/workspace" brief={`Settings · Workspace ${workspace?.name ?? "Workspace"}. Workspace edits ${canEdit ? "allowed" : "disabled"}.`} />
      <WorkspaceSection
        workspace={{
          name: workspace?.name ?? "Workspace",
          timezone: settings?.timezone ?? "Asia/Dubai",
          humanTransferNumber: settings?.humanTransferNumber ?? "",
          canEdit,
        }}
      />
    </>
  );
}

async function ServicesData() {
  const ctx = await requireCtxOrRedirect("/settings/services");
  const [connectedProviderIds, summaries, llmAccountLists, platformConfig] = await Promise.all([
    getConnectedProviderIds(ctx.organizationId),
    Promise.all(CREDENTIAL_NAMES.map(async (name) => [name, await credentialSummary(name)] as const)),
    Promise.all(LLM_PROVIDER_IDS.map((id) => listAccounts(id))),
    getPlatformConfig(),
  ]);
  const summaryMap = Object.fromEntries(
    summaries.map(([name, value]) => [name, { ...value, updatedAt: value.updatedAt?.toISOString() }]),
  ) as Record<CredentialName, CredentialSummary & { updatedAt?: string }>;
  const llmConfigured = llmAccountLists.some((accounts) => accounts.some((account) => account.enabled));
  // Readiness rows come from the shared helper (ticket 04) so the services
  // section and the landing badge can never disagree on what "ready" means.
  const services = buildServiceReadiness({
    assemblyaiConfigured: summaryMap.assemblyai_api_key.configured,
    telnyxConfigured: summaryMap.telnyx_api_key.configured,
    telnyxConnectionId: platformConfig.telnyxConnectionId,
    telnyxCallerNumber: platformConfig.telnyxCallerNumber,
    llmConfigured,
    cartesiaConfigured: summaryMap.cartesia_api_key.configured,
    cartesiaVoiceId: platformConfig.cartesiaVoiceId,
  });
  const ready = services.filter((service) => service.configured).length;
  return (
    <>
      <RouteBrief route="/settings/services" brief={`Settings · Services. ${ready} of ${services.length} services configured. ${connectedProviderIds.length} providers connected. Platform credentials are operator-managed outside customer settings.`} />
      <ServicesSection
        services={services}
        providerCatalog={PROVIDER_CATALOG}
        connectedProviderIds={connectedProviderIds}
      />
    </>
  );
}

function AppearanceData() {
  return (
    <>
      <RouteBrief route="/settings/appearance" brief="Settings · Appearance. Use light, dark, or the system setting." />
      <AppearanceSection />
    </>
  );
}

async function SectionData({ tab }: { tab: SettingsTabValue }) {
  switch (tab) {
    case "account":
      return <AccountData />;
    case "voice":
      return <VoiceData />;
    case "workspace":
      return <WorkspaceData />;
    case "services":
      return <ServicesData />;
    case "appearance":
      return <AppearanceData />;
  }
}

export default async function SettingsSectionPage({
  params,
}: PageProps<"/settings/[tab]">) {
  const { tab } = await params;
  // Same single source as the layout guard above — heading and content can
  // never disagree on what exists. The shell's Suspense boundary (layout)
  // streams this leaf.
  const tile = settingsSectionTile(tab);
  if (!tile) notFound();
  return <SectionData tab={tile.value as SettingsTabValue} />;
}
