import type { Metadata } from "next";
import { SETTINGS_TILES, type SettingsTile } from "@/lib/settings-tiles";
import { BentoTile } from "./tiles";

export const metadata: Metadata = {
  title: "Settings bento gallery (throwaway mockups)",
  robots: { index: false, follow: false },
};

const HERO_SPAN = "lg:col-span-2";

/**
 * Throwaway gallery v4 (ticket 01, deleted in ticket 08): the winning V01
 * layout carrying the approved second-round scenes. Static mock data;
 * nothing prefetches. Section tiles point at the live `/settings` page until
 * ticket 02 makes the planned `/settings/<tab>` routes real; numbers and
 * operator link for real.
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings bento gallery</h1>
        <p className="text-sm text-muted-foreground">
          Winning V01 layout with the approved scene round. Pick-level review per tile;
          this whole route is deleted in ticket 08.
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
