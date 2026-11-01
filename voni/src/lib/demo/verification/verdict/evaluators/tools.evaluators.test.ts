import test from "node:test";
import assert from "node:assert/strict";

import { loadContract, type Contract } from "../../contract";
import { buildEvaluatorRegistry, evaluateScenarios } from "../evaluators";
import type { EvaluatorModule, ScenarioAttempt } from "../types";
import tools from "./tools.evaluators";

/**
 * The X1–X10 evaluators over the tool log, the trace and the judge record.
 *
 * The seam is `evaluateScenarios` + `judgeProperty`: the tests hand evidence
 * the runner produces and assert the verdict a certificate would read. Every
 * expected bar is the contract's frozen number, never a literal here. A
 * property with no evidence fails closed; a tool result is never inferred from
 * what the agent said.
 */

const CONTRACT = loadContract();
/** tsx's default import may be the module namespace; the loader reads `.default`. */
const TOOLS_MODULE = ((tools as unknown as { default?: EvaluatorModule }).default ??
  (tools as unknown as EvaluatorModule)) satisfies EvaluatorModule;
const MODULES = [{ path: "tools.evaluators.ts", module: TOOLS_MODULE }];

function propertyOf(contract: Contract, id: string) {
  const property = contract.properties.find((entry) => entry.id === id);
  assert.ok(property !== undefined, `contract has ${id}`);
  return property;
}

/** Three repetitions for a timing/behaviour property, one for a deterministic one. */
function attempts(
  contract: Contract,
  propertyId: string,
  evidence: ScenarioAttempt["evidence"],
  scenario = "tools-email-send",
): ScenarioAttempt[] {
  const property = propertyOf(contract, propertyId);
  const count = property.repetitions;
  return Array.from({ length: count }, (_, index) => ({
    scenario,
    repetition: index + 1,
    locale: "en",
    evidence,
  }));
}

async function verdictOf(propertyId: string, evidence: ScenarioAttempt["evidence"]) {
  const contract = await CONTRACT;
  // The protocol bundle's ledger carries the same turn rows; X3 reads them.
  const withLedger =
    evidence.ledger === undefined &&
    typeof evidence.trace === "object" &&
    evidence.trace !== null &&
    Array.isArray((evidence.trace as { rows?: unknown }).rows)
      ? {
          ...evidence,
          ledger: { turns: (evidence.trace as { rows: unknown[] }).rows },
        }
      : evidence;
  const registry = buildEvaluatorRegistry(MODULES, contract);
  const measured = await evaluateScenarios({
    contract,
    evaluators: registry,
    attempts: attempts(contract, propertyId, withLedger),
  });
  const { judgeProperty } = await import("../judge");
  return judgeProperty(
    propertyOf(contract, propertyId),
    measured.find((entry) => entry.propertyId === propertyId),
  );
}

test("the tools module owns every X property with exactly the contract's bar keys", async () => {
  const contract = await CONTRACT;
  const registry = buildEvaluatorRegistry(MODULES, contract);
  const owned = registry.filter((evaluator) => /^X\d+$/.test(evaluator.propertyId));
  assert.deepEqual(
    owned
      .map((evaluator) => evaluator.propertyId)
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))),
    ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"],
  );
  for (const evaluator of owned) {
    const property = propertyOf(contract, evaluator.propertyId);
    assert.deepEqual(
      evaluator.bars.map((bar) => bar.key).sort(),
      property.thresholds.map((entry) => entry.key).sort(),
      `${evaluator.propertyId} binds the frozen bars`,
    );
  }
});

// ── Evidence fixtures ──────────────────────────────────────────────────────

type LogRowOverrides = Partial<{
  toolCallId: string;
  toolName: string;
  status: "found" | "free" | "not_arrived" | "invalid" | null;
  returning: boolean;
  sent: boolean;
  ok: boolean;
  code: string | null;
  latencyMs: number | null;
  attempts: number;
  createdAt: string | null;
}>;

function logRow(overrides: LogRowOverrides = {}) {
  return {
    toolCallId: "c1",
    toolName: "check_email",
    status: "found" as const,
    returning: false,
    sent: false,
    ok: true,
    code: null,
    latencyMs: 900,
    attempts: 1,
    createdAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  };
}

type RowOverrides = Record<string, unknown>;

function row(type: string, overrides: RowOverrides = {}) {
  return { callId: "call-1", type, atMs: 0, ...overrides };
}

