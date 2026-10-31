/**
 * Tools and email evaluators (spec "Tools and email", X1–X10).
 *
 * Every judgment comes from the call's own evidence: the redacted demo tool log,
 * the turn-level ledger, the trace's captions, the real inbox's delivery record
 * and the judge's grounded returning-sender record. No evaluator reads a tool
 * result out of what the agent said, and none invents a missing fact: a property
 * whose evidence is absent is `unmeasured`, which the verdict engine turns into
 * a failure.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Tools and email".
 */

import type { EvaluatorModule, PropertyEvaluator } from "../types";
import {
  continuationAfter,
  firstAgentCaptionAfter,
  readLedgerTurns,
  readToolEvidence,
  readTrace,
  sensitiveValues,
  toolCalls,
  toolResults,
  turnEndBefore,
  type Caption,
  type EvidenceRow,
  type ToolCallRow,
  type ToolResultRow,
} from "../../tools/evidence";
import { threshold } from "./threshold";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

function traceOf(evidence: Record<string, unknown>) {
  return evidence.trace === undefined ? null : readTrace(evidence.trace);
}

/** One turn's rows for a tool call, from the trace or the ledger. */
function rowsOf(source: unknown): readonly EvidenceRow[] {
  return readLedgerTurns(source);
}

function callById(calls: readonly ToolCallRow[], id: string): ToolCallRow | null {
  return calls.find((call) => call.toolCallId === id) ?? null;
}

function resultById(results: readonly ToolResultRow[], id: string): ToolResultRow | null {
  return results.find((result) => result.toolCallId === id) ?? null;
}

function turnCitation(turn: string | null): string[] {
  return turn === null ? [] : [`turn:${turn}`];
}

// ── X1: tool decision after turn end ───────────────────────────────────────

const x1: PropertyEvaluator = {
  propertyId: "X1",
  source: "tools.evaluators.ts",
  bars: [{ key: "dvToolDecisionMaxMs", statistic: "max", comparison: "at-most" }],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return {
        kind: "unmeasured",
        reason: "the trace is missing, so the tool decision cannot be timed from the caller's final",
      };
    }
    let calls: ToolCallRow[];
    try {
      calls = toolCalls(trace.rows);
    } catch (error) {
      return { kind: "unmeasured", reason: `the trace's tool rows cannot be read: ${reasonOf(error)}` };
    }
    if (calls.length === 0) {
      return {
        kind: "unmeasured",
        reason: "no tool was requested on this call; X1 has no decision to time",
        citations: [],
      };
    }
    const samples: number[] = [];
    let worst: { call: ToolCallRow; delay: number } | null = null;
    for (const call of calls) {
      let end: number | null;
      try {
        end = turnEndBefore(trace.rows, call);
      } catch (error) {
        return { kind: "unmeasured", reason: reasonOf(error) };
      }
      if (end === null) {
        return {
          kind: "unmeasured",
          reason:
            `tool ${call.name} (${call.toolCallId}) has no preceding caller final in turn ` +
            `${call.turn}; the decision's start is not in evidence`,
          citations: turnCitation(call.turn),
        };
      }
      const delay = call.atMs - end;
      if (delay < 0) {
        return {
          kind: "unmeasured",
          reason: `tool ${call.name} was requested before the caller's final at ${ms(end)}`,
          citations: turnCitation(call.turn),
        };
      }
      samples.push(delay);
      if (worst === null || delay > worst.delay) worst = { call, delay };
    }
    return {
      kind: "measured",
      samples,
      citations: [
        ...turnCitation(worst?.call.turn ?? null),
        `trace:turn.tool_call:${worst?.call.toolCallId ?? ""}`,
      ],
      detail:
        `the tool decision came ${ms(worst?.delay ?? 0)} after the caller's final ` +
        `(${worst?.call.name ?? "tool"} in ${worst?.call.turn ?? "turn"})`,
    };
  },
};

