import { Activity, ArrowRight, Bot, Building2, Cpu, Globe, Mic, Monitor, Phone, Smartphone, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { CalendarMark, DriveMark, GmailMark, NotionMark, SlackMark } from "./provider-marks";

/**
 * Final V01 scenes (ticket 01b winners, graduated to production in ticket
 * 02; the throwaway gallery imports them until ticket 08 deletes it — see
 * DESIGN.md §10b + ADR-0001).
 * Winners: services A, voice A, account C, workspace A, appearance A
 * (placeholder — first replate in ticket 09), numbers B, operator A.
 * Lower-third composition: scene mass sits just above the bottom-anchored
 * title and dissolves into it via the rebalanced `bento-fade`. Containment
 * grammar: key glyphs never clipped (16px inset floor). Brand green ONLY
 * via `.bento-signal-*` on traveling/moment elements. No template-filler
 * words anywhere (DESIGN.md Appendix C).
 */

const PROVIDERS = [
  { label: "Gmail", Mark: GmailMark },
  { label: "Calendar", Mark: CalendarMark },
  { label: "Slack", Mark: SlackMark },
  { label: "Drive", Mark: DriveMark },
  { label: "Notion", Mark: NotionMark },
];

/** Services — provider constellation (A): user enters left, agent
 * center-left, five brand marks fan right. Green: node ping + halo +
 * packet on the you→agent connector. */
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
          d="M 30 164 C 90 164, 130 164, 184 164"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
        <g className="bento-fan">
          {[94, 118, 142, 166, 190].map((y) => (
            <path
              key={y}
              d={`M 218 164 C 270 164, 300 ${y}, 368 ${y}`}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className="bento-branch-cycle stroke-muted-foreground/60"
              strokeDasharray="5 6"
            />
          ))}
        </g>
      </svg>
      <div className="absolute top-[57%] left-4 -translate-y-1/2">
        <span className="flex size-12 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <User className="size-5" />
        </span>
      </div>
      <div className="absolute top-[57%] left-[46%] -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="bento-node-ping bento-signal-ping absolute inset-0 rounded-full" />
        <span className="bento-signal-halo absolute -inset-4 rounded-full blur-xl" aria-hidden />
        <span className="relative flex size-20 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border">
          <Bot className="size-8" />
        </span>
      </div>
      <span aria-hidden className="absolute top-[57%] right-[54%] left-[9%] h-0 -translate-y-1/2">
        <span className="bento-packet-x absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>
      <div className="absolute top-[80px] right-4 flex flex-col">
        {PROVIDERS.map(({ label, Mark }) => (
          <span
            key={label}
            title={label}
            className="-mb-1 flex size-7 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-border last:mb-0"
          >
            <Mark className="size-4" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Voice — request → Ivy voice card → answer (A): caller lane left, Ivy
 * identity center, response lane right. Green: halo breathing behind Ivy,
 * selection dot on the rail, traveling packet. */
export function LanesScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div aria-hidden className="absolute top-[136px] right-4 left-4 border-t border-dashed border-border" />
      <span aria-hidden className="absolute top-[136px] right-4 left-4 h-0">
        <span className="bento-packet-x absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>
      <div className="bento-lane bento-lane-user absolute top-[52px] left-4 w-[34%]">
        <p className="mb-1 inline-block max-w-44 rounded-xl rounded-tl-sm border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="font-medium text-foreground">You</span> · Set my voice to Ivy
        </p>
        <svg viewBox="0 0 300 70" fill="none" preserveAspectRatio="none" aria-hidden className="h-10 w-full">
          <path
            d="M 0 35 C 30 35, 35 10, 65 10 C 95 10, 100 60, 130 60 C 160 60, 165 15, 195 15 C 225 15, 235 55, 265 55 C 280 55, 290 35, 300 35"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary/70"
          />
        </svg>
      </div>
      <div className="absolute top-[52px] left-1/2 w-32 -translate-x-1/2">
        <span aria-hidden className="bento-point-breathe bento-signal-halo absolute -inset-3 rounded-2xl blur-md" />
        <div className="relative flex items-center gap-2 rounded-xl border bg-card px-2.5 py-2 shadow-sm">
          <Avatar className="size-8">
            <AvatarFallback>I</AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">Ivy</span>
            <span className="block text-xs text-muted-foreground">US · English</span>
          </span>
        </div>
        <span className="mt-1.5 flex items-end justify-center gap-0.5" aria-hidden>
          {["h-2", "h-3.5", "h-2.5", "h-4", "h-3"].map((bar, i) => (
            <span key={i} className={`w-1 rounded-full bg-primary/60 ${bar}`} />
          ))}
        </span>
      </div>
      <span aria-hidden className="bento-signal-dot absolute top-[136px] left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
      <div className="bento-lane bento-lane-voni absolute top-[80px] right-4 w-[34%]">
        <p className="mb-1 ml-auto max-w-44 rounded-xl rounded-tr-sm border bg-card px-2.5 py-1 text-right text-xs text-muted-foreground shadow-sm">
          <span className="font-medium text-foreground">Voni</span> · Done — playing Ivy
        </p>
        <svg viewBox="0 0 300 70" fill="none" preserveAspectRatio="none" aria-hidden className="h-10 w-full">
          <path
            d="M 0 35 C 30 35, 35 60, 65 60 C 95 60, 100 10, 130 10 C 160 10, 165 55, 195 55 C 225 55, 235 20, 265 20 C 280 20, 290 35, 300 35"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-primary"
          />
        </svg>
      </div>
    </div>
  );
}

/** Account — centered identity card with flanking device dots (C). Green:
 * session-pill dot breathing. */
export function OrbitScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="absolute top-[76px] left-1/2 w-56 -translate-x-1/2 rounded-xl border bg-card px-3 py-2 text-center shadow-sm">
        <div className="flex items-center gap-2.5 text-left">
          <Avatar className="size-9">
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">Amara</span>
            <span className="block truncate text-xs text-muted-foreground">amara@example.com</span>
          </span>
        </div>
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-sm">
          <span className="relative flex size-1.5" aria-hidden>
            <span className="bento-point-breathe bento-signal-halo absolute inline-flex size-full rounded-full" />
            <span className="bento-signal-dot relative inline-flex size-1.5 rounded-full" />
          </span>
          Voni session · active
        </p>
      </div>
      <span className="absolute top-[108px] left-4 flex size-9 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
        <Monitor className="size-4" />
      </span>
      <span className="absolute top-[108px] right-4 flex size-9 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
        <Smartphone className="size-4" />
      </span>
    </div>
  );
}

