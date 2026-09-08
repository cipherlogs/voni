import { z } from "zod";
import { authorizeBridge, bridgeError } from "@/lib/campaigns/bridge-auth";
import {
  DIAL_OUTCOMES,
  recordDialOutcome,
  releaseDialClaim,
} from "@/lib/campaigns/dispatch";

const schema = z.object({
  campaignLeadId: z.string().uuid(),
  outcome: z.enum(DIAL_OUTCOMES),
  /** The `calls` row the bridge opened for this dial, when it got that far. */
  callId: z.string().uuid().nullish(),
});

/**
 * "Here is how that dial ended." Closes the loop the dispatcher opened.
 *
 * `cancelled` is the one outcome that does not consume an attempt: it means the
 * dial never reached the carrier — the runner was stopped, or Telnyx rejected
 * the request — and charging someone an attempt for our own failure would
 * quietly exhaust a lead who was never actually phoned.
 */
export async function POST(request: Request) {
  const auth = await authorizeBridge(request);
  if (!auth.ok) return bridgeError(auth.status, auth.error);

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bridgeError(400, "Invalid outcome report.");
  const { campaignLeadId, outcome, callId } = parsed.data;

  if (outcome === "cancelled") {
    await releaseDialClaim(auth.organizationId, campaignLeadId, "dial cancelled");
    return Response.json(
      { ok: true, status: "queued" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await recordDialOutcome(
    auth.organizationId,
    campaignLeadId,
    outcome,
    callId ?? null,
  );
  if (!result.ok) return bridgeError(404, result.message ?? "Not found.");

  return Response.json(
    { ok: true, status: result.status },
    { headers: { "Cache-Control": "no-store" } },
  );
}
