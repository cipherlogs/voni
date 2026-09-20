import { eq } from "drizzle-orm";
import { requireCtxOrRedirect } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/platform/admin";
import { db } from "@/lib/db";
import { phoneNumbers } from "@/lib/db/schema";
import { getPlatformConfig } from "@/lib/platform/config";
import { credentialSummary } from "@/lib/platform/credentials";
import { listAccounts } from "@/lib/platform/llm-accounts";
import {
  CREDENTIAL_NAMES,
  LLM_PROVIDER_IDS,
  type CredentialName,
} from "@/lib/platform/types";
import { getConnectedProviderIds } from "@/lib/providers/store";
import { SETTINGS_TILES } from "@/lib/settings-tiles";
import { buildServiceReadiness, settingsTileBadges } from "@/lib/settings-badges";
import { BentoTile } from "@/components/settings-bento/bento-tile";
import { AppearanceTile } from "./appearance-tile";
import { SettingsHashRedirect } from "./settings-hash-redirect";
import { getCopilotVoicePrefs } from "./actions";

const HERO_SPAN = "lg:col-span-2";

/**
 * Settings bento landing (tickets 02 + 04): registry-driven tile grid where
 * every tile is a real route link with a shareable URL, plus a truthful live
 * badge derived from existing data. Single column on mobile; heroes span two
 * columns on desktop. The operator tile honors the registry's `adminOnly`
 * flag (hidden for non-admins, never a disabled dead end).
 *
 * One batched round serves all badges (voice prefs, provider connections,
 * platform summaries, phone rows) — no per-tile fetch avalanche. Appearance
 * is the exception: the theme lives in client storage, so its badge renders
 * in the `AppearanceTile` client island instead of a server mock
 * (hover prefetch arrives in ticket 06).
 */
export default async function SettingsPage() {
  const ctx = await requireCtxOrRedirect("/settings");
  const platformAdmin = await isPlatformAdmin(ctx.email);
  const [voicePrefs, connectedProviderIds, summaries, llmAccountLists, platformConfig, phoneRows] =
    await Promise.all([
      getCopilotVoicePrefs(),
      getConnectedProviderIds(ctx.organizationId),
      Promise.all(CREDENTIAL_NAMES.map(async (name) => [name, await credentialSummary(name)] as const)),
      Promise.all(LLM_PROVIDER_IDS.map((id) => listAccounts(id))),
      getPlatformConfig(),
      db
        .select({ id: phoneNumbers.id, agentId: phoneNumbers.agentId })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.organizationId, ctx.organizationId)),
    ]);
  const configuredByName = Object.fromEntries(
    summaries.map(([name, summary]) => [name, summary.configured]),
  ) as Record<CredentialName, boolean>;
  const llmConfigured = llmAccountLists.some((accounts) =>
    accounts.some((account) => account.enabled),
  );
  const services = buildServiceReadiness({
    assemblyaiConfigured: configuredByName.assemblyai_api_key,
    telnyxConfigured: configuredByName.telnyx_api_key,
    telnyxConnectionId: platformConfig.telnyxConnectionId,
    telnyxCallerNumber: platformConfig.telnyxCallerNumber,
    llmConfigured,
    cartesiaConfigured: configuredByName.cartesia_api_key,
    cartesiaVoiceId: platformConfig.cartesiaVoiceId,
  });
  const badges = settingsTileBadges({
    role: ctx.role,
    voice: voicePrefs,
    connectedProviders: connectedProviderIds.length,
    servicesReady: services.filter((service) => service.configured).length,
    servicesTotal: services.length,
    phoneTotal: phoneRows.length,
    phoneUnassigned: phoneRows.filter((row) => !row.agentId).length,
  });
  const tiles = SETTINGS_TILES.filter((tile) => !tile.adminOnly || platformAdmin);
  return (
    <div data-testid="settings-landing" className="flex flex-col gap-6">
      <SettingsHashRedirect />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account, workspace, and service readiness.</p>
      </div>
      <div className="bento-grid-rows grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {tiles.map((tile) => {
          const spanClassName = tile.span === "hero" ? HERO_SPAN : undefined;
          return tile.value === "appearance" ? (
            <AppearanceTile key={tile.value} tile={tile} className={spanClassName} />
          ) : (
            <BentoTile
              key={tile.value}
              tile={tile}
              badge={badges[tile.value]}
              className={spanClassName}
            />
          );
        })}
      </div>
    </div>
  );
}
