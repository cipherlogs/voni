import type { Metadata } from "next";
import { SETTINGS_TILES, type SettingsTile, type TileValue } from "@/lib/settings-tiles";
import { BentoTile } from "./tiles";

export const metadata: Metadata = {
  title: "Settings bento gallery (throwaway mockups)",
  robots: { index: false, follow: false },
};

const HERO_SPAN = "lg:col-span-2";

/** Gallery v2: faithful bento composition. Row rhythm mirrors the reference
 * (wide + narrow alternating). Section tiles point at the live `/settings`
 * page until ticket 02 makes the planned `/settings/<tab>` routes real;
 * numbers and operator link for real. Nothing here prefetches. */
const ORDER: ReadonlyArray<{ value: TileValue; hero?: boolean }> = [
  { value: "services", hero: true },
  { value: "account" },
  { value: "voice", hero: true },
  { value: "workspace" },
  { value: "appearance" },
  { value: "numbers" },
  { value: "operator" },
];

export default function SettingsGalleryPage() {
  const byValue = new Map<string, SettingsTile>(SETTINGS_TILES.map((tile) => [tile.value, tile]));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings bento gallery</h1>
        <p className="text-sm text-muted-foreground">
          Throwaway faithful-composition mockups for visual review — pick the scene language per
          tile and this whole route is deleted (ticket 08). Static mock data; looping motion and
          live data arrive with the winning build.
        </p>
      </div>
      <div className="bento-grid-rows grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {ORDER.map((pick) => {
          const tile = byValue.get(pick.value);
          if (!tile) return null;
          return <BentoTile key={pick.value} tile={tile} className={pick.hero ? HERO_SPAN : undefined} />;
        })}
      </div>
    </div>
  );
}
