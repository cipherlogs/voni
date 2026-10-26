import type { AgentConfig } from "./config";

/**
 * Ticket 06 seam: the AgentDetail server-to-client boundary. The detail leaf
 * resolves the row plus live generation/bridge/channel state server-side and
 * projects exactly the fields the client editor renders — a future column can
 * never leak across silently. Pure (no db/next imports) so the unit gate
 * asserts same-data/smaller-payload on real values.
 */

/** Everything AgentDetail resolves before projecting to the client. */
export type AgentDetailInput = {
  id: string;
  name: string;
  config: AgentConfig;
  deploymentStatus: string;
  deploymentError: string | null;
  assemblyaiAgentId: string | null;
  generationJobId: string | null;
  generationStatus: string | null;
  generationError: string | null;
  isBridgeAgent: boolean;
  phoneReady: boolean | null;
  whatsappReady: boolean | null;
  initialDeploymentAttention: boolean;
};

/** Exactly the props the client EditAgent renders — no row extras. */
export type EditAgentProps = AgentDetailInput & {
  /** A draft row still carrying its generation job id holds a placeholder
   * config until the reviewed save upgrades it in place. */
  isGenerationStub: boolean;
};

export function toEditAgentProps(input: AgentDetailInput): EditAgentProps {
  // Explicit picks, never a spread: extra row columns (organizationId,
  // timestamps, version counters) stay server-side even if the caller passes
  // a wider object.
  return {
    id: input.id,
    name: input.name,
    config: input.config,
    initialDeploymentAttention: input.initialDeploymentAttention,
    deploymentStatus: input.deploymentStatus,
    deploymentError: input.deploymentError,
    assemblyaiAgentId: input.assemblyaiAgentId,
    generationJobId: input.generationJobId,
    generationStatus: input.generationStatus,
    generationError: input.generationError,
    isGenerationStub:
      input.deploymentStatus === "draft" && input.generationJobId !== null,
    isBridgeAgent: input.isBridgeAgent,
    phoneReady: input.phoneReady,
    whatsappReady: input.whatsappReady,
  };
}
