"use client";

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LiveSnapshot } from "@/lib/email/live";
import { proxyReportAge } from "@/lib/email/proxy-policy";

/**
 * The `/email` console's "is it clicking right now" panel.
 *
 * It polls one authorised snapshot every five seconds, so an operator can watch
 * clicks arrive without reloading the page. The intervals stop while the tab is
 * hidden and restart on return: a background tab polling a database every five
 * seconds is load with no reader.
 *
 * Every age is derived from `snapshot.now`, never from a fresh `Date` in
 * render, so the server-rendered first paint and the first client paint agree
 * and a poll cannot make two rows look measured against different clocks.
 *
 * A failed poll never blanks the panel. The last snapshot stays on screen and
 * the header says it is stale, because "no data" and "the last reading" are
 * different facts and only one of them is true.
 */

const POLL_MS = 5_000;

/** A click this recent means the source is live, not just enabled. */
const LIVE_WINDOW_MS = 5 * 60_000;

const WINDOW_ROWS = [
  { minutes: 5 as const, label: "Last 5 min" },
  { minutes: 60 as const, label: "Last hour" },
  { minutes: 1440 as const, label: "Last 24 hours" },
];

type Os = LiveSnapshot["byOs"][number]["os"];

const OS_LABELS: Record<Os, string> = {
  ubuntu: "Ubuntu",
  windows: "Windows",
  macos: "macOS",
};

function osLabel(os: string): string {
  return OS_LABELS[os as Os] ?? os;
}

