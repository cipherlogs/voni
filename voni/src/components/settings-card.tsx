import {
  Building2,
  ChevronRight,
  Mic,
  Phone,
  Plug,
  Shield,
  SunMoon,
  User,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SettingsTile, TileIcon } from "@/lib/settings-tiles";
import type { SettingsTileBadge } from "@/lib/settings-badges";
import { HoverPrefetchLink } from "@/components/hover-prefetch-link";

const ICONS: Record<TileIcon, LucideIcon> = {
  user: User,
  mic: Mic,
  building: Building2,
  plug: Plug,
  sun: SunMoon,
  phone: Phone,
  shield: Shield,
};

/**
 * One settings destination (blocks.so grid-list-02 idiom): icon disc, name
 * with its live status, one-line description. The whole card is a single
 * real link; it prefetches only on hover/focus intent (`HoverPrefetchLink`),
 * so the grid never avalanches on viewport entry. Prefetch-silent venues pass
 * `prefetchOnIntent={false}`.
 */
export function SettingsCard({
  tile,
  badge,
  className,
  prefetchOnIntent = true,
}: {
  tile: SettingsTile;
  badge?: SettingsTileBadge;
  className?: string;
  prefetchOnIntent?: boolean;
}) {
  const Icon = ICONS[tile.icon];
  const status = badge ? ` Status: ${badge.text}` : "";
  return (
    <HoverPrefetchLink
      href={tile.href}
      enabled={prefetchOnIntent}
      ariaLabel={`${tile.label} — ${tile.description}${status}`}
      className={cn(
        "group focus-visible:ring-ring rounded-xl focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
    >
      <Card className="h-full border py-0 shadow-sm transition-[border-color,box-shadow] duration-[var(--motion-standard)] ease-out group-hover:border-muted-foreground group-hover:shadow-md">
        <CardContent className="flex h-full items-center gap-4 p-4">
          <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full">
            <Icon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium">{tile.label}</p>
              {badge ? (
                <span className="text-muted-foreground truncate text-xs">{badge.text}</span>
              ) : null}
            </div>
            <p className="text-muted-foreground text-sm text-pretty">{tile.description}</p>
          </div>
          <ChevronRight
            aria-hidden
            className="text-muted-foreground size-4 shrink-0 transition-transform duration-[var(--motion-standard)] group-hover:translate-x-0.5"
          />
        </CardContent>
      </Card>
    </HoverPrefetchLink>
  );
}
