import type { Metadata } from "next";
import { SETTINGS_TILES, type SettingsTile } from "@/lib/settings-tiles";
import { BentoTile } from "./tiles";

export const metadata: Metadata = {
  title: "Settings bento gallery (throwaway mockups)",
  robots: { index: false, follow: false },
};

const HERO_SPAN = "lg:col-span-2";

/**
 * Throwaway gallery v6 (ticket 01b final, deleted in ticket 08): the
 * recombined V01 winners — services A, voice A, account C, workspace A,
 * appearance A (placeholder until ticket 09), numbers B, operator A.
 * Static mock data; nothing prefetches. Section tiles point at the live
 * `/settings` page until ticket 02 makes the planned `/settings/<tab>`
 * routes real; numbers and operator link for real.
 */
const ORDER: ReadonlyArray<SettingsTile["value"]> = [
  "services",
  "account",
  "voice",
  "workspace",
  "appearance",
  "numbers",
  "operator",
];

export default function SettingsGalleryPage() {
  const byValue = new Map<string, SettingsTile>(SETTINGS_TILES.map((tile) => [tile.value, tile]));
  return (
    // Same content container as the dashboard shell (`(dashboard)/layout`):
    // the settings landing inherits max-w-6xl + responsive padding, so the
    // gallery reviews tile widths at production geometry instead of
    // stretching across the viewport.
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings bento gallery</h1>
        <p className="text-sm text-muted-foreground">
          Final V01: recombined per-tile winners. This whole route is deleted in ticket 08.
        </p>
      </div>
      <div className="bento-grid-rows grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {ORDER.map((value) => {
          const tile = byValue.get(value);
          if (!tile) return null;
          return (
            <BentoTile key={value} tile={tile} className={tile.span === "hero" ? HERO_SPAN : undefined} />
          );
        })}
      </div>
    </div>
  );
}
