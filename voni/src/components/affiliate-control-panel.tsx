"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Globe,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  Unlock,
} from "lucide-react";
import {
  lockControl,
  runOneOffClick,
  saveVolume,
  toggleCheck,
  unlockControl,
  type ControlState,
} from "@/app/email/actions";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clicksPerDay, FREQUENCY_MINUTES } from "@/lib/email/volume";
import { toast } from "@/components/ui/toast";

/**
 * The `/email` affiliate click control panel.
 *
 * Read-only until the server-side unlock action accepts the control secret —
 * the locked/unlocked split here is presentation only. Every action re-checks
 * the cookie inside its own body, so a hand-crafted request that skips this
 * component entirely still gets refused.
 *
 * Plain, serialisable view shapes: the page converts Grafana's epoch
 * milliseconds and the database's `Date` values to strings before they cross
 * the RSC boundary.
 */

export type CheckView = {
  id: number;
  job: string;
  target: string;
  enabled: boolean;
  frequencyMs: number;
  probeIds: number[];
  modified: string | null;
};

export type ProbeView = {
  id: number;
  name: string;
  region: string;
};

export type StatsView = {
  total: number;
  byStatus: { status: number | null; count: number }[];
  avgMs: number | null;
  /**
   * Optional because the page owns the query → view mapping. The card renders
   * the line only when it is present, so a page that has not been updated yet
   * shows no empty bucket row.
   */
  byDevice?: { device: string | null; count: number }[];
};

export type ClickRowView = {
  id: string;
  ranAt: string;
  target: string;
  source: string | null;
  status: number | null;
  ms: number | null;
  finalUrl: string | null;
  /** The identity the visit presented; absent on rows written before it was kept. */
  userAgent?: string | null;
  device?: string | null;
  browser?: string | null;
};

export type AffiliateControlPanelProps = {
  locked: boolean;
  check: CheckView | null;
  probes: ProbeView[];
  stats: StatsView;
  clicks: ClickRowView[];
  /**
   * Why `check` is null. The spec's prop list stopped at `check`, but a
   * destructive Alert that cannot name the reason is the silent failure the
   * repo's feedback protocol forbids, so the page passes the sanitized message.
   */
  checkError?: string | null;
};

const INITIAL: ControlState = { ok: false };
const MINUTE_MS = 60_000;

function FeedbackAlert({ state }: { state: ControlState }) {
  if (!state.error && !state.message) return null;
  return (
    <Alert variant={state.error ? "destructive" : "default"} className="status-enter">
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>{state.error ? "Could not complete" : "Done"}</AlertTitle>
      <AlertDescription>{state.error ?? state.message}</AlertDescription>
    </Alert>
  );
}

/** Inline Alert is the required surface; a toast rides along as a convenience. */
function useActionToast(state: ControlState) {
  useEffect(() => {
    if (state.error) {
      toast.add({ title: "Could not complete", description: state.error, type: "error" });
      return;
    }
    if (state.message) {
      toast.add({ title: "Done", description: state.message, type: "success" });
    }
  }, [state]);
}

function frequencyLabel(frequencyMs: number): string {
  const minutes = frequencyMs / MINUTE_MS;
  return Number.isInteger(minutes) ? `${minutes} min` : `${frequencyMs} ms`;
}

/** Deterministic, timezone-free display: identical on the server and client. */
function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19) + "Z";
}

