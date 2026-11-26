"use client";

import { useActionState } from "react";
import {
  Link2,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PauseAllState, PauseOutcome } from "@/app/email/actions";
import { formatCount, useActionToast, useIntentActionState } from "@/components/action-feedback";
import type { TargetState, TargetView } from "@/lib/email/target-state";
import { targetHost } from "@/lib/email/target-url";

/**
 * The `/email` targets card: the one shared list every source on the console
 * draws from, rendered above the source cards so the order on the page matches
 * the dependency — a target is not owned by the Grafana check or by Burst.
 *
 * The actions arrive as props instead of imports so the page stays the one
 * place that knows which server functions exist — the same split as
 * `BurstCard`'s `action` prop. Form fields are the actions' contract:
 * `url` to add, `id` + `enabled` to pause or resume, `id` to remove.
 *
 * Locked is presentation only. Every action re-checks the control cookie in
 * its own body, so a request that skips this card is still refused.
 */

/**
 * What each continuous source commands per day, as the page read it.
 *
 * `clicksPerDay: null` means the source could not be read (Grafana is down or
 * not configured) — a fact, not a zero. `enabled: false` means the source is
 * paused and contributes nothing, which is a zero the page is entitled to add.
 */
export type SourceVolumeView = {
  label: string;
  enabled: boolean;
  clicksPerDay: number | null;
};

export type TargetsVolumeView = {
  /** Sum over enabled sources; `null` when any enabled read failed. */
  totalClicksPerDay: number | null;
  sources: SourceVolumeView[];
};

export type TargetsCardProps = {
  targets: TargetView[];
  volume: TargetsVolumeView;
  addTarget: (previous: TargetState, formData: FormData) => Promise<TargetState>;
  toggleTarget: (
    previous: TargetState,
    formData: FormData,
  ) => Promise<TargetState>;
  removeTarget: (
    previous: TargetState,
    formData: FormData,
  ) => Promise<TargetState>;
  pauseAll: (
    previous: PauseAllState,
    formData: FormData,
  ) => Promise<PauseAllState>;
};

const TARGET_ERROR_TITLE = "Could not update targets";

const INITIAL: TargetState = { ok: false };
const INITIAL_PAUSE: PauseAllState = { ok: false };

/** One clause of the breakdown: unavailable, paused, or a number. */
function describeSource(source: SourceVolumeView): string {
  if (source.clicksPerDay === null) return `${source.label} unavailable`;
  if (!source.enabled) return `${source.label} paused`;
  return `${source.label} ${formatCount(source.clicksPerDay)}`;
}

/** Pause all's per-source sentences, so a failure is words, not a spinner. */
function grafanaLine(outcome: PauseOutcome): string {
  if (!outcome.ok) return `Grafana: could not be paused. ${outcome.error}`;
  return outcome.changed
    ? "Grafana: check paused."
    : "Grafana: check was already paused.";
}

function githubLine(outcome: PauseOutcome): string {
  if (!outcome.ok) return `GitHub: could not be disabled. ${outcome.error}`;
  return outcome.changed
    ? "GitHub: source disabled."
    : "GitHub: source was already disabled.";
}

function AddTargetForm({
  addTarget,
}: {
  addTarget: TargetsCardProps["addTarget"];
}) {
  const [state, action, pending] = useActionState(addTarget, INITIAL);
  useActionToast(state, TARGET_ERROR_TITLE, { successTitle: "Target added" });

  return (
    <form action={action} className="grid gap-3">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email-target-url">Add a target</FieldLabel>
          <Input
            id="email-target-url"
            name="url"
            type="url"
            inputMode="url"
            placeholder="https://www.glizzitrium.com/BCMPW39K/XXXX/?creative_id=123"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            required
          />
          <FieldDescription>
            The full click URL, path and query included. The check starts
            clicking it once it is added.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <div>
        <LoadingButton
          type="submit"
          pending={pending}
          pendingText="Adding…"
          icon={<Plus />}
          data-testid="email-target-add"
        >
          Add target
        </LoadingButton>
      </div>
    </form>
  );
}

/**
 * One row, and the reason the two hooks live here rather than in the card:
 * each form's pending state then belongs to that row and that action, so
 * pausing one target cannot blank every other row's buttons.
 */
