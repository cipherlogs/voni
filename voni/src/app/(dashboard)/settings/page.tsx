import { requireCtxOrRedirect } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/platform/admin";
import { SETTINGS_TILES } from "@/lib/settings-tiles";
import { BentoTile } from "@/components/settings-bento/bento-tile";
import { SettingsHashRedirect } from "./settings-hash-redirect";

const HERO_SPAN = "lg:col-span-2";

/**
 * Settings bento landing (ticket 02): registry-driven tile grid where every
 * tile is a real route link with a shareable URL. Single column on mobile;
 * heroes span two columns on desktop. The operator tile honors the
 * registry's `adminOnly` flag (live badges arrive in ticket 04, hover
 * prefetch in ticket 06).
 */
export default async function SettingsPage() {
  const ctx = await requireCtxOrRedirect("/settings");
  const platformAdmin = await isPlatformAdmin(ctx.email);
  const tiles = SETTINGS_TILES.filter((tile) => !tile.adminOnly || platformAdmin);
  return (
    <div data-testid="settings-landing" className="flex flex-col gap-6">
      <SettingsHashRedirect />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account, workspace, and service readiness.</p>
      </div>
      <div className="bento-grid-rows grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {tiles.map((tile) => (
          <BentoTile key={tile.value} tile={tile} className={tile.span === "hero" ? HERO_SPAN : undefined} />
        ))}
      </div>
    </div>
  );
}
