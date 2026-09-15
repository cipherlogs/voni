/**
 * Connected-provider tool catalog — the picker source for GOAL 4B.
 *
 * Pure data + pure lookups. NO persistence here: picker selections live in
 * `AgentConfig.tools` as namespaced keys (`"<provider>.<tool>"`, e.g.
 * `"gmail.send_email"`) and round-trip through the existing JSON config
 * storage untouched — `agentConfigSchema.tools` is a plain string array, so
 * no column migration and no schema change.
 *
 * Two follow-ups live outside this file and are NOT handled here:
 * - `normalizeConfig` (src/lib/agents/config.ts) drops tool names outside
 *   TOOL_REGISTRY on save, so provider picks survive reload via the editor's
 *   durable draft but need the schema owner to teach the normalizer (and the
 *   voice-tool compiler) the `"<provider>.<tool>"` namespace before they
 *   survive a save and reach a call.
 * - Brand icons arrive later via react-icons; rows stay lucide-neutral here.
 *
 * To extend: add a ProviderMeta entry with an id, label, description, and
 * tools. Each tool carries an id (unique within its provider), a label, a
 * one-line description, and an optional overlapsWith list of namespaced keys
 * of tools that achieve the same thing — the picker renders those as a
 * "pick one" hint.
 */

export type ProviderId = "gmail" | "zoho" | "google-docs";

export interface ToolMeta {
  /** Short id, unique within its provider (e.g. "send_email"). */
  id: string;
  label: string;
  description: string;
  /**
   * Namespaced keys (`"<provider>.<tool>"`) of catalog tools that achieve
   * the same thing. The picker renders these as an "X and Y achieve the
   * same thing — pick one" hint so the agent is not given two tools for
   * one job.
   */
  overlapsWith?: string[];
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  description: string;
  tools: ToolMeta[];
}

export const PROVIDER_CATALOG: ProviderMeta[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Send and search email on the lead's thread.",
    tools: [
      {
        id: "send_email",
        label: "Send email",
        description: "Send a follow-up email to the lead.",
        overlapsWith: ["zoho.send_email"],
      },
      {
        id: "search_email",
        label: "Search email",
        description: "Find earlier email threads with the lead.",
        overlapsWith: ["zoho.search_email"],
      },
    ],
  },
  {
    id: "zoho",
    label: "Zoho CRM",
    description: "Log outcomes and work the Zoho lead record.",
    tools: [
      {
        id: "send_email",
        label: "Send email",
        description: "Send the follow-up through Zoho instead of Gmail.",
        overlapsWith: ["gmail.send_email"],
      },
      {
        id: "search_email",
        label: "Search email",
        description: "Find earlier Zoho email threads with the lead.",
        overlapsWith: ["gmail.search_email"],
      },
      {
        id: "log_call",
        label: "Log call",
        description: "Write the call outcome back to the Zoho lead record.",
      },
    ],
  },
  {
    id: "google-docs",
    label: "Google Docs",
    description: "Keep call notes in a shared document.",
    tools: [
      {
        id: "create_notes_doc",
        label: "Create notes doc",
        description: "Start a fresh call-notes document for the lead.",
      },
      {
        id: "append_note",
        label: "Append note",
        description: "Append the call summary to the lead's notes document.",
      },
    ],
  },
];

/** Namespaced key for a catalog tool, as stored in `AgentConfig.tools`. */
export function providerToolKey(providerId: string, toolId: string): string {
  return `${providerId}.${toolId}`;
}

export interface CatalogHit {
  provider: ProviderMeta;
  tool: ToolMeta;
}

/** Resolve a namespaced `"<provider>.<tool>"` key to its catalog entry. */
export function findCatalogTool(key: string): CatalogHit | null {
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const provider = PROVIDER_CATALOG.find((p) => p.id === key.slice(0, dot));
  const tool = provider?.tools.find((t) => t.id === key.slice(dot + 1));
  return provider && tool ? { provider, tool } : null;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Nearest catalog tool for a free-text name (e.g. a tool idea). Same
 * substring heuristic the form uses for built-ins, over tool id + label.
 */
export function matchCatalogTool(query: string): CatalogHit | null {
  const q = squash(query);
  if (!q) return null;
  for (const provider of PROVIDER_CATALOG) {
    for (const tool of provider.tools) {
      const id = squash(tool.id);
      const label = squash(tool.label);
      if (
        id === q ||
        label === q ||
        id.includes(q) ||
        q.includes(id) ||
        label.includes(q) ||
        q.includes(label)
      ) {
        return { provider, tool };
      }
    }
  }
  return null;
}

/**
 * Human-readable overlap targets for a tool ("Zoho Send email"), for the
 * picker's "X and Y achieve the same thing — pick one" hint. Unknown keys
 * pass through verbatim rather than dropping the hint.
 */
export function overlapLabels(tool: ToolMeta): string[] {
  return (tool.overlapsWith ?? []).map((key) => {
    const hit = findCatalogTool(key);
    return hit ? `${hit.provider.label} ${hit.tool.label}` : key;
  });
}
