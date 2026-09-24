import type { SettingsTabValue } from "./settings-tabs";

/**
 * Tile registry for the settings landing cards (grid-list-02 idiom).
 * Plain module (no "use client") so server components can import it, mirroring
 * `lib/settings-tabs.ts`. `icon` is a key resolved to a lucide component by
 * client renderers — never a component reference here, so this module stays
 * server-safe.
 *
 * NOTE: `scripts/generate-app-manifest.mts` parses `settings-tabs.ts`
 * textually and expands the `/settings/[tab]` template into one static
 * voice destination per section (ticket 07) — this file stays separate so
 * the tile registry never disturbs the manifest shape.
 * Internal `href`s name the `/settings/<tab>` routes served by the
 * section shell (ticket 02).
 */
/** Every tile value: the five tab values plus the two external destinations. */
export type TileValue = SettingsTabValue | "numbers" | "operator";

export type { SettingsTabValue } from "./settings-tabs";

/**
 * Section lookup (ticket 02): the non-external tile serving
 * `/settings/<tab>`, or undefined for unknown values and externals.
 * Single validation source for the section layout + page guards, so a
 * tile-without-tab can never split heading vs. content 404s.
 */
export function settingsSectionTile(tab: string): SettingsTile | undefined {
  return SETTINGS_TILES.find((entry) => entry.value === tab && !entry.external);
}

export type TileIcon = "user" | "mic" | "building" | "plug" | "sun" | "phone" | "shield";

export interface SettingsTile {
  readonly value: TileValue;
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly icon: TileIcon;
  readonly external?: true;
  readonly adminOnly?: true;
}

export const SETTINGS_TILES: ReadonlyArray<SettingsTile> = [
  {
    value: "account",
    label: "Account",
    description: "Your Google profile and session.",
    href: "/settings/account",
    icon: "user",
  },
  {
    value: "voice",
    label: "Voice copilot",
    description: "Who talks back when you tap the mic.",
    href: "/settings/voice",
    icon: "mic",
  },
  {
    value: "workspace",
    label: "Workspace",
    description: "Customer-facing defaults for this organization.",
    href: "/settings/workspace",
    icon: "building",
  },
  {
    value: "services",
    label: "Services",
    description: "Connect the tools your agents can use.",
    href: "/settings/services",
    icon: "plug",
  },
  {
    value: "appearance",
    label: "Appearance",
    description: "Use light, dark, or your system setting.",
    href: "/settings/appearance",
    icon: "sun",
  },
  {
    value: "numbers",
    label: "Phone numbers",
    description: "Which agent picks up when someone calls.",
    href: "/numbers",
    icon: "phone",
    external: true,
  },
  {
    value: "operator",
    label: "Platform operator",
    description: "Voni-managed platform capacity.",
    href: "/operator",
    icon: "shield",
    external: true,
    adminOnly: true,
  },
] satisfies ReadonlyArray<SettingsTile>;
