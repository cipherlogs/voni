/**
 * Client-side command bus for the voice copilot.
 *
 * ToolCoordinator (transport timing) delivers model tool calls here; this bus
 * owns authorization, execution, deduplication, and reconciliation. Two hard
 * rules:
 *
 * 1. Model-callable tools never mutate. Mutations run only through executors,
 *    which the model cannot invoke directly — only via a confirmed proposal.
 * 2. "Nothing was applied" is never inferred from a discarded tool result.
 *    Outcomes are applied (show the result), not-applied (cancelled before
 *    execution), or unknown (reconcile before retrying).
 */

import { z } from "zod";
import {
  classifyAssent,
  ProposalStore,
  type Proposal,
  type ProposalTarget,
} from "./proposals";

export type BusToolResult =
  | { ok: true; data: Record<string, unknown>; note?: string }
  | { ok: false; error: string; retryable: boolean; note?: string };

export type EffectMetadata = {
  mutates: boolean;
  scope: string;
  reversible: boolean;
};

export type TargetSnapshot = { value: unknown; version: number | string };

export type ExecutorContext = {
  userId: string;
  organizationId: string;
  sessionId: string;
  route: string;
  registration: number;
  readTarget: (target: ProposalTarget) => TargetSnapshot | null;
};

/**
 * Definitive execution failure (rejected input, refused action): the outcome
 * is KNOWN, so the proposal closes as failed instead of unknown. Throw for
 * transport-level uncertainty (the bus reconciles); throw this when the
 * server said no.
 */
export class ExecutorFailure extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "ExecutorFailure";
  }
};

export type Executor = (
  payload: unknown,
  ctx: ExecutorContext,
) => Promise<{
  result: Record<string, unknown>;
  resultingVersion?: number | string;
  uncertain?: boolean;
  uncertaintyReason?: string;
}>;

export type RegisteredTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType;
  effect: EffectMetadata;
  /** Routes that may call this. "*" means every route (globals only). */
  routes: string[] | "*";
  mode: "interactive" | "hold";
  /** False for executors: reachable only through a confirmed proposal. */
  listed: boolean;
  /** Direct implementation for read-only tools; null for executors. */
  run: ((args: unknown, ctx: BusContext) => Promise<BusToolResult>) | null;
  /** Mutation implementation, reachable only through a confirmed proposal. */
  executor: Executor | null;
};

/**
 * Model-visible definitions for the three global tools. dispatch()
 * intercepts them before the registry, but the session still needs their
 * schemas to offer them — so they ship here, not in the registry.
 */
export function globalToolDefs(): {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execution_mode: "interactive" | "hold";
  timeout_seconds: number;
}[] {
  return [
    {
      type: "function",
      name: "confirm_proposal",
      description:
        "Apply a confirmed change. Call only with the proposal id the user just affirmed by voice, or that they tapped Apply on. Never invent an id.",
      parameters: {
        type: "object",
        properties: { proposal_id: { type: "string" } },
        required: ["proposal_id"],
        additionalProperties: false,
      },
      execution_mode: "interactive",
      timeout_seconds: 15,
    },
    {
      type: "function",
      name: "dismiss_proposal",
      description:
        "Discard a pending proposal the user rejected. Call with its proposal id.",
      parameters: {
        type: "object",
        properties: { proposal_id: { type: "string" } },
        required: ["proposal_id"],
        additionalProperties: false,
      },
      execution_mode: "interactive",
      timeout_seconds: 15,
    },
    {
      type: "function",
      name: "proposals_read",
      description:
        "Recap pending proposals and recent outcomes — call after an interruption or reconnect to recover what was being confirmed.",
      parameters: { type: "object", properties: {} },
      execution_mode: "interactive",
      timeout_seconds: 15,
    },
  ];
}

export type BusContext = {
  userId: string;
  organizationId: string;
  sessionId: string;
  route: string;
  registration: number;
  targets: Map<string, () => TargetSnapshot | null>;
};

