import { after } from "next/server";
import { CHECK_CODE_TOOL, CHECK_EMAIL_TOOL, SEND_CODE_REPLY_TOOL, WEBSITE_POLL, executeDemoTool, withCodeVerified } from "@/lib/demo/demo-tools";
import { runCheckEmail } from "@/lib/demo/inbox";
import { runCheckCode, runSendReply } from "@/lib/demo/reply";
import { loadLiveTestTag } from "@/lib/demo/test-tag-registry";
import { demoCallById, demoCallCodeVerified } from "@/lib/demo/tool-call";
import { resolveDemoToolCall } from "@/lib/demo/tool-credential";
import { websiteReadyInstructions } from "@/lib/demo/voni-agent";
import { runWebsiteRead } from "@/lib/demo/website-read";

/**
 * Public demo tools, scoped to one call. Two credentials name the call: the
 * browser's `callToken` (minted with the session), and the pipeline's shared
 * tool secret with the demo call id in the tool context. Both resolve to the
 * same `DemoCall`, so these tools cannot be driven outside a live demo call.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/demo/tools/[name]">,
) {
  const auth = await resolveDemoToolCall(request, demoCallById);
  if (!auth.ok) {
    return Response.json({ ok: false, error: auth.error, retryable: false }, { status: auth.status });
  }
  const { call, args } = auth;
  const { name } = await context.params;
  // The inbox check, the reply and the code check are server-only (Gmail,
  // Jev, the call's row), so they are dispatched here, not in the
  // browser-safe executor. The call component also polls the inbox check.
  if (name === WEBSITE_POLL) {
    // The call's poll once their email is found (not a model tool): it runs the read.
    const tag = call.tagId ? await loadLiveTestTag(call.tagId) : null;
    const site = tag?.matchedFrom ? await runWebsiteRead(call, tag.matchedFrom, after) : null;
    const data = !site || site.status === "reading" ? { status: site?.status ?? "none" } : { status: site.status, instructions: websiteReadyInstructions(site) };
    return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  }
  let result =
    name === CHECK_EMAIL_TOOL
      ? await runCheckEmail(call, args)
      : name === SEND_CODE_REPLY_TOOL
        ? await runSendReply(call, args)
        : name === CHECK_CODE_TOOL
          ? await runCheckCode(call, args)
          : await executeDemoTool(name, args, {
              testTag: call.tagId ? (await loadLiveTestTag(call.tagId))?.tag : null,
            });
  // The pipeline owns `check_code`; the browser's poll is how the visible
  // verified state rises. Only the check_email response carries the fact.
  if (name === CHECK_EMAIL_TOOL) {
    result = withCodeVerified(result, await demoCallCodeVerified(call.callId));
  }
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
