/**
 * Single source for the settings tab list. Plain module (no "use client") so
 * both the server-rendered settings shell and the client SettingsView can
 * import it without crossing the server/client module boundary.
 *
 * NOTE: scripts/generate-app-manifest.mts parses this file textually to feed
 * the voice copilot manifest — keep the `SETTINGS_TABS = [...] as const`
 * shape intact.
 */
export const SETTINGS_TABS = [
  { value: "account", label: "Account" },
  { value: "voice", label: "Voice copilot" },
  { value: "workspace", label: "Workspace" },
  { value: "services", label: "Services" },
  { value: "appearance", label: "Appearance" },
] as const;

export type SettingsTabValue = (typeof SETTINGS_TABS)[number]["value"];

/**
 * Legacy-hash redirect (ticket 02): tabbed settings never had deep URLs,
 * so `#voice`-style fragments are the only bookmarkable past. The landing
 * resolves them client-side (fragments never reach the server) to the new
 * `/settings/<tab>` routes. Returns null for anything unrecognized.
 */
export function settingsHashTarget(hash: string): SettingsTabValue | null {
  const value = hash.replace(/^#/, "").trim().toLowerCase();
  const hit = SETTINGS_TABS.find((tab) => tab.value === value);
  return hit ? hit.value : null;
}