/** Milliseconds for an ISO stamp, or null when it cannot be read. */
function stampMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The newest click across the OS rows, from the snapshot's own clock. */
function newestClickMs(byOs: LiveSnapshot["byOs"]): number | null {
  let newest: number | null = null;
  for (const row of byOs) {
    const ms = stampMs(row.lastClickAt);
    if (ms === null) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/** A fixed instant, timezone-free, so two renders print the same string. */
function formatStamp(iso: string | null): string {
  const ms = stampMs(iso);
  if (ms === null) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function ageWords(iso: string | null, nowMs: number): string {
  if (iso === null) return "never";
  return proxyReportAge(iso, nowMs);
}

function osBadge(lastClickAt: string | null, nowMs: number): {
  label: string;
  variant: "secondary" | "outline" | "destructive";
} {
  const ms = stampMs(lastClickAt);
  if (ms === null) return { label: "Never", variant: "destructive" };
  if (nowMs - ms <= LIVE_WINDOW_MS) return { label: "Live", variant: "secondary" };
  return { label: "Quiet", variant: "outline" };
}

/**
 * A minimal guard, not a second contract: it only stops an error page or a
 * proxy's HTML from replacing a real snapshot with `undefined` fields.
 */
function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.now === "string" &&
    typeof snapshot.enabled === "boolean" &&
    (snapshot.lastDispatchAt === null ||
      typeof snapshot.lastDispatchAt === "string") &&
    Array.isArray(snapshot.windows) &&
    Array.isArray(snapshot.byOs) &&
    Array.isArray(snapshot.failures) &&
    Array.isArray(snapshot.exits)
  );
}

export type LivePanelProps = {
  /** The page's server-rendered snapshot, so the panel paints immediately. */
  initial: LiveSnapshot;
};

export function LivePanel({ initial }: LivePanelProps) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(initial);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight: AbortController | null = null;

    async function poll(): Promise<void> {
      // One request at a time: the next tick waits rather than aborting a read
      // that may finish in time, and a hidden tab never starts one.
      if (cancelled || document.hidden || inFlight !== null) return;

      const controller = new AbortController();
      inFlight = controller;
      setPending(true);

      try {
        const response = await fetch("/api/email/live", {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`live snapshot ${response.status}`);
        }
        const body: unknown = await response.json();
        if (!isLiveSnapshot(body)) {
          throw new Error("live snapshot shape");
        }
        if (cancelled) return;
        setSnapshot(body);
        setStale(false);
      } catch {
        // An abort means this poll was superseded or the panel unmounted; that
        // is not a failed read and must not mark a good snapshot stale.
        if (cancelled || controller.signal.aborted) return;
        setStale(true);
      } finally {
        if (inFlight === controller) {
          inFlight = null;
          if (!cancelled) setPending(false);
        }
      }
    }

    function start(): void {
      if (timer !== null || document.hidden) return;
      void poll();
      timer = setInterval(() => {
        void poll();
      }, POLL_MS);
    }

    function stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    function onVisibilityChange(): void {
      if (document.hidden) stop();
      else start();
    }

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
      inFlight?.abort();
    };
  }, []);

  const nowMs = Date.parse(snapshot.now);
  const newest = newestClickMs(snapshot.byOs);
  const recent = newest !== null && nowMs - newest <= LIVE_WINDOW_MS;
  const lastFive = snapshot.windows.find((window) => window.minutes === 5);
  const status = !snapshot.enabled ? "Off" : recent || (lastFive?.total ?? 0) > 0 ? "Live" : "Idle";

  const statusLine = !snapshot.enabled
    ? newest === null
      ? "The source is disabled; nothing is being dispatched."
      : `The source is disabled; nothing is being dispatched. Last click ${proxyReportAge(newest, nowMs)}.`
    : newest === null
      ? "No click has been recorded yet."
      : `Last click ${proxyReportAge(newest, nowMs)}.`;

  return (
    <Card data-testid="email-live-panel">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" aria-hidden />
            Clicking now
          </CardTitle>
          {stale ? (
            <Badge variant="destructive" data-testid="email-live-stale">
              Stale
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          The GitHub runners, from their own click reports. It refreshes every
          five seconds while this tab is visible.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4">
        {stale ? (
          <p className="text-sm font-medium" role="status">
            The last refresh failed. These are the numbers from the last
            successful poll; the panel keeps trying every five seconds.
          </p>
        ) : null}

        <section aria-label="Live status" className="grid gap-1">
          <p
            className="text-2xl font-semibold tracking-tight"
            data-testid="email-live-status"
          >
            {status}
          </p>
          <p className="text-sm" data-testid="email-live-last-click">
            {statusLine}
          </p>
        </section>

        <section aria-label="Clicks by window" className="grid gap-2">
          <h3 className="text-sm font-medium">Clicks</h3>
          <dl className="grid gap-2 sm:grid-cols-3">
            {WINDOW_ROWS.map(({ minutes, label }) => {
              const window = snapshot.windows.find(
                (row) => row.minutes === minutes,
              );
              return (
                <div
                  key={minutes}
                  className="grid gap-1 rounded-lg border px-3 py-3"
                  data-testid={`email-live-window-${minutes}`}
                >
                  <dt className="text-muted-foreground font-mono text-xs">
                    {label}
                  </dt>
                  <dd className="grid gap-0.5">
                    <span className="text-2xl font-semibold tabular-nums">
                      {window?.total ?? 0}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {window?.ok ?? 0} ok · {window?.failed ?? 0} failed
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        <section aria-label="Runners by operating system" className="grid gap-2">
          <h3 className="text-sm font-medium">Runners</h3>
          <ul className="grid gap-2">
            {snapshot.byOs.map((row) => {
              const badge = osBadge(row.lastClickAt, nowMs);
              return (
                <li
                  key={row.os}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
                  data-testid={`email-live-os-${row.os}`}
                >
                  <span className="font-medium">{OS_LABELS[row.os]}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm">
                      {row.lastClickAt === null
                        ? "Never clicked"
                        : `Last click ${ageWords(row.lastClickAt, nowMs)}`}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {row.clicksLastHour} this hour
                    </span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Failures by reason" className="grid gap-2">
          <h3 className="text-sm font-medium">Failures · last 24 hours</h3>
          {snapshot.failures.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No failure reason was recorded.
            </p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="email-live-failures">
              {snapshot.failures.map((failure) => (
                <li
                  key={failure.reason}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="font-mono text-xs">{failure.reason}</span>
                  <span className="font-mono text-xs tabular-nums">
                    × {failure.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Ready exits by operating system" className="grid gap-2">
          <h3 className="text-sm font-medium">Exits ready</h3>
          {snapshot.exits.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No runner has reported its exit pool yet.
            </p>
          ) : (
            <ul className="grid gap-2">
              {snapshot.exits.map((exit) => (
                <li
                  key={exit.os}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
                  data-testid={`email-live-exits-${exit.os}`}
                >
                  <span className="font-medium">{osLabel(exit.os)}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm">
                      {exit.ready} of {exit.liveExitLimit} exits ready ·
                      reported {ageWords(exit.receivedAt, nowMs)}
                    </span>
                    <Badge variant={exit.ok ? "secondary" : "destructive"}>
                      {exit.ok ? "Pool ok" : "Pool failed"}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-2 border-t pt-4">
          <p className="text-sm" data-testid="email-live-dispatch">
            Last dispatch:{" "}
            <span className="font-mono text-xs">
              {formatStamp(snapshot.lastDispatchAt)}
            </span>
            {snapshot.lastDispatchAt === null ? null : (
              <span className="text-muted-foreground">
                {" "}
                · {ageWords(snapshot.lastDispatchAt, nowMs)}
              </span>
            )}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-testid="email-live-poll"
          >
            {stale
              ? "Refresh failed — showing the last snapshot, retrying every five seconds."
              : pending
                ? "Checking…"
                : "Refreshes every five seconds while this tab is visible."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
