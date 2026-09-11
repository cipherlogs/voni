import Link from "next/link";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { RouteBrief } from "@/components/copilot/route-brief";
import { recentCalls } from "@/lib/copilot/detail-data";
import { relativeCallTime } from "@/lib/calls/format";

/**
 * Secondary section on /agents: the 5 most recent calls (lead + when +
 * direction), each linking to its /calls/[id] detail. Agents stay the
 * page's primary content — this streams in below without blocking them.
 *
 * When the org has no calls yet, the section renders a deliberate shadcn
 * `Empty` state instead of disappearing: a missing section reads as a
 * broken page, an explicit one reads as "nothing here yet".
 */
export async function RecentCalls() {
  const rows = await recentCalls();

  return (
    <section aria-labelledby="recent-calls-heading" className="flex flex-col gap-3">
      <RouteBrief
        route="/agents"
        brief={`Recent calls: ${rows.length} recent calls with lead, time, and direction. Voice reads here.`}
      />
      <div className="flex items-center justify-between">
        <h2
          id="recent-calls-heading"
          className="text-base font-semibold tracking-tight"
        >
          Recent calls
        </h2>
        {rows.length > 0 ? (
          <Button
            nativeButton={false}
            render={<Link href="/calls" />}
            variant="outline"
            size="sm"
          >
            View all
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Phone />
            </EmptyMedia>
            <EmptyTitle>No calls yet</EmptyTitle>
            <EmptyDescription>
              Calls appear here after the first inbound or outbound call.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((call) => {
            const label = call.name ?? call.phone;
            const directionLabel =
              call.direction === "inbound" ? "Inbound" : "Outbound";
            return (
              <Card
                key={call.id}
                className="relative transition-colors hover:bg-muted/50"
              >
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <Link
                    href={`/calls/${call.id}`}
                    aria-label={`${directionLabel} call with ${label}`}
                    title={call.startedAt?.toISOString() ?? "Start time not recorded"}
                    className="before:absolute before:inset-0 min-w-0 flex-1"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{label}</span>
                        <Badge
                          variant={
                            call.direction === "inbound"
                              ? "default"
                              : "secondary"
                          }
                        >
                          {directionLabel}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground text-sm">
                        {relativeCallTime(call.startedAt)}
                      </span>
                    </span>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
