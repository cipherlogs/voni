import { RouteBrief } from "@/components/copilot/route-brief";
import { notFound } from "next/navigation";
import { getAgent } from "../actions";
import { EditAgent } from "./edit-agent";
import { BackLink } from "@/components/back-link";
import type { AgentConfig } from "@/lib/agents/config";

export default async function AgentPage({
  params,
  searchParams,
}: PageProps<"/agents/[id]">) {
  // params is a Promise in this Next version — see voni/AGENTS.md.
  const { id } = await params;
  const query = await searchParams;
  const agent = await getAgent(id);
  if (!agent) notFound();

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route={`/agents/${id}`} brief={`Agent ${agent.name}. Deployment ${agent.deploymentStatus}. Configuration version ${agent.configVersion}. Edit configuration or test this agent.`} />
      <BackLink href="/agents" label="Agents" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        <p className="text-muted-foreground text-sm">
          Changes take effect on the next call this agent takes.
        </p>
      </div>
      <EditAgent
        id={agent.id}
        name={agent.name}
        config={agent.config as AgentConfig}
        initialDeploymentAttention={query.deployment === "attention"}
        deploymentStatus={agent.deploymentStatus}
        deploymentError={agent.deploymentError}
      />
    </div>
  );
}
