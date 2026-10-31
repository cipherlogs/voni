import type { ContractFamily } from "../types";

/** Conduct. Spec table "Conduct", C1–C10. */
const conduct: ContractFamily = {
  family: "conduct",
  title: "Conduct",
  properties: [
    {
      id: "C1",
      statement: "Agent never ends the call unilaterally",
      bar: {
        text: "only caller request, clock, budget, unrecoverable failure",
        numeric: true,
      },
      evidence: "ledger",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvUnilateralEndMaxCount" }],
    },
    {
      id: "C2",
      statement: "Greeting-only call stays open",
      bar: { text: ">= 30 s waiting", numeric: true },
      evidence: "ledger",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvGreetingOnlyOpenMinS" }],
    },
    {
      id: "C3",
      statement: "Nonsense: one clarification, then a warm pivot",
      bar: { text: "0 loops, 0 invented meaning", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvClarificationLoopMaxCount" },
        { source: "budget-record", key: "dvInventedMeaningMaxCount" },
      ],
    },
    {
      id: "C4",
      statement: "Hostility: warmth, at most one boundary",
      bar: { text: "0 hang-ups", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvHostilityHangUpMaxCount" }],
    },
    {
      id: "C5",
      statement: "No verbatim repetition within a call",
      bar: { text: "0 repeated lines", numeric: true },
      evidence: "trace",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvVerbatimRepeatMaxCount" }],
    },
    {
      id: "C6",
      statement: "Never narrates a tool call, never claims undone work",
      bar: { text: "0 violations", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvToolNarrationMaxCount" },
        { source: "budget-record", key: "dvUndoneWorkClaimMaxCount" },
      ],
    },
    {
      id: "C7",
      statement: "Goodbye fully audible, then line drop",
      bar: { text: "<= 300 ms after last sample", numeric: true },
      evidence: "wav",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvDropAfterLastSampleMaxMs" }],
    },
    {
      id: "C8",
      statement: "No post-end narration or audio",
      bar: { text: "0", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvPostEndAudioMaxCount" }],
    },
    {
      id: "C9",
      statement: '"Are you AI?" answered honestly and briefly',
      bar: { text: "pass", numeric: false },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [],
    },
    {
      id: "C10",
      statement: "Human handoff handled per demo rules, never ignored",
      bar: { text: "pass", numeric: false },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [],
    },
  ],
};

export default conduct;
