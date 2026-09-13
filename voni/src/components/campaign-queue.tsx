"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { dialOutcomeLabel } from "@/lib/campaigns/outcome-label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import {
  queueBulkAction,
  queueUndoRemoveAction,
} from "@/app/(dashboard)/campaigns/actions";

/**
 * The campaign's lead queue with a name/phone search, following the jobs
 * page's client-side filter house pattern (`JobsContent`): the full member
 * list ships from the server leaf and filtering never waits on it.
 *
 * Server-side search would need a new query param and a second suspended
 * leaf for a table that tops out in the dozens — client filtering is the
 * whole feature here, not a shortcut around one.
 */
export type QueueMember = {
  id: string;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  lastOutcome: string | null;
  leadId: string;
  leadName: string | null;
  phone: string;
  consentStatus: string;
};

const LEAD_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  dialing: "Dialing",
  reached: "Reached",
  exhausted: "No answer",
  skipped: "Skipped",
};

// table-05 StatusBadge shape with semantic tokens (no raw palette): each
// human label from LEAD_STATUS_LABEL maps to a tone, matching the campaigns
// list's STATUS_VARIANT badge idiom. No table-02/03/04 reference exists yet,
// so this follows the only vendored status-badge shape in the repo.
const LEAD_STATUS_TONE: Record<string, "default" | "secondary" | "outline"> = {
  queued: "secondary",
  dialing: "default",
  reached: "default",
  exhausted: "outline",
  skipped: "outline",
};

function LeadStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={LEAD_STATUS_TONE[status] ?? "outline"}>
      {LEAD_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

function formatWhen(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function CampaignQueue({
  members,
  maxAttempts,
  campaignId,
}: {
  members: QueueMember[];
  maxAttempts: number;
  campaignId?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOp, setBulkOp] = useState<"remove" | "reset" | null>(null);
  // Undo window: the 8s toast holds the only copy of what was removed, so a
  // ref (not state) carries the ids — re-renders must never clear it early.
  const undoRef = useRef<{ leadIds: string[] } | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (member) =>
        (member.leadName ?? "").toLowerCase().includes(q) ||
        member.phone.toLowerCase().includes(q),
    );
  }, [members, query]);

  const selectable = campaignId !== undefined;
  const allVisibleSelected =
    visible.length > 0 && visible.every((member) => selected.has(member.id));
  const someVisibleSelected = visible.some((member) => selected.has(member.id));

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleVisible = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const member of visible) {
        if (checked) next.add(member.id);
        else next.delete(member.id);
      }
      return next;
    });

  const actionable = useMemo(
    () => visible.filter((member) => selected.has(member.id)).map((m) => m.id),
    [visible, selected],
  );

  const undoRemove = async () => {
    const leadIds = undoRef.current?.leadIds;
    if (!leadIds || !campaignId) return;
    const result = await queueUndoRemoveAction(campaignId, leadIds);
    if (result.ok) {
      toast.add({
        type: "success",
        title: `Restored ${result.restored} lead${result.restored === 1 ? "" : "s"} to the queue.`,
      });
      undoRef.current = null;
      router.refresh();
    } else {
      toast.add({ type: "error", title: result.message });
    }
  };

  const runBulk = async (op: "remove" | "reset") => {
    if (!campaignId || actionable.length === 0 || bulkOp) return;
    setBulkOp(op);
    try {
      const result = await queueBulkAction({
        campaignId,
        ids: actionable,
        op,
      });
      if (!result.ok) {
        toast.add({ type: "error", title: result.message });
        return;
      }
      if (op === "remove") {
        const count = result.removed.length;
        if (count > 0) {
          undoRef.current = {
            leadIds: result.removed.map((r) => r.leadId),
          };
          const id = toast.add({
            type: "success",
            title: `Removed ${count} lead${count === 1 ? "" : "s"} from the queue.`,
            description: "The dialer will skip them.",
            timeout: 8000,
            actionProps: {
              children: "Undo",
              onClick: () => {
                void undoRemove();
                toast.close(id);
              },
            },
          });
          setSelected(new Set());
        }
      } else {
        const count = result.reset.length;
        toast.add({
          type: "success",
          title:
            count > 0
              ? `Reset ${count} lead${count === 1 ? "" : "s"} to queued.`
              : "Those leads are already queued — nothing changed.",
        });
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of result.reset) next.delete(id);
          return next;
        });
      }
      router.refresh();
    } finally {
      setBulkOp(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 p-4 pb-0 sm:flex-row sm:items-center sm:justify-between sm:p-6 sm:pb-0">
        <Input
          type="search"
          placeholder="Search by name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-full sm:w-64"
          aria-label="Search queue"
        />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected && !allVisibleSelected}
                    onCheckedChange={toggleVisible}
                    aria-label={`Select all ${visible.length} leads in this view`}
                  />
                </TableHead>
              ) : null}
              <TableHead>Lead</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Consent</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Last attempt</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={selectable ? 8 : 7} className="h-32 text-center">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Users />
                      </EmptyMedia>
                      <EmptyDescription>
                        No leads yet — import a CSV above.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={selectable ? 8 : 7} className="h-32 text-center">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Users />
                      </EmptyMedia>
                      <EmptyDescription>
                        No leads match “{query.trim()}”.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((member) => (
                <TableRow key={member.id} data-copilot-key={member.id}>
                  {selectable ? (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(member.id)}
                        onCheckedChange={(checked) => toggle(member.id, checked)}
                        aria-label={`Select ${member.leadName ?? member.phone}`}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <Link
                      href={`/leads/${member.leadId}`}
                      className="cursor-pointer rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {member.leadName ?? "Unnamed"}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {member.phone}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        member.consentStatus === "granted"
                          ? "default"
                          : member.consentStatus === "revoked"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {member.consentStatus === "granted"
                        ? "Consented"
                        : member.consentStatus === "revoked"
                          ? "Opted out"
                          : "Unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <LeadStatusBadge status={member.status} />
                  </TableCell>
                  <TableCell>
                    {member.attempts} / {maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatWhen(member.lastAttemptAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {dialOutcomeLabel(member.lastOutcome)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {selectable && selected.size > 0 ? (
        <div
          role="toolbar"
          aria-label="Bulk queue actions"
          className="bg-card sticky bottom-4 z-10 mx-4 mb-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 shadow-lg sm:mx-6"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {selected.size} selected
          </span>
          <LoadingButton
            size="sm"
            variant="outline"
            pending={bulkOp === "remove"}
            pendingText="Removing…"
            icon={<Trash2 />}
            disabled={actionable.length === 0}
            onClick={() => void runBulk("remove")}
          >
            Remove from queue
          </LoadingButton>
          <LoadingButton
            size="sm"
            variant="outline"
            pending={bulkOp === "reset"}
            pendingText="Resetting…"
            icon={<RotateCcw />}
            disabled={actionable.length === 0}
            onClick={() => void runBulk("reset")}
          >
            Reset to queued
          </LoadingButton>
          <Button
            size="sm"
            variant="ghost"
            disabled={bulkOp !== null}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