const BASE_ROWS = [
  row("turn.user_final", { turn: "0:t1", atMs: 1_000, phase: "turn", chars: 20, empty: false, wantsEnd: false }),
  row("turn.tool_call", {
    turn: "0:t1",
    atMs: 1_100,
    phase: "tool",
    name: "check_email",
    toolCallId: "c1",
    index: 0,
  }),
  row("turn.tool_result", {
    turn: "0:t1",
    atMs: 2_000,
    phase: "tool",
    name: "check_email",
    toolCallId: "c1",
    ok: true,
    code: "",
  }),
  row("turn.reply_start", { turn: "0:t1", atMs: 2_100, phase: "turn" }),
  row("turn.first_audio", { turn: "0:t1", atMs: 2_200, phase: "turn", seq: 1 }),
];

const BASE_TRANSCRIPT = [
  { role: "agent", text: "One moment.", atMs: 1_150, turn: "0:t1", final: false },
  { role: "agent", text: "I found your email, thank you.", atMs: 2_400, turn: "0:t1", final: true },
];

const DELIVERY = {
  verified: true as const,
  tag: "Lime 42",
  messageId: "m1",
  threadId: "thread-m1",
  senderKind: "work" as const,
  repliesFromInbox: 1,
};

function toolEvidence(overrides: Record<string, unknown> = {}) {
  return { log: [logRow()], delivery: DELIVERY, ...overrides };
}

function traceEvidence(overrides: Record<string, unknown> = {}) {
  return { rows: BASE_ROWS, lineCount: BASE_ROWS.length, transcript: BASE_TRANSCRIPT, ...overrides };
}

const WAV = { file: "/run/calls/call-1/received.wav", sampleRate: 24_000, channels: 1, bitsPerSample: 16, frames: 24_000, durationMs: 1_000, bytes: 48_044 };

// ── X1 ─────────────────────────────────────────────────────────────────────

test("X1 measures the tool decision from the caller's final, within the frozen bar", async () => {
  const pass = await verdictOf("X1", { tool: toolEvidence(), trace: traceEvidence() });
  assert.equal(pass.status, "PASS");
  assert.match(pass.detail, /100ms/);
  assert.deepEqual(pass.citations.filter((entry) => entry.startsWith("turn:")), ["turn:0:t1"]);

  const decisionLate = BASE_ROWS.map((entry) =>
    entry.type === "turn.tool_call" ? { ...entry, atMs: 1_400 } : entry,
  );
  const fail = await verdictOf("X1", {
    tool: toolEvidence(),
    trace: traceEvidence({ rows: decisionLate }),
  });
  assert.equal(fail.status, "FAIL");
  assert.match(fail.detail, /400ms/);
});

