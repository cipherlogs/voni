import type { SessionConfig, TokenFetcher } from "@/lib/voice/session";
import type { ToolResponse } from "@/lib/tools/execute";
import { END_CALL_TOOL } from "@/lib/tools/definitions";
import {
  DEMO_AGENT_VARIANTS,
  demoAgentStorageKey,
  resolveDemoAgentVariant,
  type DemoAgentVariant,
  type DemoTurnWindows,
} from "./stored-agents";
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

/**
 * The experimental variant a run binds, resolved from the `--variant` /
 * `--turn-windows` flags (explicit) or the `DEMO_AGENT_VARIANT` /
 * `DEMO_TURN_*` environment (the deployment's selection). `source` is
 * provenance for the artifact, not behaviour.
 */
export type EvalVariantSelection = {
  variant: DemoAgentVariant;
  /** The variant's own row key (`<voice>:exp`), or null for production. */
  variantKey: string | null;
  /** Configured windows the variant body carries; null for production. */
  turnWindows: DemoTurnWindows | null;
  source: "flag" | "env" | "default";
};

/** `--variant production|turn-window`, or null when the flag is absent. */
export function parseEvalVariantArg(argv: readonly string[]): DemoAgentVariant | null {
  const index = argv.indexOf("--variant");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "") {
    throw new Error(`--variant needs one of ${DEMO_AGENT_VARIANTS.join(", ")}, got ""`);
  }
  try {
    return resolveDemoAgentVariant(value);
  } catch {
    throw new Error(
      `--variant needs one of ${DEMO_AGENT_VARIANTS.join(", ")}, got "${value ?? ""}"`,
    );
  }
}

function windowPart(part: string, label: string): number | undefined {
  if (part === "" || part === "-") return undefined;
  if (!/^\d+$/.test(part)) {
    throw new Error(
      `--turn-windows ${label} needs a non-negative integer or "-" to omit, got "${part}"`,
    );
  }
  return Number(part);
}

/**
 * `--turn-windows min,max,interruption_delay` — the rung in one flag, so the
 * ladder never edits code. Any part may be `-`/empty: rung 3 is `-,-,0`
 * (`interruption_delay` alone, no silence pair).
 */
export function parseEvalTurnWindowsArg(argv: readonly string[]): DemoTurnWindows | null {
  const index = argv.indexOf("--turn-windows");
  if (index < 0) return null;
  const raw = argv[index + 1] ?? "";
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length !== 3) {
    throw new Error(
      `--turn-windows needs min,max,interruption_delay (use "-" to omit a part), got "${raw}"`,
    );
  }
  const minSilence = windowPart(parts[0], "min_silence");
  const maxSilence = windowPart(parts[1], "max_silence");
  const interruptionDelay = windowPart(parts[2], "interruption_delay");
  if ((minSilence === undefined) !== (maxSilence === undefined)) {
    throw new Error("--turn-windows needs both min_silence and max_silence, or neither");
  }
  if (minSilence !== undefined && maxSilence !== undefined && minSilence > maxSilence) {
    throw new Error(
      `--turn-windows min_silence (${minSilence}) must not exceed max_silence (${maxSilence})`,
    );
  }
  const windows: DemoTurnWindows = {
    ...(minSilence !== undefined ? { min_silence: minSilence } : {}),
    ...(maxSilence !== undefined ? { max_silence: maxSilence } : {}),
    ...(interruptionDelay !== undefined ? { interruption_delay: interruptionDelay } : {}),
  };
  if (Object.keys(windows).length === 0) {
    throw new Error("--turn-windows needs at least one window (min,max or interruption_delay)");
  }
  return windows;
}

/** One `--turn-windows` value: `-` marks an omitted part (rung 3). */
export function formatEvalTurnWindows(windows: DemoTurnWindows): string {
  const part = (value: number | undefined) => (value === undefined ? "-" : String(value));
  return `${part(windows.min_silence)},${part(windows.max_silence)},${part(windows.interruption_delay)}`;
}

