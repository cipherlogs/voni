"use client";

import {
  DeleteConfirmDialog,
  type DeleteDialogLayout,
} from "@/components/delete-confirm-dialog";
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
  open,
  onOpenChange,
  id,
  name,
  layout = "icon",
  redirectTo,
  className,
  label = "Delete campaign",
  showIcon = true,
}: {
  /** Controlled open state, for `layout="none"` (row "…" menus). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id: string;
  name: string;
  /** "icon" for list rows, "full" for the detail header next to Activate. */
  layout?: DeleteDialogLayout;
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
        <>This is permanent. Type the campaign&apos;s name to confirm.</>
      }
      consequence={
        <>
          This removes the campaign, its queue, and its job history. Past call
          records and leads are kept. This cannot be undone.
        </>
      }
      fieldLabel="Campaign name"
      confirmLabel="Delete campaign"
      confirmAction={deleteCampaignAction}
    />
  );
}
