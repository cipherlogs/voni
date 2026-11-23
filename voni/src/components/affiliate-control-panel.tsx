"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  Activity,
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
  lockPage,
  runOneOffClick,
  saveVolume,
  toggleCheck,
  unlockControl,
  type ControlState,
} from "@/app/email/actions";
import { LoadingButton } from "@/components/loading-button";
import {
  SourceCard,
  type SourceCardSummary,
} from "@/components/source-card";
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
import { Switch } from "@/components/ui/switch";
import {
  TARGET_SELECTION_DEFAULT,
  TARGET_SELECTION_DESCRIPTIONS,
  TARGET_SELECTION_LABELS,
  TARGET_SELECTION_LEGACY,
  type TargetSelection,
} from "@/lib/email/target-selection";
import { targetHost } from "@/lib/email/target-url";
import {
  FREQUENCY_MINUTES,
  FREE_TIER_EXECUTIONS_PER_MONTH,
  HIGH_VOLUME_CLICKS_PER_DAY,
  MAX_CLICKS_PER_RUN,
  clicksPerDay,
  executionsPerMonth,
} from "@/lib/email/volume";
import { toast } from "@/components/ui/toast";

/**
 * The Grafana source on the `/email` console, and the shared click surface that
 * used to live inside it.
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
  /** Clicks one run sends, read from the stored script by the page. */
  clicksPerRun: number;
  /**
   * How the stored script picks a target, read from its `TARGET_SELECTION`
   * marker. `null` means the script predates the setting — "no choice yet", not
   * "rotate": the panel opens its switch on the new default while the copy
   * beside it says the live script is still rotating.
   */
  targetSelection: TargetSelection | null;
  modified: string | null;
};

/**
 * One tickable target for "Run one click now". Only enabled rows are passed;
 * `url` is here so the picker can name the host instead of a database id.
 */
