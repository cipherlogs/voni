import type { ContractFamily } from "../types";

/**
 * Audio. Spec table "Audio", A1–A8. Measured on the delivered WAV; A4 is the
 * one property whose evidence is the transcript (agent echo returning as
 * caller speech), and A3/A5 reuse the existing measured timbre axes rather than
 * inventing parallel bars.
 */
const audio: ContractFamily = {
  family: "audio",
  title: "Audio",
  properties: [
    {
      id: "A1",
      statement: "No dropouts > 20 ms, no clicks, no seams",
      bar: { text: "0", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "dvDropoutMaxCount" },
        { source: "budget-record", key: "floorBreakupSeconds" },
      ],
    },
    {
      id: "A2",
      statement: "Sample rate and format correct end-to-end",
      bar: { text: "exact", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvAudioFormatMismatchMaxCount" }],
    },
    {
      id: "A3",
      statement: "Level within the measured reference band; no pumping",
      bar: { text: "measured axes", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "timbreLufsToleranceDb" },
        { source: "budget-record", key: "comparisonModulationDepth" },
      ],
    },
    {
      id: "A4",
      statement: "Agent echo never returns as caller speech",
      bar: { text: "0", numeric: true },
      evidence: "trace",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvEchoAsCallerSpeechMaxCount" }],
    },
    {
      id: "A5",
      statement: "Timbre matches the voice reference",
      bar: { text: "existing six axes", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "timbreMeasuredTruePeakDbtp" },
        { source: "budget-record", key: "timbreMeasuredDistortionDb" },
        { source: "budget-record", key: "timbreMeasuredCrestMin" },
        { source: "budget-record", key: "timbreMeasuredBandDeltaDb" },
        { source: "budget-record", key: "timbreMeasuredBreakupMax" },
        { source: "budget-record", key: "timbreMeasuredBreakupMatchSeconds" },
      ],
    },
    {
      id: "A6",
      statement: "No playout underrun or overrun",
      bar: { text: "0", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "dvPlayoutUnderrunMaxCount" },
        { source: "budget-record", key: "dvPlayoutOverrunMaxCount" },
      ],
    },
    {
      id: "A7",
      statement: "Barge-in fade smooth and short",
      bar: { text: "<= 120 ms, no pop", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "dvBargeInFadeMaxMs" },
        { source: "budget-record", key: "dvBargeInPopMaxCount" },
      ],
    },
    {
      id: "A8",
      statement: "Silence is not sent as audio",
      bar: { text: "0 silent frames", numeric: true },
      evidence: "wav",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvSilentFrameMaxCount" }],
    },
  ],
};

export default audio;
