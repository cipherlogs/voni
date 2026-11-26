"use client";

import { useActionState, useState } from "react";
import { Repeat } from "lucide-react";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useCardDisclosure } from "@/components/card-disclosure";
import { CollapsibleCardTitle } from "@/components/collapsible-card-title";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useActionToast } from "@/components/action-feedback";
import type { ControlState } from "@/app/email/actions";
import {
  TARGET_SELECTION_DESCRIPTIONS,
  TARGET_SELECTION_LABELS,
  type TargetSelection,
} from "@/lib/email/target-selection";

/**
 * The page's rotation mode: one setting, read by every producer.
 *
 * It used to be a switch inside the Grafana card, saved into the check's own
 * script, so only Grafana could see it and the GitHub Source dispatched with no
 * mode at all. It now lives here, at page level, because the same choice has to
 * reach Grafana's script and the GitHub dispatch: two controls would let them
 * disagree, and a click that rotates in one producer and draws at random in the
 * other makes the two Sources' numbers incomparable.
 *
 * The mode is a value, not a form: the Switch posts nothing, so a hidden field
 * carries it and the server refuses a request without one rather than guessing.
 * The action arrives as a prop, like `BurstCard`'s, so the page stays the one
 * place that knows which server functions exist.
 *
 * `chosen` is the migration state. Until a mode is written for the first time,
 * an existing Grafana script keeps running — and reporting — whatever mode it
 * already carries, and this card says so instead of claiming a choice nobody
 * made.
 */
export type RotationCardProps = {
  /** What every producer runs with right now. */
  mode: TargetSelection;
  /** Whether that mode came from the stored setting, or from the script. */
  chosen: boolean;
  action: (previous: ControlState, formData: FormData) => Promise<ControlState>;
};

const INITIAL: ControlState = { ok: false };

export function RotationCard({ mode, chosen, action }: RotationCardProps) {
  // Local until Save: the switch is a preference, and the saved value is what
  // both producers actually run, so the two must not be shown as one.
  const [selection, setSelection] = useState<TargetSelection>(mode);
  const [state, formAction, saving] = useActionState(action, INITIAL);

  useActionToast(state, "Could not save the rotation mode", {
    successTitle: "Rotation saved",
    warningTitle: "Rotation saved, Grafana not updated",
  });

  const label =
    selection === "random"
      ? "Draw targets at random"
      : "Rotate through every target";
  const changed = selection !== mode;
  const { open, onOpenChange } = useCardDisclosure("email-rotation-card");

  return (
    <Card data-testid="email-rotation-card">
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="group/card grid gap-(--card-spacing)"
      >
        <CardHeader>
          <CollapsibleCardTitle
            icon={<Repeat className="size-4" />}
            testId="email-rotation-trigger"
          >
            Target rotation
          </CollapsibleCardTitle>
          <CardDescription>
            How every source picks its next target: Grafana&apos;s scheduled
            check and the GitHub browser source share this one setting.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">{TARGET_SELECTION_LABELS[mode]}</Badge>
          </CardAction>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="grid gap-4">
            <form action={formAction} className="grid gap-4">
              <Field>
                <input type="hidden" name="selection" value={selection} />
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="email-rotation-selection">
                    {label}
                  </FieldLabel>
                  <Switch
                    id="email-rotation-selection"
                    checked={selection === "random"}
                    onCheckedChange={(next: boolean) => {
                      setSelection(next ? "random" : "rotate");
                    }}
                    disabled={saving}
                    data-testid="email-rotation-selection"
                  />
                </div>
                <FieldDescription>
                  <span className="text-foreground font-medium">
                    {TARGET_SELECTION_LABELS[selection]}
                  </span>{" "}
                  — {TARGET_SELECTION_DESCRIPTIONS[selection]}
                  {chosen
                    ? null
                    : " No mode has been saved here yet, so this shows what Grafana's script already does; saving applies your choice to both sources."}
                </FieldDescription>
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <LoadingButton
                  type="submit"
                  pending={saving}
                  pendingText="Saving…"
                  icon={<Repeat />}
                  disabled={saving}
                >
                  {changed ? "Save rotation" : "Re-apply rotation"}
                </LoadingButton>
                {chosen ? null : (
                  <span className="text-muted-foreground text-sm">
                    The check is still running its own saved mode until you save
                    one here.
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
