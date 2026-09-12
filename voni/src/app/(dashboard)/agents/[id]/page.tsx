import { Suspense } from "react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { notFound } from "next/navigation";
import { getAgentWithGeneration } from "../actions";
import { EditAgent } from "./edit-agent";
import { DetailSkeleton } from "@/components/page-skeletons";
import { agentConfigSchema, normalizeConfig } from "@/lib/agents/config";
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

  // Parse rather than cast: stored rows predate the current schema (notably
  // `knowledge`, once a string[]), and the schema's coercions only run on a
  // parse. A cast would hand the form a legacy array, which React then renders
  // comma-joined into the textarea. Genuinely unparseable rows fall back to the
  // raw value so the editor still opens instead of crashing the route.
  const parsedConfig = agentConfigSchema.safeParse(agent.config);
  const storedConfig = parsedConfig.success
    ? normalizeConfig(parsedConfig.data)
    : (agent.config as AgentConfig);

  return (
    <>
      <RouteBrief route={`/agents/${id}`} brief={`Agent ${agent.name}. Deployment ${agent.deploymentStatus}.${generationNote} Configuration version ${agent.configVersion}. Edit configuration or test this agent.`} />
      <EditAgent
        id={agent.id}
        name={agent.name}
        config={storedConfig}
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
      {/* Generic detail frame: no invented record title — the resolved leaf
          renders backlink, heading, and sub inside the config column. */}
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
