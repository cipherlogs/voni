import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, phoneNumbers } from "@/lib/db/schema";
import { authorizeBridge, bridgeError } from "@/lib/campaigns/bridge-auth";
import { getPlatformConfig } from "@/lib/platform/config";

/**
 * "Someone dialled this number — which agent answers?" (plan Day 7-8, inbound
 * number binding).
 *
 * Before this, every inbound call was answered by the one agent selected in
 * the operator area, so a workspace can run exactly one inbound persona.
 * A binding lets a number route to its own agent, and anything unbound still
 * falls back to that platform default rather than dropping the call — an
 * unrecognised number ringing out is a far worse failure than answering it with
 * the general agent.
 *
 * Lookups are scoped to the bridge's configured workspace. `phone_numbers.e164`
 * is globally unique, so without that scope a number registered by another
 * tenant would route their caller into this bridge's organization.
 */
export async function GET(request: Request) {
  const auth = await authorizeBridge(request);
  if (!auth.ok) return bridgeError(auth.status, auth.error);

  const to = new URL(request.url).searchParams.get("to")?.trim();
  if (!to) return bridgeError(400, "Missing the dialled number.");

  const [binding] = await db
    .select({
      agentId: agents.id,
      assemblyaiAgentId: agents.assemblyaiAgentId,
      label: phoneNumbers.label,
      enabled: phoneNumbers.inboundEnabled,
    })
    .from(phoneNumbers)
    .innerJoin(agents, eq(agents.id, phoneNumbers.agentId))
    .where(
      and(
        eq(phoneNumbers.e164, to),
        eq(phoneNumbers.organizationId, auth.organizationId),
      ),
    )
    .limit(1);

  if (binding?.enabled && binding.assemblyaiAgentId) {
    return Response.json(
      {
        ok: true,
        source: "binding",
        agentId: binding.agentId,
        assemblyaiAgentId: binding.assemblyaiAgentId,
        label: binding.label,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const config = await getPlatformConfig();
  if (!config.bridgeAgentId) {
    return bridgeError(503, "No agent is bound to this number and no default is set.");
  }
  const [fallback] = await db
    .select({ id: agents.id, remote: agents.assemblyaiAgentId })
    .from(agents)
    .where(
      and(
        eq(agents.id, config.bridgeAgentId),
        eq(agents.organizationId, auth.organizationId),
      ),
    )
    .limit(1);
  if (!fallback?.remote) return bridgeError(503, "The default agent is not deployed.");

  return Response.json(
    {
      ok: true,
      // The bridge logs this, so an operator can tell "my binding worked" from
      // "my binding was ignored and you got the default".
      source: binding ? "default (binding is disabled or undeployed)" : "default",
      agentId: fallback.id,
      assemblyaiAgentId: fallback.remote,
      label: null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
