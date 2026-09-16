import type { SETTINGS_TABS } from "./settings-tabs";

/**
 * Tile registry for the settings bento landing (`.scratch/settings-bento`).
 * Plain module (no "use client") so server components can import it, mirroring
 * `lib/settings-tabs.ts`. `icon` is a key resolved to a lucide component by
 * client renderers — never a component reference here, so this module stays
 * server-safe. `span`/`bgKind` record the v1 composition recommendation from
 * the gallery review; variants may override presentation locally.
 *
 * NOTE: `scripts/generate-app-manifest.mts` parses `settings-tabs.ts`
 * textually — this file is intentionally separate so the registry never
 * disturbs the manifest shape (migration happens in ticket 07).
 * Internal `href`s name the `/settings/<tab>` routes that land in ticket 02;
 * until then the gallery resolves them to the live `/settings` page.
 */
export type SettingsTabValue = (typeof SETTINGS_TABS)[number]["value"];

/** Every tile value: the five tab values plus the two external destinations. */
export type TileValue = SettingsTabValue | "numbers" | "operator";

export type TileIcon = "user" | "mic" | "building" | "plug" | "sun" | "phone" | "shield";

export type TileSpan = "standard" | "hero";

export type TileBgKind =
  | "session"
  | "equalizer"
  | "defaults"
  | "beam"
  | "theme"
  | "wiring"
  | "meters";

export interface SettingsTile {
  readonly value: TileValue;
  readonly label: string;
  readonly description: string;
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
    href: "/settings/account",
    icon: "user",
    span: "standard",
    bgKind: "session",
  },
  {
    value: "voice",
    label: "Voice copilot",
    description: "Who talks back when you tap the mic.",
    href: "/settings/voice",
    icon: "mic",
    span: "hero",
    bgKind: "equalizer",
  },
  {
    value: "workspace",
    label: "Workspace",
    description: "Customer-facing defaults for this organization.",
    href: "/settings/workspace",
    icon: "building",
    span: "standard",
    bgKind: "defaults",
  },
  {
    value: "services",
    label: "Services",
    description: "Connect the tools your agents can use.",
    href: "/settings/services",
    icon: "plug",
    span: "hero",
    bgKind: "beam",
  },
  {
    value: "appearance",
    label: "Appearance",
    description: "Use light, dark, or your system setting.",
    href: "/settings/appearance",
    icon: "sun",
    span: "standard",
    bgKind: "theme",
  },
  {
    value: "numbers",
    label: "Phone numbers",
    description: "Which agent picks up when someone calls.",
    href: "/numbers",
    icon: "phone",
    span: "standard",
    bgKind: "wiring",
    external: true,
  },
  {
    value: "operator",
    label: "Platform operator",
    description: "Voni-managed platform capacity.",
    href: "/operator",
    icon: "shield",
    span: "standard",
    bgKind: "meters",
    external: true,
    adminOnly: true,
  },
] satisfies ReadonlyArray<SettingsTile>;
