"use client";

import Link from "next/link";
import { BulkBar } from "@/components/bulk-bar";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Trash2, Users } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { consentStatus, queueStatus } from "@/lib/campaigns/status";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
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

function LeadStatus({ status }: { status: string }) {
  const { tone, label } = queueStatus(status);
  return <StatusDot tone={tone}>{label}</StatusDot>;
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
      <DataTable
        toolbar={
          members.length > 0 ? (
            <Input
              type="search"
              placeholder="Search by name or phone"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-full sm:w-64"
              aria-label="Search queue"
            />
          ) : undefined
        }
      >
        {members.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="feature">
                <Users />
              </EmptyMedia>
              <EmptyTitle>No leads in this campaign yet</EmptyTitle>
              <EmptyDescription>
                Import a CSV above — imported leads queue here for the dialer.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Users />
              </EmptyMedia>
              <EmptyTitle>No matches in this view</EmptyTitle>
              <EmptyDescription>No leads match “{query.trim()}”.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
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
                <TableHead className="hidden md:table-cell">Phone</TableHead>
                <TableHead className="hidden lg:table-cell">Consent</TableHead>
                <TableHead className="hidden sm:table-cell">State</TableHead>
                <TableHead className="hidden sm:table-cell">Attempts</TableHead>
                <TableHead className="hidden lg:table-cell">Last attempt</TableHead>
                <TableHead className="hidden md:table-cell">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((member) => {
                const consent = consentStatus(member.consentStatus);
                return (
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
                      <div className="flex min-w-0 flex-col gap-1">
                        <Link
                          href={`/leads/${member.leadId}`}
                          className="w-fit rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {member.leadName ?? "Unnamed"}
                        </Link>
                        {/* Phones: phone and state fold under the lead. */}
                        <span className="text-muted-foreground font-mono text-xs md:hidden">
                          {member.phone}
                        </span>
                        <span className="sm:hidden">
                          <LeadStatus status={member.status} />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {member.phone}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <StatusDot tone={consent.tone}>{consent.label}</StatusDot>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <LeadStatus status={member.status} />
                    </TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">
                      {member.attempts} / {maxAttempts}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
                      {formatWhen(member.lastAttemptAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                      {dialOutcomeLabel(member.lastOutcome)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DataTable>
      {selectable && selected.size > 0 ? (
        <BulkBar label="Bulk queue actions" count={selected.size}>
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
        </BulkBar>
      ) : null}
    </div>
  );
}
