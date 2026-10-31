/**
 * Frozen demo-scoreboard budgets: the single table every gate threshold
 * derives from. The numbers are quotations of the pipeline's own bars (the
 * stop-over 1.5s cut, the 2.5s resume tail, the 15s check-in, the 400ms
 * overlap bar, the ADR-0005 drain handshake), never fresh tuning.
 *
 * A threshold edit is a spec change, not a test fix. It must move this
 * table, the matching GOLDEN_SCRIPT window, the pinned expectation in
 * scoreboard.test.ts, and the committed record in
 * `scoreboard-budgets.json` together — the freeze guard fails otherwise.
 */

export type BudgetUnit =
  | "ms"
  | "s"
  | "count"
  | "ratio"
  | "db"
  | "dbtp"
  | "lufs"
  | "usd";

export type BudgetEntry = {
  value: number;
  unit: BudgetUnit;
  /** The gate (or beat) this number guards. */
  gate: string;
  /** Spec story, ADR, or pipeline contract the number quotes. */
  source: string;
};

const BUDGETS = {
  goldenScriptBudgetS: {
    value: 90,
    unit: "s",
    gate: "golden-script",
    source: "spec: one locked 90s property-inquiry Demo call",
  },
  replyGapP50Ms: {
    value: 1500,
    unit: "ms",
    gate: "reply-gap",
    source: "spec story 2: median reply gap feels snappy",
  },
  replyGapP95Ms: {
    value: 2500,
    unit: "ms",
    gate: "reply-gap",
    source: "spec story 2: tail reply gap stays under 2.5s",
  },
  realCutMs: {
    value: 1500,
    unit: "ms",
    gate: "barge-in-cut",
    source: "eval stop-over contract: cut within 1.5s of caller speech start",
  },
  fillerResumeTailMs: {
    value: 2500,
    unit: "ms",
    gate: "filler-resume",
    source: "spec story 6: exact unheard tail resumes within 2.5s",
  },
  overheardAsidesMin: {
    value: 1,
    unit: "count",
    gate: "overheard-recall",
    source: "spec stories 7-8: every aside marked Overheard speech and ledger-counted",
  },
  overheardAsidesMax: {
    value: 1,
    unit: "count",
    gate: "overheard-recall",
    source: "spec stories 7-8: one aside in the golden script",
  },
  deadAirMaxMs: {
    value: 2000,
    unit: "ms",
    gate: "dead-air",
    source: "spec story 12: no uncovered silence past 2s",
  },
  silenceCheckInTargetMs: {
    value: 15_000,
    unit: "ms",
    gate: "dead-air",
    source: "voni-agent SILENCE_CHECK_IN_MS: check-in only after 15s free-floor silence",
  },
  silenceCheckInMaxMs: {
    value: 18_000,
    unit: "ms",
    gate: "dead-air",
    source: "spec story 13: exactly one check-in inside the 15-18s window",
  },
  emailTagMentionsMin: {
    value: 1,
    unit: "count",
    gate: "email-invite",
    source: "spec story 18: the Test tag is said exactly once",
  },
  emailTagMentionsMax: {
    value: 1,
    unit: "count",
    gate: "email-invite",
    source: "spec story 18: the Test tag is never repeated",
  },
  doubleTalkMaxOverlapMs: {
    value: 400,
    unit: "ms",
    gate: "double-talk",
    source: "spec story 11: audible overlap stays brief (barge-in judge bar)",
  },
  doubleTalkFadeOutS: {
    value: 0.04,
    unit: "s",
    gate: "double-talk",
    source: "session FADE_OUT_S: a cut ramps to silence, never a hard stop",
  },
  endCallPollMs: {
    value: 250,
    unit: "ms",
    gate: "end-call-drain",
    source: "ADR-0005 holdUntilReplyDone: drain settle poll",
  },
  endCallSettlePolls: {
    value: 3,
    unit: "count",
    gate: "end-call-drain",
    source: "ADR-0005 holdUntilReplyDone: settled-streak polls",
  },
  endCallAudioGraceMs: {
    value: 500,
    unit: "ms",
    gate: "end-call-drain",
    source: "ADR-0005 holdUntilReplyDone: audio grace after the last frame",
  },
  endCallDrainTimeoutMs: {
    value: 10_000,
    unit: "ms",
    gate: "end-call-drain",
    source: "ADR-0005 holdUntilReplyDone: drain timeout",
  },
  goodbyeAudioCoverageMin: {
    value: 0.8,
    unit: "ratio",
    gate: "end-call-drain",
    source: "spec story 15: the closing line plays in full (>=80%)",
  },
  hangUpAfterGoodbyeMaxMs: {
    value: 1500,
    unit: "ms",
    gate: "end-call-drain",
    source: "spec story 16: End call closes within 1.5s of goodbye audio end",
  },
  timbreReferenceLufs: {
    value: -23.1,
    unit: "lufs",
    gate: "timbre-probes",
    source: "voice registry: anna reference loudness",
  },
  timbreLufsToleranceDb: {
    value: 1.5,
    unit: "db",
    gate: "timbre-probes",
    source: "spec story 25: voices match loudness through registry gain only",
  },
  timbreProbeMaxCount: {
    value: 0,
    unit: "count",
    gate: "timbre-probes",
    source: "spec story 25: zero clip/jump/overload/underrun/input-drop probes",
  },
  popJumpInt16: {
    value: 9830,
    unit: "count",
    gate: "timbre-probes",
    source: "playout POP_JUMP 0.3 full scale in int16 steps (Math.round(0.3 * 32767))",
  },
  humanRatersRequired: {
    value: 2,
    unit: "count",
    gate: "accent-human",
    source: "spec testing decisions: at least two independent blind raters",
  },
  humanRatingScaleMin: {
    value: 1,
    unit: "count",
    gate: "accent-human",
    source: "blind ballot scale 1-5",
  },
  humanRatingScaleMax: {
    value: 5,
    unit: "count",
    gate: "accent-human",
    source: "blind ballot scale 1-5",
  },
  // W0 verdict bars (ticket 15). New records only: the demo-scoreboard
  // thresholds above are untouched, so a green there keeps its meaning.
  comparisonLevelLu: {
    value: 1.5,
    unit: "db",
    gate: "audio-comparison",
    source: "spec W0 comparison + story 7: a level step above 1.5 LU is a different loudness, not a re-encode",
  },
  comparisonModulationDepth: {
    value: 0.05,
    unit: "ratio",
    gate: "audio-comparison",
    source: "envelope-modulation module bar: 5% peak-to-trough is the smallest detectable cushion artifact",
  },
  // Coupled pair: this and timbreMeasuredBandDeltaDb judge the same timbre
  // defect (an octave tilt a re-encode does not make) on two captures. Keep
  // them equal; the freeze test asserts the pair so the bars cannot drift.
  comparisonBandDeltaDb: {
    value: 3,
    unit: "db",
    gate: "audio-comparison",
    source: "spec W0: an octave tilt move above 3 dB is a timbre change a re-encode does not make",
  },
  comparisonDistortionDb: {
    value: -45,
    unit: "db",
    gate: "audio-comparison",
    source: "ticket 14 probe: a 1% third harmonic reads -40 dB, so -45 dB separates a clean re-encode from reshaping with margin",
  },
  comparisonDistortionDeltaDb: {
    value: 3,
    unit: "db",
    gate: "audio-comparison",
    source: "spec W0: the delivered residual may not rise more than 3 dB above the platform's against the same reference",
  },
  comparisonBreakupCount: {
    value: 1,
    unit: "count",
    gate: "audio-comparison",
    source: "spec stories 4, 12: one inserted silence in a capture the other does not have is a hole",
  },
  comparisonOnsetToleranceS: {
    value: 0.05,
    unit: "s",
    gate: "audio-comparison",
    source: "spec W0: captures more than 50 ms apart cannot be compared sample-for-sample; a lead-in is reported, never blamed",
  },
  comparisonModelTextWordChanges: {
    value: 0,
    unit: "count",
    gate: "audio-comparison",
    source: "spec W0: the platform transcript must be the intended line before any audio layer is attributed",
  },
  comparisonReferenceClipDbtp: {
    value: -0.1,
    unit: "db",
    gate: "audio-comparison",
    source: "spec W0: a reference at the full-scale ceiling cannot be the baseline for peak or distortion",
  },
  // W5 timbre gate bars (voice-parity ticket 74). New records only: the
  // comparison and scoreboard thresholds above are untouched, so a green
  // there keeps its meaning. Each is the bar the measured result is judged
  // against, never a value re-derived from the pipeline.
  timbreMeasuredTruePeakDbtp: {
    value: -1,
    unit: "dbtp",
    gate: "timbre-probes",
    source: "spec W5: delivered true peak keeps 1 dBTP of encode headroom; a peak at the ceiling is a clip risk, not parity",
  },
  // Coupled pair: this and comparisonDistortionDb are the same clean-file
  // residual bar measured on two captures (delivered vs the platform's). Keep
  // them equal; the freeze test asserts the pair so the bars cannot drift.
  timbreMeasuredDistortionDb: {
    value: -45,
    unit: "db",
    gate: "timbre-probes",
    source: "ticket 14 probe: a 1% third harmonic reads -40 dB, so -45 dB separates a clean delivery from reshaping with margin",
  },
  timbreMeasuredCrestMin: {
    value: 1.2,
    unit: "ratio",
    gate: "timbre-probes",
    source: "ticket 14: crest 1.2 sits between a square wave (1.0) and a sine (1.414), the lowest crest a clean voiced signal shows",
  },
  timbreMeasuredBandDeltaDb: {
    value: 3,
    unit: "db",
    gate: "timbre-probes",
    source: "spec W0/W5: a band-to-band move above 3 dB is a timbre change a re-encode does not make",
  },
  timbreMeasuredBreakupMax: {
    value: 0,
    unit: "count",
    gate: "timbre-probes",
    source: "spec stories 4, 12 and W5: an inserted silence the reference does not have is a hole; the delivered cut carries none",
  },
  timbreMeasuredBreakupMatchSeconds: {
    value: 0.05,
    unit: "s",
    gate: "timbre-probes",
    source: "timbre-measurement.ts: two breakups within 50 ms are the same hole in both captures, so only an unmatched hole counts",
  },
  // W6 floor-mode bars (review fix): the driver's comparison tolerances moved
  // here from floor-mode.ts so every quality bar has one record. New records
  // only: the W0/W5 bars above are untouched.
  floorLevelDeviationLu: {
    value: 0.2,
    unit: "db",
    gate: "vendor-floor",
    source: "level-facts.ts LEVEL_TOLERANCE_DB: EBU Tech 3341 ±0.1 LU widened a tenth for 16-bit captures",
  },
  floorPeakHeadroomDb: {
    value: 0.3,
    unit: "db",
    gate: "vendor-floor",
    source: "level-facts.ts TRUE_PEAK_TOLERANCE_DB: the 4x-oversampled true-peak estimate's own resolution",
  },
  floorDistortionResidualDb: {
    value: -60,
    unit: "db",
    gate: "vendor-floor",
    source: "distortion-crest.ts DEFAULT_DISTORTION_CREST_THRESHOLDS.maxResidualDb: the clean-file residual bar",
  },
  floorBreakupSeconds: {
    value: 0.02,
    unit: "s",
    gate: "vendor-floor",
    source: "floor-mode.ts: breakups are found on 10 ms envelope frames; two frames absorb one edge frame",
  },
  floorModulationDepth: {
    value: 0.01,
    unit: "ratio",
    gate: "vendor-floor",
    source: "floor-mode.ts: one percentage point of peak-to-trough swing, twice the modulation metric's 0.5% detection floor",
  },
  timbreBallotWeightTimbre: {
    value: 0.5,
    unit: "ratio",
    gate: "timbre-probes",
    source: "spec W5: the timbre gate weights timbre half of the weighted ballot (the axis this gate claims)",
  },
  timbreBallotWeightAccent: {
    value: 0.25,
    unit: "ratio",
    gate: "timbre-probes",
    source: "spec W5: accent is one quarter of the weighted ballot, equal to language naturalness",
  },
  timbreBallotWeightLanguageNaturalness: {
    value: 0.25,
    unit: "ratio",
    gate: "timbre-probes",
    source: "spec W5: language naturalness is one quarter of the weighted ballot (ticket 75 wires the axis; the weight is fixed here)",
  },
  timbreBallotPassScore: {
    value: 5,
    unit: "count",
    gate: "timbre-probes",
    source: "spec W5: a subject passes timbre at five out of five, never at four",
  },
  timbreBallotRatersRequired: {
    value: 2,
    unit: "count",
    gate: "timbre-probes",
    source: "spec W5/testing: two independent raters on one shared recording per subject",
  },

  // Demo-verification contract bars (ticket 06). New records only: every
  // budget above is untouched, so a scoreboard green keeps its meaning. The
  // contract registry references these keys and never restates a value. A bar
  // edit is a spec change: move this table, the JSON record, the pinned
  // expectation in scoreboard.test.ts and the contract bar record together.
  dvRingbackAfterAnswerMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L1",
    source: "demo-verification spec L1: ringback after the answer",
  },
  dvRingbackOnHoldReturnMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L1",
    source: "demo-verification spec L1: ringback on a hold return",
  },
  dvConnectedBeforeAdmissionMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L2",
    source: "demo-verification spec L2: a connected mark before pipeline admission",
  },
  dvChimeCountExact: {
    value: 1,
    unit: "count",
    gate: "contract/L3",
    source: "demo-verification spec L3: exactly one chime at the first audible greeting sample",
  },
  dvChimeWindowMs: {
    value: 300,
    unit: "ms",
    gate: "contract/L3",
    source: "demo-verification spec L3: the chime lands within 300 ms of the first audible sample",
  },
  dvGreetingFirstAudioP95Ms: {
    value: 2000,
    unit: "ms",
    gate: "contract/L4",
    source: "demo-verification spec L4: greeting first audio p95 <= 2 s after connected",
  },
  dvGreetingFirstAudioMaxMs: {
    value: 3000,
    unit: "ms",
    gate: "contract/L4",
    source: "demo-verification spec L4: greeting first audio max 3 s after connected",
  },
  dvConfigAfterMicMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L5",
    source: "demo-verification spec L5: a config frame sent after mic-acquired",
  },
  dvTtsOpenMaxMs: {
    value: 3000,
    unit: "ms",
    gate: "contract/L6",
    source: "demo-verification spec L6: bounded TTS open, else the named unavailable state",
  },
  dvGreetingContinuousMaxMs: {
    value: 4000,
    unit: "ms",
    gate: "contract/L7",
    source: "demo-verification spec L7: one human breath, <= 4 s continuous or a natural split",
  },
  dvClockStartBeforeAudioMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L8",
    source: "demo-verification spec L8: a talk clock started before first audible audio",
  },
  dvGoodbyePlayedRatioMin: {
    value: 1,
    unit: "ratio",
    gate: "contract/L9",
    source: "demo-verification spec L9: a started goodbye fully audible (100% played)",
  },
  dvDropAfterLastSampleMaxMs: {
    value: 300,
    unit: "ms",
    gate: "contract/L9/C7",
    source: "demo-verification spec L9/C7: line drop <= 300 ms after the last goodbye sample",
  },
  dvSilentEndMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L10",
    source: "demo-verification spec L10: a silent end after a failed greeting",
  },
  dvEndEndCallDivergenceMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/L11",
    source: "demo-verification spec L11: end/end_call divergence",
  },
  dvFirstResponseP50Ms: {
    value: 350,
    unit: "ms",
    gate: "contract/T1",
    source: "demo-verification spec T1: first response p50 <= 350 ms",
  },
  dvFirstResponseP95Ms: {
    value: 700,
    unit: "ms",
    gate: "contract/T1",
    source: "demo-verification spec T1: first response p95 <= 700 ms",
  },
  dvFirstResponseMaxMs: {
    value: 1200,
    unit: "ms",
    gate: "contract/T1",
    source: "demo-verification spec T1: first response max 1.2 s",
  },
  dvSubstantiveResponseP50Ms: {
    value: 900,
    unit: "ms",
    gate: "contract/T2",
    source: "demo-verification spec T2: substantive response p50 <= 900 ms",
  },
  dvSubstantiveResponseP95Ms: {
    value: 1800,
    unit: "ms",
    gate: "contract/T2",
    source: "demo-verification spec T2: substantive response p95 <= 1.8 s",
  },
  dvSubstantiveResponseMaxMs: {
    value: 2500,
    unit: "ms",
    gate: "contract/T2",
    source: "demo-verification spec T2: substantive response max 2.5 s",
  },
  dvBargeInStopP95Ms: {
    value: 300,
    unit: "ms",
    gate: "contract/T3",
    source: "demo-verification spec T3: barge-in stop p95 <= 300 ms",
  },
  dvBargeInStopMaxMs: {
    value: 500,
    unit: "ms",
    gate: "contract/T3",
    source: "demo-verification spec T3: barge-in stop max 500 ms",
  },
  dvFillerTurnMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/T4",
    source: "demo-verification spec T4: a filler or backchannel answered as a turn",
  },
  dvFillerResumeMaxMs: {
    value: 400,
    unit: "ms",
    gate: "contract/T5",
    source: "demo-verification spec T5: resume after a filler cut <= 400 ms, no repeat",
  },
  dvRestartFromTopMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/T6",
    source: "demo-verification spec T6: an interruption restarted from the top",
  },
  dvDoubledFramesMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/T7",
    source: "demo-verification spec T7: doubled playback frames under overlap",
  },
  dvLostFinalMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/T7",
    source: "demo-verification spec T7: lost caller finals under overlap",
  },
  dvDeadAirWithoutBridgeMaxMs: {
    value: 700,
    unit: "ms",
    gate: "contract/T8",
    source: "demo-verification spec T8: dead air without a bridge never exceeds 700 ms",
  },
  dvPrematureCutMaxRatio: {
    value: 0.03,
    unit: "ratio",
    gate: "contract/T9",
    source: "demo-verification spec T9: premature endpoint cut <= 3% of turns",
  },
  dvMissedEndMaxMs: {
    value: 500,
    unit: "ms",
    gate: "contract/T9",
    source: "demo-verification spec T9: missed end <= 500 ms",
  },
  dvReplyWhileCallerSpeaksMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/T10",
    source: "demo-verification spec T10: a reply that starts while the caller speaks",
  },
  dvUnilateralEndMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C1",
    source: "demo-verification spec C1: an end not caused by caller, clock, budget or unrecoverable failure",
  },
  dvGreetingOnlyOpenMinS: {
    value: 30,
    unit: "s",
    gate: "contract/C2",
    source: "demo-verification spec C2: a greeting-only call stays open at least 30 s",
  },
  dvClarificationLoopMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C3",
    source: "demo-verification spec C3: a clarification loop",
  },
  dvInventedMeaningMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C3",
    source: "demo-verification spec C3: invented meaning on nonsense",
  },
  dvHostilityHangUpMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C4",
    source: "demo-verification spec C4: a hang-up under hostility",
  },
  dvVerbatimRepeatMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C5",
    source: "demo-verification spec C5: a verbatim repeated line within a call",
  },
  dvToolNarrationMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C6",
    source: "demo-verification spec C6: a narrated tool call",
  },
  dvUndoneWorkClaimMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C6",
    source: "demo-verification spec C6: a claim of work not done",
  },
  dvPostEndAudioMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/C8",
    source: "demo-verification spec C8: narration or audio after the end signal",
  },
  dvSpelledEmailMismatchMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K1",
    source: "demo-verification spec K1: a spelled email reconstructed inexactly",
  },
  dvNumberReadbackMismatchMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K2",
    source: "demo-verification spec K2: a number read back incorrectly",
  },
  dvAmbiguityGuessMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K4",
    source: "demo-verification spec K4: a guess where ambiguity needed one targeted question",
  },
  dvEnglishLeakMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K5",
    source: "demo-verification spec K5: an English leak in a non-English Locale",
  },
  dvInventedFactMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K7",
    source: "demo-verification spec K7: an invented fact",
  },
  dvTranscriptEntityMismatchMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/K8",
    source: "demo-verification spec K8: an entity mismatch between transcript and delivered audio",
  },
  dvToolDecisionMaxMs: {
    value: 300,
    unit: "ms",
    gate: "contract/X1",
    source: "demo-verification spec X1: tool decision <= 300 ms after turn end",
  },
  dvToolBridgeMaxMs: {
    value: 700,
    unit: "ms",
    gate: "contract/X2",
    source: "demo-verification spec X2: a spoken bridge when a tool exceeds 700 ms",
  },
  dvToolContinuationP95Ms: {
    value: 2000,
    unit: "ms",
    gate: "contract/X3",
    source: "demo-verification spec X3: result plus spoken continuation p95 <= 2 s",
  },
  dvToolSilenceMaxMs: {
    value: 3000,
    unit: "ms",
    gate: "contract/X3",
    source: "demo-verification spec X3: a tool turn silent for more than 3 s fails",
  },
  dvPersonalDomainGateCount: {
    value: 1,
    unit: "count",
    gate: "contract/X5",
    source: "demo-verification spec X5: the personal-domain email gate fires exactly once",
  },
  dvToolResultSpokenMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/X9",
    source: "demo-verification spec X9: a tool result or secret spoken aloud",
  },
  dvDropoutMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A1",
    source: "demo-verification spec A1: a dropout longer than 20 ms, a click or a seam",
  },
  dvAudioFormatMismatchMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A2",
    source: "demo-verification spec A2: a sample-rate or format mismatch end-to-end",
  },
  dvEchoAsCallerSpeechMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A4",
    source: "demo-verification spec A4: agent echo returned as caller speech",
  },
  dvPlayoutUnderrunMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A6",
    source: "demo-verification spec A6: a playout underrun",
  },
  dvPlayoutOverrunMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A6",
    source: "demo-verification spec A6: a playout overrun",
  },
  dvBargeInFadeMaxMs: {
    value: 120,
    unit: "ms",
    gate: "contract/A7",
    source: "demo-verification spec A7: a barge-in fade longer than 120 ms",
  },
  dvBargeInPopMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A7",
    source: "demo-verification spec A7: a pop at the barge-in fade",
  },
  dvSilentFrameMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/A8",
    source: "demo-verification spec A8: a silent frame sent as audio",
  },
  dvJitterLostTurnMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/R1",
    source: "demo-verification spec R1: a turn lost under jitter and loss",
  },
  dvJitterDoubledAudioMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/R1",
    source: "demo-verification spec R1: doubled audio under jitter and loss",
  },
  dvPromptLeakMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/S1",
    source: "demo-verification spec S1: a prompt or secret revealed by injection",
  },
  dvCrossSubjectToolCallMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/S2",
    source: "demo-verification spec S2: a tool call for another subject or call",
  },
  dvPiiBeyondContractMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/S4",
    source: "demo-verification spec S4: caller PII in traces beyond the contract",
  },
  dvCredentialLeakMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/S5",
    source: "demo-verification spec S5: a credential in client frames or logs",
  },
  dvCrossCallMemoryLeakMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/S6",
    source: "demo-verification spec S6: a cross-call memory leak",
  },
  dvCostPerCallMaxUsd: {
    value: 0.15,
    unit: "usd",
    gate: "contract/E2",
    source: "demo-verification spec E2: cost per demo call <= $0.15",
  },
  dvCostFastRunMaxUsd: {
    value: 2,
    unit: "usd",
    gate: "contract/E3",
    source: "demo-verification spec E3: fast-contract run ceiling <= $2",
  },
  dvCostNightlyRunMaxUsd: {
    value: 10,
    unit: "usd",
    gate: "contract/E3",
    source: "demo-verification spec E3: nightly-health run ceiling <= $10",
  },
  dvCostFullRunMaxUsd: {
    value: 30,
    unit: "usd",
    gate: "contract/E3",
    source: "demo-verification spec E3: full-certification run ceiling <= $30",
  },
  dvBudgetStopMaxCount: {
    value: 0,
    unit: "count",
    gate: "contract/E4",
    source: "demo-verification spec E4: a budget stop on the golden path",
  },
  dvStayOnCallYesMinRatio: {
    value: 0.8,
    unit: "ratio",
    gate: "contract/H1",
    source: "demo-verification spec H1: >= 80% would stay on the call",
  },
  dvStayOnCallLocaleMinRatio: {
    value: 0.7,
    unit: "ratio",
    gate: "contract/H1",
    source: "demo-verification spec H1: no Locale below 70% would stay",
  },
  dvHumanDetectionMinRatio: {
    value: 0.4,
    unit: "ratio",
    gate: "contract/H2",
    source: "demo-verification spec H2: blind A/B human detection >= 40%",
  },
  dvHumanDetectionMaxRatio: {
    value: 0.6,
    unit: "ratio",
    gate: "contract/H2",
    source: "demo-verification spec H2: blind A/B human detection <= 60%",
  },
  dvHumanDetectionMinJudgments: {
    value: 40,
    unit: "count",
    gate: "contract/H2",
    source: "demo-verification spec H2: at least 40 blind A/B judgments per Locale",
  },
  dvSoundsHumanMedianMin: {
    value: 4,
    unit: "count",
    gate: "contract/H3",
    source: "demo-verification spec H3: sounds-human median >= 4",
  },
  dvSoundsHumanCallMin: {
    value: 3,
    unit: "count",
    gate: "contract/H3",
    source: "demo-verification spec H3: no call rated below 3",
  },
  dvTurnTakingMedianMin: {
    value: 4,
    unit: "count",
    gate: "contract/H4",
    source: "demo-verification spec H4: turn-taking naturalness median >= 4",
  },
  dvAgentNotPreferredMaxRatio: {
    value: 0.4,
    unit: "ratio",
    gate: "contract/H5",
    source: "demo-verification spec H5: agent not preferred < 40%",
  },
  dvJudgeKappaMin: {
    value: 0.65,
    unit: "ratio",
    gate: "contract/H6",
    source: "demo-verification spec H6: weighted kappa >= 0.65, else unverified",
  },
} as const satisfies Record<string, BudgetEntry>;

