import { z } from "zod";
import { demoCallFromRequest } from "@/lib/demo/call-token";
import { CHECK_EMAIL_TOOL, executeDemoTool } from "@/lib/demo/demo-tools";
import { runCheckEmail } from "@/lib/demo/inbox";
import { loadLiveTestTag } from "@/lib/demo/test-tag-registry";

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
  // The inbox check is server-only (Gmail + Jev), so it is dispatched here,
  // not in the browser-safe executor. The call component also polls it.
  const result =
    name === CHECK_EMAIL_TOOL
      ? await runCheckEmail(call, parsed.data.arguments)
      : await executeDemoTool(name, parsed.data.arguments, {
          testTag: call.tagId ? (await loadLiveTestTag(call.tagId))?.tag : null,
        });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
