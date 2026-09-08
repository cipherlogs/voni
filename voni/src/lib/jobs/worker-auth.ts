import { NextResponse } from "next/server";
import { secret } from "@/lib/env";

/**
 * Guard for worker-only internal routes (/api/internal/jobs/*).
 *
 * The custom worker re-dispatches queue and scheduled work through these
 * routes so all job code executes inside the patched OpenNext server (which
 * resolves @/ aliases, next/cache, and the AI SDK correctly) rather than in
 * a second hand-bundled copy. Both sides read the same JOB_WORKER_SECRET
 * from the worker environment, so they always agree.
 */
export async function requireWorkerSecret(
  request: Request,
): Promise<NextResponse | null> {
  const expected = await secret("JOB_WORKER_SECRET");
  const provided = request.headers.get("x-voni-worker-secret");
  if (!expected || !provided || provided !== expected) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return null;
}