/** The one table. Gate constants in scoreboard.ts derive from these values. */
export const SCOREBOARD_BUDGETS = Object.freeze(BUDGETS);

export type BudgetKey = keyof typeof SCOREBOARD_BUDGETS;

/** Flat key → number view used by the freeze guard and the committed record. */
export function budgetValues(
  table: Readonly<Record<string, { value: number }>> = SCOREBOARD_BUDGETS,
): Record<string, number> {
  return Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, entry.value]));
}

export type BudgetDriftReason = "changed" | "missing" | "extra";

export type BudgetDrift = {
  key: string;
  table: number | null;
  record: number | null;
  reason: BudgetDriftReason;
};

/**
 * Compare the live budget table against the committed record. A threshold
 * edit alone shows up as `changed`; a budget dropped from either side shows
 * up as `missing`/`extra`. Empty means frozen.
 */
export function checkBudgetFreeze(
  table: Readonly<Record<string, number>>,
  record: Readonly<Record<string, number>>,
): BudgetDrift[] {
  const keys = [...new Set([...Object.keys(table), ...Object.keys(record)])].sort();
  const drift: BudgetDrift[] = [];
  for (const key of keys) {
    const inTable = Object.hasOwn(table, key);
    const inRecord = Object.hasOwn(record, key);
    if (!inRecord) {
      drift.push({ key, table: inTable ? table[key] : null, record: null, reason: "missing" });
    } else if (!inTable) {
      drift.push({ key, table: null, record: record[key], reason: "extra" });
    } else if (table[key] !== record[key]) {
      drift.push({ key, table: table[key], record: record[key], reason: "changed" });
    }
  }
  return drift;
}

