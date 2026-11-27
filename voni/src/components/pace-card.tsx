"use client";

import { useActionState, useState } from "react";
import { Gauge } from "lucide-react";
import { useActionToast } from "@/components/action-feedback";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ControlState } from "@/app/email/actions";
import {
  describePace,
  paceRange,
  passesFor,
  planPace,
  type PacePlan,
} from "@/lib/email/pace";
import {
  CLICKS_PER_SEGMENT_BUDGET,
  RUNNER_STARTUP_SECONDS,
  clicksPerDay,
} from "@/lib/email/sources";

/**
 * The one control an operator actually wants: how many clicks a day.
 *
 * The schedule card below still carries every raw setting, but nobody should
 * have to reason about "restart gap 120" to go faster. This card takes a rate,
 * shows what that rate turns into (passes, replaced after N minutes), says what
 * the machine can do at most, and saves it. Everything it renders comes from
 * the same `click` arithmetic the ticker obeys, so the number on screen is the
 * number the queue delivers — or it says why not.
 */

export type PaceCardSettings = {
  enabled: boolean;
  intervalSeconds: number;
  windowSeconds: number;
  segmentSeconds: number;
  restartSeconds: number;
};

export type PaceCardProps = {
  /** The saved row, or null when the source is not seeded. */
  settings: PaceCardSettings | null;
  targetCount: number;
  osCount: number;
  /** Clicks the runners recorded in the last hour, or null when unread. */
  measuredLastHour: number | null;
  action: (previous: ControlState, formData: FormData) => Promise<ControlState>;
};

const INITIAL: ControlState = { ok: false };

function formatPerDay(value: number): string {
  return value.toLocaleString("en-US");
}

/** What the saved row is worth, by the same arithmetic the ticker obeys. */
function currentRate(
  settings: PaceCardSettings | null,
  targetCount: number,
  osCount: number,
): number {
  if (settings === null) return 0;
  return clicksPerDay(
    settings.intervalSeconds,
    settings.windowSeconds,
    settings.segmentSeconds,
    settings.restartSeconds,
    targetCount,
    osCount,
  );
}

/** "≈ 2,400/day" from an hourly count, so the two numbers are comparable. */
function fromHourly(clicks: number): number {
  return Math.round(clicks * 24);
}

