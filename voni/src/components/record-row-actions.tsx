"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Trash2 } from "lucide-react";
import { RowActions } from "@/components/row-actions";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AgentDeleteButton } from "@/app/(dashboard)/agents/delete-agent-button";
import { CampaignDeleteButton } from "@/app/(dashboard)/campaigns/delete-campaign-button";

/**
 * The agents/campaigns "…" menu (list rows and detail headers): Open (or Review for a finished
 * generation) and Delete. Delete opens that record's typed-name dialog
 * through controlled state, because menu content unmounts on close.
 */
export function RecordRowActions({
  kind,
  id,
  name,
  openHref,
  openLabel = "Open",
  neverProvisioned = false,
  redirectTo,
}: {
  kind: "agent" | "campaign";
  id: string;
  name: string;
  /** Omit on the record's own page, where there is nothing to open. */
  openHref?: string;
  openLabel?: string;
  /** Where to go after deleting (detail pages pass their list). */
  redirectTo?: string;
  /** Agents only: shortens the delete copy for never-deployed drafts. */
  neverProvisioned?: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <RowActions label={`Actions for ${name}`}>
        {openHref ? (
          <>
            <DropdownMenuItem render={<Link href={openHref} />}>
              <ExternalLink />
              {openLabel}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 />
          Delete {kind}
        </DropdownMenuItem>
      </RowActions>
      {kind === "agent" ? (
        <AgentDeleteButton
          id={id}
          name={name}
          layout="none"
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          neverProvisioned={neverProvisioned}
          redirectTo={redirectTo}
        />
      ) : (
        <CampaignDeleteButton
          id={id}
          name={name}
          layout="none"
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          redirectTo={redirectTo}
        />
      )}
    </>
  );
}
