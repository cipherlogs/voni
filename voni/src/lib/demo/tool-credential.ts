import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { secret } from "@/lib/env";
import { demoCallFromRequest, type DemoCall } from "./call-token";

/**
 * The two credentials the call-scoped demo tool route accepts.
 *
 * A browser sends the demo call token it minted with the call; the cascade
 * pipeline sends the shared tool secret plus the call id in the tool context
 * (`voice-pipeline/cascade/tools.py`, `ToolRequest.body`). Both resolve to the
 * same `DemoCall`, so every handler below the resolver is one code path.
 *
 * The lookup is injected: production reads the demo_calls table, tests pass a
 * function, and no tenant call can resolve because only demo rows are read.
 */
export type DemoCallLookup = (callId: string) => Promise<DemoCall | null>;

export type DemoToolCredential = "browser" | "service";

export type DemoToolCall =
  | {
      ok: true;
      credential: DemoToolCredential;
      call: DemoCall;
      /** The model's tool id: the route's idempotency key and the log's key. */
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | { ok: false; status: 400 | 401 | 404; error: string };

/** The browser's body: the call token already names the call. */
const browserRequestSchema = z.object({
  toolCallId: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
});

/** The service's body: exactly `ToolRequest.body()` — tool id, arguments, call context. */
const serviceRequestSchema = browserRequestSchema.extend({
  context: z.object({
    kind: z.literal("call"),
    callId: z.string().uuid(),
  }),
});

/** Constant-time bearer check, so a wrong secret cannot be probed by timing. */
function bearerMatches(authorization: string | null, expected: string | undefined): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export async function resolveDemoToolCall(
  request: Request,
  lookup: DemoCallLookup,
): Promise<DemoToolCall> {
  const authorization = request.headers.get("authorization");

  if (bearerMatches(authorization, await secret("VONI_TOOL_SECRET"))) {
    const parsed = serviceRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return { ok: false, status: 400, error: "Invalid tool request." };
    const call = await lookup(parsed.data.context.callId);
    if (!call) return { ok: false, status: 404, error: "Call not found." };
    return {
      ok: true,
      credential: "service",
      call,
      toolCallId: parsed.data.toolCallId,
      args: parsed.data.arguments,
    };
  }

  // Unchanged browser path: the bearer is the call token, then the same body.
  const call = await demoCallFromRequest(request);
  if (!call) return { ok: false, status: 401, error: "Unauthorized." };
  const parsed = browserRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return { ok: false, status: 400, error: "Invalid tool request." };
  return {
    ok: true,
    credential: "browser",
    call,
    toolCallId: parsed.data.toolCallId,
    args: parsed.data.arguments,
  };
}
