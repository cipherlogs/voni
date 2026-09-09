import { Suspense } from "react";
import { callDetail } from "@/lib/copilot/detail-data";
import { RouteBrief } from "@/components/copilot/route-brief";
import { BackLink } from "@/components/back-link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DetailSkeleton } from "@/components/page-skeletons";

/**
 * Authorized call leaf: call data and implemented details resolve here.
 * notFound()/denial stay inside detail-data, called from this leaf.
 */
async function CallDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const call = await callDetail(id);
  const transcriptCount = Array.isArray(call.transcript) ? call.transcript.length : 0;

  return (
    <>
      <RouteBrief route={`/calls/${id}`} brief={`${call.direction} call with ${call.name ?? call.phone}. Started ${call.startedAt?.toISOString() ?? "not recorded"}. ${call.endedAt ? "Ended " + call.endedAt.toISOString() : "End time not recorded"}. ${transcriptCount} transcript entries recorded. Transcript playback and reasoning trace are not implemented.`} />
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
    </>
  );
}

export default function CallDetailPage({
  params,
}: PageProps<"/calls/[id]">) {
  return (
    <div data-testid="call-shell" className="flex flex-col gap-6">
      <BackLink href="/calls" label="Calls" />
      {/* Existing back navigation + detail structure shell; authorized call
          data streams in the leaf below. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading call">
            <DetailSkeleton />
          </div>
        }
      >
        <CallDetail params={params} />
      </Suspense>
    </div>
  );
}
