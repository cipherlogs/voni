import { after } from "next/server";
import { z } from "zod";
import { demoCallFromRequest } from "@/lib/demo/call-token";
import { CHECK_CODE_TOOL, CHECK_EMAIL_TOOL, SEND_CODE_REPLY_TOOL, WEBSITE_POLL, executeDemoTool } from "@/lib/demo/demo-tools";
import { runCheckEmail } from "@/lib/demo/inbox";
import { runCheckCode, runSendReply } from "@/lib/demo/reply";
import { loadLiveTestTag } from "@/lib/demo/test-tag-registry";
import { websiteReadyInstructions } from "@/lib/demo/voni-agent";
import { runWebsiteRead } from "@/lib/demo/website-read";

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
  // The inbox check, the reply and the code check are server-only (Gmail,
  // Jev, the call's row), so they are dispatched here, not in the
  // browser-safe executor. The call component also polls the inbox check.
  const args = parsed.data.arguments;
  if (name === WEBSITE_POLL) {
    // The call's poll once their email is found (not a model tool): it runs the read.
    const tag = call.tagId ? await loadLiveTestTag(call.tagId) : null;
    const site = tag?.matchedFrom ? await runWebsiteRead(call, tag.matchedFrom, after) : null;
    const data = !site || site.status === "reading" ? { status: site?.status ?? "none" } : { status: site.status, instructions: websiteReadyInstructions(site) };
    return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  }
  const result =
    name === CHECK_EMAIL_TOOL
      ? await runCheckEmail(call, args)
      : name === SEND_CODE_REPLY_TOOL
        ? await runSendReply(call, args)
        : name === CHECK_CODE_TOOL
          ? await runCheckCode(call, args)
          : await executeDemoTool(name, args, {
              testTag: call.tagId ? (await loadLiveTestTag(call.tagId))?.tag : null,
            });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