/** The timing window a golden beat must land in, quoted from the budget table. */
export type GoldenWindowBudget = {
  metric: string;
  unit: "ms" | "count";
  min: number;
  max: number;
};

/**
 * The GOLDEN_SCRIPT windows reconstructed from the budget table. The script
 * keeps its windows as independent literals on purpose: this expectation is
 * what the test compares them against, so editing either side alone fails.
 */
export function goldenWindowExpectations(): Record<string, GoldenWindowBudget> {
  const b = SCOREBOARD_BUDGETS;
  return {
    "greeting-cut": { metric: "cut-latency", unit: "ms", min: 0, max: b.realCutMs.value },
    "filler-ignored": {
      metric: "resume-tail-latency",
      unit: "ms",
      min: 0,
      max: b.fillerResumeTailMs.value,
    },
    "real-cut-answered": {
      metric: "cut-to-answer-latency",
      unit: "ms",
      min: 0,
      max: b.realCutMs.value,
    },
    "overheard-aside": {
      metric: "asides-recalled",
      unit: "count",
      min: b.overheardAsidesMin.value,
      max: b.overheardAsidesMax.value,
    },
    "silence-check-in": {
      metric: "check-in-at-silence",
      unit: "ms",
      min: b.silenceCheckInTargetMs.value,
      max: b.silenceCheckInMaxMs.value,
    },
    "email-invite": {
      metric: "tag-mentions",
      unit: "count",
      min: b.emailTagMentionsMin.value,
      max: b.emailTagMentionsMax.value,
    },
    "goodbye-drain": {
      metric: "hang-up-after-goodbye-audio",
      unit: "ms",
      min: 0,
      max: b.hangUpAfterGoodbyeMaxMs.value,
    },
  };
}