// ── X2: spoken bridge when a tool will be slow ─────────────────────────────

const x2: PropertyEvaluator = {
  propertyId: "X2",
  source: "tools.evaluators.ts",
  bars: [{ key: "dvToolBridgeMaxMs", statistic: "max", comparison: "at-most" }],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return { kind: "unmeasured", reason: "the trace is missing, so no spoken bridge can be located" };
    }
    let tool;
    try {
      tool = readToolEvidence(context.evidence.tool);
    } catch (error) {
      return { kind: "unmeasured", reason: `the tool log cannot be read: ${reasonOf(error)}` };
    }
    if (tool.log.length === 0) {
      return { kind: "unmeasured", reason: "the tool log is empty; no tool duration exists to judge a bridge against" };
    }
    const slowBar = threshold(context, "dvToolBridgeMaxMs");
    const slow = tool.log.filter(
      (row) => row.latencyMs !== null && row.latencyMs > slowBar,
    );
    if (slow.length === 0) {
      return {
        kind: "unmeasured",
        reason:
          `no tool took longer than ${Math.round(slowBar)} ms (the frozen bridge bar), so no bridge was due; ` +
          "the scenario did not exercise X2",
        citations: [],
      };
    }
    if (trace.captions === null) {
      return { kind: "unmeasured", reason: trace.captionGap ?? "the call has no transcript" };
    }
    let calls: ToolCallRow[];
    let results: ToolResultRow[];
    try {
      calls = toolCalls(trace.rows);
      results = toolResults(trace.rows);
    } catch (error) {
      return { kind: "unmeasured", reason: reasonOf(error) };
    }
    const samples: number[] = [];
    let worst: { caption: Caption; delay: number; call: ToolCallRow } | null = null;
    for (const row of slow) {
      const call = callById(calls, row.toolCallId);
      if (call === null) {
        return {
          kind: "unmeasured",
          reason: `slow tool ${row.toolName} (${row.toolCallId}) has no trace row, so its turn is unknown`,
        };
      }
      let end: number | null;
      try {
        end = turnEndBefore(trace.rows, call);
      } catch (error) {
        return { kind: "unmeasured", reason: reasonOf(error) };
      }
      if (end === null) {
        return {
          kind: "unmeasured",
          reason: `slow tool ${row.toolName} has no caller final to time a bridge from`,
          citations: turnCitation(call.turn),
        };
      }
      const caption = firstAgentCaptionAfter(trace.captions, call.atMs);
      const result = resultById(results, row.toolCallId);
      if (caption === null || (result !== null && caption.atMs >= result.atMs)) {
        return {
          kind: "unmeasured",
          reason:
            `slow tool ${row.toolName} (${ms(row.latencyMs ?? 0)}, ${call.turn}) produced no spoken ` +
            "bridge before its result; the caller heard the wait as silence",
          citations: turnCitation(call.turn),
        };
      }
      const delay = Math.max(0, caption.atMs - end);
      samples.push(delay);
      if (worst === null || delay > worst.delay) worst = { caption, delay, call };
    }
    return {
      kind: "measured",
      samples,
      citations: [
        ...turnCitation(worst?.call.turn ?? null),
        `trace:turn.tool_call:${worst?.call.toolCallId ?? ""}`,
      ],
      detail:
        `the bridge for ${worst?.call.name ?? "the slow tool"} started ${ms(worst?.delay ?? 0)} ` +
        `after the caller's final (${worst?.caption.text ?? ""})`,
    };
  },
};

// ── X3: result plus spoken continuation ────────────────────────────────────

