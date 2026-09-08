import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { jobKindSchema } from "@/lib/jobs/kinds";
import { jobToJson } from "@/lib/jobs/serialize";
import { JobStartError, startJob } from "@/lib/jobs/start";
import { listJobs } from "@/lib/jobs/store";

/** Start a job. Returns 202 Accepted as soon as the work is durable. */
export async function POST(request: Request) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const envelope = body as {
    kind?: unknown;
    input?: unknown;
    title?: unknown;
    idempotencyKey?: unknown;
    relatedId?: unknown;
  };
  const kind = jobKindSchema.safeParse(envelope.kind);
  if (!kind.success) {
    return NextResponse.json({ error: "Unknown job kind." }, { status: 400 });
  }

  try {
    const { job, created } = await startJob(ctx, kind.data, envelope.input, {
      title: typeof envelope.title === "string" ? envelope.title : undefined,
      idempotencyKey:
        typeof envelope.idempotencyKey === "string" ? envelope.idempotencyKey : undefined,
      relatedId: typeof envelope.relatedId === "string" ? envelope.relatedId : undefined,
    });
    return NextResponse.json(
      { jobId: job.id, status: job.status, targetUrl: job.targetUrl, created, job: jobToJson(job) },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof JobStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** List the creator's jobs, newest first (dismissed hidden). */
export async function GET() {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const jobs = await listJobs(ctx.organizationId, ctx.userId);
  return NextResponse.json({ jobs: jobs.map(jobToJson) });
}
