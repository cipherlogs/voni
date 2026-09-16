import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Building2,
  Check,
  Mic,
  Moon,
  Phone,
  Plug,
  ShieldCheck,
  Sun,
  User,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SettingsTile, TileIcon } from "@/lib/settings-tiles";

const TILE_ICONS: Record<TileIcon, LucideIcon> = {
  user: User,
  mic: Mic,
  building: Building2,
  plug: Plug,
  sun: Sun,
  phone: Phone,
  shield: ShieldCheck,
};

/** Mock badges for gallery review only — live badges arrive in ticket 04. */
export const MOCK_BADGES: Record<string, { text: string; variant: "secondary" | "outline" }> = {
  account: { text: "Signed in", variant: "secondary" },
  voice: { text: "Ivy · Auto", variant: "secondary" },
  workspace: { text: "Owner", variant: "secondary" },
  services: { text: "2 of 3 ready", variant: "secondary" },
  appearance: { text: "System", variant: "outline" },
  numbers: { text: "3 assigned", variant: "secondary" },
  operator: { text: "Needs setup", variant: "outline" },
};

/**
 * Gallery-local hrefs: section tiles point at the live `/settings` page until
 * ticket 02 makes the planned `/settings/<tab>` routes real. Externals
 * already exist, so they link for real.
 */
export function galleryHref(tile: Pick<SettingsTile, "href" | "external">): string {
  return tile.external ? tile.href : "/settings";
}

/** Services scene: provider nodes hand work to one agent through live beams.
 * The SVG uses non-scaling strokes in a 400-unit space so its paths stay
 * registered with the HTML nodes at any tile width. */