const x3: PropertyEvaluator = {
  propertyId: "X3",
  source: "tools.evaluators.ts",
  bars: [
    { key: "dvToolContinuationP95Ms", statistic: "p95", comparison: "at-most" },
    { key: "dvToolSilenceMaxMs", statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return { kind: "unmeasured", reason: "the trace is missing, so no continuation can be timed" };
    }
    if (trace.captions === null) {
      return { kind: "unmeasured", reason: trace.captionGap ?? "the call has no transcript" };
    }
    let rows: readonly EvidenceRow[];
    let results: ToolResultRow[];
    try {
      rows = rowsOf(context.source);
      results = toolResults(rows).filter((result) => result.ok);
    } catch (error) {
      return { kind: "unmeasured", reason: `the ledger's tool rows cannot be read: ${reasonOf(error)}` };
    }
    if (results.length === 0) {
      return {
        kind: "unmeasured",
        reason: "no successful tool result exists on this call; X3 has no continuation to time",
      };
    }
    const samples: number[] = [];
    let worst: { result: ToolResultRow; caption: Caption; delay: number } | null = null;
    for (const result of results) {
      const caption = continuationAfter(trace.captions, result);
      if (caption === null) {
        return {
          kind: "unmeasured",
          reason:
            `tool ${result.name} (${result.toolCallId}) answered in turn ${result.turn} with no ` +
            "spoken continuation; the caller heard the result as silence or a dropped turn",
          citations: turnCitation(result.turn),
        };
      }
      const delay = caption.atMs - result.atMs;
      samples.push(delay);
      if (worst === null || delay > worst.delay) worst = { result, caption, delay };
    }
    return {
      kind: "measured",
      samples,
      citations: [...turnCitation(worst?.result.turn ?? null), `tool:${worst?.result.toolCallId ?? ""}`],
      detail:
        `the continuation after ${worst?.result.name ?? "the tool"} came ${ms(worst?.delay ?? 0)} ` +
        `in turn ${worst?.result.turn ?? "unknown"} (${worst?.caption.text ?? ""})`,
    };
  },
};

// ── X4: real email delivered and found by tag ──────────────────────────────

const x4: PropertyEvaluator = {
  propertyId: "X4",
  source: "tools.evaluators.ts",
  bars: [],
  evaluate(context) {
    let tool;
    try {
      tool = readToolEvidence(context.evidence.tool);
    } catch (error) {
      return { kind: "unmeasured", reason: `the tool evidence cannot be read: ${reasonOf(error)}` };
    }
    const checks = tool.log.filter((row) => row.toolName === "check_email");
    if (checks.length === 0) {
      return { kind: "unmeasured", reason: "no check_email was requested on this call" };
    }
    const found = checks.filter((row) => row.status === "found");
    if (found.length === 0) {
      const statuses = [...new Set(checks.map((row) => row.status ?? "unknown"))].join(", ");
      return {
        kind: "measured",
        passed: false,
        citations: ["tool:check_email"],
        detail: `no check_email found the email; the call recorded: ${statuses}`,
      };
    }
    if (tool.delivery === null) {
      return {
        kind: "unmeasured",
        reason:
          `the tool found message ${found[0]?.toolCallId ?? ""}, but there is no inbox delivery ` +
          "record: the real test inbox was not re-read, so the golden path is unverified",
        citations: ["tool:check_email"],
      };
    }
    let calls: ToolCallRow[] = [];
    try {
      const trace = traceOf(context.evidence);
      calls = trace === null ? [] : toolCalls(trace.rows);
    } catch {
      calls = [];
    }
    const call = found[0] === undefined ? null : callById(calls, found[0].toolCallId);
    return {
      kind: "measured",
      passed: true,
      citations: [
        ...turnCitation(call?.turn ?? null),
        `inbox:tag:${tool.delivery.tag}`,
        `inbox:message:${tool.delivery.messageId}`,
      ],
      detail:
        `the email was delivered to the test inbox and found by tag ${tool.delivery.tag} ` +
        `(message ${tool.delivery.messageId}, ${tool.delivery.senderKind} sender)`,
    };
  },
};

// ── X5: personal-domain gate once ──────────────────────────────────────────