export function PaceCard({
  settings,
  targetCount,
  osCount,
  measuredLastHour,
  action,
}: PaceCardProps) {
  const range = paceRange({
    intervalSeconds: settings?.intervalSeconds ?? 15,
    windowSeconds: settings?.windowSeconds ?? 86_400,
    targetCount,
    osCount,
  });
  const currentPerDay = currentRate(settings, targetCount, osCount);

  // The draft target starts at what is saved, so opening the card and pressing
  // save changes nothing by accident.
  const [target, setTarget] = useState<number>(() => currentPerDay);
  const plan: PacePlan = planPace(
    {
      intervalSeconds: settings?.intervalSeconds ?? 15,
      windowSeconds: settings?.windowSeconds ?? 86_400,
      targetCount,
      osCount,
    },
    target,
  );

  const [state, formAction, saving] = useActionState(action, INITIAL);
  useActionToast(state, "Could not save the pace", { successTitle: "Pace saved" });

  const reachesCeiling = target >= range.maxPerDay;
  const measuredPerDay =
    measuredLastHour === null ? null : fromHourly(measuredLastHour);

  return (
    <Card data-testid="email-pace-card">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle as="h2" className="flex items-center gap-2">
            <span className="text-muted-foreground" aria-hidden>
              <Gauge className="size-4" />
            </span>
            Clicks per day
          </CardTitle>
          <Badge variant={settings?.enabled ? "secondary" : "outline"}>
            {settings?.enabled ? "Running" : "Paused"}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Set the rate you want; the app turns it into the schedule the runners
          follow. Slower is a longer pause after each run. Faster is a shorter
          one, until the ceiling.
        </p>
      </CardHeader>

      <CardContent className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div data-testid="email-pace-now">
            <p className="text-muted-foreground font-mono text-xs">Configured</p>
            <p className="text-2xl font-semibold tracking-tight">
              {formatPerDay(currentPerDay)}
              <span className="text-muted-foreground ml-1 text-sm font-normal">
                clicks/day
              </span>
            </p>
            <p className="text-muted-foreground text-xs">
              {describePace(
                planPace(
                  {
                    intervalSeconds: settings?.intervalSeconds ?? 15,
                    windowSeconds: settings?.windowSeconds ?? 86_400,
                    targetCount,
                    osCount,
                  },
                  currentPerDay || range.minPerDay,
                ),
                settings?.intervalSeconds ?? 15,
              )}
            </p>
          </div>

          <div data-testid="email-pace-measured">
            <p className="text-muted-foreground font-mono text-xs">Measured</p>
            <p className="text-2xl font-semibold tracking-tight">
              {measuredPerDay === null ? "—" : formatPerDay(measuredPerDay)}
              <span className="text-muted-foreground ml-1 text-sm font-normal">
                clicks/day
              </span>
            </p>
            <p className="text-muted-foreground text-xs">
              {measuredLastHour === null
                ? "Not read yet."
                : `${measuredLastHour} click${measuredLastHour === 1 ? "" : "s"} in the last hour. Includes failures.`}
            </p>
          </div>

          <div data-testid="email-pace-ceiling">
            <p className="text-muted-foreground font-mono text-xs">Ceiling</p>
            <p className="text-2xl font-semibold tracking-tight">
              {formatPerDay(range.maxPerDay)}
              <span className="text-muted-foreground ml-1 text-sm font-normal">
                clicks/day
              </span>
            </p>
            <p className="text-muted-foreground text-xs">
              {osCount} runner{osCount === 1 ? "" : "s"} x {targetCount} target
              {targetCount === 1 ? "" : "s"}, each run paying{" "}
              {RUNNER_STARTUP_SECONDS}s of startup for at most{" "}
              {CLICKS_PER_SEGMENT_BUDGET} clicks.
            </p>
          </div>
        </div>

        <form action={formAction} className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Presets</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTarget(range.minPerDay)}
              disabled={saving}
            >
              Slowest ({formatPerDay(range.minPerDay)})
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setTarget(Math.round((range.minPerDay + range.maxPerDay) / 2))
              }
              disabled={saving}
            >
              Half ({formatPerDay(Math.round((range.minPerDay + range.maxPerDay) / 2))})
            </Button>
            <Button
              type="button"
              variant={reachesCeiling ? "default" : "outline"}
              size="sm"
              onClick={() => setTarget(range.maxPerDay)}
              disabled={saving}
            >
              As fast as possible ({formatPerDay(range.maxPerDay)})
            </Button>
          </div>

          <Field>
            <FieldLabel htmlFor="email-pace-target">
              Target clicks per day
            </FieldLabel>
            <Input
              id="email-pace-target"
              name="clicksPerDay"
              type="number"
              min={1}
              step={100}
              inputMode="numeric"
              value={target}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 0) setTarget(next);
              }}
              disabled={saving}
              className="max-w-48"
            />
            <FieldDescription>
              Range at the current settings: {formatPerDay(range.minPerDay)} to{" "}
              {formatPerDay(range.maxPerDay)} clicks/day. The window
              ({Math.round((settings?.windowSeconds ?? 86_400) / 3_600)} h a
              day) and the interval (
              {settings?.intervalSeconds ?? 15} s) are on the GitHub card below.
            </FieldDescription>
          </Field>

          <div className="grid gap-1" data-testid="email-pace-preview">
            <p className="text-sm">
              This saves{" "}
              <span className="font-medium">
                about {formatPerDay(plan.projectedPerDay)} clicks/day
              </span>{" "}
              — {describePace(plan, settings?.intervalSeconds ?? 15)}.
            </p>
            <p className="text-muted-foreground text-xs">
              {plan.passes} pass{plan.passes === 1 ? "" : "es"} per run
              {passesFor(targetCount) === plan.passes
                ? `, which is what ${CLICKS_PER_SEGMENT_BUDGET} clicks of exit budget pays for at ${targetCount} target${targetCount === 1 ? "" : "s"}`
                : ""}
              .
            </p>
            {plan.note ? (
              <p
                className="text-destructive text-sm"
                data-testid="email-pace-note"
              >
                {plan.note}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <LoadingButton
              type="submit"
              pending={saving}
              pendingText="Saving…"
              data-testid="email-pace-save"
            >
              Save pace
            </LoadingButton>
            <p className="text-muted-foreground text-xs">
              Applies from the next dispatch. Runs already queued keep the pace
              they started with.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
