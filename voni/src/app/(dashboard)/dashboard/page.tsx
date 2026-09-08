import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RouteBrief } from "@/components/copilot/route-brief";

const PIPELINE_STAGES = [
  "New",
  "Contacted",
  "Interested",
  "Qualifying",
  "Blocked",
  "Follow-up scheduled",
  "Qualified",
  "Appointment booked",
  "Completed",
];

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <RouteBrief
        route="/dashboard"
        brief="Dashboard: pipeline funnel across active campaigns, broken down by stage. Voice reads here."
      />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Pipeline funnel across all active campaigns.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {PIPELINE_STAGES.map((stage) => (
          <Card key={stage}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stage}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">—</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          No activity yet — connect a database and create your first campaign
          to see calls and messages here.
        </CardContent>
      </Card>
    </div>
  );
}