const x5: PropertyEvaluator = {
  propertyId: "X5",
  source: "tools.evaluators.ts",
  bars: [{ key: "dvPersonalDomainGateCount", statistic: "each", comparison: "exact" }],
  evaluate(context) {
    let tool;
    try {
      tool = readToolEvidence(context.evidence.tool);
    } catch (error) {
      return { kind: "unmeasured", reason: `the tool evidence cannot be read: ${reasonOf(error)}` };
    }
    const checks = tool.log.filter((row) => row.toolName === "check_email");
    if (checks.length === 0) {
      return { kind: "unmeasured", reason: "no check_email was requested, so the gate could not fire" };
    }
    const gated = checks.filter((row) => row.status === "free");
    let call: ToolCallRow | null = null;
    if (gated[0] !== undefined) {
      try {
        const trace = traceOf(context.evidence);
        call = trace === null ? null : callById(toolCalls(trace.rows), gated[0].toolCallId);
      } catch {
        call = null;
      }
    }
    return {
      kind: "measured",
      samples: [gated.length],
      citations: [
        ...turnCitation(call?.turn ?? null),
        "tool:check_email:personal-domain-gate",
      ],
      detail:
        `the personal-domain gate fired ${gated.length} time${gated.length === 1 ? "" : "s"} ` +
        "across this call's email checks",
    };
  },
};

// ── X6: spoken recovery on failure or timeout ─────────────────────────────

const FAILURE_CODES = new Set([
  "tool_timeout",
  "tool_http_error",
  "tool_transport_error",
  "tool_unreadable_body",
  "tool_malformed_result",
  "denied",
]);

const x6: PropertyEvaluator = {
  propertyId: "X6",
  source: "tools.evaluators.ts",
  bars: [],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return { kind: "unmeasured", reason: "the trace is missing, so a recovery cannot be located" };
    }
    if (trace.captions === null) {
      return { kind: "unmeasured", reason: trace.captionGap ?? "the call has no transcript" };
    }
    let results: ToolResultRow[];
    try {
      results = toolResults(trace.rows).filter((result) => !result.ok);
    } catch (error) {
      return { kind: "unmeasured", reason: `the tool result rows cannot be read: ${reasonOf(error)}` };
    }
    if (results.length === 0) {
      return {
        kind: "unmeasured",
        reason:
          "no tool failure or timeout was exercised on this call; X6 has no recovery to judge",
      };
    }
    const failures: { result: ToolResultRow; caption: Caption; code: string }[] = [];
    for (const result of results) {
      const code = result.code !== null && FAILURE_CODES.has(result.code) ? result.code : "tool_error";
      const caption = firstAgentCaptionAfter(trace.captions, result.atMs);
      if (caption === null) {
        return {
          kind: "measured",
          passed: false,
          citations: [...turnCitation(result.turn), `tool:${result.toolCallId}`],
          detail:
            `tool ${result.name} failed with ${code} in turn ${result.turn} and the agent never ` +
            "spoke a recovery",
        };
      }
      failures.push({ result, caption, code });
    }
    return {
      kind: "measured",
      passed: true,
      citations: [
        ...turnCitation(failures[0]?.result.turn ?? null),
        `tool:${failures[0]?.result.toolCallId ?? ""}`,
      ],
      detail:
        `tool ${failures[0]?.result.name ?? "tool"} failed with ${failures[0]?.code ?? "tool_error"} ` +
        `and the agent recovered aloud: ${failures[0]?.caption.text ?? ""}`,
    };
  },
};

// ── X7: two tools in one turn, ordered, one message each ───────────────────