test("X1 with no tool call is unmeasured and fails, never a vacuous pass", async () => {
  const verdict = await verdictOf("X1", {
    tool: toolEvidence(),
    trace: traceEvidence({ rows: [BASE_ROWS[0]] }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
});

// ── X2 ─────────────────────────────────────────────────────────────────────

test("X2 needs a slow tool: a 900 ms hop with a bridge 150 ms after the decision passes", async () => {
  const verdict = await verdictOf("X2", {
    tool: toolEvidence({ log: [logRow({ latencyMs: 900 })] }),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "PASS");
  assert.match(verdict.detail, /150ms/);
});

test("X2 fails when the bridge starts after the frozen 700 ms bar", async () => {
  const transcript = [
    { role: "agent", text: "One moment.", atMs: 1_800, turn: "0:t1", final: false },
    { role: "agent", text: "I found your email, thank you.", atMs: 2_400, turn: "0:t1", final: true },
  ];
  const verdict = await verdictOf("X2", {
    tool: toolEvidence({ log: [logRow({ latencyMs: 900 })] }),
    trace: traceEvidence({ transcript }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /800ms/);
});

test("X2 with no tool over the bar is unmeasured, because no bridge was due in evidence", async () => {
  const verdict = await verdictOf("X2", {
    tool: toolEvidence({ log: [logRow({ latencyMs: 300 })] }),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /no tool took longer than 700 ms/);
});

// ── X3 ─────────────────────────────────────────────────────────────────────

test("X3 measures the spoken continuation after the result", async () => {
  const verdict = await verdictOf("X3", { tool: toolEvidence(), trace: traceEvidence() });
  assert.equal(verdict.status, "PASS");
  assert.match(verdict.detail, /400ms/);
});

test("X3 fails a silent continuation over 3 s and records the tool and turn", async () => {
  const transcript = [
    { role: "agent", text: "One moment.", atMs: 1_150, turn: "0:t1", final: false },
    { role: "agent", text: "Sorry to keep you.", atMs: 5_200, turn: "0:t1", final: true },
  ];
  const verdict = await verdictOf("X3", {
    tool: toolEvidence(),
    trace: traceEvidence({ transcript }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /3200ms/);
  assert.deepEqual(verdict.citations.filter((entry) => entry.startsWith("turn:")), ["turn:0:t1"]);
});

test("X3 with no continuation at all is unmeasured, never a silent pass", async () => {
  const transcript = [{ role: "agent", text: "One moment.", atMs: 1_150, turn: "0:t1", final: false }];
  const verdict = await verdictOf("X3", {
    tool: toolEvidence(),
    trace: traceEvidence({ transcript }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /check_email/);
  assert.match(verdict.detail, /0:t1/);
});

// ── X4 ─────────────────────────────────────────────────────────────────────

test("X4 with an unreadable tool log names the gap, not a call that never happened", async () => {
  const verdict = await verdictOf("X4", {
    tool: {
      log: [],
      gap:
        'the demo tool log could not be read: Failed query: select * from "demo_tool_calls" ' +
        '(cause: 42P01: relation "demo_tool_calls" does not exist)',
    },
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /tool log could not be read/);
  assert.match(verdict.detail, /42P01/);
  assert.doesNotMatch(verdict.detail, /no check_email was requested/);
});

test("X4 with no log row and no requested check_email says so", async () => {
  const verdict = await verdictOf("X4", {
    tool: { log: [] },
    trace: traceEvidence({ rows: [BASE_ROWS[0]] }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /no check_email was requested/);
});

test("X4 passes only when the tool found the email and the real inbox re-finds it by tag", async () => {
  const verdict = await verdictOf("X4", {
    tool: toolEvidence(),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "PASS");
  assert.ok(verdict.citations.includes("inbox:tag:Lime 42"));
  assert.ok(verdict.citations.includes("turn:0:t1"));
});

test("X4 with no inbox delivery record is unmeasured: the golden path was not verified", async () => {
  const verdict = await verdictOf("X4", {
    tool: { log: [logRow()] },
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /inbox/);
});

test("X4 fails when the tool claimed a find the inbox cannot produce", async () => {
  const verdict = await verdictOf("X4", {
    tool: toolEvidence({ delivery: { verified: true, tag: "Lime 42", messageId: "m2", threadId: "t2", senderKind: "work", repliesFromInbox: 1 } }),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "PASS", "a delivery record with a different message is still a real delivery");

  const noToolFind = await verdictOf("X4", {
    tool: toolEvidence({ log: [logRow({ status: "not_arrived" })] }),
    trace: traceEvidence(),
  });
  assert.equal(noToolFind.status, "FAIL");
  assert.match(noToolFind.detail, /not_arrived/);
});

// ── X5 ─────────────────────────────────────────────────────────────────────

test("X5 counts the personal-domain gate and passes exactly once", async () => {
  const verdict = await verdictOf("X5", {
    tool: toolEvidence({ log: [logRow({ status: "free" })] }),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.summary?.max, 1);
});

test("X5 fails zero or two gates against the frozen exact-one bar", async () => {
  const zero = await verdictOf("X5", {
    tool: toolEvidence({ log: [logRow({ status: "found" })] }),
    trace: traceEvidence(),
  });
  assert.equal(zero.status, "FAIL");
  assert.equal(zero.summary?.max, 0);

  const twice = await verdictOf("X5", {
    tool: toolEvidence({
      log: [
        logRow({ toolCallId: "c1", status: "free" }),
        logRow({ toolCallId: "c2", status: "free" }),
      ],
    }),
    trace: traceEvidence(),
  });
  assert.equal(twice.status, "FAIL");
  assert.equal(twice.summary?.max, 2);
});

// ── X6 ─────────────────────────────────────────────────────────────────────

const FAILED_ROWS = BASE_ROWS.map((entry) =>
  entry.type === "turn.tool_result"
    ? { ...entry, ok: false, code: "tool_timeout" }
    : entry,
);

const FAILED_LOG = logRow({ ok: false, code: "tool_timeout", status: null });

test("X6 passes when a timed-out tool is followed by a spoken recovery in the same turn", async () => {
  const verdict = await verdictOf("X6", {
    tool: toolEvidence({ log: [FAILED_LOG] }),
    trace: traceEvidence({ rows: FAILED_ROWS }),
  });
  assert.equal(verdict.status, "PASS");
  assert.ok(verdict.citations.includes("tool:c1"));
  assert.ok(verdict.citations.includes("turn:0:t1"));
});

test("X6 fails a failure with no spoken recovery and names the tool and class", async () => {
  const verdict = await verdictOf("X6", {
    tool: toolEvidence({ log: [FAILED_LOG] }),
    trace: traceEvidence({ rows: FAILED_ROWS, transcript: [] }),
  });
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /check_email/);
  assert.match(verdict.detail, /tool_timeout/);
});

test("X6 with no failure or timeout is unmeasured, never a pass on an untested path", async () => {
  const verdict = await verdictOf("X6", {
    tool: toolEvidence(),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /no tool failure or timeout/);
});

// ── X7 ─────────────────────────────────────────────────────────────────────

const TWO_TOOL_ROWS = [
  row("turn.user_final", { turn: "0:t1", atMs: 1_000, phase: "turn", chars: 20, empty: false, wantsEnd: false }),
  row("turn.tool_call", { turn: "0:t1", atMs: 1_100, phase: "tool", name: "check_email", toolCallId: "c1", index: 0 }),
  row("turn.tool_call", { turn: "0:t1", atMs: 1_105, phase: "tool", name: "send_code_reply", toolCallId: "c2", index: 1 }),
  row("turn.tool_result", { turn: "0:t1", atMs: 2_000, phase: "tool", name: "check_email", toolCallId: "c1", ok: true, code: "" }),
  row("turn.tool_result", { turn: "0:t1", atMs: 2_300, phase: "tool", name: "send_code_reply", toolCallId: "c2", ok: true, code: "" }),
  row("turn.reply_start", { turn: "0:t1", atMs: 2_400, phase: "turn" }),
  row("turn.first_audio", { turn: "0:t1", atMs: 2_500, phase: "turn", seq: 1 }),
];

const TWO_TOOL_LOG = [
  logRow({ toolCallId: "c1", toolName: "check_email", status: "found", latencyMs: 900 }),
  logRow({ toolCallId: "c2", toolName: "send_code_reply", status: null, sent: true, latencyMs: 300 }),
];

test("X7 passes two calls in one turn when they run in index order with one result each", async () => {
  const verdict = await verdictOf("X7", {
    tool: toolEvidence({ log: TWO_TOOL_LOG }),
    trace: traceEvidence({ rows: TWO_TOOL_ROWS }),
  });
  assert.equal(verdict.status, "PASS");
  assert.deepEqual(verdict.citations.filter((entry) => entry.startsWith("turn:")), ["turn:0:t1"]);
});

test("X7 fails a duplicated result and an out-of-order result", async () => {
  const duplicate = [...TWO_TOOL_ROWS, row("turn.tool_result", { turn: "0:t1", atMs: 2_100, phase: "tool", name: "check_email", toolCallId: "c1", ok: true, code: "" })];
  const dup = await verdictOf("X7", {
    tool: toolEvidence({ log: TWO_TOOL_LOG }),
    trace: traceEvidence({ rows: duplicate }),
  });
  assert.equal(dup.status, "FAIL");
  assert.match(dup.detail, /result/);

  const outOfOrder = TWO_TOOL_ROWS.map((entry) =>
    entry.type === "turn.tool_call" &&
    (entry as { toolCallId?: string }).toolCallId === "c2"
      ? { ...entry, index: 0 }
      : entry,
  );
  const bad = await verdictOf("X7", {
    tool: toolEvidence({ log: TWO_TOOL_LOG }),
    trace: traceEvidence({ rows: outOfOrder }),
  });
  assert.equal(bad.status, "FAIL");
  assert.match(bad.detail, /order/);
});

test("X7 with a single tool call is unmeasured, because no two-tool turn was exercised", async () => {
  const verdict = await verdictOf("X7", {
    tool: toolEvidence(),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
});

// ── X8 ─────────────────────────────────────────────────────────────────────

test("X8 passes a retried call that replayed one send", async () => {
  const verdict = await verdictOf("X8", {
    tool: toolEvidence({
      log: [
        logRow({ toolCallId: "c2", toolName: "send_code_reply", status: null, sent: true, attempts: 2, latencyMs: 500 }),
      ],
      delivery: { ...DELIVERY, repliesFromInbox: 1 },
    }),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "PASS");
  assert.match(verdict.detail, /1/);
});

test("X8 fails two successful sends or two replies in the thread", async () => {
  const twoRows = await verdictOf("X8", {
    tool: toolEvidence({
      log: [
        logRow({ toolCallId: "c2", toolName: "send_code_reply", status: null, sent: true }),
        logRow({ toolCallId: "c3", toolName: "send_code_reply", status: null, sent: true }),
      ],
    }),
    trace: traceEvidence(),
  });
  assert.equal(twoRows.status, "FAIL");
  assert.match(twoRows.detail, /double send|two sends/);

  const twoReplies = await verdictOf("X8", {
    tool: toolEvidence({
      log: [logRow({ toolCallId: "c2", toolName: "send_code_reply", status: null, sent: true, attempts: 2 })],
      delivery: { ...DELIVERY, repliesFromInbox: 2 },
    }),
    trace: traceEvidence(),
  });
  assert.equal(twoReplies.status, "FAIL");
  assert.match(twoReplies.detail, /2 replies/);
});

test("X8 with no retry and no send is unmeasured, never a vacuous pass", async () => {
  const verdict = await verdictOf("X8", {
    tool: toolEvidence(),
    trace: traceEvidence(),
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
});

// ── X9 ─────────────────────────────────────────────────────────────────────

test("X9 passes when no agent caption carries a tool output or a secret", async () => {
  const verdict = await verdictOf("X9", {
    trace: traceEvidence(),
    tool: toolEvidence(),
    wav: WAV,
  });
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.summary?.max, 0);
});

test("X9 counts a spoken address and a credential-shaped secret", async () => {
  const transcript = [
    ...BASE_TRANSCRIPT,
    { role: "agent", text: "I sent it to andres@casaverde.pt.", atMs: 3_000, turn: "0:t2", final: true },
    { role: "agent", text: "The key is sk_live_ABC123.", atMs: 3_500, turn: "0:t2", final: true },
  ];
  const verdict = await verdictOf("X9", {
    trace: traceEvidence({ transcript }),
    tool: toolEvidence(),
    wav: WAV,
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.summary?.max, 2);
  assert.match(verdict.detail, /turn:0:t2/);
});

test("X9 refuses audio that no agent caption covers, because un-scanned speech is not clean", async () => {
  const rows = [
    ...BASE_ROWS,
    row("turn.first_audio", { turn: "0:t9", atMs: 3_100, phase: "turn", seq: 2 }),
  ];
  const verdict = await verdictOf("X9", {
    trace: traceEvidence({ rows }),
    tool: toolEvidence(),
    wav: WAV,
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /0:t9/);
});

test("X9 with no transcript or delivered audio fails closed, because silence cannot be proven safe", async () => {
  const noTranscript = await verdictOf("X9", {
    trace: traceEvidence({ transcript: null }),
    tool: toolEvidence(),
    wav: WAV,
  });
  assert.equal(noTranscript.status, "FAIL");
  assert.equal(noTranscript.reason, "unmeasured");

  const noWav = await verdictOf("X9", {
    trace: traceEvidence(),
    tool: toolEvidence(),
  });
  assert.equal(noWav.status, "FAIL");
  assert.equal(noWav.reason, "unmeasured");
});

// ── X10 ────────────────────────────────────────────────────────────────────

function judgeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    callId: "call-1",
    judgeId: "judge-b",
    judgedAt: "2026-10-31T10:05:00.000Z",
    memoryUsed: true,
    inviteRepeated: false,
    citations: ["turn:0:t1"],
    rationale: "The agent greeted the caller by name and skipped the second invite.",
    ...overrides,
  };
}

test("X10 passes a grounded judgement that memory was used and the invite was not repeated", async () => {
  const verdict = await verdictOf("X10", {
    judge: judgeEvidence(),
    tool: toolEvidence({ log: [logRow({ returning: true })] }),
  });
  assert.equal(verdict.status, "PASS");
  assert.ok(verdict.citations.includes("turn:0:t1"));
});

test("X10 fails a repeated invite or a judgement with no memory use", async () => {
  const repeated = await verdictOf("X10", {
    judge: judgeEvidence({ inviteRepeated: true }),
    tool: toolEvidence({ log: [logRow({ returning: true })] }),
  });
  assert.equal(repeated.status, "FAIL");
  assert.match(repeated.detail, /invite/);

  const noMemory = await verdictOf("X10", {
    judge: judgeEvidence({ memoryUsed: false }),
    tool: toolEvidence({ log: [logRow({ returning: true })] }),
  });
  assert.equal(noMemory.status, "FAIL");
  assert.match(noMemory.detail, /memory/);
});

test("X10 with no judge record or no grounding is unmeasured, never inferred from the tool", async () => {
  const missing = await verdictOf("X10", {
    tool: toolEvidence({ log: [logRow({ returning: true })] }),
  });
  assert.equal(missing.status, "FAIL");
  assert.equal(missing.reason, "missing-evidence");

  const ungrounded = await verdictOf("X10", {
    judge: judgeEvidence({ citations: [] }),
    tool: toolEvidence({ log: [logRow({ returning: true })] }),
  });
  assert.equal(ungrounded.status, "FAIL");
  assert.match(ungrounded.detail, /ground|citation/);
});
