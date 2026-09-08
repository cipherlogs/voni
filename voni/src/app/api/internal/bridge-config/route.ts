import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, organizationSettings } from "@/lib/db/schema";
import { secret } from "@/lib/env";
import { getPlatformConfig } from "@/lib/platform/config";
import { resolveCredential } from "@/lib/platform/credentials";

function failure(status: number, error: string) {
  return Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const expected = await secret("VONI_TOOL_SECRET");
  const supplied = request.headers.get("authorization");
  if (!expected || supplied !== `Bearer ${expected}`) {
    return failure(401, "Unauthorized.");
  }
  if (
    process.env.NODE_ENV === "production" &&
    new URL(request.url).protocol !== "https:" &&
    request.headers.get("x-forwarded-proto") !== "https"
  ) {
    return failure(400, "HTTPS is required.");
  }

  const config = await getPlatformConfig();
  const [assemblyai, telnyx] = await Promise.all([
    resolveCredential("assemblyai_api_key"),
    resolveCredential("telnyx_api_key"),
  ]);
  const missing: string[] = [];
  if (!assemblyai.value) missing.push("AssemblyAI credential");
  if (!telnyx.value) missing.push("Telnyx credential");
  if (!config.telnyxConnectionId) missing.push("Telnyx connection");
  if (!config.telnyxCallerNumber) missing.push("caller number");
  if (!config.bridgeOrganizationId) missing.push("bridge workspace");
  if (!config.bridgeAgentId) missing.push("bridge agent");
  if (missing.length) return failure(503, `Bridge setup is incomplete: ${missing.join(", ")}.`);

  const [[agent], [workspaceSettings]] = await Promise.all([
    db
      .select({ id: agents.id, assemblyaiAgentId: agents.assemblyaiAgentId })
      .from(agents)
      .where(
        and(
          eq(agents.id, config.bridgeAgentId!),
          eq(agents.organizationId, config.bridgeOrganizationId!),
        ),
      )
      .limit(1),
    db
      .select({ humanTransferNumber: organizationSettings.humanTransferNumber })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, config.bridgeOrganizationId!))
      .limit(1),
  ]);
  if (!agent?.assemblyaiAgentId) return failure(503, "The selected bridge agent is not deployed.");

  return Response.json(
    {
      ok: true,
      credentials: {
        assemblyaiApiKey: assemblyai.value,
        telnyxApiKey: telnyx.value,
      },
      defaults: {
        organizationId: config.bridgeOrganizationId,
        agentId: agent.id,
        assemblyaiAgentId: agent.assemblyaiAgentId,
        telnyxConnectionId: config.telnyxConnectionId,
        callerNumber: config.telnyxCallerNumber,
        humanTransferConfigured: Boolean(workspaceSettings?.humanTransferNumber),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
