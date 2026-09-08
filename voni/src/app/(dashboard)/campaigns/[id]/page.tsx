import { RouteBrief } from "@/components/copilot/route-brief";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, PhoneOutgoing, Clock } from "lucide-react";
import { CampaignControls } from "@/components/campaign-controls";
import { LeadImport } from "@/components/lead-import";
import { describeCallingWindow } from "@/lib/campaigns/policy";
import { getCampaign, getCampaignDispatchStatus } from "../actions";

const STATUS_VARIANT = {
  active: "default",
  draft: "secondary",
  paused: "outline",
  completed: "outline",
} as const;

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

export default async function CampaignPage({
  params,
}: PageProps<"/campaigns/[id]">) {
  const { id } = await params;
  const [data, dispatch] = await Promise.all([
    getCampaign(id),
    getCampaignDispatchStatus(id),
  ]);
  if (!data || !dispatch) notFound();

  const { campaign, members } = data;
  const queued = members.filter((m) => m.status === "queued").length;

  // The activate button's precondition, phrased for a human. Mirrors what
  // setCampaignStatusAction enforces server-side; shown up front so the
  // operator does not have to click to discover it.
  const activationBlocker =
    !campaign.agentDeployed
      ? `${campaign.agentName} is still a draft — publish it before activating.`
      : queued === 0
        ? "Import leads before activating this campaign."
        : null;

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route={`/campaigns/${id}`} brief={`Campaign ${campaign.name}. Status ${campaign.status}. ${members.length} leads, ${queued} queued. ${dispatch.dueNow} due now. ${activationBlocker ?? ""} ${dispatch.blockers.join(". ")}`} />
      <div className="flex flex-col gap-2">
        <Button
          nativeButton={false}
          render={<Link href="/campaigns" />}
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
        >
          <ChevronLeft />
          Campaigns
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {campaign.name}
              </h1>
              <Badge variant={STATUS_VARIANT[campaign.status]}>
                {campaign.status}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              {campaign.agentName} ·{" "}
              {describeCallingWindow(dispatch.window)} · up to{" "}
              {campaign.maxAttempts} attempt
              {campaign.maxAttempts === 1 ? "" : "s"} per lead
            </p>
          </div>
          <CampaignControls
            id={campaign.id}
            status={campaign.status}
            activationBlocker={activationBlocker}
          />
        </div>
      </div>

      {/* Why the dialer is or is not working right now. A campaign that is
          simply outside its calling window is indistinguishable from a broken
          one without this. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {dispatch.blockers.length === 0 ? (
              <PhoneOutgoing className="h-4 w-4" />
            ) : (
              <Clock className="text-muted-foreground h-4 w-4" />
            )}
            Dialer
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {dispatch.blockers.length === 0 ? (
            <>
              <p className="font-medium">
                Ready to dial — {dispatch.dueNow} lead
                {dispatch.dueNow === 1 ? "" : "s"} due now.
              </p>
              <p className="text-muted-foreground text-sm">
                The bridge runner picks these up on its next poll. It previews by
                default and only places calls when started with{" "}
                <code className="text-xs">--live</code>.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Not dialing</p>
              <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5 text-sm">
                {dispatch.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              {dispatch.dueNow > 0 && !dispatch.windowOpen ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  {dispatch.dueNow} lead{dispatch.dueNow === 1 ? " is" : "s are"}{" "}
                  waiting for the window to open.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import leads</CardTitle>
        </CardHeader>
        <CardContent>
          <LeadImport campaignId={campaign.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Queue ({members.length} lead{members.length === 1 ? "" : "s"})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
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
                ) : (
                  members.map((member) => (
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
                          {member.consentStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {LEAD_STATUS_LABEL[member.status] ?? member.status}
                      </TableCell>
                      <TableCell>
                        {member.attempts} / {campaign.maxAttempts}
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
        </CardContent>
      </Card>
    </div>
  );
}