function hostOf(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function statusBadgeVariant(
  status: number | null,
): "secondary" | "destructive" | "outline" {
  if (status === null) return "outline";
  return status >= 200 && status < 400 ? "secondary" : "destructive";
}

function StatusCard({
  check,
  checkError,
}: {
  check: CheckView | null;
  checkError: string | null;
}) {
  return (
    <Card data-testid="email-control-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="size-4" />
          Status
        </CardTitle>
        <CardDescription>
          What the Grafana synthetic check is doing right now.
        </CardDescription>
        <CardAction>
          {check === null ? (
            <Badge variant="destructive">Unavailable</Badge>
          ) : check.enabled ? (
            <Badge>Live</Badge>
          ) : (
            <Badge variant="outline">Paused</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        {check === null ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Grafana check unavailable</AlertTitle>
            <AlertDescription>
              {checkError ??
                "The check could not be read. Grafana may be unreachable or unconfigured on this deployment."}
            </AlertDescription>
          </Alert>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatusField label="state">
              {check.enabled ? "enabled" : "paused"}
            </StatusField>
            <StatusField label="interval">
              {frequencyLabel(check.frequencyMs)}
            </StatusField>
            <StatusField label="probes">{check.probeIds.length}</StatusField>
            <StatusField label="clicks/day">
              {clicksPerDay(check.frequencyMs, check.probeIds.length)}
            </StatusField>
            <StatusField label="check id">{check.id}</StatusField>
            <StatusField label="last modified">
              {formatWhen(check.modified)}
            </StatusField>
            <div className="sm:col-span-2 lg:col-span-3">
              <StatusField label="target">
                <span className="break-all">{check.target}</span>
              </StatusField>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
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
      <dd className="font-mono text-sm break-all">{children}</dd>
    </div>
  );
}

function UnlockSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      pending={pending}
      pendingText="Unlocking…"
      icon={<Unlock />}
    >
      Unlock
    </LoadingButton>
  );
}

function UnlockForm() {
  const [state, action, pending] = useActionState(unlockControl, INITIAL);
  useActionToast(state);

  return (
    <form action={action} className="grid max-w-md gap-4">
      <Field>
        <FieldLabel htmlFor="email-control-secret">Control secret</FieldLabel>
        <Input
          id="email-control-secret"
          name="secret"
          type="password"
          autoComplete="current-password"
          disabled={pending}
          required
        />
        <FieldDescription>
          The panel is read-only until this matches the control secret
          configured for this deployment.
        </FieldDescription>
      </Field>
      <FeedbackAlert state={state} />
      <div>
        <UnlockSubmitButton />
      </div>
    </form>
  );
}

function SaveSubmitButton({ disabled = false }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      pending={pending}
      pendingText="Saving…"
      icon={<CheckCircle2 />}
      disabled={disabled}
    >
      Save
    </LoadingButton>
  );
}

function ControlsForm({
  check,
  probes,
}: {
  check: CheckView | null;
  probes: ProbeView[];
}) {
  const [frequency, setFrequency] = useState<number>(() => {
    const minutes = check ? check.frequencyMs / MINUTE_MS : NaN;
    return FREQUENCY_MINUTES.find((option) => option === minutes) ?? 5;
  });
  const [selected, setSelected] = useState<number[]>(() => [
    ...(check?.probeIds ?? []),
  ]);

  const [saveState, saveAction, saving] = useActionState(saveVolume, INITIAL);
  const [toggleState, toggleAction, toggling] = useActionState(
    toggleCheck,
    INITIAL,
  );
  const [clickState, clickAction, clicking] = useActionState(
    runOneOffClick,
    INITIAL,
  );
  const [locking, setLocking] = useState(false);

  useActionToast(saveState);
  useActionToast(toggleState);
  useActionToast(clickState);

  // A selected id can be missing from the probe list when Grafana's probe read
  // failed; render it rather than silently dropping it from the next save.
  const options = useMemo(() => {
    const known = probes.map((probe) => ({
      id: probe.id,
      name: probe.name || `Probe ${probe.id}`,
    }));
    const missing = (check?.probeIds ?? [])
      .filter((id) => !probes.some((probe) => probe.id === id))
      .map((id) => ({ id, name: `Probe ${id}` }));
    return [...known, ...missing];
  }, [probes, check]);

  const preview = clicksPerDay(frequency * MINUTE_MS, selected.length);
  const disabled = !check || saving;

  async function handleLock() {
    setLocking(true);
    try {
      // Success redirects to `/email?notice=locked`. That redirect rejects this
      // call on purpose — RedirectBoundary needs to see it — so it is not
      // caught and reported as a failure here.
      await lockControl();
    } finally {
      setLocking(false);
    }
  }

  return (
    <div className="grid gap-6">
      {!check ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Editing is unavailable</AlertTitle>
          <AlertDescription>
            The Grafana check could not be read, so interval and probe changes
            cannot be saved right now.
          </AlertDescription>
        </Alert>
      ) : null}

      <form action={saveAction} className="grid gap-5">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="email-control-frequency">Interval</FieldLabel>
            <input type="hidden" name="frequency" value={frequency} />
            <Select
              value={String(frequency)}
              onValueChange={(next) => {
                if (next) setFrequency(Number(next));
              }}
              disabled={disabled}
            >
              <SelectTrigger id="email-control-frequency" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FREQUENCY_MINUTES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      Every {minutes} minutes
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Grafana runs every selected probe once per interval.
            </FieldDescription>
          </Field>

          <div className="flex flex-col justify-end gap-1 rounded-lg border px-3 py-2">
            <span className="text-muted-foreground font-mono text-xs">
              clicks/day
            </span>
            <span className="font-mono text-lg font-medium" data-testid="email-control-preview">
              {preview}
            </span>
            <span className="text-muted-foreground text-xs">
              {selected.length} probe{selected.length === 1 ? "" : "s"} × every{" "}
              {frequency} min
            </span>
          </div>
        </FieldGroup>

        <FieldGroup className="grid gap-2 sm:grid-cols-2">
          {options.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No probes were returned by Grafana.
            </p>
          ) : (
            options.map((probe) => {
              const checked = selected.includes(probe.id);
              return (
                <Field key={probe.id} orientation="horizontal">
                  <Checkbox
                    id={`email-control-probe-${probe.id}`}
                    name="probe"
                    value={String(probe.id)}
                    checked={checked}
                    onCheckedChange={(next: boolean) => {
                      setSelected((previous) =>
                        next
                          ? [...previous.filter((id) => id !== probe.id), probe.id]
                          : previous.filter((id) => id !== probe.id),
                      );
                    }}
                    disabled={disabled}
                  />
                  <FieldLabel htmlFor={`email-control-probe-${probe.id}`}>
                    <span className="font-normal">{probe.name}</span>
                    <span className="text-muted-foreground font-mono text-xs">
                      #{probe.id}
                    </span>
                  </FieldLabel>
                </Field>
              );
            })
          )}
        </FieldGroup>

        <FeedbackAlert state={saveState} />
        <div>
          <SaveSubmitButton disabled={!check} />
        </div>
      </form>

      <div className="grid gap-4 border-t pt-4">
        <form action={toggleAction} className="flex flex-wrap items-center gap-3">
          <LoadingButton
            type="submit"
            variant={check?.enabled ? "outline" : "default"}
            pending={toggling}
            pendingText={check?.enabled ? "Pausing…" : "Resuming…"}
            icon={check?.enabled ? <Pause /> : <Play />}
            disabled={!check}
          >
            {check?.enabled ? "Pause check" : "Resume check"}
          </LoadingButton>
          <span className="text-muted-foreground text-sm">
            {check?.enabled
              ? "Stops Grafana from running this check; the saved settings stay."
              : "Starts the check again with its saved interval and probes."}
          </span>
        </form>
        <FeedbackAlert state={toggleState} />

        <form action={clickAction} className="flex flex-wrap items-center gap-3">
          <LoadingButton
            type="submit"
            variant="outline"
            pending={clicking}
            pendingText="Running…"
            icon={<RefreshCw />}
          >
            Run one click now
          </LoadingButton>
          <span className="text-muted-foreground text-sm">
            Runs from voni&apos;s server, not Grafana.
          </span>
        </form>
        <FeedbackAlert state={clickState} />

        <div className="flex flex-wrap items-center gap-3">
          <LoadingButton
            type="button"
            variant="outline"
            pending={locking}
            pendingText="Locking…"
            icon={<LockKeyhole />}
            onClick={() => {
              void handleLock().catch(() => {});
            }}
          >
            Lock panel
          </LoadingButton>
          <span className="text-muted-foreground text-sm">
            Clears the control cookie on this browser.
          </span>
        </div>
      </div>
    </div>
  );
}

