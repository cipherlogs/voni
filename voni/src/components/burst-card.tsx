"use client";

import { useActionState, useState } from "react";
import { AlertCircle, LockKeyhole, Zap } from "lucide-react";
import { copyCommand, useActionToast } from "@/components/action-feedback";
import { LoadingButton } from "@/components/loading-button";
import { SourceCard } from "@/components/source-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  FREE_VU_HOURS,
  MAX_CLICKS,
  US_ZONES,
  describePlan,
  planBurst,
} from "@/lib/burst/plan";
import type { BurstState } from "@/lib/burst/state";

/**
 * The `/email` burst source card: one k6 Cloud run from the US load zones,
 * started through the workflow dispatch in `src/lib/burst/dispatch.ts`.
 *
 * It is a source card like Grafana — same collapsible shell, same header facts
 * (state, the volume one run commands, readiness) — because the console grows
 * by adding cards, not by adding pages.
 *
 * The action arrives as a prop instead of an import so this card can land and
 * be reviewed before `src/app/email/actions.ts` grows the matching export. The
 * form fields are the action's contract: `clicks`, `duration` (minutes) and one
 * `zones` entry per selected zone id.
 *
 * Every number shown comes from `planBurst` — the same call the action
 * validates with — so the preview cannot promise a run the dispatch refuses.
 * Locked is presentation only; the action authorises inside its own body like
 * every other action on this page.
 */

export type BurstCardProps = {
  locked: boolean;
  action: (prev: BurstState, formData: FormData) => Promise<BurstState>;
  /** Zone ids to start selected; empty or unknown ids fall back to all four. */
  defaultZones: string[];
};

const INITIAL: BurstState = { ok: false };

/** Where a burst stops being a test, in clicks and in VU-hours. */
const LOUD_CLICKS = 10_000;
const LOUD_VU_HOURS = 50;

const DEFAULT_CLICKS = "2000";
const DEFAULT_MINUTES = "2";

function initialZones(defaultZones: string[]): string[] {
  const known = defaultZones.filter((id) => US_ZONES.some((zone) => zone.id === id));
  return known.length > 0 ? known : US_ZONES.map((zone) => zone.id);
}

const BURST_SUCCESS_DEFAULT =
  "The workflow is queued. It appears on the run page once GitHub starts it.";

/**
 * The VU-hours share of the month, as a thin bar. The generated Progress
 * primitive owns the fill geometry, so no inline style is needed here.
 */
function BudgetBar({ vuHours }: { vuHours: number }) {
  const used = Number(vuHours.toFixed(2));
  return (
    <Progress
      value={vuHours}
      max={FREE_VU_HOURS}
      aria-label={`VU-hours used: ${used} of ${FREE_VU_HOURS}`}
      className="grid"
      data-testid="email-burst-budget-bar"
    />
  );
}

