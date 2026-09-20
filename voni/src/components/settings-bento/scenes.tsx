import {
  ArrowRight,
  Bot,
  Building2,
  Cpu,
  Globe,
  Mic,
  Monitor,
  Moon,
  Phone,
  Smartphone,
  Sun,
  User,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { CalendarMark, DriveMark, GmailMark, NotionMark, SlackMark } from "./provider-marks";

/**
 * Ticket 09 image-art replate. The generated comps are composition references;
 * these production scenes stay token-driven React, SVG, and CSS. Green is
 * reserved for traveling packets, live presence, and momentary emphasis.
 */

const PROVIDERS = [
  { label: "Gmail", Mark: GmailMark },
  { label: "Calendar", Mark: CalendarMark },
  { label: "Slack", Mark: SlackMark },
  { label: "Drive", Mark: DriveMark },
  { label: "Notion", Mark: NotionMark },
];

/** Services A: a haloed agent contains the provider fan. */
export function ConstellationScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg viewBox="0 0 400 288" fill="none" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
        <path
          d="M 44 142 C 105 142, 128 142, 183 142"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
        <g className="bento-fan">
          {[76, 108, 140, 172, 204].map((y) => (
            <path
              key={y}
              d={`M 215 142 C 264 142, 292 ${y}, 348 ${y}`}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className="bento-branch-cycle stroke-muted-foreground/60"
              strokeDasharray="5 6"
            />
          ))}
        </g>
      </svg>

      <span className="absolute top-[142px] left-4 flex -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
        <User className="size-3.5" />
        You
      </span>

      <div className="absolute top-[142px] left-1/2 -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="bento-node-ping bento-signal-ping absolute inset-0 rounded-full" />
        <span aria-hidden className="bento-signal-halo absolute -inset-5 rounded-full blur-xl" />
        <span className="relative flex size-16 items-center justify-center rounded-2xl border bg-card text-foreground shadow-md">
          <Bot className="size-7" />
        </span>
      </div>

      <span aria-hidden className="absolute top-[142px] right-1/2 left-[18%] h-0">
        <span className="bento-packet-x absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>

      <div className="absolute top-[61px] right-4 flex flex-col gap-1.5">
        {PROVIDERS.map(({ label, Mark }) => (
          <span key={label} className="flex w-[5.75rem] items-center gap-2 rounded-lg border bg-card px-2 py-1 shadow-sm">
            <Mark className="size-4 shrink-0" />
            <span className="truncate text-xs text-muted-foreground">{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Voice A: one waveform passes through Ivy's identity. */
export function LanesScene() {
  const bars = ["h-2", "h-4", "h-3", "h-5", "h-3.5", "h-6", "h-3", "h-4.5", "h-2.5", "h-4", "h-2"];

  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg viewBox="0 0 400 288" fill="none" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
        <path
          d="M 28 142 C 50 142, 58 118, 78 118 S 104 168, 126 168 S 150 110, 174 110 S 201 172, 226 172 S 248 118, 274 118 S 306 158, 330 158 S 350 142, 372 142"
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/55"
        />
      </svg>

      <span className="bento-lane bento-lane-user absolute top-[130px] left-4 flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-sm">
        <Mic className="size-3.5 text-muted-foreground" />
        You
      </span>
      <span className="bento-lane bento-lane-voni absolute top-[130px] right-4 flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-sm">
        Voni
        <ArrowRight className="size-3.5 text-muted-foreground" />
      </span>

      <div className="absolute top-[91px] left-1/2 w-36 -translate-x-1/2">
        <span aria-hidden className="bento-point-breathe bento-signal-halo absolute -inset-4 rounded-3xl blur-lg" />
        <div className="relative rounded-2xl border bg-card p-2.5 shadow-md">
          <div className="flex items-center gap-2">
            <Avatar className="size-9">
              <AvatarFallback>I</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">Ivy</span>
              <span className="block text-xs text-muted-foreground">US English</span>
            </span>
          </div>
          <span className="mt-2 flex h-7 items-center justify-center gap-0.5" aria-hidden>
            {bars.map((height, index) => (
              <span key={index} className={cn("w-0.5 rounded-full bg-primary/70", height)} />
            ))}
          </span>
        </div>
      </div>

      <span aria-hidden className="absolute top-[142px] right-[17%] left-[17%] h-0">
        <span className="bento-packet-x absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>
    </div>
  );
}

/** Account B: an identity seal opens into two recent sessions. */
export function OrbitScene() {
  const sessions = [
    { icon: Monitor, device: "MacBook Pro", detail: "Active now", live: true },
    { icon: Smartphone, device: "iPhone", detail: "2 hours ago", live: false },
  ];

  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg viewBox="0 0 400 288" fill="none" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
        <path
          d="M 127 142 C 174 142, 183 108, 224 108"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
        <path
          d="M 127 142 C 174 142, 183 176, 224 176"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
      </svg>

      <div className="absolute top-[142px] left-5 -translate-y-1/2">
        <span aria-hidden className="absolute -inset-3 rounded-full border border-muted-foreground/25" />
        <span aria-hidden className="bento-account-orbit absolute -inset-3 rounded-full">
          <span className="bento-signal-dot absolute top-1/2 -right-1 size-2 -translate-y-1/2 rounded-full" />
        </span>
        <div className="relative flex size-24 flex-col items-center justify-center rounded-full border bg-card shadow-md">
          <Avatar className="size-9">
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <span className="mt-1 text-xs font-semibold">Amara</span>
          <span className="text-xs text-muted-foreground">Owner</span>
        </div>
      </div>

      <div className="absolute top-[79px] right-4 flex w-40 flex-col gap-2">
        {sessions.map((session) => (
          <div key={session.device} className="flex items-center gap-2 rounded-xl border bg-card px-2.5 py-2 shadow-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <session.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{session.device}</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {session.live ? <span aria-hidden className="bento-signal-dot size-1.5 rounded-full" /> : null}
                {session.detail}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Workspace A: a defaults ledger feeds Sara and Jonas. */
export function SpineScene() {
  const defaults = [
    { icon: Building2, label: "Workspace", value: "Main" },
    { icon: Globe, label: "Timezone", value: "Dubai" },
    { icon: Phone, label: "Transfer", value: "+971 50" },
  ];

  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg viewBox="0 0 400 288" fill="none" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
        <path
          d="M 214 142 C 254 142, 260 112, 300 112"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
        <path
          d="M 214 142 C 254 142, 260 174, 300 174"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground/50"
          strokeDasharray="5 6"
        />
      </svg>

      <div className="absolute top-[72px] left-4 w-48 overflow-hidden rounded-2xl border bg-card shadow-md">
        <div className="border-b bg-muted/50 px-3 py-2 text-xs font-semibold">Workspace defaults</div>
        {defaults.map((item) => (
          <div key={item.label} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
            <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.label}</span>
            <span className="truncate text-xs font-medium">{item.value}</span>
          </div>
        ))}
      </div>

      <span aria-hidden className="absolute top-[142px] left-[50%] h-0 w-[20%]">
        <span className="bento-packet-x absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>

      <div className="absolute top-[86px] right-4 flex w-[5.75rem] flex-col gap-2">
        {["Sara", "Jonas"].map((name, index) => (
          <div key={name} className="flex items-center gap-1.5 rounded-xl border bg-card px-2 py-2 shadow-sm">
            <span className="relative shrink-0">
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">{name[0]}</AvatarFallback>
              </Avatar>
              {index === 0 ? <span aria-hidden className="bento-signal-dot absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card" /> : null}
            </span>
            <span className="truncate text-xs font-medium">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AppearancePreview({ dark = false }: { dark?: boolean }) {
  const strong = dark ? "bg-background/65 dark:bg-foreground/65" : "bg-foreground/65 dark:bg-background/65";
  const muted = dark ? "bg-background/10 dark:bg-foreground/10" : "bg-muted dark:bg-background/10";

  return (
    <div
      className={cn(
        "absolute inset-0 p-3",
        dark
          ? "bg-foreground text-background dark:bg-background dark:text-foreground"
          : "bg-background text-foreground dark:bg-foreground dark:text-background",
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn("h-2 w-16 rounded-full", strong)} />
        {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </div>
      <div className={cn("mt-3 h-8 rounded-lg", muted)} />
      <div className="mt-2 flex gap-2">
        <div className={cn("h-12 flex-1 rounded-lg", muted)} />
        <div className={cn("h-12 flex-1 rounded-lg", muted)} />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className={cn("h-2 w-20 rounded-full", dark ? "bg-background/30 dark:bg-foreground/30" : "bg-foreground/20 dark:bg-background/20")} />
        <span
          className={cn(
            "h-6 w-14 rounded-md",
            dark ? "bg-background text-foreground dark:bg-foreground dark:text-background" : "bg-foreground dark:bg-background",
          )}
        />
      </div>
    </div>
  );
}

/** Appearance B: one surface crosses a moving light/dark seam. */
export function HorizonScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <div className="absolute top-[60px] right-5 left-5 h-40 overflow-hidden rounded-2xl border bg-card shadow-md">
        <AppearancePreview />
        <div className="bento-theme-dark absolute inset-0 overflow-hidden" aria-hidden>
          <AppearancePreview dark />
        </div>
        <span aria-hidden className="bento-theme-seam absolute inset-y-0 w-px bento-signal-dot" />
      </div>
      <div className="absolute top-[218px] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
        <Sun className="size-3.5" />
        Preview
        <Moon className="size-3.5" />
      </div>
    </div>
  );
}

/** Phone numbers A: number to route to Sara in one linear switchboard. */
export function IncomingScene() {
  return (
    <div className="bento-fade absolute inset-0 origin-top scale-90 transition-transform duration-300 group-hover:scale-95">
      <span aria-hidden className="absolute top-[142px] right-5 left-5 border-t border-dashed border-muted-foreground/50" />
      <span aria-hidden className="absolute top-[142px] right-5 left-5 h-0">
        <span className="bento-packet-x absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bento-signal-dot" />
      </span>

      <span className="absolute top-[142px] left-4 -translate-y-1/2 rounded-xl border bg-card px-3 py-2 font-mono text-xs font-semibold tracking-tight shadow-sm">
        +971 50 123 4567
      </span>

      <div className="absolute top-[142px] left-[61%] -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="bento-route-pulse bento-signal-halo-ring absolute -inset-1 rounded-full" />
        <span className="relative flex size-11 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm">
          <ArrowRight className="size-4" />
        </span>
      </div>

      <span className="absolute top-[142px] right-4 flex -translate-y-1/2 items-center gap-2 rounded-xl border bg-card px-2.5 py-2 shadow-sm">
        <span className="relative">
          <Avatar className="size-7">
            <AvatarFallback>S</AvatarFallback>
          </Avatar>
          <span aria-hidden className="bento-signal-dot absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card" />
        </span>
        <span className="text-xs font-medium">Sara</span>
      </span>
    </div>
  );
}

/** Platform operator C: three service lanes braid through one operator. */
export function ControlScene() {
  const lanes = [
    { icon: Mic, label: "Voice", width: "w-[82%]" },
    { icon: Phone, label: "Phone", width: "w-[64%]" },
    { icon: Cpu, label: "AI", width: "w-[74%]" },
  ];

  return (
    <div className="bento-fade absolute inset-0 origin-top-right scale-90 transition-transform duration-300 group-hover:scale-95">
      <svg viewBox="0 0 400 288" fill="none" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
        {[96, 142, 188].map((y) => (
          <path
            key={y}
            d={`M 91 ${y} C 132 ${y}, 142 142, 181 142 S 228 ${y}, 266 ${y}`}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="stroke-muted-foreground/50"
            strokeDasharray="5 6"
          />
        ))}
      </svg>

      <div className="absolute top-[78px] left-4 flex w-20 flex-col gap-3">
        {lanes.map((lane) => (
          <span key={lane.label} className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 text-xs shadow-sm">
            <lane.icon className="size-3.5 text-muted-foreground" />
            {lane.label}
          </span>
        ))}
      </div>

      <div className="absolute top-[142px] left-1/2 -translate-x-1/2 -translate-y-1/2">
        <span aria-hidden className="absolute -inset-4 rounded-2xl bg-muted/70 blur-lg" />
        <span className="relative flex size-16 flex-col items-center justify-center rounded-2xl border bg-card shadow-md">
          <Bot className="size-6" />
          <span className="mt-1 text-xs font-medium">Operator</span>
        </span>
      </div>

      <div className="bento-operator-stack absolute top-[82px] right-4 flex w-28 flex-col gap-[1.125rem]">
        {lanes.map((lane) => (
          <div key={lane.label} className="relative h-6 rounded-md border bg-card p-1.5 shadow-sm">
            <span className="block h-full rounded-sm bg-muted">
              <span className={cn("block h-full rounded-sm bg-primary/70", lane.width)} />
            </span>
            <span aria-hidden className="bento-operator-packet bento-signal-dot absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