const x7: PropertyEvaluator = {
  propertyId: "X7",
  source: "tools.evaluators.ts",
  bars: [],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return { kind: "unmeasured", reason: "the trace is missing, so no two-tool turn can be found" };
    }
    let tool;
    let calls: ToolCallRow[];
    let results: ToolResultRow[];
    try {
      tool = readToolEvidence(context.evidence.tool);
      calls = toolCalls(trace.rows);
      results = toolResults(trace.rows);
    } catch (error) {
      return { kind: "unmeasured", reason: reasonOf(error) };
    }
    const turns = new Map<string, ToolCallRow[]>();
    for (const call of calls) {
      const list = turns.get(call.turn) ?? [];
      list.push(call);
      turns.set(call.turn, list);
    }
    const batched = [...turns.entries()].find(([, rows]) => rows.length >= 2);
    if (batched === undefined) {
      return {
        kind: "unmeasured",
        reason:
          "no turn requested two tools; X7 needs a two-tool turn and this call has only one " +
          `(${calls.length} tool call${calls.length === 1 ? "" : "s"})`,
      };
    }
    const [turn, rows] = batched;
    const indexed = rows.map((call) => ({ call, index: call.index }));
    if (indexed.some((entry) => entry.index === null)) {
      return {
        kind: "measured",
        passed: false,
        citations: turnCitation(turn),
        detail: `turn ${turn} requested two tools with no model index; the order is unknown`,
      };
    }
    const indexes = indexed.map((entry) => entry.index as number);
    const unique = new Set(indexes);
    const ordered = indexes.every((value, index) => index === 0 || value > (indexes[index - 1] ?? value));
    if (unique.size !== indexes.length || !ordered) {
      return {
        kind: "measured",
        passed: false,
        citations: turnCitation(turn),
        detail:
          `turn ${turn}'s tool calls are not in model index order (${indexed
            .map((entry) => `${entry.call.name}#${String(entry.index)}`)
            .join(", ")})`,
      };
    }
    const expected = [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    let previousResultAt = -Infinity;
    for (const call of expected) {
      const matching = results.filter((result) => result.toolCallId === call.toolCallId);
      if (matching.length !== 1) {
        return {
          kind: "measured",
          passed: false,
          citations: turnCitation(turn),
          detail:
            `tool ${call.name} (${call.toolCallId}) has ${matching.length} results; one call owes ` +
            "exactly one message",
        };
      }
      const result = matching[0];
      if (result === undefined || result.atMs < previousResultAt) {
        return {
          kind: "measured",
          passed: false,
          citations: turnCitation(turn),
          detail: `turn ${turn}'s results are out of order after ${call.name}`,
        };
      }
      previousResultAt = result.atMs;
    }
    for (const call of rows) {
      const logged = tool.log.filter((entry) => entry.toolCallId === call.toolCallId);
      if (logged.length !== 1) {
        return {
          kind: "unmeasured",
          reason:
            `tool ${call.name} (${call.toolCallId}) has ${logged.length} tool log rows; the side ` +
            "effects cannot be judged without one row per call",
          citations: turnCitation(turn),
        };
      }
    }
    const sideEffects = tool.log.filter((entry) => entry.sent);
    if (sideEffects.length > rows.length) {
      return {
        kind: "measured",
        passed: false,
        citations: turnCitation(turn),
        detail: `turn ${turn} logged ${sideEffects.length} sends for ${rows.length} tool calls`,
      };
    }
    return {
      kind: "measured",
      passed: true,
      citations: turnCitation(turn),
      detail:
        `turn ${turn} requested ${rows.length} tools in index order ` +
        `(${expected.map((call) => call.name).join(" -> ")}) with one result each`,
    };
  },
};

// ── X8: a retried call does not double-send ────────────────────────────────