function AnalyticsCard({
  stats,
  clicks,
}: {
  stats: StatsView;
  clicks: ClickRowView[];
}) {
  return (
    <Card data-testid="email-control-analytics">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4" />
          Analytics
        </CardTitle>
        <CardDescription>
          Affiliate clicks recorded in the last 24 hours.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{stats.total} clicks</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <StatusField label="24h total">{stats.total}</StatusField>
          <StatusField label="avg ms">
            {stats.avgMs === null ? "—" : stats.avgMs}
          </StatusField>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground font-mono text-xs">
              by status
            </dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              {stats.byStatus.length === 0 ? (
                <span className="text-muted-foreground text-sm">
                  No clicks in the window.
                </span>
              ) : (
                stats.byStatus.map((row) => (
                  <Badge
                    key={row.status === null ? "none" : row.status}
                    variant={statusBadgeVariant(row.status)}
                  >
                    {row.status === null ? "no status" : `HTTP ${row.status}`} ·{" "}
                    {row.count}
                  </Badge>
                ))
              )}
            </dd>
          </div>
          {stats.byDevice === undefined ? null : (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground font-mono text-xs">
                by device
              </dt>
              <dd className="mt-1 flex flex-wrap gap-2">
                {stats.byDevice.length === 0 ? (
                  <span className="text-muted-foreground text-sm">
                    No clicks in the window.
                  </span>
                ) : (
                  stats.byDevice.map((row) => (
                    <Badge
                      key={row.device ?? "unknown"}
                      variant="outline"
                    >
                      {row.device ?? "no device"} · {row.count}
                    </Badge>
                  ))
                )}
              </dd>
            </div>
          )}
        </dl>

        {clicks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No clicks recorded yet. Run one click or wait for the Grafana check.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Target host</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 pr-3 font-medium">Device</th>
                  <th className="py-2 pr-3 font-medium">Browser</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">ms</th>
                  <th className="py-2 font-medium">Final host</th>
                </tr>
              </thead>
              <tbody>
                {clicks.map((click) => (
                  <tr key={click.id} className="border-b last:border-0">
                    <td className="text-muted-foreground py-2 pr-3 font-mono text-xs whitespace-nowrap">
                      {formatWhen(click.ranAt)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {hostOf(click.target)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {click.source ?? "—"}
                    </td>
                    <td
                      className="py-2 pr-3 font-mono text-xs"
                      title={click.userAgent ?? undefined}
                    >
                      {click.device ?? "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {click.browser ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={statusBadgeVariant(click.status)}>
                        {click.status ?? "—"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {click.ms ?? "—"}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {hostOf(click.finalUrl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AffiliateControlPanel({
  locked,
  check,
  probes,
  stats,
  clicks,
  checkError = null,
}: AffiliateControlPanelProps) {
  return (
    <div className="grid gap-6" data-testid="affiliate-control-panel">
      <StatusCard check={check} checkError={checkError} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {locked ? <LockKeyhole className="size-4" /> : <Unlock className="size-4" />}
            Controls
          </CardTitle>
          <CardDescription>
            {locked
              ? "The panel is read-only. Unlock it to change the check or run a click."
              : "Changes apply to the Grafana check on the next run."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {locked ? <UnlockForm /> : <ControlsForm check={check} probes={probes} />}
        </CardContent>
      </Card>

      <AnalyticsCard stats={stats} clicks={clicks} />
    </div>
  );
}
