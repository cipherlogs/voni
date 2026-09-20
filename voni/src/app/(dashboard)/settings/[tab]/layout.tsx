import { Suspense } from "react";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { SettingsSectionSkeleton } from "@/components/page-skeletons";
import { settingsSectionTile, type SettingsTabValue } from "@/lib/settings-tiles";

/**
 * Shared section shell (ticket 02, per-section loading in 03): BackLink +
 * registry heading paint immediately (no data needed — the registry is
 * static) and persist across section-to-section navigation, since this
 * layout stays mounted while only the `[tab]` param changes. Each section's
 * data streams inside the shell's own Suspense boundary below, with a
 * skeleton shaped to that section's real layout — so the loading state
 * reads as the incoming page, never a generic placeholder.
 */
export default async function SettingsSectionLayout({
  children,
  params,
}: LayoutProps<"/settings/[tab]">) {
  const { tab } = await params;
  const tile = settingsSectionTile(tab);
  if (!tile) notFound();
  // Same single source as the page guard — after the 404 above, the value
  // is a known section, so the skeleton switch below is exhaustive.
  const section = tile.value as SettingsTabValue;
  return (
    <div data-testid="settings-section-shell" className="flex flex-col gap-6">
      <BackLink href="/settings" label="Settings" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tile.label}</h1>
        <p className="text-muted-foreground text-sm">{tile.description}</p>
      </div>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading settings section">
            <SettingsSectionSkeleton tab={section} />
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  );
}
