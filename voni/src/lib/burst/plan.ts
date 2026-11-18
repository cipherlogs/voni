/**
 * The `/email` burst planner: turn "N clicks over M seconds from these load
 * zones" into the exact VU count, duration and zone distribution a k6 Cloud run
 * needs, and refuse a request that the free tier cannot carry.
 *
 * Pure by design. The card renders `describePlan` on every keystroke from this
 * module, and `saveBurst` in the page's actions validates with the same call,
 * so the preview can never promise a run the dispatch would refuse — the same
 * split `src/lib/email/volume.ts` has with the volume form.
 *
 * Why VU-hours: k6 Cloud's free tier is billed in VU-hours (VUs × hours), not
 * in clicks or runs. One burst that asks for more than the whole monthly
 * allowance can only ever be cancelled, so the planner refuses it up front and
 * the reason names the allowance.
 */

/** One click per VU every 1.5 s — the pace a browser-shaped visit holds up. */
export const SECONDS_PER_CLICK = 1.5;

/** k6 Cloud's practical per-run ceiling on the free tier. */
export const MAX_VUS = 500;

/** The whole monthly k6 Cloud allowance, in VU-hours. */
export const FREE_VU_HOURS = 500;

export const MIN_CLICKS = 1;
export const MAX_CLICKS = 100_000;
export const MIN_DURATION_SEC = 30;
export const MAX_DURATION_SEC = 3_600;

/**
 * The four US load zones Grafana has confirmed for this account. The ids are
 * k6 Cloud's own (`amazon:us:<city>`) and are the only values
 * `options.ext.loadimpact.distribution` accepts; the labels are what the panel
 * shows.
 */
export const US_ZONES = [
  { id: "amazon:us:ashburn", label: "Ashburn" },
  { id: "amazon:us:columbus", label: "Columbus" },
  { id: "amazon:us:palo alto", label: "Palo Alto" },
  { id: "amazon:us:portland", label: "Portland" },
] as const;

export type UsZoneId = (typeof US_ZONES)[number]["id"];

const ZONE_LABELS = new Map<string, string>(
  US_ZONES.map((zone) => [zone.id, zone.label]),
);

export function isUsZone(id: string): id is UsZoneId {
  return ZONE_LABELS.has(id);
}

export type BurstPlan = {
  vus: number;
  durationSec: number;
  clicks: number;
  vuHours: number;
  zones: { id: string; label: string; percent: number }[];
};

export type BurstErrorCode =
  | "too_few_clicks"
  | "too_short"
  | "too_long"
  | "no_zones"
  | "over_budget"
  | "too_many_vus"
  | "unknown_zone";

export type BurstPlanResult =
  | { ok: true; plan: BurstPlan }
  | { ok: false; reason: string; code: BurstErrorCode };

export type BurstInput = {
  clicks: number;
  durationSec: number;
  zoneIds: string[];
};

/**
 * Even split, remainder to the first zone. k6 requires the percentages to sum
 * to exactly 100, and only integers survive that check, so 3 zones become
 * 34/33/33 rather than 33.33 each.
 */
function splitEvenly(count: number): number[] {
  const base = Math.floor(100 / count);
  const percents = Array.from({ length: count }, () => base);
  percents[0] += 100 - base * count;
  return percents;
}

/** Deterministic grouping; the same string on the server and in the browser. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * VU-hours in the precision the number deserves: a fraction of an hour needs
 * two decimals to be non-zero (0.83), a whole VU-hour reads better at one
 * (6.7). Trailing zeros are dropped so 500 does not read as "500.0".
 */
