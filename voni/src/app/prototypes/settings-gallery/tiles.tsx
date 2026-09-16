import Link from "next/link";
import {
  Bot,
  Building2,
  Check,
  Mic,
  Phone,
  Plug,
  ShieldCheck,
  Sun,
  User,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

function MiniFrame({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-lg border bg-muted/50 p-3">
      {children}
    </div>
  );
}

/** Services hero language: provider nodes hand work to one agent. */
export function BeamMini() {
  return (
    <MiniFrame>
      <div className="flex h-24 items-center gap-3">
        <div className="flex flex-col gap-2">
          {["G", "Z", "D"].map((initial) => (
            <Avatar key={initial} size="sm">
              <AvatarFallback>{initial}</AvatarFallback>
            </Avatar>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="border-t border-dashed border-border" />
          <div className="absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary transition-transform duration-[var(--motion-standard)] group-hover:translate-x-4" />
        </div>
        <Avatar size="sm">
          <AvatarFallback>
            <Bot className="size-4" />
          </AvatarFallback>
        </Avatar>
      </div>
    </MiniFrame>
  );
}

/** Voice hero language: equalizer bars over the voice motif. */
export function EqMini() {
  const bars = [
    { height: "h-5", strong: false },
    { height: "h-9", strong: true },
    { height: "h-12", strong: true },
    { height: "h-7", strong: false },
    { height: "h-10", strong: true },
  ];
  return (
    <MiniFrame>
      <div className="flex h-24 items-end justify-center gap-1.5">
        {bars.map((bar, index) => (
          <div
            key={index}
            className={cn(
              "w-2 rounded-full transition-transform duration-[var(--motion-standard)] group-hover:scale-y-110",
              bar.height,
              bar.strong ? "bg-primary" : "bg-primary/40",
            )}
          />
        ))}
      </div>
    </MiniFrame>
  );
}

/** Shared dashed handoff connector with a centered state seal. */
function MiniLink({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="relative flex-1">
      <span className="block border-t border-dashed border-border" />
      <span className="absolute top-1/2 left-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Icon className="size-3" />
      </span>
    </span>
  );
}

/** Account language: identity hands off to a Voni session. */
export function SessionMini() {
  return (
    <MiniFrame>
      <div className="flex h-24 items-center gap-2">
        <span className="flex items-center gap-2 rounded-lg border bg-card px-2 py-1 text-xs">
          <Avatar size="sm">
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          Amara
        </span>
        <MiniLink icon={Check} />
        <span className="rounded-lg border bg-card px-2 py-1 text-xs">Voni session</span>
      </div>
    </MiniFrame>
  );
}

/** Workspace language: stacked customer-facing defaults. */
export function DefaultsMini() {
  const rows = [
    { label: "Workspace", value: "Acme Viewings" },
    { label: "Timezone", value: "Asia/Dubai" },
    { label: "Transfer number", value: "+971 50 123 4567" },
  ];
  return (
    <MiniFrame>
      <div className="flex h-24 flex-col justify-center gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg bg-card px-3 py-1.5">
            <p className="text-xs text-muted-foreground">{row.label}</p>
            <p className="truncate text-sm">{row.value}</p>
          </div>
        ))}
      </div>
    </MiniFrame>
  );
}

/** Appearance language: light/dark split preview. */
export function ThemeMini() {
  return (
    <MiniFrame>
      <div className="grid h-24 grid-cols-2 gap-2">
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border bg-card">
          <Sun className="size-4" />
          <span className="text-xs">Light</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border bg-primary text-primary-foreground">
          <Sun className="size-4" />
          <span className="text-xs">Dark follows OS</span>
        </div>
      </div>
    </MiniFrame>
  );
}

/** Numbers language: a number wires to its agent. */
export function WiringMini() {
  return (
    <MiniFrame>
      <div className="flex h-24 items-center gap-2">
        <span className="rounded-lg border bg-card px-2 py-1 font-mono text-xs">+971 50 123 4567</span>
        <MiniLink icon={Plug} />
        <span className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs">
          <Bot className="size-3.5" />
          Sara
        </span>
      </div>
    </MiniFrame>
  );
}

/** Operator language: readiness meters. */
export function MetersMini() {
  const rows = [
    { label: "Voice agents", width: "w-3/4" },
    { label: "Phone calls", width: "w-1/2" },
    { label: "AI generation", width: "w-full" },
  ];
  return (
    <MiniFrame>
      <div className="flex h-24 flex-col justify-center gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{row.label}</span>
            <span className="h-1 flex-1 rounded-full bg-muted">
              <span className={cn("block h-full rounded-full bg-primary", row.width)} />
            </span>
          </div>
        ))}
      </div>
    </MiniFrame>
  );
}

/** Variant-08 language: truthful mark wall (real providers + readiness only). */
export function MarqueeMini() {
  const marks = [
    "Gmail · Connected",
    "Zoho · Off",
    "Docs · Off",
    "Voice · Ready",
    "Phone · Needs setup",
    "AI generation · Ready",
    "Voice notes · Needs setup",
  ];
  return (
    <MiniFrame>
      <div className="flex h-24 flex-col justify-center gap-2 overflow-hidden">
        {[0, 1].map((row) => (
          <div key={row} className="flex w-max gap-2">
            {marks.map((mark) => (
              <span
                key={`${row}-${mark}`}
                className="flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs whitespace-nowrap"
              >
                <span className="flex size-4 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                  {mark.charAt(0)}
                </span>
                {mark}
              </span>
            ))}
          </div>
        ))}
      </div>
    </MiniFrame>
  );
}

export const BG_MINIATURES: Record<SettingsTile["bgKind"], () => React.JSX.Element> = {
  session: SessionMini,
  equalizer: EqMini,
  defaults: DefaultsMini,
  beam: BeamMini,
  theme: ThemeMini,
  wiring: WiringMini,
  meters: MetersMini,
};

/**
 * One mock tile: whole card is a single link (grid-list-02 stretched-link
 * idiom, no nested controls). Static mock data — live badges arrive in ticket
 * 04, looping motion in ticket 05 (hover transitions only here).
 */
export function MockTile({
  tile,
  miniature,
  spanClassName,
}: {
  tile: SettingsTile;
  miniature?: React.ReactNode;
  spanClassName?: string;
}) {
  const Icon = TILE_ICONS[tile.icon];
  const badge = MOCK_BADGES[tile.value] ?? { text: "Preview", variant: "outline" as const };
  const Miniature = tile.bgKind in BG_MINIATURES ? BG_MINIATURES[tile.bgKind] : null;
  return (
    <Link
      href={galleryHref(tile)}
      prefetch={false}
      aria-label={`${tile.label} — ${tile.description} Badge: ${badge.text}`}
      className={cn(
        "group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        spanClassName,
      )}
    >
      <Card className="h-full transition-shadow duration-[var(--motion-standard)] hover:shadow-md">
        <CardContent className="flex flex-col gap-4 p-4">
          {miniature ?? (Miniature ? <Miniature /> : null)}
          <div className="flex items-center gap-3">
            <Avatar size="sm">
              <AvatarFallback>
                <Icon className="size-4" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="flex items-center justify-between gap-3 text-sm font-medium">
                {tile.label}
                <Badge variant={badge.variant}>{badge.text}</Badge>
              </p>
              <p className="truncate text-sm text-muted-foreground">{tile.description}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