function targetKey(target: ProposalTarget): string {
  return `${target.kind}:${target.id}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export class CopilotBus {
  private tools = new Map<string, RegisteredTool>();
  /** Memoized outcomes: duplicate confirms replay, never re-execute. */
  private outcomes = new Map<string, BusToolResult>();

  constructor(
    private store: ProposalStore,
    private now: () => number = Date.now,
  ) {}

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Tools the model may see on this route (globals ship separately). */
  visibleTools(route: string): RegisteredTool[] {
    return [...this.tools.values()].filter(
      (tool) =>
        tool.listed &&
        (tool.routes === "*" ||
          (Array.isArray(tool.routes) && tool.routes.includes(route))),
    );
  }

  private executorContext(ctx: BusContext): ExecutorContext {
    return {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      sessionId: ctx.sessionId,
      route: ctx.route,
      registration: ctx.registration,
      readTarget: (target) => ctx.targets.get(targetKey(target))?.() ?? null,
    };
  }

  private checkScope(proposal: Proposal, ctx: BusContext): string | null {
    if (
      proposal.userId !== ctx.userId ||
      proposal.organizationId !== ctx.organizationId ||
      proposal.sessionId !== ctx.sessionId
    ) {
      return "Proposal belongs to a different session.";
    }
    if (proposal.route !== ctx.route || proposal.registration !== ctx.registration) {
      this.store.expireWhere((p) => p.id === proposal.id);
      return "That proposal expired when you navigated away.";
    }
    if (proposal.expiresAt <= this.now()) {
      this.store.expireWhere((p) => p.id === proposal.id);
      return "That proposal expired.";
    }
    return null;
  }

  /**
   * Feed a finalized user turn. Returns what the provider should narrate:
   * an attachment, a dismissal, or a disambiguation request. Never attaches
   * on ambiguous/qualified turns, and never attaches pre-arming speech.
   */
  recordVoiceTurn(
    turnId: string,
    text: string,
    ctx: BusContext,
  ): {
    verdict: "affirm" | "deny" | "qualified" | "ambiguous" | "ignored";
    proposalId?: string;
    needsDisambiguation?: boolean;
  } {
    const verdict = classifyAssent(text);
    if (verdict === "ambiguous" || verdict === "qualified") return { verdict };
    const armed = this.store
      .list("armed")
      .filter((p) => p.route === ctx.route && p.registration === ctx.registration);
    if (verdict === "deny") {
      if (armed.length === 1 && !armed[0].assent) {
        this.store.markDismissed(armed[0].id);
        return { verdict, proposalId: armed[0].id };
      }
      return { verdict };
    }
    // Affirm.
    if (armed.length === 0) return { verdict: "ignored" };
    if (armed.length > 1) return { verdict, needsDisambiguation: true };
    const seq = this.store.noteEvent();
    const attached = this.store.attachVoiceAssent(armed[0].id, turnId, seq);
    return attached
      ? { verdict, proposalId: armed[0].id }
      : { verdict: "ignored" };
  }

  /** Apply-tap on a pending card. Only armed proposals accept it. */
  recordTapApply(id: string): boolean {
    return this.store.attachTapAssent(id);
  }

  /** Feed a finalized agent turn for readback matching. Returns candidates. */
  recordAgentTurn(agentTurnId: string, text: string): string[] {
    this.store.noteEvent();
    return this.store.matchReadback(agentTurnId, text);
  }

  confirmProposal(id: string, ctx: BusContext): Promise<BusToolResult> {
    return this.settleProposal(id, ctx);
  }

  private async settleProposal(
    id: string,
    ctx: BusContext,
  ): Promise<BusToolResult> {
    const memoized = this.outcomes.get(id);
    if (memoized) {
      return { ...memoized, note: "Already settled — replaying the outcome." };
    }
    const proposal = this.store.get(id);
    if (!proposal) {
      return { ok: false, error: "Unknown proposal.", retryable: false };
    }
    const scopeError = this.checkScope(proposal, ctx);
    if (scopeError) {
      return { ok: false, error: scopeError, retryable: false };
    }
    if (proposal.status === "applied") {
      const outcome: BusToolResult = {
        ok: true,
        data: (proposal.result ?? {}) as Record<string, unknown>,
        note: "Already applied.",
      };
      this.outcomes.set(id, outcome);
      return outcome;
    }
    if (proposal.status !== "armed") {
      return {
        ok: false,
        error:
          proposal.status === "pending"
            ? "I haven't finished reading that back yet — one moment."
            : `That proposal is ${proposal.status}.`,
        retryable: proposal.status === "pending",
      };
    }
    if (!proposal.assent || proposal.assentConsumed) {
      return {
        ok: false,
        error: "No confirmation observed for that change yet.",
        retryable: true,
      };
    }
    // Revalidate the world the proposer saw. A keyboard edit that moved the
    // target is a conflict, not a silent overwrite.
    const reader = ctx.targets.get(targetKey(proposal.target));
    const current = reader?.() ?? null;
    if (reader && !current) {
      this.store.markConflicted(id, "The target is no longer available. Read the screen and propose again.");
      return { ok: false, error: "The target is no longer available. Read the screen and propose again.", retryable: false };
    }
    if (
      current &&
      (current.version !== proposal.expected.version ||
        stableStringify(current.value) !==
          stableStringify(proposal.expected.value))
    ) {
      this.store.markConflicted(
        id,
        "That changed since I proposed it. Say the word and I'll re-propose against the latest.",
      );
      return {
        ok: false,
        error:
          "That changed since I proposed it — I won't overwrite your edit. Want me to re-propose?",
        retryable: false,
      };
    }
    const claim = this.store.claim(id);
    if (!claim.ok) {
      return { ok: false, error: claim.reason, retryable: false };
    }
    const tool = this.tools.get(proposal.executor);
    if (!tool?.executor) {
      this.store.markUnknown(id, "Executor not registered.");
      return {
        ok: false,
        error: "That action isn't available here.",
        retryable: false,
      };
    }
    try {
      const ran = await tool.executor(
        proposal.payload,
        this.executorContext(ctx),
      );
      if (ran.uncertain) {
        this.store.markUnknown(
          id,
          ran.uncertaintyReason ?? "Outcome unknown.",
        );
        const outcome: BusToolResult = {
          ok: false,
          error:
            "I sent that but couldn't confirm the outcome. I'll check what actually happened before retrying.",
          retryable: true,
        };
        this.outcomes.set(id, outcome);
        return outcome;
      }
      this.store.markApplied(id, ran.result, ran.resultingVersion ?? null);
      const outcome: BusToolResult = { ok: true, data: ran.result };
      this.outcomes.set(id, outcome);
      return outcome;
    } catch (error) {
      if (error instanceof ExecutorFailure) {
        this.store.markFailed(id, error.message);
        const outcome: BusToolResult = {
          ok: false,
          error: error.message,
          retryable: error.retryable,
        };
        this.outcomes.set(id, outcome);
        return outcome;
      }
      // Thrown = outcome unknown, NOT failure. Assent is spent; only
      // reconciliation (same idempotency, read-back-first) may continue it.
      const message =
        error instanceof Error ? error.message : "Execution failed.";
      this.store.markUnknown(id, message);
      const outcome: BusToolResult = {
        ok: false,
        error:
          "Something interrupted that — I don't know if it applied. I'll verify before trying again.",
        retryable: true,
      };
      this.outcomes.set(id, outcome);
      return outcome;
    }
  }

  dismissProposal(id: string): BusToolResult {
    const proposal = this.store.get(id);
    if (!proposal) {
      return { ok: false, error: "Unknown proposal.", retryable: false };
    }
    if (proposal.status === "applied") {
      return {
        ok: false,
        error: "That's already applied — ask me to undo it instead.",
        retryable: false,
      };
    }
    const dismissed = this.store.markDismissed(id);
    return dismissed
      ? { ok: true, data: { dismissed: id } }
      : {
          ok: false,
          error: `That proposal is ${proposal.status}.`,
          retryable: false,
        };
  }

  /** Recap for post-interruption recovery ("what was I confirming?"). */
  proposalsRead(): BusToolResult {
    const pending = this.store
      .list()
      .filter((p) => p.status === "pending" || p.status === "armed")
      .map((p) => ({ id: p.id, summary: p.summary, status: p.status }));
    const recent = this.store
      .list()
      .filter(
        (p) =>
          p.status === "applied" ||
          p.status === "unknown" ||
          p.status === "failed" ||
          p.status === "conflicted",
      )
      .slice(-5)
      .map((p) => ({
        id: p.id,
        summary: p.summary,
        status: p.status,
        error: p.lastError,
      }));
    return { ok: true, data: { pending, recent } };
  }

  /**
   * Build a fresh undo proposal for an applied change. Returns stale when a
   * later edit moved the target — the old card's Undo dies instead of
   * clobbering new work.
   */
  buildUndoProposal(
    appliedId: string,
    ctx: BusContext,
  ):
    | { ok: true; input: Parameters<ProposalStore["create"]>[0] }
    | { ok: false; error: string } {
    const applied = this.store.get(appliedId);
    if (!applied || applied.status !== "applied" || !applied.inverse) {
      return { ok: false, error: "Nothing undoable there." };
    }
    const reader = ctx.targets.get(targetKey(applied.target));
    const current = reader?.() ?? null;
    if (
      current &&
      applied.resultingVersion !== null &&
      current.version !== applied.resultingVersion
    ) {
      return {
        ok: false,
        error: "That changed again after I applied it — undo would clobber newer work.",
      };
    }
    return {
      ok: true,
      input: {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        sessionId: ctx.sessionId,
        route: ctx.route,
        registration: ctx.registration,
        target: applied.target,
        expected: current
          ? { value: current.value, version: current.version }
          : applied.expected,
        payload: applied.inverse.payload,
        executor: applied.executor,
        summary: applied.inverse.summary,
        keyPhrases: [applied.inverse.summary],
      },
    };
  }

  /**
   * Entry point for model tool calls. Read-only registered tools run
   * directly; executors are unreachable (proposal-only); the three global
   * tools run against the proposal store.
   */
  async dispatch(
    name: string,
    args: unknown,
    ctx: BusContext,
  ): Promise<BusToolResult> {
    if (name === "confirm_proposal") {
      const parsed = z.object({ proposal_id: z.string() }).safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: "confirm_proposal needs a proposal_id.", retryable: false };
      }
      return this.settleProposal(parsed.data.proposal_id, ctx);
    }
    if (name === "dismiss_proposal") {
      const parsed = z.object({ proposal_id: z.string() }).safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: "dismiss_proposal needs a proposal_id.", retryable: false };
      }
      return this.dismissProposal(parsed.data.proposal_id);
    }
    if (name === "proposals_read") {
      return this.proposalsRead();
    }
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}.`, retryable: false };
    }
    if (tool.routes !== "*" && !tool.routes.includes(ctx.route)) {
      return { ok: false, error: `${name} isn't available on this screen.`, retryable: false };
    }
    if (tool.effect.mutates || !tool.run) {
      return {
        ok: false,
        error: `${name} changes data — propose it first so it can be confirmed.`,
        retryable: false,
      };
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: "Those arguments don't fit. Try again.", retryable: false };
    }
    try {
      if (!tool.run) {
        return { ok: false, error: `${name} has no read implementation.`, retryable: false };
      }
      return await tool.run(parsed.data, ctx);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That failed.",
        retryable: true,
      };
    }
  }
}
