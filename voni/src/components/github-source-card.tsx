import { ExternalLink, GitBranch } from "lucide-react";
import { SourceCard, type SourceCardSummary } from "@/components/source-card";
import { Badge } from "@/components/ui/badge";
import type { GithubClickSummary } from "@/lib/email/clicks";
import {
  RUNNER_OSES,
  clicksPerDay,
  deadAfterSeconds,
  type RunnerOs,
} from "@/lib/email/sources";
import { targetHost } from "@/lib/email/target-url";

/**
 * The GitHub source on the `/email` console: real Chrome on GitHub Actions,
 * one runner per OS, clicking every shared target once per interval.
 *
 * Read-only by construction. A dispatch answers 204 with no body, so the app
 * never learns a run id; the only honest destination is the workflow page, and
 * the only evidence of a run is the click rows the runner posted. That is why
 * every status here is derived from clicks (the same heartbeat the ticker
 * reads) and never from a GitHub API call.
 *
 * The header facts come from the shared `SourceCard` shell and stay outside
 * the collapsed body: enabled state, the volume `clicksPerDay` computes, and
 * the worst-OS status. Opening the card adds detail, never the one number or
 * failure a collapsed card is allowed to hide.
 */

/** What the source row says, when it has one. */
export type GithubSourceConfigView = {
  enabled: boolean;
  intervalSeconds: number;
  windowSeconds: number;
  windowStartHour: number;
  lastDispatchedAt: Date | null;
};

export type GithubSourceCardProps = {
  /** The `email_sources` row for this producer; null when it is not seeded. */
  config: GithubSourceConfigView | null;
  /** The shared target list size — the denominator of `targets x/x`. */
  targetCount: number;
  /** Newest click per OS, the heartbeat the ticker also reads. */
  newestByOs: Partial<Record<RunnerOs, Date>>;
  /** This source's clicks for the basis window, already folded. */
  summary: GithubClickSummary;
  /** How the window is labelled, e.g. "since last dispatch". */
  basis: string;
  /** The stable workflow page; there is no per-run URL to link to. */
  workflowUrl: string;
  /** The request-time clock, so staleness is one value per render. */
  now: Date;
};

const OS_LABELS: Record<RunnerOs, string> = {
  ubuntu: "Ubuntu",
  windows: "Windows",
  macos: "macOS",
};

