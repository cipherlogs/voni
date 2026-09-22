"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, TriangleAlert } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DestructiveDialogIcon,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { deleteCampaignAction } from "./actions";

/**
 * Delete a campaign with a GitHub-style confirm step, from the list row or
 * the detail header next to Activate/Pause.
 *
 * Same friction as deleting an agent: the dialog restates the consequences
 * in a destructive alert and requires typing the campaign's name (exact
 * match) before the confirm enables. Deleting removes the queue and job
 * history. Leads and past call records are kept.
 */
export function CampaignDeleteButton({
  id,
  name,
  layout = "icon",
  redirectTo,
  className,
  label = "Delete campaign",
  showIcon = true,
}: {
  id: string;
  name: string;
  /** "icon" for list rows, "full" for the detail header next to Activate. */
  layout?: "icon" | "full";
  /**
   * Extra classes for the `layout="full"` trigger.
   */
  className?: string;
  /** Trigger label for `layout="full"`. The dialog's own copy is unaffected. */
  label?: string;
  /** `layout="full"` only. */
  showIcon?: boolean;
  /** Where to go after a successful delete (detail page uses "/campaigns"). */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  // The typed name is UI friction only — ownership is still enforced
  // server-side by deleteCampaignAction. Trimmed, not case-folded: names are
  // echoed verbatim, so folding would weaken the "read it carefully" effect.
  const confirmed = confirmation.trim() === name;

  const confirm = () =>
    startDelete(async () => {
      setError(null);
      const result = await deleteCampaignAction(id);
      if (!result.ok) {
        // Stay in the dialog so the reason (e.g. still active) is readable
        // next to the action. Inline-only: the dialog stays open with the
        // typed-name gate intact, so no duplicate toast.
        setError(result.message);
        return;
      }
      setOpen(false);
      toast.add({ type: "success", title: `“${name}” deleted.` });
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setConfirmation("");
        }
      }}
    >
      <DialogTrigger
        render={
          layout === "icon" ? (
            <Button variant="ghost" size="icon" aria-label={`Delete ${name}`} />
          ) : (
            <Button variant="destructive" className={className} />
          )
        }
      >
        {layout === "icon" ? (
          <Trash2 />
        ) : (
          <>
            {showIcon ? <Trash2 data-icon="inline-start" /> : null}
            {label}
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DestructiveDialogIcon />
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            This is permanent. Type the campaign&apos;s name to confirm.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>
              This removes the campaign, its queue, and its job history. Past
              call records and leads are kept. This cannot be undone.
            </AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor={`delete-confirm-${id}`}>
            Campaign name
          </FieldLabel>
          <FieldDescription>
            Type <span className="font-medium text-foreground">{name}</span>{" "}
            to enable deletion.
          </FieldDescription>
          <Input
            id={`delete-confirm-${id}`}
            className="max-w-sm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={name}
            autoComplete="off"
            aria-invalid={
              confirmation.length > 0 && !confirmed ? true : undefined
            }
          />
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <LoadingButton
            variant="destructive"
            pending={pending}
            pendingText="Deleting…"
            disabled={!confirmed}
            onClick={confirm}
          >
            Delete campaign
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
