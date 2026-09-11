import { Suspense } from "react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { notFound } from "next/navigation";
import { getAgentWithGeneration } from "../actions";
import { EditAgent } from "./edit-agent";
import { BackLink } from "@/components/back-link";
import { DetailSkeleton } from "@/components/page-skeletons";
import type { AgentConfig } from "@/lib/agents/config";

/**
 * Authorized detail leaf: params, query, record, and the data-derived brief
 * resolve here. Missing/denied records keep notFound() inside this leaf.
 */
async function AgentDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // params is a Promise in this Next version — see voni/AGENTS.md.
  const { id } = await params;
  const query = await searchParams;
  const result = await getAgentWithGeneration(id);
  if (!result) notFound();
  const { agent, generationStatus, generationError } = result;

  // A draft row still carrying its generation job id holds a placeholder
  // config until the reviewed save upgrades it in place.
  const isGenerationStub =
    agent.deploymentStatus === "draft" && agent.generationJobId !== null;
  const generationNote =
    agent.generationJobId !== null
      ? ` Generation ${generationStatus ?? "unknown"}.`
      : "";

  return (
    <>
      <RouteBrief route={`/agents/${id}`} brief={`Agent ${agent.name}. Deployment ${agent.deploymentStatus}.${generationNote} Configuration version ${agent.configVersion}. Edit configuration or test this agent.`} />
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
        assemblyaiAgentId={agent.assemblyaiAgentId}
        generationJobId={agent.generationJobId}
        generationStatus={generationStatus}
        generationError={generationError}
        isGenerationStub={isGenerationStub}
      />
    </>
  );
}

export default function AgentPage({
  params,
  searchParams,
}: PageProps<"/agents/[id]">) {
  return (
    <div data-testid="agent-shell" className="flex flex-col gap-6">
      <BackLink href="/agents" label="Agents" />
      {/* Generic detail frame: no invented record title — the resolved leaf
          renders the real agent name as the heading. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading agent">
            <DetailSkeleton />
          </div>
        }
      >
        <AgentDetail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
