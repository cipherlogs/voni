import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { jobToJson } from "@/lib/jobs/serialize";
import { getJobByIdempotencyKey } from "@/lib/jobs/store";

/**
 * Creator-scoped idempotency lookup. The voice copilot calls this after an
 * uncertain submission (request sent, outcome unknown): a found row is
 * adopted, so reconciliation resubmits the same key instead of duplicating
 * work. A client-supplied key alone grants nothing beyond the caller's own
 * jobs — scoping matches the insert conflict target exactly.
 */
export async function GET(request: Request) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const key = new URL(request.url).searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "Missing key parameter." }, { status: 400 });
  }
  const job = await getJobByIdempotencyKey(ctx.organizationId, ctx.userId, key);
  if (!job) {
    return NextResponse.json({ error: "No job with that key." }, { status: 404 });
  }
  return NextResponse.json({ job: jobToJson(job) });
}
