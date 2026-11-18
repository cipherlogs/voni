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

/**
 * The `/email` targets card: the live list the Grafana check and the one-off
 * click draw from.
 *
 * The actions arrive as props instead of imports so the page stays the one
 * place that knows which server functions exist — the same split as
 * `BurstCard`'s `action` prop. Form fields are the actions' contract:
 * `url` to add, `id` + `enabled` to pause or resume, `id` to remove.
 *
 * Locked is presentation only. Every action re-checks the control cookie in
 * its own body, so a request that skips this card is still refused.
 */

export type TargetsCardProps = {
  locked: boolean;
  targets: TargetView[];
  addTarget: (previous: TargetState, formData: FormData) => Promise<TargetState>;
  toggleTarget: (
    previous: TargetState,
    formData: FormData,
  ) => Promise<TargetState>;
  removeTarget: (
    previous: TargetState,
    formData: FormData,
  ) => Promise<TargetState>;
};

const INITIAL: TargetState = { ok: false };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function FeedbackAlert({ state }: { state: TargetState }) {
  if (!state.error && !state.message) return null;

  return (
    <Alert variant={state.error ? "destructive" : "default"} className="status-enter">
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>{state.error ? "Could not update targets" : "Done"}</AlertTitle>
      <AlertDescription>{state.error ?? state.message}</AlertDescription>
    </Alert>
  );
}

/** Inline Alert is the required surface; a toast rides along as a convenience. */
function useActionToast(state: TargetState) {
  useEffect(() => {
    if (state.error) {
      toast.add({
        title: "Could not update targets",
        description: state.error,
        type: "error",
      });
      return;
    }
    if (state.message) {
      toast.add({ title: "Done", description: state.message, type: "success" });
    }
  }, [state]);
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
            {hostOf(target.url)}
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

export function TargetsCard({
  locked,
  targets,
  addTarget,
  toggleTarget,
  removeTarget,
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
          The click URLs the check and the one-off click draw from. Paused
          targets stay in the list but receive no clicks.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {active} of {targets.length} active
          </Badge>
        </CardAction>
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