function formatVuHours(value: number): string {
  const digits = value >= 1 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

/** Whole minutes once a run lasts a minute; seconds below that. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Number((seconds / 60).toFixed(1))} min`;
}

/** One sentence for the card: `200 VUs · 2 min · ~16,000 clicks · 6.7 VU-hours of 500`. */
export function describePlan(plan: BurstPlan): string {
  return (
    `${plan.vus} VUs · ${formatDuration(plan.durationSec)} · ` +
    `~${formatCount(plan.clicks)} clicks · ` +
    `${formatVuHours(plan.vuHours)} VU-hours of ${FREE_VU_HOURS}`
  );
}

function fail(code: BurstErrorCode, reason: string): BurstPlanResult {
  return { ok: false, code, reason };
}

/**
 * Validate one burst request.
 *
 * Check order matters twice:
 *   - duration before the zones, so "5 seconds" is reported as a duration
 *     problem even when the form is also empty;
 *   - the VU-hour budget before the VU ceiling and the click ceiling. All three
 *     are refusals, but they mean different things: over budget is "this would
 *     spend more than the month has", over the ceiling is "this single run is
 *     more VUs than the free tier starts", and the click ceiling is "this is
 *     more clicks than one run carries". Budget first keeps the most serious
 *     message, which is also the one no retry fixes.
 */
export function planBurst({
  clicks,
  durationSec,
  zoneIds,
}: BurstInput): BurstPlanResult {
  if (!Number.isInteger(clicks) || clicks < MIN_CLICKS) {
    return fail(
      "too_few_clicks",
      `A burst needs at least ${MIN_CLICKS} click.`,
    );
  }

  // Rounded rather than refused: the card edits minutes, and 0.5 min is 30 s.
  const seconds = Math.round(durationSec);
  if (!Number.isFinite(seconds) || seconds < MIN_DURATION_SEC) {
    return fail(
      "too_short",
      `A burst must last at least ${MIN_DURATION_SEC} seconds.`,
    );
  }
  if (seconds > MAX_DURATION_SEC) {
    return fail(
      "too_long",
      `A burst may last at most ${MAX_DURATION_SEC / 60} minutes.`,
    );
  }

  if (zoneIds.length === 0) {
    return fail("no_zones", "Select at least one US load zone.");
  }
  const unknown = zoneIds.filter((id) => !isUsZone(id));
  if (unknown.length > 0) {
    return fail(
      "unknown_zone",
      `Unknown load zone: ${unknown.join(", ")}. Only the confirmed US zones can be used.`,
    );
  }
  if (new Set(zoneIds).size !== zoneIds.length) {
    return fail(
      "unknown_zone",
      "Each load zone may be selected once; the distribution has to describe distinct zones.",
    );
  }

  // VUs that would deliver the clicks at one every 1.5 s, rounded up so the
  // run is not short of clicks at the end of the window.
  const vus = Math.max(1, Math.ceil((clicks * SECONDS_PER_CLICK) / seconds));
  const vuHours = (vus * seconds) / 3_600;

  // Budget before ceiling, and clicks last. VU-hours is what k6 Cloud bills,
  // and it is what a run cannot get back: a request that would eat the month's
  // allowance is refused for that reason, even when it is also too many VUs or
  // more clicks than one burst carries.
  if (vuHours > FREE_VU_HOURS) {
    return fail(
      "over_budget",
      `${formatVuHours(vuHours)} VU-hours is more than the ${FREE_VU_HOURS} VU-hour ` +
        "monthly k6 Cloud allowance; the run would be cancelled before it finished.",
    );
  }
  if (vus > MAX_VUS) {
    return fail(
      "too_many_vus",
      `${formatCount(vus)} VUs is over the ${MAX_VUS}-VU ceiling one k6 Cloud run ` +
        `can start on the free tier; spread the clicks over a longer window or send fewer.`,
    );
  }
  if (clicks > MAX_CLICKS) {
    return fail(
      "over_budget",
      `A burst carries at most ${formatCount(MAX_CLICKS)} clicks; ` +
        `${formatCount(clicks)} would spend more than one run of the ${FREE_VU_HOURS} VU-hour allowance.`,
    );
  }

  const percents = splitEvenly(zoneIds.length);
  return {
    ok: true,
    plan: {
      vus,
      durationSec: seconds,
      clicks,
      vuHours,
      zones: zoneIds.map((id, index) => ({
        id,
        label: ZONE_LABELS.get(id) ?? id,
        percent: percents[index],
      })),
    },
  };
}