const x8: PropertyEvaluator = {
  propertyId: "X8",
  source: "tools.evaluators.ts",
  bars: [],
  evaluate(context) {
    let tool;
    try {
      tool = readToolEvidence(context.evidence.tool);
    } catch (error) {
      return { kind: "unmeasured", reason: `the tool evidence cannot be read: ${reasonOf(error)}` };
    }
    const sends = tool.log.filter((row) => row.sent);
    if (sends.length === 0) {
      return {
        kind: "unmeasured",
        reason: "no reply send was logged; X8 has no side effect to check for a double send",
      };
    }
    if (sends.length > 1) {
      return {
        kind: "measured",
        passed: false,
        citations: ["tool:send_code_reply"],
        detail: `double send: ${sends.length} successful reply sends were logged for one call`,
      };
    }
    if (tool.delivery !== null && tool.delivery.repliesFromInbox > 1) {
      return {
        kind: "measured",
        passed: false,
        citations: [`inbox:thread:${tool.delivery.threadId}`],
        detail:
          `double send: ${tool.delivery.repliesFromInbox} replies landed in the caller's thread; ` +
          "one send has one message",
      };
    }
    const retried = tool.log.filter((row) => row.attempts > 1);
    if (retried.length === 0) {
      return {
        kind: "unmeasured",
        reason:
          "the call logged one send but no retried tool id; a retry was not exercised, so X8 " +
          "cannot claim the retry path is safe",
        citations: ["tool:send_code_reply"],
      };
    }
    return {
      kind: "measured",
      passed: true,
      citations: [
        "tool:send_code_reply",
        ...(tool.delivery === null ? [] : [`inbox:thread:${tool.delivery.threadId}`]),
      ],
      detail:
        `one reply send across ${Math.max(...retried.map((row) => row.attempts))} attempts; ` +
        `the inbox holds ${tool.delivery?.repliesFromInbox ?? "an unread number of"} reply` +
        `${(tool.delivery?.repliesFromInbox ?? 0) === 1 ? "" : "ies"}`,
    };
  },
};

// ── X9: no tool result or secret is spoken ─────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /\bsk_(?:live|test)_[A-Za-z0-9]{6,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/g,
  /-----BEGIN [A-Z ]+-----/g,
];

function leaksIn(text: string, supplied: readonly string[]): string[] {
  const found = new Set<string>();
  for (const value of supplied) {
    if (text.includes(value)) found.add(value);
  }
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0] ?? "";
      if (value !== "") found.add(value);
    }
  }
  return [...found];
}

const x9: PropertyEvaluator = {
  propertyId: "X9",
  source: "tools.evaluators.ts",
  bars: [{ key: "dvToolResultSpokenMaxCount", statistic: "each", comparison: "exact" }],
  evaluate(context) {
    const trace = traceOf(context.evidence);
    if (trace === null) {
      return { kind: "unmeasured", reason: "the trace is missing, so no spoken words can be scanned" };
    }
    if (trace.captions === null) {
      return { kind: "unmeasured", reason: trace.captionGap ?? "the call has no transcript" };
    }
    const wav = context.evidence.wav;
    if (wav === undefined || wav === null) {
      return {
        kind: "unmeasured",
        reason:
          "the delivered WAV is missing; un-transcribed speech could carry a tool result or a " +
          "secret, so X9 cannot be a pass",
      };
    }
    // Tie the transcript to the audio it claims to describe: a turn that
    // delivered audio with no agent caption is un-scanned speech, so the leak
    // count cannot be zero by evidence.
    const firstAudio = trace.rows.filter((row) => row.type === "turn.first_audio");
    if (firstAudio.length === 0) {
      return {
        kind: "unmeasured",
        reason:
          "the trace records no turn.first_audio row; the delivered WAV cannot be tied to any " +
          "spoken turn, so a secret in audio cannot be ruled out",
      };
    }
    for (const row of firstAudio) {
      const turn = typeof row.turn === "string" ? row.turn : null;
      const at = typeof row.atMs === "number" && Number.isFinite(row.atMs) ? row.atMs : 0;
      const covered = trace.captions.some(
        (caption) =>
          caption.role === "agent" &&
          ((turn !== null && caption.turn === turn) || (caption.turn === null && caption.atMs >= at)),
      );
      if (!covered) {
        return {
          kind: "unmeasured",
          reason:
            `turn ${turn ?? "(unknown)"} delivered audio at ${ms(at)} but has no agent caption; ` +
            "the audio is un-scanned speech, so X9 cannot pass",
          citations: turnCitation(turn),
        };
      }
    }
    let supplied: readonly string[] = [];
    try {
      supplied = sensitiveValues(context.evidence.tool);
    } catch {
      supplied = [];
    }
    const leaks: { caption: Caption; values: string[] }[] = [];
    for (const caption of trace.captions) {
      if (caption.role !== "agent") continue;
      const values = leaksIn(caption.text, supplied);
      if (values.length > 0) leaks.push({ caption, values });
    }
    const samples = [leaks.reduce((sum, leak) => sum + leak.values.length, 0)];
    const turns = [...new Set(leaks.map((leak) => leak.caption.turn).filter((turn): turn is string => turn !== null))];
    return {
      kind: "measured",
      samples,
      citations: [...turns.map((turn) => `turn:${turn}`), "trace:transcript"],
      detail:
        leaks.length === 0
          ? "no agent caption carried a tool result, a caller address or a credential-shaped secret"
          : `the agent spoke ${samples[0]} tool/secret value${samples[0] === 1 ? "" : "s"} in ` +
            `${turns.map((turn) => `turn:${turn}`).join(", ") || "unattributed turns"}: ` +
            leaks.map((leak) => `${leak.caption.turn ?? "turn"}: ${leak.values.join(", ")}`).join("; "),
    };
  },
};