export type GoldenWindowContract = {
  beat: string;
  window: { metric: string; unit: string; min: number; max: number };
};

export type GoldenWindowDrift = {
  beat: string;
  field: "metric" | "unit" | "min" | "max" | "missing" | "extra";
  script: string | number | null;
  budget: string | number | null;
};

/** Compare the locked script's windows with the budget table; empty means frozen. */
export function checkGoldenWindows(
  script: readonly GoldenWindowContract[],
  expected: Record<string, GoldenWindowBudget> = goldenWindowExpectations(),
): GoldenWindowDrift[] {
  const byBeat = new Map(script.map((beat) => [beat.beat, beat.window]));
  const beats = [...new Set([...byBeat.keys(), ...Object.keys(expected)])].sort();
  const drift: GoldenWindowDrift[] = [];
  for (const beat of beats) {
    const window = byBeat.get(beat);
    const budget = expected[beat];
    if (!window) {
      drift.push({ beat, field: "missing", script: null, budget: budget.max });
      continue;
    }
    if (!budget) {
      drift.push({ beat, field: "extra", script: window.max, budget: null });
      continue;
    }
    for (const field of ["metric", "unit", "min", "max"] as const) {
      if (window[field] !== budget[field]) {
        drift.push({ beat, field, script: window[field], budget: budget[field] });
      }
    }
  }
  return drift;
}
