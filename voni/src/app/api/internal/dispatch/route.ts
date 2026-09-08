import { authorizeBridge, bridgeError } from "@/lib/campaigns/bridge-auth";
import { nextDialTarget, requeueStaleClaims } from "@/lib/campaigns/dispatch";

/**
 * "Who should I dial next?" — asked by the bridge's campaign runner.
 *
 * POST rather than GET because the `claim` mode mutates: it takes a lead out of
 * the queue and consumes an attempt. `preview` is the default precisely so that
 * a runner started without `--live` cannot change anything, however it is
 * configured.
 */
export async function POST(request: Request) {
  const auth = await authorizeBridge(request);
  if (!auth.ok) return bridgeError(auth.status, auth.error);

  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
  // Anything that is not exactly "claim" previews. An unrecognised mode must
  // fall to the side that places no calls.
  const mode = body.mode === "claim" ? "claim" : "preview";

  // Cheap, and it means a runner that was killed mid-dial recovers on its next
  // poll instead of leaving rows stuck in `dialing` that look like an empty queue.
  const requeued = await requeueStaleClaims(auth.organizationId);

  const decision = await nextDialTarget(auth.organizationId, mode);

  return Response.json(
    decision.status === "dial"
      ? { ok: true, mode, requeued, ...decision }
      : { ok: true, mode, requeued, status: "idle", reason: decision.reason },
    { headers: { "Cache-Control": "no-store" } },
  );
}