const OS_SHORT: Record<RunnerOs, string> = {
  ubuntu: "ubuntu",
  windows: "windows",
  macos: "macos",
};

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/** Deterministic, timezone-free display: identical on the server and client. */
function formatWhen(at: Date | null): string {
  if (!at) return "Never run";
  return at.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatInterval(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

function formatWindow(seconds: number): string {
  return `${Math.round(seconds / 3_600)} h`;
}

function formatStartHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00 UTC`;
}

type OsStatus = "never" | "stale" | "live";

/**
 * The same half-open judgement `decideDue` makes: an OS is stale once its
 * newest click is at least `deadAfterSeconds` old. Kept here as a word rather
 * than a second scheduling rule — the number comes from `sources.ts`.
 */
function osStatus(
  newest: Date | undefined,
  now: Date,
  intervalSeconds: number,
): OsStatus {
  if (!newest) return "never";
  const thresholdMs = deadAfterSeconds(intervalSeconds) * 1_000;
  return now.getTime() - newest.getTime() >= thresholdMs ? "stale" : "live";
}

/**
 * The worst OS status, in the order the ticket fixes:
 * disabled, then any OS never run, then any OS stale, else live.
 */
function worstHealth(
  enabled: boolean,
  statuses: readonly OsStatus[],
): SourceCardSummary["health"] {
  if (!enabled) return { label: "Disabled", variant: "outline" };
  if (statuses.includes("never")) {
    return { label: "Never run", variant: "destructive" };
  }
  if (statuses.includes("stale")) {
    return { label: "Stale", variant: "destructive" };
  }
  return { label: "Live", variant: "secondary" };
}

function osBadgeVariant(status: OsStatus): "secondary" | "destructive" {
  return status === "live" ? "secondary" : "destructive";
}

function osStatusLabel(status: OsStatus): string {
  if (status === "never") return "Never run";
  return status === "stale" ? "Stale" : "Live";
}

function StatusField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground font-mono text-xs">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

export function GithubSourceCard({
  config,
  targetCount,
  newestByOs,
  summary,
  basis,
  workflowUrl,
  now,
}: GithubSourceCardProps) {
  const configured = config !== null;
  const enabled = config?.enabled ?? false;
  // The one volume arithmetic in the repo; a second formula would let the
  // header and the scheduler disagree about what the source commands.
  const perDay = config
    ? clicksPerDay(
        config.intervalSeconds,
        config.windowSeconds,
        targetCount,
        RUNNER_OSES.length,
      )
    : null;
  const statuses = config
    ? RUNNER_OSES.map((os) =>
        osStatus(newestByOs[os], now, config.intervalSeconds),
      )
    : [];

  return (
    <SourceCard
      testId="email-github-source"
      name="GitHub"
      icon={<GitBranch className="size-4" />}
      description="Real Chrome on GitHub Actions, one runner on every OS, clicking every shared target once per interval. It proves a click survives a browser, not just an HTTP client."
      summary={{
        status: !configured
          ? { label: "Not configured", variant: "destructive" }
          : enabled
            ? { label: "Enabled", variant: "default" }
            : { label: "Disabled", variant: "outline" },
        volume: {
          value: perDay === null ? "—" : formatCount(perDay),
          label: "clicks/day",
        },
        health: !configured
          ? { label: "Not configured", variant: "destructive" }
          : worstHealth(enabled, statuses),
      }}
    >
      {config === null ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="email-github-unconfigured"
        >
          This source has no configuration row yet. Nothing clicks from GitHub
          until the source is seeded and enabled.
        </p>
      ) : (
        <div className="grid gap-5">
          <section
            aria-label="GitHub source schedule"
            data-testid="email-github-schedule"
            className="grid gap-3"
          >
            <h4 className="text-muted-foreground font-mono text-xs">
              Schedule
            </h4>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatusField label="interval">
                {formatInterval(config.intervalSeconds)}
              </StatusField>
              <StatusField label="window">
                {formatWindow(config.windowSeconds)}
              </StatusField>
              <StatusField label="starts">
                {formatStartHour(config.windowStartHour)}
              </StatusField>
              <StatusField label="shared targets">
                {targetCount}
              </StatusField>
            </dl>
            <p className="text-muted-foreground text-xs">
              Every pass clicks every shared target from every OS, so the
              header&apos;s clicks/day is one pass × {targetCount} targets ×{" "}
              {RUNNER_OSES.length} OSes. Coverage below is counted {basis}.
            </p>
          </section>

          {enabled ? null : (
            <p
              className="rounded-lg border px-3 py-2 text-sm"
              data-testid="email-github-disabled"
            >
              This source is disabled. Nothing clicks from GitHub, and the OS
              rows below show what was last recorded rather than a live run.
            </p>
          )}

          <section
            aria-label="GitHub runs by operating system"
            data-testid="email-github-runs"
            className="grid gap-3"
          >
            <h4 className="text-muted-foreground font-mono text-xs">
              Runs by operating system
            </h4>
            <ul className="grid gap-3">
              {RUNNER_OSES.map((os) => {
                const newest = newestByOs[os];
                const status = osStatus(
                  newest,
                  now,
                  config.intervalSeconds,
                );
                const osStats = summary.byOs.find((row) => row.os === os)!;
                // A never-run OS and a disabled source are said in words: a
                // `0/4` would read as a measured miss rather than "no run".
                const coverage = !enabled
                  ? "Not scheduled"
                  : status === "never"
                    ? "Never run"
                    : `${osStats.targets.length}/${targetCount}`;
                const conclusion = !newest
                  ? "Never run"
                  : osStats.clicks === 0
                    ? `No clicks ${basis}`
                    : osStats.failed === 0
                      ? `${formatCount(osStats.clicks)} clicks, none failed`
                      : `${formatCount(osStats.failed)} of ${formatCount(osStats.clicks)} clicks failed`;

                return (
                  <li
                    key={os}
                    className="grid gap-2 rounded-lg border px-3 py-3"
                    data-testid={`email-github-os-${os}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{OS_LABELS[os]}</span>
                      <Badge
                        variant={osBadgeVariant(status)}
                        data-testid={`email-github-os-${os}-status`}
                      >
                        {osStatusLabel(status)}
                      </Badge>
                    </div>
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <StatusField label="last run">
                        <span className="font-mono text-xs">
                          {formatWhen(newest ?? null)}
                        </span>
                      </StatusField>
                      <StatusField label="conclusion">{conclusion}</StatusField>
                      <StatusField label="targets">
                        <span data-testid={`email-github-os-${os}-targets`}>
                          {coverage}
                        </span>{" "}
                        <span className="text-muted-foreground text-xs">
                          ({basis})
                        </span>
                      </StatusField>
                      <StatusField label="runs">
                        <a
                          href={workflowUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                          data-testid={`email-github-os-${os}-runs`}
                        >
                          Runs &amp; artifacts
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                      </StatusField>
                    </dl>
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground text-xs">
              A dispatch has no run id to link to, so every row points at the
              same workflow page; the latest run and its artifacts are the
              first entry there.
            </p>
          </section>

          <section
            aria-label="GitHub source clicks by OS and target"
            data-testid="email-github-stats"
            className="grid gap-3"
          >
            <h4 className="text-muted-foreground font-mono text-xs">
              This source · {basis}
            </h4>

            <dl className="grid gap-3 sm:grid-cols-3">
              {RUNNER_OSES.map((os) => {
                const osStats = summary.byOs.find((row) => row.os === os)!;
                return (
                  <StatusField key={os} label={OS_LABELS[os]}>
                    {osStats.clicks === 0 ? (
                      <span data-testid={`email-github-stats-${os}`}>
                        No clicks
                      </span>
                    ) : (
                      <span data-testid={`email-github-stats-${os}`}>
                        {formatCount(osStats.clicks)} clicks ·{" "}
                        {osStats.targets.length}/{targetCount} targets
                      </span>
                    )}
                  </StatusField>
                );
              })}
            </dl>

            {summary.byTarget.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No GitHub clicks {basis}.
              </p>
            ) : (
              <ul className="grid gap-2" data-testid="email-github-targets">
                {summary.byTarget.map((row) => (
                  <li
                    key={row.target}
                    className="grid gap-1 rounded-md border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span
                      className="font-mono text-xs break-all"
                      title={row.target}
                    >
                      {targetHost(row.target)}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {RUNNER_OSES.map((os) => (
                        <Badge
                          key={os}
                          variant={row.byOs[os] > 0 ? "secondary" : "outline"}
                        >
                          {OS_SHORT[os]} · {row.byOs[os]}
                        </Badge>
                      ))}
                      <Badge variant="outline">
                        total · {row.clicks}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </SourceCard>
  );
}
