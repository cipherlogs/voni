"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
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
  lockPage,
  runOneOffClick,
  saveVolume,
  toggleCheck,
  type ControlState,
} from "@/app/email/actions";
import { formatCount, useActionToast } from "@/components/action-feedback";
import { LoadingButton } from "@/components/loading-button";
import { describeClickExit } from "@/lib/email/click-exit";
import type { ClickProxyKind } from "@/lib/email/click-report";
import {
  SourceCard,
  type SourceCardSummary,
} from "@/components/source-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useCardDisclosure } from "@/components/card-disclosure";
import { CollapsibleCardTitle } from "@/components/collapsible-card-title";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
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
import {
  TARGET_SELECTION_DEFAULT,
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

/**
 * The Grafana source on the `/email` console, and the shared click surface that
 * used to live inside it.
 *
 * The card is only rendered once the page password has been accepted, and that
 * same grant is what the server-side actions re-check inside their own bodies —
 * so a hand-crafted request that skips this component entirely still gets
 * refused. There is no second secret to unlock the forms with.
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
   * The rotation mode every producer runs with, resolved by the page from the
   * shared setting (and, until that is written, from the script's own marker).
   * The card shows it; it no longer sets it — the page-level `RotationCard`
   * does, because Grafana, GitHub, the one-off click and the burst all read the
   * same value.
   */
  targetSelection: TargetSelection;
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
  /** The exit the click left from, for rows written after the pool existed. */
  exitIp?: string | null;
  exitCountry?: string | null;
  exitAsn?: string | null;
  proxyKind?: ClickProxyKind | null;
  /** Why no page was opened, for a click that failed before a browser started. */
  failureReason?: string | null;
};

/** The view shape of one `?source=` chip, built by the page's data boundary. */
export type ClickSourceChipView = {
  /** The `?source=` value this chip links to. */
  value: string;
  label: string;
  /** The producer this chip narrows to; null for All. */
  producer: string | null;
  /** The link itself, so the panel never has to reconstruct the contract. */
  href: string;
  /** Whether this chip is the view the server resolved. */
  active: boolean;
};

export type AffiliateControlPanelProps = {
  check: CheckView | null;
  probes: ProbeView[];
  /**
   * Enabled target rows, for the one-off click's picker. The server re-reads
   * the rows itself and refuses an unknown or empty subset, so this list is
   * only what the operator may choose from, not the authority.
   */
  oneOffTargets: OneOffTargetView[];
  /**
   * The Grafana producer's 24-hour buckets: its card header reads them for the
   * one number a collapsed card must keep visible (its worst health) and its
   * body prints the total, latency, status and device mix inline. The shared
   * table has its own, filtered read — `ClickSurface` takes its stats as props.
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

function frequencyLabel(frequencyMs: number): string {
  const minutes = frequencyMs / MINUTE_MS;
  return Number.isInteger(minutes) ? `${minutes} min` : `${frequencyMs} ms`;
}

/**
 * The closed option set as the `items` map a Base UI Select needs, so the
 * closed trigger shows "Every 5 min" rather than the raw minute value. The
 * options render this same map, so the open list and the closed trigger cannot
 * disagree.
 */
const FREQUENCY_ITEMS: Record<string, string> = Object.fromEntries(
  FREQUENCY_MINUTES.map((minutes) => [String(minutes), `Every ${minutes} min`]),
);

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

/**
 * The Grafana source's own 24-hour numbers, inline in its expanded body: the
 * reader sees this producer's total, latency, status and device mix without
 * first navigating the shared table to a filtered view.
 */
function SourceStatsSection({ stats }: { stats: StatsView }) {
  return (
    <section
      data-testid="email-control-grafana-stats"
      className="grid gap-4"
      aria-labelledby="email-grafana-stats-heading"
    >
      <h4
        id="email-grafana-stats-heading"
        className="text-muted-foreground flex items-center gap-2 font-mono text-xs"
      >
        <Clock className="size-3.5" aria-hidden />
        Last 24 hours
      </h4>
      <StatsBlock stats={stats} />
    </section>
  );
}

/**
 * Drop the page grant and return to the password screen.
 *
 * The page cookie is also the write grant, so clearing it makes the console
 * read-only in the same step it stops rendering. Success redirects, and that
 * redirect rejects this call on purpose, so the rejection is swallowed; a real
 * failure still surfaces through the route's error boundary rather than being
 * reported as a locked page.
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

  useActionToast(saveState, "Could not save the volume", {
    successTitle: "Volume saved",
  });
  useActionToast(toggleState, "Could not update the check", {
    successTitle: "Check updated",
  });
  useActionToast(clickState, "Could not run the click", {
    successTitle: "Click ran",
  });

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
  // The mode is the page's rotation setting, not this card's: it moved out to
  // `RotationCard` because every producer reads it, and this form no longer
  // submits one. `check?.` is only the "check could not be read" case, where a
  // note about the mode has nothing to say, so it falls back to the default.
  const savedSelection: TargetSelection =
    check?.targetSelection ?? TARGET_SELECTION_DEFAULT;
  const hasOneOffTargets = oneOffTargets.length > 0;
  // The server refuses an empty subset; this only makes the refusal visible
  // immediately instead of after a round trip. Count the *rendered* ticks, not
  // the state array: a target removed or paused since mount stays in state but
  // has no checkbox to submit, so it must not keep the button alive.
  const tickedCount = oneOffTargets.filter((target) =>
    oneOffSelected.includes(target.id),
  ).length;
  const oneOffReady = !hasOneOffTargets || tickedCount > 0;

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
              items={FREQUENCY_ITEMS}
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
                      {FREQUENCY_ITEMS[String(minutes)]}
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

        <div className="flex flex-wrap items-center gap-3">
          <LockPageButton />
          <span className="text-muted-foreground text-sm">
            The page password also authorizes these changes; locking the page
            clears it and returns to the password screen.
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The 24-hour counts, in the shape both surfaces use: one block of labelled
 * values and badges. The Grafana card renders it as its own inline stats and
 * the shared table renders it above the rows, so the numbers cannot drift into
 * two visual languages.
 */
function StatsBlock({ stats }: { stats: StatsView }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <StatusField label="24h total">{stats.total}</StatusField>
      <StatusField label="avg ms">
        {stats.avgMs === null ? "—" : stats.avgMs}
      </StatusField>
      <div className="sm:col-span-2">
        <dt className="text-muted-foreground font-mono text-xs">by status</dt>
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
                <Badge key={row.device ?? "unknown"} variant="outline">
                  {row.device ?? "no device"} · {row.count}
                </Badge>
              ))
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The shared click history, as its own surface rather than a footer inside the
 * Grafana card: every source on the page writes through the same intake, so the
 * table belongs to the console, not to one producer's card.
 *
 * The chips are links, not client state. The page resolves `?source=` inside its
 * request-time data boundary and hands the already-built links down, so a
 * copied URL opens the same narrowed table and a reload cannot reset it.
 *
 * The card folds like every other `/email` card and remembers the choice under
 * its own `data-testid`. Its header keeps the two facts an operator must not
 * have to open a card to see — how many clicks landed and the worst health among
 * them — so a collapsed card never hides volume or a failure.
 */