export function BurstCard({ locked, action, defaultZones }: BurstCardProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  // One toast per burst outcome: an error, a queued run with a "View run"
  // action, or the exact manual line with a copy action. The manual line gets a
  // longer timeout so it can be read and copied before it disappears.
  const command = state.fallback?.command;
  useActionToast(state, "Burst not dispatched", {
    successTitle: command ? "Run it yourself" : "Burst dispatched",
    timeout: command ? 12_000 : undefined,
    description: command ? (
      <>
        {state.message}{" "}
        <code className="mt-1 block font-mono text-xs break-all whitespace-pre-wrap">
          {command}
        </code>
      </>
    ) : (
      state.message ?? BURST_SUCCESS_DEFAULT
    ),
    action: command
      ? { label: "Copy", onClick: () => copyCommand(command) }
      : state.runUrl
        ? { label: "View run", href: state.runUrl }
        : undefined,
  });
  const [clicksText, setClicksText] = useState(DEFAULT_CLICKS);
  const [minutesText, setMinutesText] = useState(DEFAULT_MINUTES);
  const [selected, setSelected] = useState<string[]>(() => initialZones(defaultZones));

  const clicks = Number(clicksText);
  // The card edits minutes (0.5–60); the plan and the workflow take seconds.
  const durationSec = Math.round(Number(minutesText) * 60);
  const result = planBurst({ clicks, durationSec, zoneIds: selected });
  const plan = result.ok ? result.plan : null;

  const loud =
    plan !== null && (plan.clicks > LOUD_CLICKS || plan.vuHours > LOUD_VU_HOURS);
  const disabled = locked || pending;

  return (
    <SourceCard
      testId="email-burst-card"
      name="Burst"
      icon={locked ? <LockKeyhole className="size-4" /> : <Zap className="size-4" />}
      description="One manual k6 Cloud run of the same click script, from the US load zones, for a fixed window. It spends the monthly VU-hour allowance."
      summary={{
        status: locked
          ? { label: "Locked", variant: "outline" }
          : { label: "On demand", variant: "secondary" },
        // Burst has no cadence to state, so the volume slot says what one run
        // commands rather than a daily rate it does not have.
        volume: {
          value: plan ? plan.clicks.toLocaleString("en-US") : "—",
          label: "clicks/run",
        },
        health:
          plan === null
            ? { label: "Check inputs", variant: "destructive" }
            : { label: `${plan.vus} VUs`, variant: "outline" },
      }}
    >
      <form action={formAction} className="grid gap-5">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="email-burst-clicks">Clicks</FieldLabel>
            <Input
              id="email-burst-clicks"
              name="clicks"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CLICKS}
              step={1}
              value={clicksText}
              onChange={(event) => setClicksText(event.target.value)}
              disabled={disabled}
              aria-invalid={!Number.isInteger(clicks) || clicks < 1}
              required
            />
            <FieldDescription>
              Whole number 1–{MAX_CLICKS}. Each click draws a fresh profile.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="email-burst-minutes">
              Duration (minutes)
            </FieldLabel>
            <Input
              id="email-burst-minutes"
              name="duration"
              type="number"
              inputMode="decimal"
              min={0.5}
              max={60}
              step={0.5}
              value={minutesText}
              onChange={(event) => setMinutesText(event.target.value)}
              disabled={disabled}
              required
            />
            <FieldDescription>
              0.5–60 minutes. VUs are sized so the clicks fit the window.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <FieldGroup className="grid gap-2 sm:grid-cols-2">
          {US_ZONES.map((zone) => {
            const checked = selected.includes(zone.id);
            return (
              <Field key={zone.id} orientation="horizontal">
                <Checkbox
                  id={`email-burst-zone-${zone.id.replace(/[^a-z]+/gi, "-")}`}
                  name="zones"
                  value={zone.id}
                  checked={checked}
                  onCheckedChange={(next: boolean) => {
                    setSelected((previous) =>
                      next
                        ? [...previous.filter((id) => id !== zone.id), zone.id]
                        : previous.filter((id) => id !== zone.id),
                    );
                  }}
                  disabled={disabled}
                />
                <FieldLabel htmlFor={`email-burst-zone-${zone.id.replace(/[^a-z]+/gi, "-")}`}>
                  <span className="font-normal">{zone.label}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {zone.id}
                  </span>
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>

        <div className="grid gap-3 rounded-lg border px-3 py-3">
          <p
            className="font-mono text-sm leading-relaxed break-words"
            data-testid="email-burst-preview"
          >
            {result.ok ? (
              describePlan(result.plan)
            ) : (
              <span className="text-muted-foreground">{result.reason}</span>
            )}
          </p>

          {plan ? <BudgetBar vuHours={plan.vuHours} /> : null}

          {plan && plan.zones.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {plan.zones
                .map((zone) => `${zone.label} ${zone.percent}%`)
                .join(" · ")}
            </p>
          ) : null}

          {loud && plan ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>This is a load test, not a check</AlertTitle>
              <AlertDescription>
                {[
                  plan.clicks > LOUD_CLICKS
                    ? `${plan.clicks.toLocaleString("en-US")} clicks in one run`
                    : null,
                  plan.vuHours > LOUD_VU_HOURS
                    ? `${plan.vuHours.toFixed(1)} VU-hours of the ${FREE_VU_HOURS}`
                    : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" and ")}{" "}
                is past where affiliate networks read traffic as testing.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        {locked ? (
          <p className="text-muted-foreground text-sm">
            The panel is read-only. Unlock it to dispatch a burst.
          </p>
        ) : null}

        <div>
          <LoadingButton
            type="submit"
            pending={pending}
            pendingText="Dispatching…"
            icon={<Zap />}
            disabled={locked || plan === null}
            data-testid="email-burst-dispatch"
          >
            Dispatch burst
          </LoadingButton>
        </div>
      </form>
    </SourceCard>
  );
}
