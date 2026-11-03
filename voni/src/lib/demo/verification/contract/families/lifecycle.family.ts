import type { ContractFamily } from "../types";

/**
 * Lifecycle and connect. Spec table "Lifecycle and connect", L1–L11.
 * Evidence is the browser unless the trace or delivered WAV is the only place
 * the event exists; every number is a frozen-record key.
 */
const lifecycle: ContractFamily = {
  family: "lifecycle",
  title: "Lifecycle and connect",
  properties: [
    {
      id: "L1",
      statement: "Ringback only while genuinely connecting; stops at the answer",
      bar: { text: "no ringback after answer; none on hold return", numeric: true },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvRingbackAfterAnswerMaxCount" },
        { source: "budget-record", key: "dvRingbackOnHoldReturnMaxCount" },
      ],
    },
    {
      id: "L2",
      statement: '"Connected" never precedes pipeline admission',
      bar: { text: "connected mark at or after admission", numeric: true },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvConnectedBeforeAdmissionMaxCount" }],
    },
    {
      id: "L3",
      statement: "Chime exactly once at first audible greeting sample",
      bar: { text: "1x, within 300 ms", numeric: true },
      evidence: "browser",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvChimeCountExact" },
        { source: "budget-record", key: "dvChimeWindowMs" },
      ],
    },
    {
      id: "L4",
      statement: 'Greeting first audio after "connected"',
      bar: { text: "p95 <= 2 s, max 3 s", numeric: true },
      evidence: "browser",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvGreetingFirstAudioP95Ms" },
        { source: "budget-record", key: "dvGreetingFirstAudioMaxMs" },
      ],
    },
    {
      id: "L5",
      statement: "Config does not wait for mic permission; warm-up overlaps it",
      bar: { text: "config sent before mic-acquired", numeric: true },
      evidence: "trace",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvConfigAfterMicMaxCount" }],
    },
    {
      id: "L6",
      statement: "TTS open is bounded",
      bar: { text: "<= 3 s, else named unavailable state", numeric: true },
      evidence: "trace",
      kind: "timing",
      thresholds: [{ source: "budget-record", key: "dvTtsOpenMaxMs" }],
    },
    {
      id: "L7",
      statement: "Greeting is one human breath",
      bar: { text: "<= 4 s continuous, or a natural split", numeric: true },
      evidence: "wav",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvGreetingContinuousMaxMs" }],
    },
    {
      id: "L8",
      statement: "Talk clock starts at first agent audio",
      bar: { text: "clock start at or after first audible", numeric: true },
      evidence: "ledger",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvClockStartBeforeAudioMaxCount" }],
    },
    {
      id: "L9",
      statement: "A started goodbye is fully audible before teardown",
      bar: { text: "100% played; drop <= 300 ms after last sample", numeric: true },
      evidence: "wav",
      kind: "timing",
      thresholds: [
        { source: "budget-record", key: "dvGoodbyePlayedRatioMin" },
        { source: "budget-record", key: "dvDropAfterLastSampleMaxMs" },
      ],
    },
    {
      id: "L10",
      statement: "A failed greeting shows an honest unavailable state",
      bar: { text: "named state, never a silent end", numeric: true },
      evidence: "browser",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvSilentEndMaxCount" }],
    },
    {
      id: "L11",
      statement: "The client drains on the message production sends",
      bar: { text: "no end/end_call divergence", numeric: true },
      evidence: "trace",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvEndEndCallDivergenceMaxCount" }],
    },
  ],
};

export default lifecycle;
