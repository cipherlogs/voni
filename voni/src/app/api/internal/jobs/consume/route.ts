import { NextResponse } from "next/server";
import { consumeMessage } from "@/lib/jobs/consumer";
import { requireWorkerSecret } from "@/lib/jobs/worker-auth";

/**
 * Worker-only entry for one queue message. The queue consumer in worker.ts
 * re-dispatches here instead of importing job code into a second bundle.
 * Non-2xx propagates to the infrastructure retry, then the dead-letter
 * queue; job-domain outcomes (including recorded failures) return 200 with
 * the outcome because the row already owns them.
 */
export async function POST(request: Request) {
  const denied = await requireWorkerSecret(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const outcome = await consumeMessage((body as { message?: unknown }).message);
  return NextResponse.json({ outcome });
}
