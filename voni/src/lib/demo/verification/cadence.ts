/**
 * The demo verification cadence (ticket 30), as one source the workflow and
 * its as-code test read.
 *
 * The counts are the spec's written coverage, not a tuning knob:
 *
 * - fast: the ten-scenario English contract, one repetition;
 * - nightly: English 40 x 1 plus the Locale core 12 x 1 on es, fr, de, pt;
 * - full: the same 88-call plan at three repetitions, with a panel.
 *
 * At the frozen E2 per-call cap ($0.15) nightly is 88 x $0.15 = $13.20 and
 * full is 264 x $0.15 = $39.60; the amended E3 ceilings are $15 and $45.
 * Changing a number here is a spec change and must move the plan test, the CI
 * gate reader and the docs together.
 */

export const FAST_CALLS = 10;
export const NIGHTLY_CALLS = 88;
export const FULL_CALLS = 264;

export const DEMO_CADENCE = {
  fast: { calls: FAST_CALLS, repetitions: 1 },
  nightly: {
    calls: NIGHTLY_CALLS,
    repetitions: 1,
    englishScenarios: 40,
    localeCoreScenarios: 12,
    locales: 4,
  },
  full: { calls: FULL_CALLS, repetitions: 3 },
} as const;

/** The wall-clock cadence the scheduled workflows carry. */
export const NIGHTLY_CRON = "17 3 * * *";
export const WEEKLY_FULL_CRON = "23 4 * * 1";
