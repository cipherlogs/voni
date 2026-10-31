import type { ContractFamily } from "../types";

/**
 * Comprehension and content. Spec table "Comprehension and content", K1–K8.
 *
 * K8 has one recorded gap: the spec says "word error within bar" without
 * stating the bar. The entity check is numeric (zero mismatches); the word
 * error bar must be recorded by ticket 13 before K8 can pass, never invented
 * here.
 */
const comprehension: ContractFamily = {
  family: "comprehension",
  title: "Comprehension and content",
  properties: [
    {
      id: "K1",
      statement: "Spelled emails reconstructed, including corrections",
      bar: { text: "exact", numeric: true },
      evidence: "tool",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvSpelledEmailMismatchMaxCount" }],
    },
    {
      id: "K2",
      statement: "Numbers read back correctly",
      bar: { text: "exact", numeric: true },
      evidence: "trace",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvNumberReadbackMismatchMaxCount" }],
    },
    {
      id: "K3",
      statement: "Unusual names captured and used once correctly",
      bar: { text: "pass", numeric: false },
      evidence: "trace",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "K4",
      statement: "Ambiguity resolved by one targeted question",
      bar: { text: "no guessing", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvAmbiguityGuessMaxCount" }],
    },
    {
      id: "K5",
      statement: "Locale-appropriate output",
      bar: { text: "0 English leaks", numeric: true },
      evidence: "trace",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvEnglishLeakMaxCount" }],
    },
    {
      id: "K6",
      statement: "Code-switching understood, reply stays in Locale",
      bar: { text: "pass", numeric: false },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "K7",
      statement: "No invented facts",
      bar: { text: "0", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvInventedFactMaxCount" }],
    },
    {
      id: "K8",
      statement: "Transcript matches delivered audio; entities exact",
      bar: { text: "word error within bar, entities exact", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvTranscriptEntityMismatchMaxCount" }],
      gaps: [
        "The spec states 'word error within bar' without a number. Ticket 13 must record the word-error bar in a frozen record before K8 can pass; an unrecorded bar fails closed.",
      ],
    },
  ],
};

export default comprehension;
