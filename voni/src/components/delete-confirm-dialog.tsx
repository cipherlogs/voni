"use client";

import { useState, useTransition, type ReactNode } from "react";
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

export type DeleteDialogLayout = "icon" | "full" | "none";

/** Structural result both delete actions already return. */
export type DeleteActionResult =
  | { ok: true; id?: string }
  | { ok: false; message: string };

/**
 * Shared GitHub-style delete confirm dialog for agents and campaigns.
 *
 * Destructive actions get intentional friction, not a fire-and-forget icon:
 * the dialog restates the consequences in a destructive alert and requires
 * typing the item's name (exact match) before the confirm enables. Failures
 * stay visible in-dialog as an inline Alert that *replaces* the consequence
 * note (never stacked beside it); success toasts once and navigates.
 */
export function DeleteConfirmDialog({
  id,
  name,
  layout = "icon",
  redirectTo,
  className,
  triggerLabel,
  showIcon = true,
  description,
  notice = null,
  consequence,
  fieldLabel,
  confirmLabel,
  confirmAction,
  open: controlledOpen,
  onOpenChange,
}: {
  id: string;
  name: string;
  /**
   * "icon" for a bare row button, "full" for a labelled button, "none" when
   * something else (a row "…" menu) opens it through `open`/`onOpenChange`.
   */
  layout?: DeleteDialogLayout;
  /** Where to go after a successful delete (detail pages pass their list). */
  redirectTo?: string;
  /** Extra classes for the `layout="full"` trigger. */
  className?: string;
  /** Trigger label for `layout="full"`. The dialog's own copy is unaffected. */
  triggerLabel: string;
  /** `layout="full"` only. */
  showIcon?: boolean;
  /** DialogDescription body (the "type the name to confirm" sentence). */
  description: ReactNode;
  /** Optional blocking note rendered above the error/consequence Alert. */
  notice?: ReactNode;
  /** Destructive-alert copy stating what removal destroys and what survives. */
  consequence: ReactNode;
  /** Typed-name gate label, e.g. "Agent name". */
  fieldLabel: string;
  /** Destructive confirm button text, e.g. "Delete agent". */
  confirmLabel: string;
  /** Server-side delete; ownership is enforced there, not by the gate. */
  confirmAction: (id: string) => Promise<DeleteActionResult>;
  /** Controlled open state, for `layout="none"`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [pending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  // The typed name is UI friction only — ownership is still enforced
  // server-side by the confirmAction. Trimmed, not case-folded: names are
  // echoed verbatim, so folding would weaken the "read it carefully" effect.
  const confirmed = confirmation.trim() === name;

  const confirm = () =>
    startDelete(async () => {
      setError(null);
      const result = await confirmAction(id);
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
      {layout === "none" ? null : (
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
              {triggerLabel}
            </>
          )}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DestructiveDialogIcon />
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {notice}
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{consequence}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor={`delete-confirm-${id}`}>{fieldLabel}</FieldLabel>
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
            {confirmLabel}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