export function BeamScene() {
  return (
    <div className="bento-fade absolute top-0 right-0 h-72 w-full origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg
        viewBox="0 0 400 288"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden
        className="absolute inset-0 size-full"
      >
        <path
          d="M 44 144 C 100 144, 140 144, 182 144"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="bento-beam-flow stroke-muted-foreground/60"
        />
        <path
          d="M 218 144 C 272 144, 312 80, 366 80"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="bento-beam-flow stroke-muted-foreground/60"
        />
        <path
          d="M 218 144 C 272 144, 312 144, 366 144"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="bento-beam-flow stroke-muted-foreground/60"
        />
        <path
          d="M 218 144 C 272 144, 312 208, 366 208"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="bento-beam-flow stroke-muted-foreground/60"
        />
      </svg>
      <div className="absolute top-1/2 left-8 -translate-y-1/2">
        <span className="flex size-12 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <User className="size-5" />
        </span>
      </div>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="bento-node-ping absolute inset-0 rounded-full ring-2 ring-primary" />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border">
          <Bot className="size-7" />
        </span>
      </div>
      <div className="absolute top-1/2 right-8 flex -translate-y-1/2 flex-col gap-6">
        {["G", "Z", "D"].map((initial) => (
          <span
            key={initial}
            className="flex size-10 items-center justify-center rounded-full bg-card text-sm text-muted-foreground shadow-sm ring-1 ring-border"
          >
            {initial}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Voice scene: transcript rows cycle through like the reference list. */
export function ListScene() {
  const rows = [
    { speaker: "You", line: "Set my voice to Ivy, please." },
    { speaker: "Voni", line: "Done — Ivy, auto-detect on." },
    { speaker: "You", line: "And switch me to dark?" },
    { speaker: "Voni", line: "Appearance is now System." },
  ];
  return (
    <div className="bento-fade-soft bento-list absolute top-8 right-6 flex w-3/4 max-w-xs origin-top-right scale-90 flex-col gap-2 transition-transform duration-300 group-hover:scale-95">
      {rows.map((row) => (
        <div key={`${row.speaker}-${row.line}`} className="bento-list-item rounded-xl border bg-card p-3 shadow-sm">
          <p className="text-xs font-medium">{row.speaker}</p>
          <p className="truncate text-xs text-muted-foreground">{row.line}</p>
        </div>
      ))}
    </div>
  );
}

/** Account scene: identity card with a live session seal. */
export function SessionScene() {
  return (
    <div className="bento-fade absolute top-10 right-6 w-60 origin-top-right scale-90 rounded-xl border bg-card p-4 shadow-sm transition-transform duration-300 group-hover:scale-95">
      <div className="flex items-center gap-3">
        <Avatar size="lg">
          <AvatarFallback>A</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Amara</p>
          <p className="truncate text-xs text-muted-foreground">amara@acme.test</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
        <p className="text-xs">Voni session · active</p>
      </div>
    </div>
  );
}

/** Workspace scene: scaled customer-facing defaults widget. */
export function DefaultsScene() {
  const rows = [
    { label: "Workspace", value: "Acme Viewings" },
    { label: "Timezone", value: "Asia/Dubai" },
    { label: "Transfer number", value: "+971 50 123 4567" },
  ];
  return (
    <div className="bento-fade absolute inset-x-8 top-10 origin-top scale-90 rounded-xl border bg-card p-3 shadow-sm transition-transform duration-300 group-hover:scale-95">
      <div className="flex flex-col gap-1.5">        {rows.map((row) => (
          <div key={row.label} className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">{row.label}</p>
            <p className="truncate text-sm font-medium">{row.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Appearance scene: light/dark split preview. */
export function ThemeScene() {
  return (
    <div className="bento-fade absolute inset-x-8 top-12 grid origin-top scale-90 grid-cols-2 gap-3 transition-transform duration-300 group-hover:scale-95">
      <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-xl border bg-card shadow-sm">
        <Sun className="size-5" />
        <span className="text-xs font-medium">Light</span>
      </div>
      <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-xl bg-foreground text-background shadow-sm">
        <Moon className="size-5" />
        <span className="text-xs font-medium">Dark follows OS</span>
      </div>
    </div>
  );
}

/** Numbers scene: a number wires to its agent. */
export function WiringScene() {
  return (
    <div className="bento-fade absolute inset-x-8 top-16 flex origin-top scale-90 items-center gap-3 transition-transform duration-300 group-hover:scale-95">
      <span className="rounded-xl border bg-card px-3 py-2 font-mono text-xs shadow-sm">+971 50 123 4567</span>
      <span className="relative flex-1">
        <span className="block border-t border-dashed border-border" />
        <span className="absolute top-1/2 left-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Plug className="size-3" />
        </span>
      </span>
      <span className="flex items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-xs font-medium shadow-sm">
        <Bot className="size-3.5" />
        Sara
      </span>
    </div>
  );
}

/** Operator scene: scaled readiness meters. */
export function MetersScene() {
  const rows = [
    { label: "Voice agents", width: "w-3/4" },
    { label: "Phone calls", width: "w-1/2" },
    { label: "AI generation", width: "w-full" },
  ];
  return (
    <div className="bento-fade absolute inset-x-8 top-12 origin-top scale-90 rounded-xl border bg-card p-4 shadow-sm transition-transform duration-300 group-hover:scale-95">
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{row.label}</span>
            <span className="h-1 flex-1 rounded-full bg-muted">
              <span className={cn("block h-full rounded-full bg-primary", row.width)} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const TILE_SCENES: Record<SettingsTile["bgKind"], () => React.JSX.Element> = {
  session: SessionScene,
  transcript: ListScene,
  defaults: DefaultsScene,
  beam: BeamScene,
  theme: ThemeScene,
  wiring: WiringScene,
  meters: MetersScene,
};

/**
 * One faithful bento tile: tall card, full-bleed masked scene, bottom-anchored
 * icon/name/description, hover-reveal CTA. The whole card is a single link
 * (stretched-link idiom); the CTA row is a styled span, never a nested link.
 * Static mock data — live badges arrive in ticket 04.
 */
export function BentoTile({
  tile,
  className,
}: {
  tile: SettingsTile;
  className?: string;
}) {
  const Icon = TILE_ICONS[tile.icon];
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
          <Icon className="size-12 origin-left text-foreground transition-transform duration-300 group-hover:scale-75" />
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
