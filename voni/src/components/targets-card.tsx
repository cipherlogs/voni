"use client";

import { useActionState, useEffect } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
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

/** One source's outcome from Pause all; the shape the action returns. */
export type PauseOutcomeView =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

/** Pause all's result, kept local to the card like the other card states. */
export type PauseAllState = {
  ok: boolean;
  message?: string;
  error?: string;
  grafana?: PauseOutcomeView;
  github?: PauseOutcomeView;
};

export type TargetsCardProps = {
  locked: boolean;
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

const INITIAL: TargetState = { ok: false };
const INITIAL_PAUSE: PauseAllState = { ok: false };

/** Deterministic grouping, so the server and client render the same digits. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/** One clause of the breakdown: unavailable, paused, or a number. */
function describeSource(source: SourceVolumeView): string {
  if (source.clicksPerDay === null) return `${source.label} unavailable`;
  if (!source.enabled) return `${source.label} paused`;
  return `${source.label} ${formatCount(source.clicksPerDay)}`;
}

/** Pause all's per-source sentences, so a failure is words, not a spinner. */
function grafanaLine(outcome: PauseOutcomeView): string {
  if (!outcome.ok) return `Grafana: could not be paused. ${outcome.error}`;
  return outcome.changed
    ? "Grafana: check paused."
    : "Grafana: check was already paused.";
}

function githubLine(outcome: PauseOutcomeView): string {
  if (!outcome.ok) return `GitHub: could not be disabled. ${outcome.error}`;
  return outcome.changed
    ? "GitHub: source disabled."
    : "GitHub: source was already disabled.";
}

function FeedbackAlert({
  state,
  title = "Could not update targets",
}: {
  state: { error?: string | null; message?: string | null };
  title?: string;
}) {
  if (!state.error && !state.message) return null;

  return (
    <Alert variant={state.error ? "destructive" : "default"} className="status-enter">
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>{state.error ? title : "Done"}</AlertTitle>
      <AlertDescription>{state.error ?? state.message}</AlertDescription>
    </Alert>
  );
}

/** Inline Alert is the required surface; a toast rides along as a convenience. */
function useActionToast(
  state: { error?: string | null; message?: string | null },
  title = "Could not update targets",
) {
  useEffect(() => {
    if (state.error) {
      toast.add({
        title,
        description: state.error,
        type: "error",
      });
      return;
    }
    if (state.message) {
      toast.add({ title: "Done", description: state.message, type: "success" });
    }
  }, [state, title]);
}

function AddTargetForm({
  locked,
  addTarget,
}: {
  locked: boolean;
  addTarget: TargetsCardProps["addTarget"];
}) {
  const [state, action, pending] = useActionState(addTarget, INITIAL);
  useActionToast(state);

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
            disabled={locked || pending}
            required
          />
          <FieldDescription>
            The full click URL, path and query included. The check starts
            clicking it once it is added.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <FeedbackAlert state={state} />

      <div>
        <LoadingButton
          type="submit"
          pending={pending}
          pendingText="Adding…"
          icon={<Plus />}
          disabled={locked}
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
  locked,
  toggleTarget,
  removeTarget,
}: {
  target: TargetView;
  locked: boolean;
  toggleTarget: TargetsCardProps["toggleTarget"];
  removeTarget: TargetsCardProps["removeTarget"];
}) {
  const [toggleState, toggleAction, toggling] = useActionState(
    toggleTarget,
    INITIAL,
  );
  const [removeState, removeAction, removing] = useActionState(
    removeTarget,
    INITIAL,
  );

  useActionToast(toggleState);
  useActionToast(removeState);

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
            disabled={locked}
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
            disabled={locked}
            data-testid={`email-target-remove-${target.id}`}
          >
            Remove
          </LoadingButton>
        </form>
      </div>

      <FeedbackAlert state={toggleState} />
      <FeedbackAlert state={removeState} />
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
  locked,
  volume,
  pauseAll,
}: {
  locked: boolean;
  volume: TargetsVolumeView;
  pauseAll: TargetsCardProps["pauseAll"];
}) {
  const [state, pauseAction, pausingAll] = useActionState(
    pauseAll,
    INITIAL_PAUSE,
  );
  useActionToast(state, "Could not pause every source");

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
              disabled={locked}
              data-testid="email-targets-pause-all"
            >
              Pause all
            </LoadingButton>
          </form>
          {locked ? (
            <span className="text-muted-foreground text-xs">
              Unlock the controls to pause every source.
            </span>
          ) : null}
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

      {state.grafana ? (
        <p className="text-sm" data-testid="email-targets-pause-grafana">
          {grafanaLine(state.grafana)}
        </p>
      ) : null}
      {state.github ? (
        <p className="text-sm" data-testid="email-targets-pause-github">
          {githubLine(state.github)}
        </p>
      ) : null}

      <FeedbackAlert state={state} title="Could not pause every source" />
    </div>
  );
}

export function TargetsCard({
  locked,
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
          {locked ? <LockKeyhole className="size-4" /> : <Link2 className="size-4" />}
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
          <PauseAllControl locked={locked} volume={volume} pauseAll={pauseAll} />
        </div>
      </CardHeader>

      <CardContent className="grid gap-5">
        {locked ? (
          <p className="text-muted-foreground text-sm">
            Unlock the controls to change the target list.
          </p>
        ) : null}

        {targets.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No targets in the list.{" "}
            {locked
              ? "Unlock the controls to add one."
              : "Add the first one below."}
          </p>
        ) : (
          <ul className="grid gap-3">
            {targets.map((target) => (
              <TargetRow
                key={target.id}
                target={target}
                locked={locked}
                toggleTarget={toggleTarget}
                removeTarget={removeTarget}
              />
            ))}
          </ul>
        )}

        {locked ? null : <AddTargetForm locked={locked} addTarget={addTarget} />}
      </CardContent>
    </Card>
  );
}
