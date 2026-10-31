import type { ContractFamily } from "../types";

/**
 * Resilience. Spec table "Resilience", R1–R8. R8 is the eligibility gate: a
 * fallback makes the certificate ineligible, never a softer pass.
 */
const resilience: ContractFamily = {
  family: "resilience",
  title: "Resilience",
  properties: [
    {
      id: "R1",
      statement: "Jitter and loss: no lost turn, no doubled audio",
      bar: { text: "0", numeric: true },
      evidence: "trace",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvJitterLostTurnMaxCount" },
        { source: "budget-record", key: "dvJitterDoubledAudioMaxCount" },
      ],
    },
    {
      id: "R2",
      statement: "Reconnect resumes the same logical turn; no repeated greeting",
      bar: { text: "pass", numeric: false },
      evidence: "trace",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R3",
      statement: "Hold return keeps memory, no re-greet, no ringback",
      bar: { text: "pass", numeric: false },
      evidence: "ledger",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R4",
      statement: "Hidden page holds; talk clock stops",
      bar: { text: "pass", numeric: false },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R5",
      statement: "Mic denied yields a named error state, no zombie call",
      bar: { text: "pass", numeric: false },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R6",
      statement: "Device switch mid-call recovers or ends honestly",
      bar: { text: "pass", numeric: false },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R7",
      statement: "Deploy drain: live call finishes, new call refused honestly",
      bar: { text: "pass", numeric: false },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "R8",
      statement: "Any provider fallback makes the certificate ineligible",
      bar: { text: "ineligible", numeric: false },
      evidence: "ledger",
      kind: "deterministic",
      thresholds: [],
    },
  ],
};

export default resilience;
