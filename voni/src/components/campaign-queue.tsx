"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
}: {
  members: QueueMember[];
  maxAttempts: number;
}) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (member) =>
        (member.leadName ?? "").toLowerCase().includes(q) ||
        member.phone.toLowerCase().includes(q),
    );
  }, [members, query]);

  return (
    <div className="flex flex-col gap-3 p-4 pb-0 sm:p-6 sm:pb-0">
      <Input
        type="search"
        placeholder="Search by name or phone…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-xs"
        aria-label="Search queue"
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={7} className="h-32 text-center">
                  <span className="text-muted-foreground">
                    No leads yet — import a CSV above.
                  </span>
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center">
                  <span className="text-muted-foreground">
                    No leads match “{query.trim()}”.
                  </span>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((member) => (
                <TableRow key={member.id} data-copilot-key={member.id}>
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
                    {LEAD_STATUS_LABEL[member.status] ?? member.status}
                  </TableCell>
                  <TableCell>
                    {member.attempts} / {maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatWhen(member.lastAttemptAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {member.lastOutcome ?? "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
