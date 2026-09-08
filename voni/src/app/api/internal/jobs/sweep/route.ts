import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sweepJobs } from "@/lib/jobs/sweep";
import { requireWorkerSecret } from "@/lib/jobs/worker-auth";

/** Worker-only entry for the 5-minute scheduled sweep (see worker.ts). */
export async function POST(request: Request) {
  const denied = await requireWorkerSecret(request);
  if (denied) return denied;

  const { env } = await getCloudflareContext({ async: true });
  const queue = (env as Record<string, unknown>).JOB_QUEUE as
    | { send: (message: unknown) => Promise<void> }
    | undefined;
  const summary = await sweepJobs(async (message) => {
    if (!queue) throw new Error("JOB_QUEUE binding is missing.");
    await queue.send(message);
  });
  return NextResponse.json(summary);
}