export function ClickSurface({
  stats,
  clicks,
  sources,
}: {
  stats: StatsView;
  clicks: ClickRowView[];
  sources: ClickSourceChipView[];
}) {
  const active = sources.find((chip) => chip.active) ?? null;
  // "All" is the absence of a producer, not a label worth repeating in prose.
  const narrowed = active !== null && active.producer !== null;
  const health = worstHealth(stats.byStatus);
  const { open, onOpenChange } = useCardDisclosure("email-control-analytics");

  return (
    <Card data-testid="email-control-analytics">
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="group/card grid gap-(--card-spacing)"
      >
        <CardHeader>
          <CollapsibleCardTitle
            icon={<Globe className="size-4" />}
            testId="email-clicks-trigger"
          >
            Clicks
          </CollapsibleCardTitle>
          <CardDescription>
            {narrowed
              ? `The last 24 hours of clicks from ${active.label}.`
              : "Every affiliate click recorded in the last 24 hours, from every source on this page."}
          </CardDescription>
          {/* Volume and worst health stay in the header: collapsing the card
              may hide the table and the chips, never how many clicks landed or
              whether they failed. */}
          <CardAction>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" data-testid="email-clicks-total">
                {stats.total} clicks
              </Badge>
              <Badge variant={health.variant} data-testid="email-clicks-health">
                {health.label}
              </Badge>
            </div>
          </CardAction>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="grid gap-5">
            <nav
              aria-label="Filter clicks by source"
              className="flex flex-wrap items-center gap-2"
              data-testid="email-clicks-sources"
            >
              {sources.map((chip) => (
                <Badge
                  key={chip.value}
                  variant={chip.active ? "default" : "outline"}
                  render={<Link href={chip.href} />}
                  aria-current={chip.active ? "page" : undefined}
                  data-testid={`email-clicks-source-${chip.value}`}
                >
                  {chip.label}
                </Badge>
              ))}
            </nav>

            <StatsBlock stats={stats} />

            {clicks.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {narrowed
                  ? `No clicks from ${active.label} in the last 24 hours.`
                  : "No clicks recorded yet. Run one click or wait for the Grafana check."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-left">
                      <th className="py-2 pr-3 font-medium">Time</th>
                      <th className="py-2 pr-3 font-medium">Target host</th>
                      <th className="py-2 pr-3 font-medium">Source</th>
                      <th className="py-2 pr-3 font-medium">Exit</th>
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
                        <td className="py-2 pr-3 font-mono text-xs">
                          {describeClickExit(click)}
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
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/**
 * The controls. There is no locked state here: the page gate is the only
 * authorization, and this card is only rendered once it has been proven.
 */
function ControlsSection({
  check,
  probes,
  oneOffTargets,
}: {
  check: CheckView | null;
  probes: ProbeView[];
  oneOffTargets: OneOffTargetView[];
}) {
  return (
    <section className="grid gap-4 border-t pt-5">
      <div className="grid gap-1">
        <h4 className="flex items-center gap-2 font-medium">
          <Unlock className="size-4" aria-hidden />
          Controls
        </h4>
        <p className="text-muted-foreground text-sm">
          Changes apply to the Grafana check on the next run.
        </p>
      </div>
      <ControlsForm
        check={check}
        probes={probes}
        oneOffTargets={oneOffTargets}
      />
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
        <SourceStatsSection stats={stats} />
        <ControlsSection
          check={check}
          probes={probes}
          oneOffTargets={oneOffTargets}
        />
      </SourceCard>
    </div>
  );
}
