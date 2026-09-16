import { Activity, ArrowRight, Bot, Building2, Cpu, Globe, Mic, Monitor, Phone, Smartphone, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { CalendarMark, DriveMark, GmailMark, NotionMark, SlackMark } from "./provider-marks";

/**
 * Second-round scenes for the winning V01 layout (ticket 01; gallery
 * throwaway, deleted in ticket 08 — see DESIGN.md §10b). Token-only color
 * except scoped `--provider-*` glyph fills; motion reuses the amended
 * `bento-*` families; meaning lives in the top 60% (the mask eats the
 * bottom); key elements bleed off the top/right edges.
 */

const PROVIDERS = [
  { label: "Gmail", Mark: GmailMark },
  { label: "Calendar", Mark: CalendarMark },
  { label: "Slack", Mark: SlackMark },
  { label: "Drive", Mark: DriveMark },
  { label: "Notion", Mark: NotionMark },
];

/** Services — provider constellation (A, flow diagram): user enters left,
 * agent right of center, five brand marks fan upper-right with two nodes
 * bleeding off the edges. Opaque discs + overshooting paths keep
 * registration at any width. */
export function ConstellationScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg
        viewBox="0 0 400 288"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden
        className="absolute inset-0 size-full"
      >
        <path
          d="M 30 150 C 100 150, 150 150, 205 150"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
        <g className="bento-fan">
          {[46, 92, 138, 184, 230].map((y) => (
            <path
              key={y}
              d={`M 258 150 C 310 150, 340 ${y}, 392 ${y}`}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className="bento-branch-cycle stroke-muted-foreground/60"
              strokeDasharray="5 6"
            />
          ))}
        </g>
      </svg>
      <div className="absolute top-1/2 left-10 -translate-y-1/2">
        <span className="flex size-12 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <User className="size-5" />
        </span>
      </div>
      <div className="absolute top-1/2 left-[58%] -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="bento-node-ping absolute inset-0 rounded-full ring-2 ring-primary" />
        <span className="absolute -inset-4 rounded-full bg-primary/10 blur-xl" aria-hidden />
        <span className="relative flex size-20 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border">
          <Bot className="size-8" />
        </span>
      </div>
      <div className="absolute top-1/2 right-0 flex -translate-y-1/2 translate-x-1/4 flex-col gap-2">
        {PROVIDERS.map(({ label, Mark }) => (
          <span
            key={label}
            title={label}
            className="flex size-9 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-border"
          >
            <Mark className="size-5" />
          </span>
        ))}
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-1 ring-border">
          …
        </span>
      </div>
    </div>
  );
}

/** Voice — duplex lanes (B, event stream): user wave left, response wave
 * right, fragments secondary, overlap at an accent conversation point. Both
 * ends bleed. */
export function LanesScene() {
  return (
    <div className="bento-fade absolute inset-y-0 -right-8 -left-8 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="bento-lane bento-lane-user absolute top-[16%] right-[30%] left-0">
        <p className="mb-1 ml-8 inline-block max-w-40 rounded-xl rounded-tl-sm border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="font-medium text-foreground">You</span> · Set my voice to Ivy
        </p>
        <svg viewBox="0 0 300 70" fill="none" preserveAspectRatio="none" aria-hidden className="h-14 w-full">
          <path
            d="M 0 35 C 30 35, 35 10, 65 10 C 95 10, 100 60, 130 60 C 160 60, 165 15, 195 15 C 225 15, 235 55, 265 55 C 280 55, 290 35, 300 35"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary/70"
          />
        </svg>
      </div>
      <div className="bento-lane bento-lane-voni absolute top-[40%] right-0 left-[30%]">
        <p className="mb-1 mr-8 ml-auto max-w-40 rounded-xl rounded-tr-sm border bg-card px-2.5 py-1 text-right text-xs text-muted-foreground shadow-sm">
          <span className="font-medium text-foreground">Voni</span> · Done
        </p>
        <svg viewBox="0 0 300 70" fill="none" preserveAspectRatio="none" aria-hidden className="h-14 w-full">
          <path
            d="M 0 35 C 30 35, 35 60, 65 60 C 95 60, 100 10, 130 10 C 160 10, 165 55, 195 55 C 225 55, 235 20, 265 20 C 280 20, 290 35, 300 35"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary"
          />
        </svg>
      </div>
      <span aria-hidden className="absolute top-[36%] left-[60%] flex size-5 items-center justify-center">
        <span className="absolute inline-flex size-full rounded-full bg-primary opacity-25 blur-sm" />
        <span className="relative size-2 rounded-full bg-primary" />
      </span>
    </div>
  );
}

/** Account — identity orbit (D, signal scene): oversized initials disc
 * clipped top-right, facet chips, orbiting session dot on thin arcs, accent
 * on the avatar edge. */
export function OrbitScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="bento-orbit absolute top-0 right-0 flex size-56 translate-x-6 -translate-y-6 items-center justify-center">
        <span aria-hidden className="absolute inset-4 rounded-full border border-dashed border-border" />
        <span aria-hidden className="absolute top-0 left-1/2 size-3 -translate-x-1/2 rounded-full bg-primary ring-4 ring-primary/15" />
        <span className="relative">
          <Avatar className="size-20">
            <AvatarFallback className="text-2xl">A</AvatarFallback>
          </Avatar>
          <span aria-hidden className="absolute right-1 bottom-1 size-4 rounded-full bg-primary ring-2 ring-card" />
        </span>
      </div>
      <div className="absolute top-[46%] right-24 flex gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <Monitor className="size-3.5" />
        </span>
        <span className="flex size-7 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <Smartphone className="size-3.5" />
        </span>
      </div>
      <div className="absolute top-[62%] right-10 text-right">
        <p className="text-sm font-medium">Amara</p>
        <p className="text-xs text-muted-foreground">amara@acme.test</p>
        <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-sm">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          Voni session · active
        </p>
      </div>
    </div>
  );
}

