import type { SettingsTabValue } from "./settings-tabs";

/**
 * Tile registry for the settings bento landing (`.scratch/settings-bento`).
 * Plain module (no "use client") so server components can import it, mirroring
 * `lib/settings-tabs.ts`. `icon` is a key resolved to a lucide component by
 * client renderers — never a component reference here, so this module stays
 * server-safe. `span`/`bgKind` record the v1 composition recommendation from
 * the gallery review; variants may override presentation locally.
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

export type TileSpan = "standard" | "hero";

export type TileBgKind =
  | "constellation"
  | "lanes"
  | "orbit"
  | "spine"
  | "horizon"
  | "incoming"
  | "control";

export interface SettingsTile {
  readonly value: TileValue;
  readonly label: string;
  readonly description: string;
  /** Per-tile action verb for the hover-reveal CTA row (e.g. "Manage services"). */
  readonly cta: string;
  readonly href: string;
  readonly icon: TileIcon;
  readonly span: TileSpan;
  readonly bgKind: TileBgKind;
  readonly external?: true;
  readonly adminOnly?: true;
}

export const SETTINGS_TILES: ReadonlyArray<SettingsTile> = [
  {
    value: "account",
    label: "Account",
    description: "Your Google profile and session.",
    cta: "Manage account",
    href: "/settings/account",
    icon: "user",
    span: "standard",
    bgKind: "orbit",
  },
  {
    value: "voice",
    label: "Voice copilot",
    description: "Who talks back when you tap the mic.",
    cta: "Configure voice copilot",
    href: "/settings/voice",
    icon: "mic",
    span: "hero",
    bgKind: "lanes",
  },
  {
    value: "workspace",
    label: "Workspace",
    description: "Customer-facing defaults for this organization.",
    cta: "Manage workspace",
    href: "/settings/workspace",
    icon: "building",
    span: "standard",
    bgKind: "spine",
  },
  {
    value: "services",
    label: "Services",
    description: "Connect the tools your agents can use.",
    cta: "Manage services",
    href: "/settings/services",
    icon: "plug",
    span: "hero",
    bgKind: "constellation",
  },
  {
    value: "appearance",
    label: "Appearance",
    description: "Use light, dark, or your system setting.",
    cta: "Manage appearance",
    href: "/settings/appearance",
    icon: "sun",
    span: "standard",
    bgKind: "horizon",
  },
  {
    value: "numbers",
    label: "Phone numbers",
    description: "Which agent picks up when someone calls.",
    cta: "Manage numbers",
    href: "/numbers",
    icon: "phone",
    span: "standard",
    bgKind: "incoming",
    external: true,
  },
  {
    value: "operator",
    label: "Platform operator",
    description: "Voni-managed platform capacity.",
    cta: "View status",
    href: "/operator",
    icon: "shield",
    span: "standard",
    bgKind: "control",
    external: true,
    adminOnly: true,
  },
] satisfies ReadonlyArray<SettingsTile>;