function TargetRow({
  target,
  toggleTarget,
  removeTarget,
}: {
  target: TargetView;
  toggleTarget: TargetsCardProps["toggleTarget"];
  removeTarget: TargetsCardProps["removeTarget"];
}) {
  const [toggleState, toggleAction, toggling, pauseIntent] =
    useIntentActionState(
      toggleTarget,
      INITIAL,
      (formData) => formData.get("enabled") === "false",
    );
  const [removeState, removeAction, removing] = useActionState(
    removeTarget,
    INITIAL,
  );

  // The submitted value, not the revalidated prop: after the write the row
  // says the new state, which would title a pause "Target resumed".
  useActionToast(toggleState, TARGET_ERROR_TITLE, {
    successTitle: pauseIntent ? "Target paused" : "Target resumed",
  });
  useActionToast(removeState, TARGET_ERROR_TITLE, {
    successTitle: "Target removed",
  });

  return (
    <li
      className="grid gap-3 rounded-lg border px-3 py-3"
      data-testid={`email-target-${target.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <span
            className="block max-w-md truncate font-mono text-xs"
            title={target.url}
          >
            {target.url}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {targetHost(target.url)}
          </span>
        </div>
        <Badge variant={target.enabled ? "secondary" : "outline"}>
          {target.enabled ? "Active" : "Paused"}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form action={toggleAction}>
          <input type="hidden" name="id" value={target.id} />
          <input
            type="hidden"
            name="enabled"
            value={target.enabled ? "false" : "true"}
          />
          <LoadingButton
            type="submit"
            size="sm"
            variant="outline"
            pending={toggling}
            pendingText={target.enabled ? "Pausing…" : "Resuming…"}
            icon={target.enabled ? <Pause /> : <Play />}
            data-testid={`email-target-toggle-${target.id}`}
          >
            {target.enabled ? "Pause" : "Resume"}
          </LoadingButton>
        </form>

        {/* No confirm: one operator, and re-adding the URL undoes it. */}
        <form action={removeAction}>
          <input type="hidden" name="id" value={target.id} />
          <LoadingButton
            type="submit"
            size="sm"
            variant="ghost"
            className="text-destructive"
            pending={removing}
            pendingText="Removing…"
            icon={<Trash2 />}
            data-testid={`email-target-remove-${target.id}`}
          >
            Remove
          </LoadingButton>
        </form>
      </div>
    </li>
  );
}

/**
 * The aggregate line and Pause all: the header fact the console exists to show,
 * and the one act that stops every continuous source.
 *
 * Pending state is per source by copy, not by number: one request still names
 * both sources it is acting on ("Pausing Grafana…", "Disabling GitHub…"), so a
 * slow Grafana never looks like a button that did nothing.
 */
function PauseAllControl({
  volume,
  pauseAll,
}: {
  volume: TargetsVolumeView;
  pauseAll: TargetsCardProps["pauseAll"];
}) {
  const [state, pauseAction, pausingAll] = useActionState(
    pauseAll,
    INITIAL_PAUSE,
  );

  // Both sources answer in the one toast, each on its own sentence: the act is
  // a single request, but a Grafana failure must not hide GitHub's outcome.
  const details = [
    state.grafana ? grafanaLine(state.grafana) : null,
    state.github ? githubLine(state.github) : null,
  ].filter((line): line is string => line !== null);

  useActionToast(state, "Could not pause every source", {
    successTitle: "Paused every source",
    description:
      details.length > 0 ? (
        <>
          {state.message}{" "}
          <span className="mt-1 block">{details.join(" ")}</span>
        </>
      ) : (
        state.message
      ),
  });

  const enabledCount = volume.sources.filter((source) => source.enabled).length;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="text-sm" data-testid="email-targets-volume">
          {volume.totalClicksPerDay === null ? (
            <>
              Total <span className="font-medium">Unavailable</span> —
              Grafana&apos;s check could not be read, so the total is unknown
              rather than zero.
            </>
          ) : (
            <>
              Total{" "}
              <span className="font-medium">
                {formatCount(volume.totalClicksPerDay)} clicks/day
              </span>{" "}
              across {enabledCount} enabled source
              {enabledCount === 1 ? "" : "s"}.
            </>
          )}
          <span className="text-muted-foreground mt-1 block font-mono text-xs">
            {volume.sources.map(describeSource).join(" · ")}
          </span>
        </p>

        <div className="grid justify-items-end gap-1">
          <form action={pauseAction}>
            <LoadingButton
              type="submit"
              size="sm"
              variant="outline"
              pending={pausingAll}
              pendingText="Pausing all…"
              icon={<Pause />}
              data-testid="email-targets-pause-all"
            >
              Pause all
            </LoadingButton>
          </form>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Pause all stops every continuous source in one act. It leaves the target
        list alone, and a queued GitHub segment keeps running to the end of its
        window.
      </p>

      {pausingAll ? (
        <ul
          className="text-muted-foreground grid gap-1 text-sm"
          aria-live="polite"
          data-testid="email-targets-pause-pending"
        >
          <li>Pausing Grafana…</li>
          <li>Disabling GitHub…</li>
        </ul>
      ) : null}

    </div>
  );
}

export function TargetsCard({
  targets,
  volume,
  addTarget,
  toggleTarget,
  removeTarget,
  pauseAll,
}: TargetsCardProps) {
  const active = targets.filter((target) => target.enabled).length;

  return (
    <Card data-testid="email-targets-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4" />
          Targets
        </CardTitle>
        <CardDescription>
          The click URLs every source on this page draws from. Paused targets
          stay in the list but receive no clicks.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {active} of {targets.length} active
          </Badge>
        </CardAction>
        {/* The aggregate sits in the header, not the body: a source's number
            and the sum are the two facts a collapsed card may never hide. */}
        <div className="col-span-full w-full">
          <PauseAllControl volume={volume} pauseAll={pauseAll} />
        </div>
      </CardHeader>

      <CardContent className="grid gap-5">
        {targets.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No targets in the list. Add the first one below.
          </p>
        ) : (
          <ul className="grid gap-3">
            {targets.map((target) => (
              <TargetRow
                key={target.id}
                target={target}
                toggleTarget={toggleTarget}
                removeTarget={removeTarget}
              />
            ))}
          </ul>
        )}

        <AddTargetForm addTarget={addTarget} />
      </CardContent>
    </Card>
  );
}
