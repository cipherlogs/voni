import { leadDetail } from "@/lib/copilot/detail-data";
import { RouteBrief } from "@/components/copilot/route-brief";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, MessageCircle } from "lucide-react";
import { BackLink } from "@/components/back-link";

export default async function LeadDetailPage({
  params,
}: PageProps<"/leads/[id]">) {
  const { id } = await params;
  const { lead, state } = await leadDetail(id);

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route={`/leads/${id}`} brief={`Lead ${lead.name ?? "Unnamed"}, ${lead.phone}. State ${lead.pipelineState}. Consent ${lead.consentStatus}. Intent ${state?.intent ?? "not recorded"}. Next action ${state?.nextAction ?? "not recorded"}. Timeline is not implemented.`} />
      <BackLink href="/leads" label="Leads" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{lead.name ?? "Unnamed lead"}</h1>
          <p className="text-muted-foreground text-sm">{lead.phone}</p>
        </div>
        <Badge variant="secondary">{lead.pipelineState}</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Intent
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{state?.intent ?? "Not recorded"}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Blocker
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{Array.isArray(state?.blockers) ? state.blockers.join(", ") || "None recorded" : "Not recorded"}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Next action
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">{state?.nextAction ?? "Not recorded"}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
          <div className="flex gap-3">
            <Phone className="h-6 w-6" />
            <MessageCircle className="h-6 w-6" />
          </div>
          Calls and WhatsApp messages for this lead will appear here,
          interleaved by time, feeding one shared conversation state.
        </CardContent>
      </Card>
    </div>
  );
}
