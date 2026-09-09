import { NextResponse } from "next/server";
import { sweepJobs } from "@/lib/jobs/sweep";
import { requireWorkerSecret } from "@/lib/jobs/worker-auth";

/** Worker-only entry for the one-minute scheduled recovery sweep. */
export async function POST(request: Request) {
  const denied = await requireWorkerSecret(request);
  if (denied) return denied;

  const summary = await sweepJobs();
  return NextResponse.json(summary);
}
