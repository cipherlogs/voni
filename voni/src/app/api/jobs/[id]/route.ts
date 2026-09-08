import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { enqueueJobMessage } from "@/lib/jobs/queue";
import { jobToJson } from "@/lib/jobs/serialize";
import {
  getJob,
  markDismissed,
  markSeen,
  requestCancel,
  retryJob,
} from "@/lib/jobs/store";

/** Read one job (creator-scoped). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await context.params;
  const job = await getJob(ctx.organizationId, ctx.userId, id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job: jobToJson(job) });
}

const ACTIONS = ["cancel", "retry", "seen", "dismiss"] as const;

/** Mutate one job: cancel | retry | seen | dismiss. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = (body as { action?: unknown }).action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if (action === "seen") {
    await markSeen(ctx.organizationId, ctx.userId, id);
  } else if (action === "dismiss") {
    await markDismissed(ctx.organizationId, ctx.userId, id);
  } else if (action === "cancel") {
    await requestCancel(ctx.organizationId, ctx.userId, id);
  } else {
    const retried = await retryJob(ctx.organizationId, ctx.userId, id);
    if (!retried) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }
    await enqueueJobMessage({ jobId: retried.id, kind: retried.kind });
  }

  const job = await getJob(ctx.organizationId, ctx.userId, id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job: jobToJson(job) });
}