/** Workspace — defaults rail + receiving agents (A): compact default rows
 * on a left rail, agent chips right. Green: traveling rail dot + Sara
 * presence. */
export function SpineScene() {
  const rows = [
    { top: "top-[24%]", icon: Building2, label: "Workspace", value: "Main workspace", strong: true },
    { top: "top-[39%]", icon: Globe, label: "Timezone", value: "Asia/Dubai", strong: false },
    { top: "top-[54%]", icon: Phone, label: "Transfer number", value: "+971 50 123 4567", strong: false },
  ];
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="absolute top-[60px] bottom-[38%] left-6 w-0">
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-muted-foreground/50" />
        <span aria-hidden className="bento-spine-dot bento-signal-dot absolute left-1/2 size-2.5 -translate-x-1/2 rounded-full" />
      </div>
      <div className="bento-spine-nodes absolute inset-0" aria-hidden>
        {rows.map((row) => (
          <span
            key={row.label}
            className={cn(
              "absolute left-6 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-primary/20",
              row.top,
            )}
          />
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.label} className={cn("absolute right-[6.25rem] -translate-y-1/2", row.top, "left-10")}>
          <div className="flex items-center gap-2 rounded-xl border bg-card px-2 py-1.5 shadow-sm">
            <row.icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">{row.label}</p>
              <p className={cn("truncate text-xs", row.strong ? "font-semibold" : "font-medium text-muted-foreground")}>
                {row.value}
              </p>
            </div>
          </div>
        </div>
      ))}
      <div className="absolute top-[39%] right-4 flex w-[5.5rem] -translate-y-1/2 flex-col gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 shadow-sm">
          <span className="relative shrink-0">
            <Avatar className="size-6">
              <AvatarFallback className="text-xs">S</AvatarFallback>
            </Avatar>
            <span aria-hidden className="bento-signal-dot absolute -right-0 -bottom-0 size-2 rounded-full ring-2 ring-card" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">Sara</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 shadow-sm">
          <Avatar className="size-6">
            <AvatarFallback className="text-xs">J</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">Jonas</span>
        </div>
      </div>
    </div>
  );
}

/** Appearance — light + dark preview cards (A, placeholder until ticket 09):
 * real control shapes on both cards, selector shuttling between them with
 * alternating selection rings. Green: the traveling selector + rings. */
