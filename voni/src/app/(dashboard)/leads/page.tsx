import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Users, Upload } from "lucide-react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listLeads } from "./actions";

export default async function LeadsPage() {
  const rows = await listLeads();

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief
        route="/leads"
        brief={`Lead list: ${rows.length} leads with pipeline stages across phone and WhatsApp. Voice reads here.`}
      />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-muted-foreground text-sm">
            Every lead, reachable across phone and WhatsApp, with one shared
            pipeline stage.
          </p>
        </div>
        {/* Import belongs to a campaign — a lead list with no campaign has
            nothing to be worked by — so this points at the place where the
            import actually happens rather than opening a second path to it. */}
        <Button nativeButton={false} render={<Link href="/campaigns" />} variant="outline">
          <Upload />
          Import CSV
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead>Blocker</TableHead>
                  <TableHead>Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-40 text-center">
                      <div className="text-muted-foreground flex flex-col items-center gap-2">
                        <Users className="h-8 w-8" />
                        No leads yet — import a CSV via a campaign to get started.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((lead) => (
                    <TableRow key={lead.id} data-copilot-key={lead.id}>
                      <TableCell>
                        <Link href={`/leads/${lead.id}`} className="cursor-pointer rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                          {lead.name ?? "Unnamed"}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{lead.phone}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            lead.consentStatus === "granted"
                              ? "default"
                              : lead.consentStatus === "revoked"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {lead.consentStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>{lead.pipelineState}</TableCell>
                      <TableCell>{lead.callCount}</TableCell>
                      <TableCell className="text-muted-foreground max-w-[16rem] truncate text-sm">
                        {lead.intent ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[16rem] truncate text-sm">
                        {lead.blocker ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[16rem] truncate text-sm">
                        {lead.nextAction ?? "—"}
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
