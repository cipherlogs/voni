/**
 * The demo verification cadence (ticket 30), as one source the workflow, the
 * plan, the CI gate reader and their as-code tests read.
 *
 * The counts are the spec's written coverage, not a tuning knob:
 *
 * - fast: the ten-scenario English contract, one repetition;
 * - nightly: English 43 x 1 plus the Locale core 12 x 1 on es, fr, de, pt;
 * - full: the same 91-call plan at three repetitions, with a panel.
 *
 * At the frozen E2 per-call cap ($0.15) nightly is 91 x $0.15 = $13.65 and
 * full is 273 x $0.15 = $40.95; the amended E3 ceilings are $15 and $45.
 * Changing a number here is a spec change and must move the plan test, the CI
 * gate reader and the docs together. Nothing else may declare these counts:
 * `voni/scripts/lib/verify-cli/plan.ts` and `voni/scripts/demo-gate-report.mjs`
 * import them, and the drift tests fail on a hand-edited copy.
 */

export const FAST_CALLS = 10;

/**
 * The English scenarios a nightly/full run is defined over. The corpus holds
 * the spec's 40 plus the three sealed held-out scenarios `sarcastic`,
 * `distressed` and `mispronounced-email` that completed the eight-name seal.
 */
export const ENGLISH_SCENARIOS = 43;

/** The Locale core, per non-English Locale. */
export const LOCALE_CORE_SCENARIOS = 12;

/** The four non-English Locales the Locale core runs on. */
export const LOCALE_COUNT = 4;

/** Repetitions the spec gives an English and a Locale-core scenario in a full run. */
export const FULL_REPETITIONS = 3;

export const NIGHTLY_CALLS = ENGLISH_SCENARIOS + LOCALE_CORE_SCENARIOS * LOCALE_COUNT;
export const FULL_CALLS = NIGHTLY_CALLS * FULL_REPETITIONS;

export const DEMO_CADENCE = {
  fast: { calls: FAST_CALLS, repetitions: 1 },
  nightly: {
    calls: NIGHTLY_CALLS,
    repetitions: 1,
    englishScenarios: ENGLISH_SCENARIOS,
    localeCoreScenarios: LOCALE_CORE_SCENARIOS,
    locales: LOCALE_COUNT,
  },
  full: { calls: FULL_CALLS, repetitions: FULL_REPETITIONS },
} as const;

/** The wall-clock cadence the scheduled workflows carry. */
export const NIGHTLY_CRON = "17 3 * * *";
export const WEEKLY_FULL_CRON = "23 4 * * 1";
