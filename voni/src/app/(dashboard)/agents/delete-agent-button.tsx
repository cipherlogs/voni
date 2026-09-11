"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, TriangleAlert } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
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
import { deleteAgentAction } from "./actions";

/**
 * Delete an agent with a GitHub-style confirm step, from the list row or the
 * detail footer next to Save.
 *
 * Destructive actions get intentional friction, not a fire-and-forget icon:
 * the dialog restates the consequences in a destructive alert and requires
 * typing the agent's name (exact match) before the confirm enables.
 * Deleting removes the stored AssemblyAI voice agent, unbinds numbers, and
 * erases job history. Call history is kept.
 */
export function AgentDeleteButton({
  id,
  name,
  layout = "icon",
  redirectTo,
}: {
  id: string;
  name: string;
  /** "icon" for list rows, "full" for the detail footer next to Save. */
  layout?: "icon" | "full";
  /** Where to go after a successful delete (detail page uses "/agents"). */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  // The typed name is UI friction only — ownership is still enforced
  // server-side by deleteAgentAction. Trimmed, not case-folded: names are
  // echoed verbatim, so folding would weaken the "read it carefully" effect.
  const confirmed = confirmation.trim() === name;

  const confirm = () =>
    startDelete(async () => {
      setError(null);
      const result = await deleteAgentAction(id);
      if (!result.ok) {
        // Stay in the dialog so the reason (e.g. owns a campaign) is
        // readable next to the action, and toast so it survives dismissal.
        setError(result.message);
        toast.add({ type: "error", title: result.message });
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
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${name}`}
            />
          ) : (
            <Button variant="destructive" />
          )
        }
      >
        {layout === "icon" ? (
          <Trash2 />
        ) : (
          <>
            <Trash2 data-icon="inline-start" />
            Delete agent
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            This is permanent. Type the agent&apos;s name to confirm.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            This removes the voice agent from AssemblyAI, unbinds its phone
            numbers, and erases its job history. Past call records are kept.
            This cannot be undone.
          </AlertDescription>
        </Alert>
        <Field>
          <FieldLabel htmlFor={`delete-confirm-${id}`}>
            Agent name
          </FieldLabel>
          <FieldDescription>
            Type <span className="font-medium text-foreground">{name}</span>{" "}
            to enable deletion.
          </FieldDescription>
          <Input
            id={`delete-confirm-${id}`}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={name}
            autoComplete="off"
            aria-invalid={confirmation.length > 0 && !confirmed ? true : undefined}
          />
        </Field>
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
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
            Delete agent
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