/**
 * Resolve the agent a stored eval binds. Precedence: an explicit `--variant`
 * beats the environment; `--turn-windows` overrides the env windows; no
 * selection is production. Misconfiguration — a typo, windows without the
 * variant, or any variant on the inline debug transport — throws instead of
 * silently measuring production (or inline) under the experiment's name.
 */
export function resolveEvalVariantSelection(input: {
  argv: readonly string[];
  transport: EvalTransport;
  voiceId: string;
  envVariant: DemoAgentVariant;
  envWindows: DemoTurnWindows;
}): EvalVariantSelection {
  const flagVariant = parseEvalVariantArg(input.argv);
  const flagWindows = parseEvalTurnWindowsArg(input.argv);
  const variant = flagVariant ?? input.envVariant;

  if (input.transport === "inline" && (variant === "turn-window" || flagWindows !== null)) {
    throw new Error(
      "--transport inline is a debugging path and is never measured: " +
        "drop the variant selection or run --transport stored",
    );
  }
  if (flagWindows !== null && variant === "production") {
    throw new Error(
      "--turn-windows requires --variant turn-window (the production agent never carries turn windows)",
    );
  }

  const selected = variant !== "production";
  return {
    variant,
    variantKey: selected ? demoAgentStorageKey(input.voiceId, false, variant) : null,
    turnWindows: selected ? (flagWindows ?? input.envWindows) : null,
    source:
      flagVariant !== null
        ? "flag"
        : input.envVariant !== "production"
          ? "env"
          : "default",
  };
}

/**
 * The `npm run eval:demo-agent` argv `score-demo` spawns. Pure so the default
 * invocation is pinned byte-for-byte and each rung's flags are asserted
 * without spawning a live runner.
 */
export function evalRunnerArgv(input: {
  voice: string;
  scenario: string;
  runs: string;
  transport?: EvalTransport | null;
  variant?: DemoAgentVariant | null;
  turnWindows?: DemoTurnWindows | null;
  /** Opt-in JSONL event stream (ticket 01); absent writes no file. */
  eventsPath?: string | null;
}): string[] {
  const argv = [
    "run",
    "eval:demo-agent",
    "--",
    "--voice",
    input.voice,
    "--scenario",
    input.scenario,
    "--runs",
    input.runs,
  ];
  if (input.transport) argv.push("--transport", input.transport);
  // An explicit `production` is forwarded too: it must override a variant in
  // the child's environment. Absent (`null`/undefined) leaves the env alone.
  if (input.variant) argv.push("--variant", input.variant);
  if (input.turnWindows) argv.push("--turn-windows", formatEvalTurnWindows(input.turnWindows));
  if (input.eventsPath) argv.push("--events", input.eventsPath);
  return argv;
}

/** What the summary reports about the agent a run actually bound. */
export type EvalAgentIdentity = {
  agentId: string;
  fingerprint: string;
  /** Override model, or null for the managed default. */
  llmModel: string | null;
  /** Which stored body bound; absent on an inline/older run means production. */
  variant?: DemoAgentVariant;
  /** The variant's `demo_agents.voice_id` (`<voice>:exp`), null for production. */
  variantKey?: string | null;
  /** The windows the variant body was built from; null for production. */
  turnWindows?: DemoTurnWindows | null;
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
  selection: EvalVariantSelection | null = null,
): {
  transport: EvalTransport;
  agentId: string | null;
  agentFingerprint: string | null;
  llmModel: string;
  variant: DemoAgentVariant;
  variantKey: string | null;
  turnWindows: DemoTurnWindows | null;
} {
  return {
    transport,
    agentId: agent?.agentId ?? null,
    agentFingerprint: agent?.fingerprint ?? null,
    llmModel: agent?.llmModel ?? "managed",
    // Which stored body ran, so a variant artifact can never be mistaken for
    // production pacing (or the reverse). The bound agent's own record wins;
    // the startup selection covers a run that never bound (e.g. a raw-socket
    // scenario only).
    variant: agent?.variant ?? selection?.variant ?? "production",
    variantKey: agent?.variantKey ?? selection?.variantKey ?? null,
    turnWindows: agent?.turnWindows ?? selection?.turnWindows ?? null,
  };
}