export type OneOffTargetView = {
  id: string;
  url: string;
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
  /**
   * Enabled target rows, for the one-off click's picker. The server re-reads
   * the rows itself and refuses an unknown or empty subset, so this list is
   * only what the operator may choose from, not the authority.
   */
  oneOffTargets: OneOffTargetView[];
  /**
   * The 24-hour status buckets. The Grafana source card reads them for the one
   * number its collapsed header must keep visible — its worst health. The
   * table the buckets also feed is `ClickSurface`, a separate console surface.
   */
  stats: StatsView;
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

/** Deterministic grouping, so the server and client render the same digits. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

const CHART_WIDTH = 240;
/** One row per interval: label, bar, value. Only `text-xs` fits seven rows. */
const CHART_ROW_HEIGHT = 20;
const CHART_TOP = 18;
const CHART_HEIGHT = CHART_TOP + CHART_ROW_HEIGHT * FREQUENCY_MINUTES.length;
const CHART_LABEL_X = 0;
const CHART_BAR_X = 34;
const CHART_BAR_MAX_WIDTH = 148;
const CHART_VALUE_X = CHART_WIDTH;
const CHART_BAR_HEIGHT = 9;

/**
 * Clicks/day for every interval the panel offers, at the probe and
 * clicks-per-run values currently in the form.
 *
 * Hand-drawn SVG, no chart dependency: one row per interval — label, bar,
 * value — so seven options and five-digit numbers both fit a 320 px screen
 * without shrinking type below the design scale. The selected row is in the
 * foreground colour, the rest recede, and every value is written out so the
 * bar length is never the only way to read a number. Colours come from the
 * theme tokens, so it follows the palette in both schemes.
 */
function VolumeChart({
  probes,
  clicks,
  frequency,
}: {
  probes: number;
  clicks: number;
  frequency: number;
}) {
  const bars = FREQUENCY_MINUTES.map((minutes) => ({
    minutes,
    clicks: clicksPerDay(minutes * MINUTE_MS, probes, clicks),
  }));
  const peak = Math.max(1, ...bars.map((bar) => bar.clicks));

  return (
    <figure className="grid max-w-sm gap-1">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Clicks per day by interval: ${bars
          .map((bar) => `every ${bar.minutes} min ${bar.clicks}`)
          .join(", ")}`}
        data-testid="email-control-volume-chart"
      >
        <text
          x={CHART_VALUE_X}
          y={9}
          textAnchor="end"
          className="fill-muted-foreground font-mono text-2xs"
        >
          clicks/day
        </text>
        <line
          x1={CHART_BAR_X}
          x2={CHART_BAR_X}
          y1={CHART_TOP - 4}
          y2={CHART_HEIGHT - 4}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {bars.map((bar, index) => {
          const width = Math.max(
            2,
            Math.round((bar.clicks / peak) * CHART_BAR_MAX_WIDTH),
          );
          const top = CHART_TOP + index * CHART_ROW_HEIGHT;
          const middle = top + CHART_ROW_HEIGHT / 2;
          const selected = bar.minutes === frequency;
          return (
            <g key={bar.minutes}>
              <text
                x={CHART_LABEL_X}
                y={middle}
                dominantBaseline="middle"
                className={
                  selected
                    ? "fill-foreground font-mono text-2xs font-medium"
                    : "fill-muted-foreground font-mono text-2xs"
                }
              >
                {bar.minutes}m
              </text>
              <rect
                x={CHART_BAR_X}
                y={middle - CHART_BAR_HEIGHT / 2}
                width={width}
                height={CHART_BAR_HEIGHT}
                rx={2}
                fill={selected ? "var(--primary)" : "var(--muted-foreground)"}
                fillOpacity={selected ? 1 : 0.3}
              />
              <text
                x={CHART_VALUE_X}
                y={middle}
                textAnchor="end"
                dominantBaseline="middle"
                className={
                  selected
                    ? "fill-foreground font-mono text-2xs font-medium"
                    : "fill-muted-foreground font-mono text-2xs"
                }
              >
                {formatCount(bar.clicks)}
              </text>
            </g>
          );
        })}
        <line
          x1={CHART_BAR_X}
          x2={CHART_BAR_X}
          y1={CHART_TOP - 4}
          y2={CHART_HEIGHT - 4}
          stroke="var(--border)"
          strokeWidth={1}
        />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        Clicks/day by interval at this probe and click count; the selected
        interval is highlighted.
      </figcaption>
    </figure>
  );
}

/**
 * The live estimate and the two lines that say when it stops being a test.
 * Pure arithmetic from the same module the action validates with, so the
 * preview cannot promise a number the save would refuse to create.
 */
function VolumePreview({
  probes,
  clicks,
  frequency,
}: {
  probes: number;
  clicks: number;
  frequency: number;
}) {
  const perDay = clicksPerDay(frequency * MINUTE_MS, probes, clicks);
  const perMonth = executionsPerMonth(frequency * MINUTE_MS, probes);
  const probeWord = probes === 1 ? "probe" : "probes";
  const clickWord = clicks === 1 ? "click" : "clicks";

  return (
    <div className="grid gap-3 rounded-lg border px-3 py-3">
      <p
        className="font-mono text-sm leading-relaxed break-words"
        data-testid="email-control-preview"
      >
        {probes} {probeWord} × every {frequency} min × {clicks} {clickWord} ={" "}
        <span className="font-medium">{formatCount(perDay)}</span> clicks/day
      </p>

      <VolumeChart probes={probes} clicks={clicks} frequency={frequency} />

      {perDay > HIGH_VOLUME_CLICKS_PER_DAY ? (
        <p
          className="text-destructive text-sm"
          data-testid="email-control-high-volume"
        >
          {formatCount(perDay)} clicks/day is volume where affiliate networks
          stop treating this as testing.
        </p>
      ) : null}
      {perMonth > FREE_TIER_EXECUTIONS_PER_MONTH ? (
        <p
          className="text-destructive text-sm"
          data-testid="email-control-free-tier"
        >
          About {formatCount(perMonth)} check executions/month at this interval
          — over Grafana&apos;s {formatCount(FREE_TIER_EXECUTIONS_PER_MONTH)}{" "}
          free-tier ceiling.
        </p>
      ) : null}
    </div>
  );
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

/**
 * What the check is doing, as the Grafana source card's body. The enabled
 * state moved up into the card header, where it stays visible when the card is
 * collapsed; everything here is detail that may be folded away.
 */
function StatusSection({
  check,
  checkError,
}: {
  check: CheckView | null;
  checkError: string | null;
}) {
  return (
    <section data-testid="email-control-status" className="grid gap-4">
      <h4 className="text-muted-foreground flex items-center gap-2 font-mono text-xs">
        <Clock className="size-3.5" aria-hidden />
        Check state
      </h4>
      <div className="grid gap-5">
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
              {formatCount(
                clicksPerDay(
                  check.frequencyMs,
                  check.probeIds.length,
                  check.clicksPerRun,
                ),
              )}
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
      </div>
    </section>
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

/**
 * Drop both grants and return to the password screen.
 *
 * `lockPage` — not `lockControl` — because the two cookies protect different
 * things: leaving the page cookie behind would keep the panel visible to
 * whoever re-enters the page password, and leaving the control cookie behind
 * would keep it writable. Success redirects, and that redirect rejects this
 * call on purpose, so the rejection is swallowed exactly as it already is for
 * `lockControl`; a real failure still surfaces through the route's error
 * boundary rather than being reported as a locked page.
 */
function LockPageButton() {
  const [locking, setLocking] = useState(false);

  async function handleLockPage() {
    setLocking(true);
    try {
      await lockPage();
    } finally {
      setLocking(false);
    }
  }

  return (
    <LoadingButton
      type="button"
      variant="outline"
      pending={locking}
      pendingText="Locking…"
      icon={<LockKeyhole />}
      data-testid="email-lock-page"
      onClick={() => {
        void handleLockPage().catch(() => {});
      }}
    >
      Lock page
    </LoadingButton>
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
  oneOffTargets,
}: {
  check: CheckView | null;
  probes: ProbeView[];
  oneOffTargets: OneOffTargetView[];
}) {
  const [frequency, setFrequency] = useState<number>(() => {
    const minutes = check ? check.frequencyMs / MINUTE_MS : NaN;
    return FREQUENCY_MINUTES.find((option) => option === minutes) ?? 5;
  });
  const [selected, setSelected] = useState<number[]>(() => [
    ...(check?.probeIds ?? []),
  ]);
  // Held as text so an empty or half-typed field stays editable; the derived
  // number is what the preview and the save gate use.
  const [clicksText, setClicksText] = useState<string>(() =>
    String(check?.clicksPerRun ?? 1),
  );
  // Initialised from the stored choice, and from the new default when the
  // script predates the setting (null = "no choice yet"). The description below
  // says what the live script is still doing in that case, so the switch never
  // claims a mode the deployed check is not running without explaining why.
  // A flip is a pending save, so `savedSelection` below stays the read-back for
  // any copy that describes the current check rather than the unsaved switch.
  const [selection, setSelection] = useState<TargetSelection>(
    () => check?.targetSelection ?? TARGET_SELECTION_DEFAULT,
  );
  // Whether the switch opens on the default because the stored script has no
  // marker yet; drives the one-line migration note.
  const selectionUnmarked = check !== null && check.targetSelection === null;
  // Every enabled target starts ticked: a one-off click usually means "do the
  // check's work once", and an unticked default would leave the button dead
  // with no hint why. Nothing persists — a reload ticks all of them again.
  const [oneOffSelected, setOneOffSelected] = useState<string[]>(() =>
    oneOffTargets.map((target) => target.id),
  );

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

  const clicks = Number(clicksText);
  const clicksValid =
    Number.isInteger(clicks) && clicks >= 1 && clicks <= MAX_CLICKS_PER_RUN;
  // The preview reads a refused value as zero rather than as `NaN`: the field
  // itself says what is wrong, and a preview must never print nonsense.
  const previewClicks = clicksValid ? clicks : 0;
  const previewProbes = selected.length;
  const disabled = !check || saving;
  // What the running script does, as opposed to what the switch is about to
  // save. The one-off click reads its mode server-side from this same value.
  const savedSelection: TargetSelection =
    check?.targetSelection ?? TARGET_SELECTION_LEGACY;
  const hasOneOffTargets = oneOffTargets.length > 0;
  // The server refuses an empty subset; this only makes the refusal visible
  // immediately instead of after a round trip. Count the *rendered* ticks, not
  // the state array: a target removed or paused since mount stays in state but
  // has no checkbox to submit, so it must not keep the button alive.
  const tickedCount = oneOffTargets.filter((target) =>
    oneOffSelected.includes(target.id),
  ).length;
  const oneOffReady = !hasOneOffTargets || tickedCount > 0;
  const selectionLabel =
    selection === "random"
      ? "Draw targets at random"
      : "Rotate through every target";

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
            The Grafana check could not be read, so interval, clicks and probe
            changes cannot be saved right now.
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
                      Every {minutes} minute{minutes === 1 ? "" : "s"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Grafana runs every selected probe once per interval.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="email-control-clicks">
              Clicks per run
            </FieldLabel>
            <Input
              id="email-control-clicks"
              name="clicks"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CLICKS_PER_RUN}
              step={1}
              value={clicksText}
              onChange={(event) => setClicksText(event.target.value)}
              disabled={disabled}
              aria-invalid={!clicksValid}
              required
            />
            <FieldDescription>
              Whole number 1–{MAX_CLICKS_PER_RUN}. Each click draws a fresh
              profile, target and source.
            </FieldDescription>
            {clicksValid ? null : (
              <p className="text-destructive text-sm">
                Clicks per run must be a whole number from 1 to{" "}
                {MAX_CLICKS_PER_RUN}.
              </p>
            )}
          </Field>
        </FieldGroup>

        {/* Full width: the mode is one choice for the whole check, so it must
            not look like a peer of the interval or the click count. The hidden
            field is the submission: the Switch is a button-style Base UI
            control that posts nothing on its own, and the server refuses a
            request with no `selection` rather than guessing the default. */}
        <Field>
          <input type="hidden" name="selection" value={selection} />
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="email-control-selection">
              {selectionLabel}
            </FieldLabel>
            <Switch
              id="email-control-selection"
              checked={selection === "random"}
              onCheckedChange={(next: boolean) => {
                setSelection(next ? "random" : "rotate");
              }}
              disabled={disabled}
              data-testid="email-control-selection"
            />
          </div>
          <FieldDescription>
            <span className="text-foreground font-medium">
              {TARGET_SELECTION_LABELS[selection]}
            </span>{" "}
            — {TARGET_SELECTION_DESCRIPTIONS[selection]} This is the mode stored
            in the saved script; flipping the switch applies it when you save.
            {selectionUnmarked
              ? " The saved script predates this setting and is still rotating through every target; saving now applies your choice."
              : null}
          </FieldDescription>
        </Field>

        <VolumePreview
          probes={previewProbes}
          clicks={previewClicks}
          frequency={frequency}
        />

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
          <SaveSubmitButton disabled={!check || !clicksValid} />
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

        <form action={clickAction} className="grid gap-3">
          {/* No picker when there is nothing enabled: the server already
              refuses with "Every target is paused…", and an empty fieldset
              would only restate that. */}
          {hasOneOffTargets ? (
            <FieldGroup className="grid gap-2 sm:grid-cols-2">
              <p className="text-muted-foreground text-sm sm:col-span-2">
                Targets for this click
              </p>
              {oneOffTargets.map((target) => {
                const id = `email-one-off-target-${target.id}`;
                const checked = oneOffSelected.includes(target.id);
                return (
                  <Field key={target.id} orientation="horizontal">
                    <Checkbox
                      id={id}
                      name="target"
                      value={target.id}
                      checked={checked}
                      onCheckedChange={(next: boolean) => {
                        setOneOffSelected((previous) =>
                          next
                            ? [
                                ...previous.filter(
                                  (value) => value !== target.id,
                                ),
                                target.id,
                              ]
                            : previous.filter((value) => value !== target.id),
                        );
                      }}
                      disabled={clicking}
                    />
                    <FieldLabel htmlFor={id}>
                      <span className="font-mono text-xs">
                        {targetHost(target.url)}
                      </span>
                    </FieldLabel>
                  </Field>
                );
              })}
              {/* Only when the check is readable: an unreadable check has no
                  mode to describe, and the card already says so. */}
              {check !== null && savedSelection === "rotate" ? (
                <p className="text-muted-foreground text-sm sm:col-span-2">
                  In Rotate mode the click goes to the least recently clicked of
                  the ticked targets.
                </p>
              ) : null}
            </FieldGroup>
          ) : null}

          {oneOffReady ? null : (
            <p className="text-destructive text-sm">
              Select at least one target for this click.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <LoadingButton
              type="submit"
              variant="outline"
              pending={clicking}
              pendingText="Running…"
              icon={<RefreshCw />}
              disabled={!oneOffReady}
              data-testid="email-one-off-click"
            >
              Run one click now
            </LoadingButton>
            <span className="text-muted-foreground text-sm">
              Runs from voni&apos;s server, not Grafana.
            </span>
          </div>
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
          <LockPageButton />
          <span className="text-muted-foreground text-sm">
            Lock panel clears the control cookie only; lock page clears both and
            returns to the password screen.
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The shared click history, as its own surface rather than a footer inside the
 * Grafana card: every source on the page writes through the same intake, so the
 * table belongs to the console, not to one producer's card.
 */
export function ClickSurface({
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
          Clicks
        </CardTitle>
        <CardDescription>
          Every affiliate click recorded in the last 24 hours, from every source
          on this page.
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
                  <th className="py-2 pr-3 font-medium">User-Agent</th>
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
                    {/* The UA was recorded and queryable all along, but only as
                        a tooltip on the Device cell — so the panel looked like
                        it stored none. Show it, truncated; the title carries
                        the whole string. */}
                    <td className="py-2 pr-3">
                      <span
                        className="block max-w-xs truncate font-mono text-xs"
                        title={click.userAgent ?? undefined}
                      >
                        {click.userAgent ?? "—"}
                      </span>
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

/** The lock state of the controls, and the forms once unlocked. */
function ControlsSection({
  locked,
  check,
  probes,
  oneOffTargets,
}: {
  locked: boolean;
  check: CheckView | null;
  probes: ProbeView[];
  oneOffTargets: OneOffTargetView[];
}) {
  return (
    <section className="grid gap-4 border-t pt-5">
      <div className="grid gap-1">
        <h4 className="flex items-center gap-2 font-medium">
          {locked ? (
            <LockKeyhole className="size-4" aria-hidden />
          ) : (
            <Unlock className="size-4" aria-hidden />
          )}
          Controls
        </h4>
        <p className="text-muted-foreground text-sm">
          {locked
            ? "The panel is read-only. Unlock it to change the check or run a click."
            : "Changes apply to the Grafana check on the next run."}
        </p>
      </div>
      {locked ? (
        <div className="grid gap-5">
          <UnlockForm />
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <LockPageButton />
            <span className="text-muted-foreground text-sm">
              Clears both cookies and returns to the password screen.
            </span>
          </div>
        </div>
      ) : (
        <ControlsForm
          check={check}
          probes={probes}
          oneOffTargets={oneOffTargets}
        />
      )}
    </section>
  );
}

/**
 * The worst thing in the 24-hour status buckets, as one header fact. A source
 * whose clicks are all failing must say so while its body is folded away, so
 * this reads failures first: no response at all outranks any HTTP code.
 */
function worstHealth(byStatus: StatsView["byStatus"]): SourceCardSummary["health"] {
  if (byStatus.length === 0) {
    return { label: "No clicks yet", variant: "outline" };
  }
  const failing = byStatus.filter(
    (row) => row.status === null || row.status >= 400,
  );
  if (failing.length === 0) {
    return { label: "Healthy", variant: "secondary" };
  }
  const noResponse = failing.find((row) => row.status === null);
  if (noResponse) {
    return { label: `No response ×${noResponse.count}`, variant: "destructive" };
  }
  const worst = failing.reduce((max, row) =>
    (row.status ?? 0) > (max.status ?? 0) ? row : max,
  );
  return { label: `HTTP ${worst.status} ×${worst.count}`, variant: "destructive" };
}

export function AffiliateControlPanel({
  locked,
  check,
  probes,
  oneOffTargets,
  stats,
  checkError = null,
}: AffiliateControlPanelProps) {
  // The same arithmetic the body prints, so the collapsed header cannot quote a
  // rate the expanded card disagrees with.
  const perDay = check
    ? clicksPerDay(
        check.frequencyMs,
        check.probeIds.length,
        check.clicksPerRun,
      )
    : null;

  return (
    <div data-testid="affiliate-control-panel">
      <SourceCard
        testId="email-control-source-grafana"
        name="Grafana"
        icon={<Activity className="size-4" />}
        description="Synthetic Monitoring runs the click script over HTTP from its US probes. Its interval, probes and enabled state live in Grafana."
        summary={{
          status:
            check === null
              ? { label: "Unavailable", variant: "destructive" }
              : check.enabled
                ? { label: "Live", variant: "default" }
                : { label: "Paused", variant: "outline" },
          volume: {
            value: perDay === null ? "—" : formatCount(perDay),
            label: "clicks/day",
          },
          health: worstHealth(stats.byStatus),
        }}
      >
        <StatusSection check={check} checkError={checkError} />
        <ControlsSection
          locked={locked}
          check={check}
          probes={probes}
          oneOffTargets={oneOffTargets}
        />
      </SourceCard>
    </div>
  );
}
