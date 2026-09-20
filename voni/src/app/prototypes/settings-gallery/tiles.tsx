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

/** Final V01 scene set (ticket 01b winners). */
export const TILE_SCENES: Record<SettingsTile["bgKind"], () => React.JSX.Element> = {
  constellation: ConstellationScene,
  lanes: LanesScene,
  orbit: OrbitScene,
  spine: SpineScene,
  horizon: HorizonScene,
  incoming: IncomingScene,
  control: ControlScene,
};

/**
 * Gallery-local hrefs: section tiles point at the live `/settings` page until
 * ticket 02 makes the planned `/settings/<tab>` routes real. Externals
 * already exist, so they link for real.
 */
export function galleryHref(tile: Pick<SettingsTile, "href" | "external">): string {
  return tile.external ? tile.href : "/settings";
}

/** Mock badges for gallery review only — live badges arrive in ticket 04. */
const MOCK_BADGES: Record<string, { text: string; variant: "secondary" | "outline" }> = {
  account: { text: "Signed in", variant: "secondary" },
  voice: { text: "Ivy · Auto", variant: "secondary" },
  workspace: { text: "Owner", variant: "secondary" },
  services: { text: "2 of 3 ready", variant: "secondary" },
  appearance: { text: "System", variant: "outline" },
  numbers: { text: "3 assigned", variant: "secondary" },
  operator: { text: "Needs setup", variant: "outline" },
};

/**
 * One faithful bento tile: tall card, full-bleed masked scene, bottom-anchored
 * name/description (no icon — the scene carries the meaning), hover-reveal
 * CTA. The whole card is a single link (stretched-link idiom); the CTA row is
 * a styled span, never a nested link. Static mock data — live badges arrive
 * in ticket 04.
 */
export function BentoTile({
  tile,
  className,
}: {
  tile: SettingsTile;
  className?: string;
}) {
  const Scene = TILE_SCENES[tile.bgKind];
  const badge = MOCK_BADGES[tile.value] ?? { text: "Preview", variant: "outline" as const };
  return (
    <Link
      href={galleryHref(tile)}
      prefetch={false}
      aria-label={`${tile.label} — ${tile.description} Status: ${badge.text}`}
      className={cn(
        "group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
    >
      <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-shadow duration-[var(--motion-standard)] hover:shadow-md">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden">
          <Scene />
        </div>
        <Badge variant={badge.variant} className="absolute top-4 right-4 z-10">
          {badge.text}
        </Badge>
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
