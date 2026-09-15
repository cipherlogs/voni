import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConnections } from "@/lib/db/schema";
import {
  PROVIDER_CATALOG,
  providerToolKey,
  type ProviderId,
  type ProviderMeta,
} from "@/lib/providers/registry";

/**
 * GOAL 4A provider connection store — server-side persistence for the
 * Settings → Services → Providers section.
 *
 * Types and catalog come from `./registry` (sibling-owned contract:
 * `ProviderMeta { id, label, description, tools: ToolMeta[] }` with
 * namespaced `"<provider>.<tool>"` config keys). This module owns only
 * connection state: one row per (organization, provider), absence means
 * disconnected ("needs setup" on the agent page).
 *
 * Disconnecting deletes the connection row only. Saved agent configs in the
 * `agents` table are never touched — agents that reference a disconnected
 * provider surface `needsSetup: true` via `providerSetupStates()` below.
 */

export type ProviderConnectionStatus = "connected" | "error";

export type ProviderSetupState = {
  providerId: string;
  connected: boolean;
  status: ProviderConnectionStatus | null;
  /** True when an agent references provider tools but the provider is not connected. */
  needsSetup: boolean;
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_CATALOG as ProviderMeta[]).some((p) => p.id === value);
}

async function rowsForOrganization(
  organizationId: string,
): Promise<Map<string, ProviderConnectionStatus>> {
  const rows = await db
    .select({
      providerId: providerConnections.providerId,
      status: providerConnections.status,
    })
    .from(providerConnections)
    .where(eq(providerConnections.organizationId, organizationId));
  return new Map(rows.map((row) => [row.providerId, row.status]));
}

/**
 * Connected provider ids for an organization — the accessor the agent page
 * wires into to decide which provider tools are available.
 */
export async function getConnectedProviderIds(
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ providerId: providerConnections.providerId })
    .from(providerConnections)
    .where(eq(providerConnections.organizationId, organizationId));
  return rows.map((row) => row.providerId);
}

/** Per-provider connection status for an organization (null = disconnected). */
export async function getProviderStatus(
  organizationId: string,
  providerId: string,
): Promise<ProviderConnectionStatus | null> {
  return (await rowsForOrganization(organizationId)).get(providerId) ?? null;
}

/**
 * Setup state for one provider given the (namespaced) tool keys an agent
 * config references. Read-only: never mutates agent rows.
 */
export async function providerSetupState(
  organizationId: string,
  providerId: string,
  agentToolKeys: string[] = [],
): Promise<ProviderSetupState> {
  const [state] = await providerSetupStates(
    organizationId,
    PROVIDER_CATALOG,
    agentToolKeys,
  ).then((states) => states.filter((s) => s.providerId === providerId));
  return (
    state ?? {
      providerId,
      connected: false,
      status: null,
      needsSetup: agentToolKeys.length > 0,
    }
  );
}

/**
 * Setup states for every provider in a catalog, given the union of
 * namespaced tool keys referenced by an organization's agent configs.
 * Read-only: never mutates agent rows — a disconnect leaves saved configs
 * intact and surfaces here as needsSetup.
 */
export async function providerSetupStates(
  organizationId: string,
  catalog: ProviderMeta[],
  agentToolKeys: string[],
): Promise<ProviderSetupState[]> {
  const connected = await rowsForOrganization(organizationId);
  const keySet = new Set(agentToolKeys);
  return catalog.map((provider) => {
    const status = connected.get(provider.id) ?? null;
    const referencesProvider = provider.tools.some((tool) =>
      keySet.has(providerToolKey(provider.id, tool.id)),
    );
    return {
      providerId: provider.id,
      connected: status === "connected",
      status,
      needsSetup: referencesProvider && status !== "connected",
    };
  });
}
