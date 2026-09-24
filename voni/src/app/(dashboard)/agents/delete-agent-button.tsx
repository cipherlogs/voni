"use client";

import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DeleteConfirmDialog,
  type DeleteDialogLayout,
} from "@/components/delete-confirm-dialog";
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
  open,
  onOpenChange,
  id,
  name,
  layout = "icon",
  redirectTo,
  neverProvisioned = false,
  className,
  label = "Delete agent",
  showIcon = true,
  isBridgeAgent = false,
}: {
  /** Controlled open state, for `layout="none"` (row "…" menus). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id: string;
  name: string;
  /** "icon" for list rows, "full" for the detail footer next to Save. */
  layout?: DeleteDialogLayout;
  /**
   * Extra classes for the `layout="full"` trigger. The agent detail page
   * dresses it as the mockup's ghost-danger pill; every other caller keeps
   * the default solid destructive button.
   */
  className?: string;
  /** Trigger label for `layout="full"`. The dialog's own copy is unaffected. */
  label?: string;
  /** `layout="full"` only. The mockup's ghost-danger pill is text alone. */
  showIcon?: boolean;
  /** Where to go after a successful delete (detail page uses "/agents"). */
  redirectTo?: string;
  /**
   * True when the agent was never provisioned (no assemblyaiAgentId and
   * deploymentStatus is draft / never deployed). Only shortens the copy —
   * the typed-name gate and delete flow are unchanged.
   */
  neverProvisioned?: boolean;
  /**
   * True when this agent is the platform bridge default. Deleting it clears
   * the bridge default (onDelete: set null), so the dialog carries a blocking
   * note — the bridge has no agent until an operator picks a new one.
   */
  isBridgeAgent?: boolean;
}) {
  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      id={id}
      name={name}
      layout={layout}
      redirectTo={redirectTo}
      className={className}
      triggerLabel={label}
      showIcon={showIcon}
      description={
        <>
          This is permanent.{" "}
          {neverProvisioned
            ? "No voice agent exists yet, so only the draft is removed."
            : null}{" "}
          Type the agent&apos;s name to confirm.
        </>
      }
      notice={
        isBridgeAgent ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>
              This agent is the platform bridge default. Deleting it clears
              the bridge default — the voice bridge has no agent until an
              operator picks a new one in Settings → Platform. Delete only if
              a replacement is ready.
            </AlertDescription>
          </Alert>
        ) : null
      }
      consequence={
        neverProvisioned ? (
          <>
            This agent was not yet provisioned: only the draft and its job
            history are removed. Past call records are kept. This cannot be
            undone.
          </>
        ) : (
          <>
            This removes the voice agent from AssemblyAI, unbinds its phone
            numbers, and erases its job history. Past call records are kept.
            This cannot be undone.
          </>
        )
      }
      fieldLabel="Agent name"
      confirmLabel="Delete agent"
      confirmAction={deleteAgentAction}
    />
  );
}