// ── X10: returning sender memory used, invite never repeated ──────────────

type ReturningJudgement = {
  readonly judgeId: string;
  readonly memoryUsed: boolean;
  readonly inviteRepeated: boolean;
  readonly citations: readonly string[];
  readonly rationale: string;
};

function returningJudgement(source: unknown): ReturningJudgement {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error("the judge evidence is not an object");
  }
  const record = source as Record<string, unknown>;
  const judgeId = typeof record.judgeId === "string" ? record.judgeId.trim() : "";
  if (judgeId === "") throw new Error("the judge evidence names no judge");
  if (typeof record.memoryUsed !== "boolean") {
    throw new Error("the judge evidence does not say whether memory was used");
  }
  if (typeof record.inviteRepeated !== "boolean") {
    throw new Error("the judge evidence does not say whether the invite was repeated");
  }
  const citations = Array.isArray(record.citations)
    ? record.citations
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim())
    : [];
  if (citations.length === 0) {
    throw new Error(
      "the judge evidence cites no transcript turn; an ungrounded judgement cannot pass X10",
    );
  }
  return {
    judgeId,
    memoryUsed: record.memoryUsed,
    inviteRepeated: record.inviteRepeated,
    citations,
    rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
  };
}

const x10: PropertyEvaluator = {
  propertyId: "X10",
  source: "tools.evaluators.ts",
  bars: [],
  evaluate(context) {
    let judgement: ReturningJudgement;
    try {
      judgement = returningJudgement(context.source);
    } catch (error) {
      return { kind: "unmeasured", reason: reasonOf(error) };
    }
    const passed = judgement.memoryUsed && !judgement.inviteRepeated;
    if (!judgement.memoryUsed) {
      return {
        kind: "measured",
        passed: false,
        citations: judgement.citations,
        detail: `judge ${judgement.judgeId} found no returning-sender memory used: ${judgement.rationale}`,
      };
    }
    if (judgement.inviteRepeated) {
      return {
        kind: "measured",
        passed: false,
        citations: judgement.citations,
        detail: `judge ${judgement.judgeId} found the invite repeated to a returning sender: ${judgement.rationale}`,
      };
    }
    return {
      kind: "measured",
      passed,
      citations: judgement.citations,
      detail: `judge ${judgement.judgeId} found returning-sender memory used and the invite not repeated: ${judgement.rationale}`,
    };
  },
};

const tools: EvaluatorModule = {
  family: "tools",
  evaluators: [x1, x2, x3, x4, x5, x6, x7, x8, x9, x10],
};

export default tools;
