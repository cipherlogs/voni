import { z } from "zod";
import { secret } from "@/lib/env";
import { getCtx } from "@/lib/session";
import {
  executeTool,
  resolveCallContext,
  resolveTestContext,
} from "@/lib/tools/execute";

const requestSchema = z.object({
  toolCallId: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
  context: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("call"), callId: z.string().uuid() }),
    z.object({ kind: z.literal("test"), agentId: z.string().uuid() }),
  ]),
});

function jsonError(error: string, status: number) {
  return Response.json({ ok: false, error, retryable: false }, { status });
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/tools/[name]">,
) {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return jsonError("Invalid tool request.", 400);

  const { name } = await context.params;
  const payload = parsed.data;

  if (payload.context.kind === "call") {
    const expected = await secret("VONI_TOOL_SECRET");
    const authorization = request.headers.get("authorization");
    if (!expected || authorization !== `Bearer ${expected}`) {
      return jsonError("Unauthorized.", 401);
    }
    const resolved = await resolveCallContext(payload.context.callId);
    if (!resolved) return jsonError("Call not found.", 404);
    return Response.json(
      await executeTool(name, payload.arguments, resolved, payload.toolCallId),
    );
  }

  const session = await getCtx();
  if (!session) return jsonError("Sign in again to test tools.", 401);
  const resolved = await resolveTestContext(
    payload.context.agentId,
    session.organizationId,
  );
  if (!resolved) return jsonError("Agent not found.", 404);

  return Response.json(
    await executeTool(
      name,
      payload.arguments,
      resolved,
      payload.toolCallId,
    ),
  );
}
