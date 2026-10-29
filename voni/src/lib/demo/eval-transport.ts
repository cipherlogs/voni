import type { SessionConfig, TokenFetcher } from "@/lib/voice/session";
import type { ToolResponse } from "@/lib/tools/execute";
import { END_CALL_TOOL } from "@/lib/tools/definitions";
import {
  CHECK_CODE_TOOL,
  CHECK_EMAIL_TOOL,
  executeDemoTool,
  SEND_CODE_REPLY_TOOL,
  SHOW_TEST_ADDRESS_TOOL,
} from "./demo-tools";

/**
 * Pure pieces of the live eval's transport switch
 * (`scripts/eval-demo-agent.mts`), so the connect payload, tool routing and
 * summary identity are unit-testable without audio, a socket, or a database.
 *
 * ── Why the eval binds the stored agent ───────────────────────────────────
 * The landing demo is a stored agent (`{ agent_id }`): the prompt, tools and
 * tuning live server-side. The eval used to send its own inline copy of the
 * body, which meant it measured a *reconstruction* of the demo, not the demo:
 * a stale stored prompt, a different tool surface, or an LLM override could
 * all pass the eval and still ship broken. `stored` (the default for live
 * runs) binds the exact agent a visitor gets, so reply-gap and behavior
 * evidence describes the real call. `inline` stays for debugging and for
 * running without DB access.
 */

export type EvalTransport = "stored" | "inline";

export const EVAL_TRANSPORTS: readonly EvalTransport[] = ["stored", "inline"];

/** `--transport stored|inline`, defaulting to the real demo path. */
export function parseEvalTransport(argv: readonly string[]): EvalTransport {
  const index = argv.indexOf("--transport");
  if (index < 0) return "stored";
  const value = argv[index + 1];
  if (value === "stored" || value === "inline") return value;
  throw new Error(
    `--transport needs stored or inline, got "${value ?? ""}"`,
  );
}

/** What the summary reports about the agent a run actually bound. */
export type EvalAgentIdentity = {
  agentId: string;
  fingerprint: string;
  /** Override model, or null for the managed default. */
  llmModel: string | null;
};

/**
 * The connect shape for a stored-agent eval call: the binding plus the two
 * shims `start()` installs for the browser. `boundAgent` is what makes the
 * session push the post-ready recognition preset; `tokenFetcher` is what lets
 * a dropped call resume instead of parking in `reconnecting` forever.
 */
export function storedAgentBinding(
  agentId: string,
  fetchToken: () => Promise<string>,
): {
  config: Extract<SessionConfig, { mode: "agent" }>;
  boundAgent: true;
  tokenFetcher: TokenFetcher;
} {
  return {
    config: { mode: "agent", agentId },
    boundAgent: true,
    tokenFetcher: async () => ({ token: await fetchToken(), agentId }),
  };
}

export type EvalToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** Tools the demo route dispatches server-side (Gmail, the call row, codes). */
const ROUTE_ONLY_TOOLS = new Set<string>([SEND_CODE_REPLY_TOOL, CHECK_CODE_TOOL]);

/**
 * Answer every tool the stored demo agent carries, for an eval call.
 *
 * A bound agent's tool surface is server-owned, so leaving any call unanswered
 * stalls that turn until the tool's 30s timeout (and the model then improvises
 * — measured live). `end_call`, `show_test_address` and `check_email` run for
 * real here. `send_code_reply` and `check_code` need the call's inbox thread
 * and code row, which the eval does not create, so they get an explicit,
 * non-retryable "not on this call" answer (the model moves on instead of the
 * turn stalling) and the runner is told so it can say so loudly.
 *
 * Anything else is a harness break: the agent called a tool this eval cannot
 * answer, so the evidence would be fiction. The coordinator turns the throw
 * into an error result (no stall); the runner records the name and aborts.
 */
export function evalToolExecutor(deps: {
  checkEmail: (args: Record<string, unknown>) => Promise<ToolResponse>;
  testTag?: string | null;
  onRouteOnlyTool?: (name: string) => void;
}) {
  return async (call: EvalToolCall): Promise<ToolResponse> => {
    if (call.name === CHECK_EMAIL_TOOL) return deps.checkEmail(call.arguments);
    if (ROUTE_ONLY_TOOLS.has(call.name)) {
      deps.onRouteOnlyTool?.(call.name);
      return {
        ok: false,
        error: `${call.name} needs the call's inbox thread, which this eval call does not have. Carry on without it.`,
        retryable: false,
      };
    }
    if (call.name === END_CALL_TOOL || call.name === SHOW_TEST_ADDRESS_TOOL) {
      return executeDemoTool(call.name, call.arguments, { testTag: deps.testTag });
    }
    throw new Error(`Unhandled demo tool in the eval: ${call.name}`);
  };
}

/**
 * The identity fields `EVAL SUMMARY` carries. `llmModel` is the literal
 * `"managed"` when there is no override (or no stored agent at all), so a
 * scoreboard can always say which model produced the reply gaps.
 */
export function evalSummaryIdentity(
  transport: EvalTransport,
  agent: EvalAgentIdentity | null,
): {
  transport: EvalTransport;
  agentId: string | null;
  agentFingerprint: string | null;
  llmModel: string;
} {
  return {
    transport,
    agentId: agent?.agentId ?? null,
    agentFingerprint: agent?.fingerprint ?? null,
    llmModel: agent?.llmModel ?? "managed",
  };
}
