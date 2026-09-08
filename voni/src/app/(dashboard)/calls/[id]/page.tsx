import { callDetail } from "@/lib/copilot/detail-data";
import { RouteBrief } from "@/components/copilot/route-brief";
import { BackLink } from "@/components/back-link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function CallDetailPage({
  params,
}: PageProps<"/calls/[id]">) {
  const { id } = await params;
  const call = await callDetail(id);
  const transcriptCount = Array.isArray(call.transcript) ? call.transcript.length : 0;

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route={`/calls/${id}`} brief={`${call.direction} call with ${call.name ?? call.phone}. Started ${call.startedAt?.toISOString() ?? "not recorded"}. ${call.endedAt ? "Ended " + call.endedAt.toISOString() : "End time not recorded"}. ${transcriptCount} transcript entries recorded. Transcript playback and reasoning trace are not implemented.`} />
      <BackLink href="/calls" label="Calls" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Call with {call.name ?? call.phone}</h1>
        <p className="text-muted-foreground text-sm">{call.direction} · {call.startedAt?.toISOString() ?? "Start time not recorded"}</p>
      </div>

      {/* Reasoning-trace layout, modeled on Vapi's chart+transcript pairing
          (see plan Section E) — chart placeholder left, transcript+trace right. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {transcriptCount ? `${transcriptCount} transcript entries recorded. Transcript playback is not available here yet.` : "No transcript yet."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reasoning trace</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Which tool call or transcript moment drove each Blocker /
            Next-Action determination will be shown here — not just the
            final state, but why.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
