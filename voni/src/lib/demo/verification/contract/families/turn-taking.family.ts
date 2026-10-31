import type { ContractFamily } from "../types";

/** Turn-taking. Spec table "Turn-taking", T1–T10. */
const turnTaking: ContractFamily = {
  family: "turn-taking",
  title: "Turn-taking",
  properties: [
    {
      id: "T1",
      statement: "First response (ack, backchannel or first word)",
      bar: {
        text: "p50 <= 350 ms, p95 <= 700 ms, max 1.2 s",
        numeric: true,
      },
      evidence: "ledger",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvFirstResponseP50Ms" },
        { source: "budget-record", key: "dvFirstResponseP95Ms" },
        { source: "budget-record", key: "dvFirstResponseMaxMs" },
      ],
    },
    {
      id: "T2",
      statement: "Substantive response start",
      bar: { text: "p50 <= 900 ms, p95 <= 1.8 s, max 2.5 s", numeric: true },
      evidence: "ledger",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvSubstantiveResponseP50Ms" },
        { source: "budget-record", key: "dvSubstantiveResponseP95Ms" },
        { source: "budget-record", key: "dvSubstantiveResponseMaxMs" },
      ],
    },
    {
      id: "T3",
      statement: "Barge-in stop",
      bar: { text: "p95 <= 300 ms, max 500 ms", numeric: true },
      evidence: "wav",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvBargeInStopP95Ms" },
        { source: "budget-record", key: "dvBargeInStopMaxMs" },
      ],
    },
    {
      id: "T4",
      statement: "Filler and backchannel never create a turn",
      bar: { text: "answered 0x", numeric: true },
      evidence: "ledger",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvFillerTurnMaxCount" }],
    },
    {
      id: "T5",
      statement: "Resume after a filler cut",
      bar: { text: "<= 400 ms, no repeat", numeric: true },
      evidence: "wav",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvFillerResumeMaxMs" }],
    },
    {
      id: "T6",
      statement: "Interruption at a clause boundary",
      bar: { text: "resume or answer, never restart from the top", numeric: true },
      evidence: "wav",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvRestartFromTopMaxCount" }],
    },
    {
      id: "T7",
      statement: "Overlap causes no double playback and no lost turn",
      bar: { text: "0 doubled frames, 0 lost finals", numeric: true },
      evidence: "wav",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvDoubledFramesMaxCount" },
        { source: "budget-record", key: "dvLostFinalMaxCount" },
      ],
    },
    {
      id: "T8",
      statement: "Dead air without a bridge",
      bar: { text: "never > 700 ms", numeric: true },
      evidence: "wav",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvDeadAirWithoutBridgeMaxMs" }],
    },
    {
      id: "T9",
      statement: "Endpointing",
      bar: { text: "premature cut <= 3% of turns; missed end <= 500 ms", numeric: true },
      evidence: "trace",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvPrematureCutMaxRatio" },
        { source: "budget-record", key: "dvMissedEndMaxMs" },
      ],
    },
    {
      id: "T10",
      statement: "No reply starts while the caller speaks",
      bar: { text: "0 violations", numeric: true },
      evidence: "wav",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvReplyWhileCallerSpeaksMaxCount" }],
    },
  ],
};

export default turnTaking;