export function HorizonScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <span aria-hidden className="absolute top-[48px] right-8 left-8 h-0">
        <span className="bento-shuttle-x absolute top-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>
      <div className="absolute top-[84px] left-4 w-[calc(50%-1.25rem)] rounded-xl border bg-card p-2.5 shadow-sm">
        <span aria-hidden className="bento-pulse-alt bento-signal-halo-ring absolute -inset-1 rounded-2xl" />
        <p className="relative mb-2 text-xs font-medium">Light</p>
        <div className="relative flex items-center gap-2">
          <span className="flex h-5 w-9 items-center justify-end rounded-full bg-primary px-0.5">
            <span className="size-3.5 rounded-full bg-primary-foreground" />
          </span>
          <span className="h-6 w-16 rounded-md bg-primary/90" />
        </div>
        <div className="relative mt-2.5 flex items-center gap-2">
          <span className="relative h-1 flex-1 rounded-full bg-muted">
            <span className="absolute top-1/2 left-[60%] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
          </span>
        </div>
      </div>
      <div className="absolute top-[84px] right-4 w-[calc(50%-1.25rem)] rounded-xl bg-foreground p-2.5 shadow-sm">
        <span aria-hidden className="bento-pulse-alt-delay bento-signal-halo-ring absolute -inset-1 rounded-2xl" />
        <p className="relative mb-2 text-xs font-medium text-primary-foreground">Dark</p>
        <div className="relative flex items-center gap-2">
          <span className="flex h-5 w-9 items-center justify-end rounded-full bg-primary-foreground/30 px-0.5">
            <span className="size-3.5 rounded-full bg-primary-foreground" />
          </span>
          <span className="h-6 w-16 rounded-md bg-primary-foreground/90" />
        </div>
        <div className="relative mt-2.5 flex items-center gap-2">
          <span className="relative h-1 flex-1 rounded-full bg-primary-foreground/30">
            <span className="absolute top-1/2 left-[60%] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Numbers — vertical route (B): number chip → seal → agent chip down a
 * center rail, packet pausing at the seal. Green: seal-route packet +
 * agent presence. */
export function IncomingScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <span aria-hidden className="absolute top-[48px] bottom-[95px] left-1/2 w-px -translate-x-1/2 border-l border-dashed border-border" />
      <span aria-hidden className="absolute top-[48px] bottom-[95px] left-1/2 w-0 -translate-x-1/2">
        <span className="bento-descend-seal absolute left-1/2 size-2 -translate-x-1/2 rounded-full bento-signal-dot" />
      </span>
      <div className="absolute top-[48px] left-1/2 -translate-x-1/2">
        <span className="block rounded-xl border bg-card px-3 py-1.5 font-mono text-xs font-semibold tracking-tight whitespace-nowrap shadow-sm">
          +971 50 123 4567
        </span>
      </div>
      <div className="absolute top-[100px] left-1/2 -translate-x-1/2">
        <span className="flex size-6 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-border">
          <ArrowRight className="size-3.5 rotate-90" />
        </span>
      </div>
      <div className="absolute top-[132px] left-1/2 -translate-x-1/2">
        <span className="flex items-center gap-2 rounded-xl border bg-card px-3 py-1.5 shadow-sm">
          <Avatar className="size-7">
            <AvatarFallback>S</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium">Sara</span>
          <span aria-hidden className="bento-signal-dot size-1.5 rounded-full" />
        </span>
      </div>
    </div>
  );
}

/** Operator — control plane (A): node over compact rails, branches scanned
 * in sequence. Green: node presence + the scanning branch flare. */
export function ControlScene() {
  const rows = [
    { icon: Mic, label: "Voice agents", filled: 4, fraction: "4/5" },
    { icon: Phone, label: "Phone calls", filled: 3, fraction: "3/5" },
    { icon: Cpu, label: "AI services", filled: 4, fraction: "4/5" },
  ];
  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <span aria-hidden className="absolute -top-16 -right-16 size-56 rounded-full border border-border/60" />
      <span aria-hidden className="absolute -top-8 -right-8 size-40 rounded-full border border-border/60" />
      <svg
        viewBox="0 0 400 288"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden
        className="absolute inset-0 size-full"
      >
        <g className="bento-scan">
          <path
            d="M 348 88 C 300 90, 220 90, 150 90"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle bento-scan-flare stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
          <path
            d="M 348 88 C 300 102, 220 114, 150 122"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle bento-scan-flare stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
          <path
            d="M 348 88 C 300 124, 220 144, 150 154"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="bento-branch-cycle bento-scan-flare stroke-muted-foreground/50"
            strokeDasharray="4 6"
          />
        </g>
      </svg>
      <div className="absolute top-[64px] right-4">
        <span className="relative flex size-12 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border">
          <Activity className="size-5" />
          <span aria-hidden className="bento-signal-dot absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card" />
        </span>
      </div>
      <div className="absolute top-[78px] left-4 flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2.5 rounded-xl border bg-card px-2.5 py-1 shadow-sm">
            <row.icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="w-[4.5rem] truncate text-xs">{row.label}</span>
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={cn("h-1.5 w-3 rounded-full", i < row.filled ? "bg-primary" : "bg-muted")}
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
