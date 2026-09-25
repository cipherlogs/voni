import { buildEndCallSuccess, END_CALL_TOOL, validateToolArguments } from "@/lib/tools/definitions";
import type { ToolResponse } from "@/lib/tools/execute";

/**
 * The demo agent's tools, run server-side for one verified demo call (the
 * route checks the call token first). Every tool on the stored demo agent
 * body (stored-agents.ts) needs a case here.
 */
export async function executeDemoTool(name: string, rawArguments: unknown): Promise<ToolResponse> {
  if (name !== END_CALL_TOOL) {
    return { ok: false, error: "Unknown tool.", retryable: false };
  }
  const parsed = validateToolArguments(name, rawArguments);
  if (!parsed.ok) {
    return { ok: false, error: "Say the closing line first, then end the call.", retryable: true };
  }
  return buildEndCallSuccess(false);
}
