import { z } from "zod";
import { demoCallFromRequest } from "@/lib/demo/call-token";
import { executeDemoTool } from "@/lib/demo/demo-tools";

/**
 * Public demo tools, scoped to one call: the bearer is the `callToken` that
 * `/api/demo/token` minted with the session, so these tools cannot be driven
 * outside a live demo call.
 */
const requestSchema = z.object({
  toolCallId: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
});

export async function POST(
  request: Request,
  context: RouteContext<"/api/demo/tools/[name]">,
) {
  const call = await demoCallFromRequest(request);
  if (!call) {
    return Response.json({ ok: false, error: "Unauthorized.", retryable: false }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid tool request.", retryable: false }, { status: 400 });
  }
  const { name } = await context.params;
  return Response.json(await executeDemoTool(name, parsed.data.arguments), {
    headers: { "Cache-Control": "no-store" },
  });
}
