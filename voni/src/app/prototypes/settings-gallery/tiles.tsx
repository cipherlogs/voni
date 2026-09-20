import type { SettingsTile } from "@/lib/settings-tiles";
import { BentoTile as ProductionTile, type TileBadge } from "@/components/settings-bento/bento-tile";

/**
 * Gallery-local tile: the production `BentoTile` fed with mock badges for
 * review only — live badges arrive on the real landing in ticket 04. The
 * whole route is deleted in ticket 08.
 */
const MOCK_BADGES: Record<string, TileBadge> = {
  account: { text: "Signed in", variant: "secondary" },
  voice: { text: "Ivy · Auto", variant: "secondary" },
  workspace: { text: "Owner", variant: "secondary" },
  services: { text: "2 of 3 ready", variant: "secondary" },
  appearance: { text: "System", variant: "outline" },
  numbers: { text: "3 assigned", variant: "secondary" },
  operator: { text: "Needs setup", variant: "outline" },
};

export function BentoTile({
  tile,
  className,
}: {
  tile: SettingsTile;
  className?: string;
}) {
  return (
    <ProductionTile
      tile={tile}
      badge={MOCK_BADGES[tile.value] ?? { text: "Preview", variant: "outline" }}
      className={className}
      prefetchOnIntent={false}
    />
  );
}
