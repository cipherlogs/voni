import type { ContractFamily } from "../types";

/** Tools and email. Spec table "Tools and email", X1–X10. */
const tools: ContractFamily = {
  family: "tools",
  title: "Tools and email",
  properties: [
    {
      id: "X1",
      statement: "Tool decision after turn end",
      bar: { text: "<= 300 ms", numeric: true },
      evidence: "tool",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvToolDecisionMaxMs" }],
    },
    {
      id: "X2",
      statement: "Spoken bridge when a tool will exceed 700 ms",
      bar: { text: "<= 700 ms", numeric: true },
      evidence: "trace",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvToolBridgeMaxMs" }],
    },
    {
      id: "X3",
      statement: "Result plus spoken continuation",
      bar: { text: "p95 <= 2 s; silent > 3 s fails", numeric: true },
      evidence: "ledger",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvToolContinuationP95Ms" },
        { source: "budget-record", key: "dvToolSilenceMaxMs" },
      ],
    },
    {
      id: "X4",
      statement: "Golden path: real email delivered and found by tag",
      bar: { text: "pass", numeric: false },
      evidence: "tool",
      kind: "deterministic",
      thresholds: [],
    },
    {
      id: "X5",
      statement: "Personal-domain email triggers the gate once",
      bar: { text: "1x", numeric: true },
      evidence: "tool",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvPersonalDomainGateCount" }],
    },
    {
      id: "X6",
      statement: "Tool failure or timeout produces spoken recovery",
      bar: { text: "pass", numeric: false },
      evidence: "tool",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "X7",
      statement: "Two tools in one turn: ordered, one message each, no duplicate side effects",
      bar: { text: "pass", numeric: false },
      evidence: "tool",
      kind: "deterministic",
      thresholds: [],
    },
    {
      id: "X8",
      statement: "Retried call does not double-send",
      bar: { text: "pass", numeric: false },
      evidence: "tool",
      kind: "deterministic",
      thresholds: [],
    },
    {
      id: "X9",
      statement: "No tool result or secret is spoken",
      bar: { text: "0", numeric: true },
      evidence: "trace",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvToolResultSpokenMaxCount" }],
    },
    {
      id: "X10",
      statement: "Returning sender: memory used, invite never repeated",
      bar: { text: "pass", numeric: false },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [],
    },
  ],
};

export default tools;
