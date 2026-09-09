import { NextResponse } from "next/server";
import { enqueueJobMessage } from "@/lib/jobs/queue";
import { getJob, markQueuedStage } from "@/lib/jobs/store";
import { getCtx } from "@/lib/session";

/**
 * Creator-scoped, idempotent nudge for a queued durable job. The browser can
 * ask for another wake-up, but it cannot execute work or access credentials.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await context.params;
  const job = await getJob(ctx.organizationId, ctx.userId, id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (job.status !== "queued") {
    return NextResponse.json({ accepted: false, status: job.status });
  }

  await markQueuedStage(job.id, "recovery-started");
  const dispatch = await enqueueJobMessage({ jobId: job.id, kind: job.kind });
  return NextResponse.json({ accepted: true, dispatchState: dispatch.state });
}
