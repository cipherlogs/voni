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

export type BudgetUnit = "ms" | "s" | "count" | "ratio" | "db" | "lufs";

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
