"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { SettingsCard } from "@/components/settings-card";
import type { SettingsTile } from "@/lib/settings-tiles";

/**
 * Appearance tile with a client-live theme badge (ticket 04).
 *
 * The theme lives in client storage (`next-themes`, default `system` with a
 * one-time migration — see `theme-provider.tsx`), so the server landing must
 * not invent it. This island reads the live preference and feeds it into the
 * production `SettingsCard`, whose link announcement already includes
 * `Status: <badge>` for screen readers. Before hydration the tile renders
 * badgeless (the badge is absolute-positioned, so withholding it shifts no
 * layout) rather than announcing the default as the user's preference.
 */
export function AppearanceTile({ tile, className }: { tile: SettingsTile; className?: string }) {
  const { theme } = useTheme();
  // Mounted via the house `useSyncExternalStore` idiom (see `use-mobile.ts`):
  // false on the server, true after hydration — no setState-in-effect.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const text =
    theme === "light" ? "Light" : theme === "dark" ? "Dark" : theme === "system" ? "System" : undefined;
  return (
    <SettingsCard
      tile={tile}
      badge={mounted && text ? { text, variant: "secondary" } : undefined}
      className={className}
    />
  );
}
