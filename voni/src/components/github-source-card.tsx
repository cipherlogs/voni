"use client";

import { useActionState, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
} from "lucide-react";
import { LoadingButton } from "@/components/loading-button";
import { SourceCard, type SourceCardSummary } from "@/components/source-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import type { GithubClickSummary } from "@/lib/email/clicks";
import {
  INTERVAL_SECONDS,
  RUNNER_OSES,
  WINDOW_SECONDS,
  clicksPerDay,
  deadAfterSeconds,
  type RunnerOs,
} from "@/lib/email/sources";
import { targetHost } from "@/lib/email/target-url";

/**
 * The GitHub source on the `/email` console: real Chrome on GitHub Actions,
 * one runner per OS, clicking every shared target once per interval.
 *
 * Every status here is derived from clicks (the same heartbeat the ticker
 * reads) and never from a GitHub API call: a dispatch answers 204 with no body,
 * so the only honest destination is the workflow page and the only evidence of
 * a run is the click rows the runner posted.
 *
 * The header facts come from the shared `SourceCard` shell and stay outside
 * the collapsed body: enabled state, the volume `clicksPerDay` computes, and
 * the worst-OS status. Opening the card adds detail, never the one number or
 * failure a collapsed card is allowed to hide.
 *
 * The controls post to actions that arrive as props, so the page stays the one
 * place that knows which server functions exist. Each write control owns its
 * pending state: saving the schedule never disables the enable button and vice
 * versa. The preview beside the selects is computed from the values about to be
 * saved, through the same `clicksPerDay` the header and ticker use.
 *
 * Locked is presentation only; both actions re-check the control cookie in
 * their own bodies.
 */

/** What the source row says, when it has one. */
export type GithubSourceConfigView = {
  enabled: boolean;
  intervalSeconds: number;
  windowSeconds: number;
  windowStartHour: number;
  lastDispatchedAt: Date | null;
};

/** The shape both actions return; the house `ControlState`, kept local. */
export type GithubControlState = {
  ok: boolean;
  message?: string;
  error?: string;
};

