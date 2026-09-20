import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SettingsTile } from "@/lib/settings-tiles";
import {
  ConstellationScene,
  ControlScene,
  HorizonScene,
  IncomingScene,
  LanesScene,
  OrbitScene,
  SpineScene,
} from "./scenes";

/** Production scene set: the ticket-01b final V01 winners. */
export const TILE_SCENES: Record<SettingsTile["bgKind"], () => React.JSX.Element> = {
  constellation: ConstellationScene,
  lanes: LanesScene,
  orbit: OrbitScene,
  spine: SpineScene,
  horizon: HorizonScene,
  incoming: IncomingScene,
  control: ControlScene,
};

/** Live badge slot: ticket 04 feeds truthful per-tile status here. Until
 * then the landing passes no badge and tiles render badgeless — never
 * mock data in production. */
export interface TileBadge {
  readonly text: string;
  readonly variant: "secondary" | "outline";
}

/**
 * One faithful bento tile: tall card, full-bleed masked scene,
 * bottom-anchored name/description (no icon — the scene carries the
 * meaning), hover-reveal CTA. The whole card is a single real link
 * (stretched-link idiom, middle-click/long-press safe); the CTA row is a
 * styled span, never a nested link. Decorative scenes stay aria-hidden;
 * the link announces label, description, and live status.
 *
 * Prefetch stays off until ticket 06 wires hover/focus intent prefetch —
 * the landing must not fetch-avalanche every section on viewport entry.
 */
export function BentoTile({
  tile,
  badge,
  className,
}: {
  tile: SettingsTile;
  badge?: TileBadge;
  className?: string;
}) {
  const Scene = TILE_SCENES[tile.bgKind];
  const status = badge ? ` Status: ${badge.text}` : "";
  return (
    <Link
      href={tile.href}
      prefetch={false}
      aria-label={`${tile.label} — ${tile.description}${status}`}
      className={cn(
        "group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
    >
      <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-shadow duration-[var(--motion-standard)] hover:shadow-md">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden">
          <Scene />
        </div>
        {badge ? (
          <Badge variant={badge.variant} className="absolute top-4 right-4 z-10">
            {badge.text}
          </Badge>
        ) : null}
        <div className="pointer-events-none relative z-10 mt-auto flex flex-col gap-1 p-6">
          <h3 className="text-xl font-semibold tracking-tight">{tile.label}</h3>
          <p className="max-w-lg text-sm text-muted-foreground">{tile.description}</p>
        </div>
        <div className="pointer-events-none relative z-10 hidden w-full translate-y-2 flex-row items-center px-6 pb-6 opacity-0 transition-all duration-[var(--motion-standard)] group-focus-visible:translate-y-0 group-focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 lg:flex">
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
            {tile.cta}
            <ArrowRight className="size-4" />
          </span>
        </div>
        <div className="pointer-events-none relative z-10 flex w-full flex-row items-center px-6 pb-6 lg:hidden">
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
            {tile.cta}
            <ArrowRight className="size-4" />
          </span>
        </div>
        <div className="pointer-events-none absolute inset-0 transition-colors duration-[var(--motion-standard)] group-hover:bg-foreground/[0.03]" />
      </div>
    </Link>
  );
}