/** Workspace — config spine (A/D, flow + signal): rail from the top edge,
 * three staggered value rows fading downward, bleeding right. */
export function SpineScene() {
  const rows = [
    { top: "top-[10%]", left: "left-[4.5rem]", icon: Building2, label: "Workspace", value: "Acme Viewings", strong: true },
    { top: "top-[42%]", left: "left-[5.5rem]", icon: Globe, label: "Timezone", value: "Asia/Dubai", strong: false },
    { top: "top-[74%]", left: "left-[6.5rem]", icon: Phone, label: "Transfer number", value: "+971 50 123 4567", strong: false },
  ];
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="absolute top-0 bottom-0 left-10 w-0">
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-muted-foreground/50" />
        <span aria-hidden className="bento-spine-dot absolute left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-primary" />
      </div>
      <div className="bento-spine-nodes absolute inset-0" aria-hidden>
        {rows.map((row) => (
          <span
            key={row.label}
            className={cn(
              "absolute left-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-primary/20",
              row.top,
            )}
          />
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.label} className={cn("absolute right-0 -translate-y-1/2", row.top, row.left)}>
          <div className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2 shadow-sm">
            <row.icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{row.label}</p>
              <p className={cn("truncate text-sm", row.strong ? "font-semibold" : "font-medium text-muted-foreground")}>
                {row.value}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Appearance — theme horizon (E, state transformation): one mock interface
 * crossing a drifting bright/dark diagonal, accent selector riding the
 * boundary. */
export function HorizonScene() {
  const rows = [0, 1, 2];
  const mockRows = (bar: string, pill: string) => (
    <div className="absolute inset-x-10 top-[14%] flex flex-col gap-3">
      {rows.map((i) => (
        <div key={i} className="flex items-center gap-2">
          <span className={cn("h-2.5 flex-1 rounded-full", bar)} />
          <span className={cn("h-6 w-12 rounded-full", pill)} />
        </div>
      ))}
    </div>
  );
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95 overflow-hidden">
      <div className="bento-horizon absolute inset-0 scale-110">
        <div aria-hidden className="absolute inset-0 bg-muted/40" />
        <div aria-hidden className="bento-horizon-dark absolute inset-0 bg-foreground" />
        <div aria-hidden className="bento-horizon-light absolute inset-0">
          {mockRows("bg-muted-foreground/30", "bg-muted-foreground/20")}
        </div>
        <div aria-hidden className="bento-horizon-dark absolute inset-0">
          {mockRows("bg-white/25", "bg-white/20")}
        </div>
        <span
          aria-hidden
          className="absolute top-[26%] left-[58%] size-3 -translate-x-1/2 rounded-full bg-primary ring-4 ring-primary/25"
        />
      </div>
    </div>
  );
}

/** Numbers — incoming route (A, flow diagram): typographic number chip,
 * routing seal, agent chip clipped by the edge. Straight-line pulse with a
 * seal pause. */
export function IncomingScene() {
  return (
    <div className="bento-fade absolute inset-x-0 top-16 origin-top scale-90 transition-transform duration-300 group-hover:scale-95 flex items-center gap-4 px-8">
      <span className="-translate-x-6 rounded-xl border bg-card px-4 py-2.5 font-mono text-lg font-semibold tracking-tight whitespace-nowrap shadow-sm">
        +971 50 123 4567
      </span>
      <span className="relative h-8 flex-1">
        <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
        <span className="absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <ArrowRight className="size-4" />
        </span>
        <span aria-hidden className="bento-route-pulse absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-primary" />
      </span>
      <span className="flex translate-x-6 items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm">
        <Avatar className="size-9">
          <AvatarFallback>S</AvatarFallback>
        </Avatar>
        <span>
          <span className="block text-sm font-medium">Sara</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            agent
          </span>
        </span>
      </span>
    </div>
  );
}

/** Operator — control plane (A/D, flow + signal): operator node clipped
 * upper-right, three branches with segmented rails and fractions,
 * decorative arcs. */
export function ControlScene() {
  const rows = [
    { icon: Mic, label: "Voice agents", filled: 4, fraction: "4/5" },
    { icon: Phone, label: "Phone calls", filled: 3, fraction: "3/5" },
    { icon: Cpu, label: "AI services", filled: 4, fraction: "4/5" },
  ];
  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <span aria-hidden className="absolute -top-20 -right-20 size-56 rounded-full border border-border/60" />
      <span aria-hidden className="absolute -top-10 -right-10 size-40 rounded-full border border-border/60" />
      <svg
        viewBox="0 0 400 288"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden
        className="absolute inset-0 size-full"
      >
        <g className="bento-scan">
          <path
            d="M 352 44 C 300 60, 220 110, 150 150"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
          <path
            d="M 352 44 C 300 90, 220 170, 150 200"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
          <path
            d="M 352 44 C 300 120, 220 220, 150 248"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
        </g>
      </svg>
      <div className="absolute top-4 right-4 translate-x-6 -translate-y-2">
        <span className="relative flex size-12 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border">
          <Activity className="size-5" />
          <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />
        </span>
      </div>
      <div className="absolute top-[38%] left-8 flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2 shadow-sm">
            <row.icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="w-24 truncate text-xs">{row.label}</span>
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={cn("h-1.5 w-4 rounded-full", i < row.filled ? "bg-primary" : "bg-muted")}
                />
              ))}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{row.fraction}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