export type GithubSourceCardProps = {
  /** Presentation only; every action re-checks the cookie itself. */
  locked: boolean;
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
  /** Enable or disable this source; field `enabled` = "true" | "false". */
  setEnabled: (
    previous: GithubControlState,
    formData: FormData,
  ) => Promise<GithubControlState>;
  /** Save the schedule; fields `interval`, `window`, `startHour`. */
  saveSchedule: (
    previous: GithubControlState,
    formData: FormData,
  ) => Promise<GithubControlState>;
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

const START_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

const INITIAL: GithubControlState = { ok: false };

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

function intervalOptionLabel(seconds: number): string {
  return seconds % 60 === 0 ? `Every ${seconds / 60} min` : `Every ${seconds} s`;
}

function FeedbackAlert({ state }: { state: GithubControlState }) {
  if (!state.error && !state.message) return null;

  return (
    <Alert
      variant={state.error ? "destructive" : "default"}
      className="status-enter"
      data-testid="email-github-feedback"
    >
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>
        {state.error ? "Could not update the source" : "Done"}
      </AlertTitle>
      <AlertDescription>{state.error ?? state.message}</AlertDescription>
    </Alert>
  );
}

/** Inline Alert is the required surface; a toast rides along as a convenience. */
function useActionToast(state: GithubControlState) {
  useEffect(() => {
    if (state.error) {
      toast.add({
        title: "Could not update the source",
        description: state.error,
        type: "error",
      });
    } else if (state.message) {
      toast.add({
        title: "Done",
        description: state.message,
        type: "success",
      });
    }
    // `state` is a fresh object per submission, so a repeat message still shows.
  }, [state]);
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
  locked,
  config,
  targetCount,
  newestByOs,
  summary,
  basis,
  workflowUrl,
  now,
  setEnabled,
  saveSchedule,
}: GithubSourceCardProps) {
  // Draft values start from the saved row and stay editable until a save lands;
  // the preview reads these, not the saved numbers, so it answers "what would
  // this schedule click" before the write.
  const [draftInterval, setDraftInterval] = useState<number>(
    () => config?.intervalSeconds ?? 60,
  );
  const [draftWindow, setDraftWindow] = useState<number>(
    () => config?.windowSeconds ?? WINDOW_SECONDS[1],
  );
  const [draftStartHour, setDraftStartHour] = useState<number>(
    () => config?.windowStartHour ?? 7,
  );

  const [scheduleState, saveScheduleAction, savingSchedule] = useActionState(
    saveSchedule,
    INITIAL,
  );
  const [enabledState, setEnabledAction, togglingSource] = useActionState(
    setEnabled,
    INITIAL,
  );

  useActionToast(scheduleState);
  useActionToast(enabledState);

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
  // The number the operator sees before saving, from the same formula.
  const previewPerDay = clicksPerDay(
    draftInterval,
    draftWindow,
    targetCount,
    RUNNER_OSES.length,
  );
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
          {locked ? (
            <Alert variant="destructive" data-testid="email-github-locked">
              <AlertCircle />
              <AlertTitle>Controls are locked</AlertTitle>
              <AlertDescription>
                Unlock the panel above to enable this source or change its
                schedule. The values below are the saved configuration, and
                nothing here can be written while the panel is locked.
              </AlertDescription>
            </Alert>
          ) : null}

          <section
            aria-label="GitHub source schedule"
            data-testid="email-github-schedule"
            className="grid gap-3"
          >
            <h4 className="text-muted-foreground font-mono text-xs">
              Schedule
            </h4>
            <form action={saveScheduleAction} className="grid gap-4">
              <FieldGroup className="grid gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="email-github-interval">
                    Interval
                  </FieldLabel>
                  <input
                    type="hidden"
                    name="interval"
                    value={draftInterval}
                  />
                  <Select
                    value={String(draftInterval)}
                    onValueChange={(next) => {
                      if (next) setDraftInterval(Number(next));
                    }}
                    disabled={locked || savingSchedule}
                  >
                    <SelectTrigger
                      id="email-github-interval"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {INTERVAL_SECONDS.map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>
                            {intervalOptionLabel(seconds)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    One pass over every target at this pace.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="email-github-window">
                    Active window
                  </FieldLabel>
                  <input type="hidden" name="window" value={draftWindow} />
                  <Select
                    value={String(draftWindow)}
                    onValueChange={(next) => {
                      if (next) setDraftWindow(Number(next));
                    }}
                    disabled={locked || savingSchedule}
                  >
                    <SelectTrigger id="email-github-window" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {WINDOW_SECONDS.map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>
                            {formatWindow(seconds)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    How long the source runs each day.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="email-github-start-hour">
                    Starts (UTC)
                  </FieldLabel>
                  <input
                    type="hidden"
                    name="startHour"
                    value={draftStartHour}
                  />
                  <Select
                    value={String(draftStartHour)}
                    onValueChange={(next) => {
                      if (next) setDraftStartHour(Number(next));
                    }}
                    disabled={locked || savingSchedule}
                  >
                    <SelectTrigger
                      id="email-github-start-hour"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {START_HOURS.map((hour) => (
                          <SelectItem key={hour} value={String(hour)}>
                            {formatStartHour(hour)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Windows are half-open: start inclusive, end exclusive.
                  </FieldDescription>
                </Field>
              </FieldGroup>

              <p className="text-sm" data-testid="email-github-preview">
                <span className="font-medium">
                  {formatCount(previewPerDay)}
                </span>{" "}
                clicks/day with this schedule
                <span className="text-muted-foreground">
                  {" "}
                  — one pass every {formatInterval(draftInterval)} for{" "}
                  {formatWindow(draftWindow)} from{" "}
                  {formatStartHour(draftStartHour)}, clicking {targetCount}{" "}
                  target{targetCount === 1 ? "" : "s"} from{" "}
                  {RUNNER_OSES.length} OSes.
                </span>
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <LoadingButton
                  type="submit"
                  pending={savingSchedule}
                  pendingText="Saving…"
                  disabled={locked}
                  data-testid="email-github-save"
                >
                  Save schedule
                </LoadingButton>
                <p className="text-muted-foreground text-xs">
                  The header changes once the save lands. The ticker reads the
                  saved row, not this form.
                </p>
              </div>

              <FeedbackAlert state={scheduleState} />
            </form>
          </section>

          <section
            aria-label="GitHub source state"
            data-testid="email-github-state"
            className="grid gap-3"
          >
            <h4 className="text-muted-foreground font-mono text-xs">
              Source state
            </h4>
            <form
              action={setEnabledAction}
              className="flex flex-wrap items-center gap-3"
            >
              <input
                type="hidden"
                name="enabled"
                value={enabled ? "false" : "true"}
              />
              <LoadingButton
                type="submit"
                variant={enabled ? "outline" : "default"}
                pending={togglingSource}
                pendingText={enabled ? "Disabling…" : "Enabling…"}
                disabled={locked}
                data-testid="email-github-toggle"
              >
                {enabled ? "Disable source" : "Enable source"}
              </LoadingButton>
              <p className="text-muted-foreground text-sm">
                {enabled
                  ? "Enabled: the ticker restarts a dead OS inside the window."
                  : "Disabled: nothing is dispatched, whatever the schedule says."}
              </p>
            </form>
            <FeedbackAlert state={enabledState} />
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
