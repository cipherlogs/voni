"use client";

import { useActionState, useMemo, useState } from "react";
import { AlertCircle, ExternalLink, GitBranch } from "lucide-react";
import type {
  ControlState,
  GithubDispatchState,
} from "@/app/email/actions";
import {
  copyCommand,
  formatCount,
  useActionToast,
  useIntentActionState,
} from "@/components/action-feedback";
import { LoadingButton } from "@/components/loading-button";
import { SourceCard, type SourceCardSummary } from "@/components/source-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GithubClickSummary, GithubOsStats } from "@/lib/email/clicks";
import {
  INTERVAL_SECONDS,
  RUNNER_OSES,
  WINDOW_SECONDS,
  clicksPerDay,
  deadAfterSeconds,
  insideWindow,
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

export type GithubSourceCardProps = {
  /** Presentation only; every action re-checks the cookie itself. */
  locked: boolean;
  /** The `email_sources` row for this producer; null when it is not seeded. */
  config: GithubSourceConfigView | null;
  /** The active shared target count — the denominator of `targets x/x`. */
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
    previous: ControlState,
    formData: FormData,
  ) => Promise<ControlState>;
  /** Save the schedule; fields `interval`, `window`, `startHour`. */
  saveSchedule: (
    previous: ControlState,
    formData: FormData,
  ) => Promise<ControlState>;
  /** Dispatch one OS right now; field `os` = one of `RUNNER_OSES`. */
  dispatchNow: (
    previous: GithubDispatchState,
    formData: FormData,
  ) => Promise<GithubDispatchState>;
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

const INITIAL: ControlState = { ok: false };

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

/**
 * The closed option sets as the `items` map a Base UI Select needs, so a closed
 * trigger shows "Every 1 min" or "07:00 UTC" rather than the raw value.
 */
const INTERVAL_ITEMS: Record<string, string> = Object.fromEntries(
  INTERVAL_SECONDS.map((seconds) => [String(seconds), intervalOptionLabel(seconds)]),
);

const START_HOUR_ITEMS: Record<string, string> = Object.fromEntries(
  START_HOURS.map((hour) => [String(hour), formatStartHour(hour)]),
);

/** The coverage basis the card states beside `targets x/x`. */
const PASS_BASIS = "most recent pass";

const SOURCE_ERROR_TITLE = "Could not update the source";

const INITIAL_DISPATCH: GithubDispatchState = { ok: false };

/**
 * The dispatch's toast, in words: an error, a run action, or the command with
 * a copy action. The effect lives in the row (one per OS), so dispatching
 * Ubuntu then Windows produces two distinct toasts rather than one shared
 * state that the second click overwrites.
 */
function useDispatchToast(state: GithubDispatchState) {
  // The manual command is this card's artifact: it names the token the line
  // needs, and the toast carries the exact line, not a summary of it.
  const manual = state.mode === "manual";
  const command = manual ? state.fallback?.command : undefined;

  // A manual result with no command is not a dispatch that happened: it is a
  // failure, and it is worded as one so no receipt claims a run that does not
  // exist. Memoised because the hook fires on the state object's identity.
  const feedback = useMemo<GithubDispatchState>(
    () =>
      manual && !command
        ? {
            ok: false,
            error:
              "No dispatch token is configured, and no command was returned.",
          }
        : state,
    [manual, command, state],
  );

  useActionToast(
    feedback,
    manual ? "Could not run the check" : "Could not dispatch",
    {
      successTitle: manual ? "Run it yourself" : "Dispatched",
      timeout: command ? 12_000 : undefined,
      description: command ? (
        <>
          {state.message}{" "}
          <code className="mt-1 block font-mono text-xs break-all whitespace-pre-wrap">
            {command}
          </code>{" "}
          <span>
            It needs <code className="font-mono">GITHUB_BURST_TOKEN</code> with
            Actions write access on the repository; this line never carries it.
          </span>
        </>
      ) : state.message,
      action: command
        ? { label: "Copy", onClick: () => copyCommand(command) }
        : state.runUrl
          ? { label: "View run", href: state.runUrl }
          : undefined,
    },
  );
}

/**
 * One OS's Dispatch now control.
 *
 * The `useActionState` lives here, in the row, rather than on the card: three
 * runners can be dispatched independently, and one shared pending flag would
 * disable the other two rows without saying which dispatch is actually running.
 */
function DispatchControl({
  os,
  locked,
  dispatchNow,
}: {
  os: RunnerOs;
  locked: boolean;
  dispatchNow: GithubSourceCardProps["dispatchNow"];
}) {
  const [dispatchState, dispatchAction, dispatching] = useActionState(
    dispatchNow,
    INITIAL_DISPATCH,
  );
  useDispatchToast(dispatchState);

  return (
    <form
      action={dispatchAction}
      className="grid gap-2"
      data-testid={`email-github-dispatch-${os}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="os" value={os} />
        <LoadingButton
          type="submit"
          variant="outline"
          size="sm"
          pending={dispatching}
          pendingText="Dispatching…"
          disabled={locked}
          data-testid={`email-github-dispatch-${os}-button`}
        >
          Dispatch now
        </LoadingButton>
        <p className="text-muted-foreground text-xs">
          {locked
            ? "Unlock the panel to dispatch a run."
            : "Runs one segment from the saved targets and schedule."}
        </p>
      </div>
    </form>
  );
}

type OsStatus = "never" | "stale" | "live" | "outside";

/**
 * The same half-open judgement `decideDue` makes: an OS is stale once its
 * newest click is at least `deadAfterSeconds` old. Kept here as a word rather
 * than a second scheduling rule — the number comes from `sources.ts`. Outside
 * the source's active window nothing is expected to be clicking, so that is
 * said as its own state rather than as staleness.
 */
function osStatus(
  newest: Date | undefined,
  now: Date,
  intervalSeconds: number,
  outsideWindow: boolean,
): OsStatus {
  if (outsideWindow) return "outside";
  if (!newest) return "never";
  const thresholdMs = deadAfterSeconds(intervalSeconds) * 1_000;
  return now.getTime() - newest.getTime() >= thresholdMs ? "stale" : "live";
}

/**
 * The worst OS status, in the order the ticket fixes:
 * disabled, outside active hours, then any OS never run, any stale, else live.
 */
function worstHealth(
  enabled: boolean,
  outsideWindow: boolean,
  statuses: readonly OsStatus[],
): SourceCardSummary["health"] {
  if (!enabled) return { label: "Disabled", variant: "outline" };
  if (outsideWindow) {
    return { label: "Outside active hours", variant: "outline" };
  }
  if (statuses.includes("never")) {
    return { label: "Never run", variant: "destructive" };
  }
  if (statuses.includes("stale")) {
    return { label: "Stale", variant: "destructive" };
  }
  return { label: "Live", variant: "secondary" };
}

function osBadgeVariant(
  status: OsStatus,
): "secondary" | "destructive" | "outline" {
  if (status === "live") return "secondary";
  if (status === "outside") return "outline";
  return "destructive";
}

function osStatusLabel(status: OsStatus): string {
  if (status === "never") return "Never run";
  if (status === "outside") return "Outside active hours";
  return status === "stale" ? "Stale" : "Live";
}

/** The pass conclusion in the card's words; no pass is "Never run". */
function passConclusionLabel(pass: GithubOsStats["pass"]): string {
  if (!pass) return "Never run";
  if (pass.conclusion === "complete") return "Complete";
  if (pass.conclusion === "partial") return "Partial";
  return "Failed";
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
  dispatchNow,
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

  const configured = config !== null;
  const enabled = config?.enabled ?? false;

  const [scheduleState, saveScheduleAction, savingSchedule] = useActionState(
    saveSchedule,
    INITIAL,
  );
  const [enabledState, setEnabledAction, togglingSource, enableIntent] =
    useIntentActionState(
      setEnabled,
      INITIAL,
      (formData) => formData.get("enabled") === "true",
    );

  useActionToast(scheduleState, SOURCE_ERROR_TITLE, {
    successTitle: "Schedule saved",
  });
  // The submitted value, not the revalidated prop: by the time the toast reads
  // this, `enabled` already says what the server wrote, so the prop would name
  // the opposite of the button that was pressed.
  useActionToast(enabledState, SOURCE_ERROR_TITLE, {
    successTitle: enableIntent === false ? "Source disabled" : "Source enabled",
  });
  // Outside the source's own window, nothing is expected to click: that is a
  // stated state, not a stale one. `insideWindow` is the same predicate the
  // ticker uses, so the card and the scheduler cannot disagree.
  const outsideWindow =
    config !== null &&
    enabled &&
    !insideWindow(now, config.windowSeconds, config.windowStartHour);
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
        osStatus(newestByOs[os], now, config.intervalSeconds, outsideWindow),
      )
    : [];
  // Keyed, not searched: the summary always carries one row per OS, and a
  // lookup that returns `undefined` falls back to an honest empty row rather
  // than a non-null assertion that could crash the card.
  const statsByOs = new Map(summary.byOs.map((row) => [row.os, row]));
  const osStatsFor = (os: RunnerOs): GithubOsStats =>
    statsByOs.get(os) ?? {
      os,
      clicks: 0,
      failed: 0,
      targets: [],
      pass: null,
    };

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
          : worstHealth(enabled, outsideWindow, statuses),
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
                schedule, or to dispatch one run. The values below are the saved
                configuration, and nothing here can be written while the panel
                is locked.
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
                    items={INTERVAL_ITEMS}
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

                <FieldSet>
                  <FieldLegend variant="label">Active window</FieldLegend>
                  <input type="hidden" name="window" value={draftWindow} />
                  <RadioGroup
                    value={String(draftWindow)}
                    onValueChange={(next) => {
                      if (next) setDraftWindow(Number(next));
                    }}
                    disabled={locked || savingSchedule}
                    aria-label="Active window"
                  >
                    {WINDOW_SECONDS.map((seconds) => {
                      const id = `email-github-window-${seconds}`;
                      return (
                        <Field key={seconds} orientation="horizontal">
                          <RadioGroupItem value={String(seconds)} id={id} />
                          <FieldLabel htmlFor={id} className="font-normal">
                            {formatWindow(seconds)}
                          </FieldLabel>
                        </Field>
                      );
                    })}
                  </RadioGroup>
                  <FieldDescription>
                    How long the source runs each day.
                  </FieldDescription>
                </FieldSet>

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
                    items={START_HOUR_ITEMS}
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
                  outsideWindow,
                );
                const osStats = osStatsFor(os);
                // A never-run OS, a disabled source and an all-paused list are
                // said in words: a `0/4` would read as a measured miss rather
                // than "no run" or "nothing to click".
                const coverage = !enabled
                  ? "Not scheduled"
                  : !osStats.pass
                    ? "Never run"
                    : osStats.pass.total === 0
                      ? "No active targets"
                      : `${osStats.pass.hits}/${osStats.pass.total}`;
                const conclusion = passConclusionLabel(osStats.pass);

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
                          ({PASS_BASIS})
                        </span>
                      </StatusField>
                      {/* Failed clicks stay visible in words: a hit is any
                          response, so a pass full of 500s would otherwise read
                          as a clean sweep. This count is the OS's whole window,
                          from the same summary fold the header uses. */}
                      <StatusField label="failures">
                        <span data-testid={`email-github-os-${os}-failures`}>
                          {osStats.clicks === 0
                            ? "No clicks yet"
                            : osStats.failed === 0
                              ? `${formatCount(osStats.clicks)} clicks, none failed`
                              : `${formatCount(osStats.failed)} of ${formatCount(osStats.clicks)} clicks failed`}
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
                    <DispatchControl
                      os={os}
                      locked={locked}
                      dispatchNow={dispatchNow}
                    />
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
                const osStats = osStatsFor(os);
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
