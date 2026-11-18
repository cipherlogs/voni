/**
 * The burst planner, proved without a network or a k6 Cloud account: the VU
 * arithmetic, the VU-hour budget, the even zone split, and every refusal the
 * card can preview.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_VU_HOURS,
  MAX_VUS,
  US_ZONES,
  describePlan,
  planBurst,
} from "./plan";

const ALL_ZONES = US_ZONES.map((zone) => zone.id);
const ASHBURN = "amazon:us:ashburn";

function planOk(input: {
  clicks: number;
  durationSec: number;
  zoneIds?: string[];
}) {
  const result = planBurst({ zoneIds: ALL_ZONES, ...input });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

function refusal(input: Parameters<typeof planBurst>[0]) {
  const result = planBurst(input);
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) throw new Error("unreachable");
  return result;
}

test("2,000 clicks over 120 s: 25 VUs and 0.83 VU-hours", () => {
  const plan = planOk({ clicks: 2_000, durationSec: 120 });
  assert.equal(plan.vus, 25);
  assert.equal(plan.durationSec, 120);
  assert.equal(plan.clicks, 2_000);
  assert.equal(Number(plan.vuHours.toFixed(2)), 0.83);
});

test("100 clicks over 120 s rounds a fractional VU up, never down", () => {
  // 100 × 1.5 / 120 = 1.25 VUs: one VU would deliver fewer clicks than asked.
  const plan = planOk({ clicks: 100, durationSec: 120 });
  assert.equal(plan.vus, 2);
});

test("16,000 clicks over 120 s: 200 VUs", () => {
  const plan = planOk({ clicks: 16_000, durationSec: 120 });
  assert.equal(plan.vus, 200);
  assert.equal(Number(plan.vuHours.toFixed(1)), 6.7);
});

test("a single click is still one VU", () => {
  assert.equal(planOk({ clicks: 1, durationSec: 3_600 }).vus, 1);
});

test("refuses clicks below one", () => {
  const result = refusal({ clicks: 0, durationSec: 120, zoneIds: ALL_ZONES });
  assert.equal(result.code, "too_few_clicks");
});

test("refuses a window shorter than 30 s", () => {
  const result = refusal({ clicks: 200, durationSec: 5, zoneIds: ALL_ZONES });
  assert.equal(result.code, "too_short");
});

test("refuses a window longer than an hour", () => {
  const result = refusal({ clicks: 200, durationSec: 7_200, zoneIds: ALL_ZONES });
  assert.equal(result.code, "too_long");
});

test("refuses an empty zone list", () => {
  const result = refusal({ clicks: 200, durationSec: 120, zoneIds: [] });
  assert.equal(result.code, "no_zones");
});

test("refuses a zone outside the confirmed US list", () => {
  const result = refusal({
    clicks: 200,
    durationSec: 120,
    zoneIds: [ASHBURN, "amazon:eu:frankfurt"],
  });
  assert.equal(result.code, "unknown_zone");
  assert.match(result.reason, /frankfurt/);
});

test("refuses a request that would spend more than the monthly allowance", () => {
  // 1.5M clicks is 625 VU-hours — a quarter more than the whole month — however
  // the window is sized, because VU-hours is clicks × 1.5 s / 3600.
  const result = refusal({
    clicks: 1_500_000,
    durationSec: 3_600,
    zoneIds: ALL_ZONES,
  });
  assert.equal(result.code, "over_budget");
  assert.match(result.reason, new RegExp(String(FREE_VU_HOURS)));
  assert.match(result.reason, /VU-hour/);
});

test("refuses a burst over the per-run VU ceiling that still fits the budget", () => {
  // 100,000 clicks in 120 s needs 1,250 VUs but only 41.7 VU-hours: the budget
  // is fine, the per-run ceiling is not.
  const result = refusal({
    clicks: 100_000,
    durationSec: 120,
    zoneIds: ALL_ZONES,
  });
  assert.equal(result.code, "too_many_vus");
  assert.match(result.reason, new RegExp(String(MAX_VUS)));
});

test("refuses more clicks than one burst carries, even inside the budget", () => {
  // 200,000 clicks over an hour is only 84 VU-hours, so this is the click
  // ceiling talking, not the allowance.
  const result = refusal({
    clicks: 200_000,
    durationSec: 3_600,
    zoneIds: ALL_ZONES,
  });
  assert.equal(result.code, "over_budget");
  assert.match(result.reason, /at most 100,000 clicks/);
});

test("zone percentages sum to 100 for 1, 3 and 4 zones, remainder first", () => {  const cases: Array<[count: number, expected: number[]]> = [
    [1, [100]],
    [3, [34, 33, 33]],
    [4, [25, 25, 25, 25]],
  ];

  for (const [count, expected] of cases) {
    const zoneIds = ALL_ZONES.slice(0, count);
    const plan = planOk({ clicks: 1_000, durationSec: 120, zoneIds });
    assert.deepEqual(
      plan.zones.map((zone) => zone.percent),
      expected,
      `${count} zone(s)`,
    );
    assert.equal(
      plan.zones.reduce((sum, zone) => sum + zone.percent, 0),
      100,
      `${count} zone(s) sum`,
    );
    assert.deepEqual(
      plan.zones.map((zone) => zone.id),
      zoneIds,
      `${count} zone(s) keep the requested order`,
    );
    assert.equal(plan.zones[0].label, "Ashburn");
  }
});

test("describePlan reads as one sentence with the allowance in it", () => {
  assert.equal(
    describePlan(planOk({ clicks: 2_000, durationSec: 120 })),
    "25 VUs · 2 min · ~2,000 clicks · 0.83 VU-hours of 500",
  );
  assert.equal(
    describePlan(planOk({ clicks: 16_000, durationSec: 120 })),
    "200 VUs · 2 min · ~16,000 clicks · 6.7 VU-hours of 500",
  );
});

test("describePlan prints a sub-minute window in seconds", () => {
  assert.match(
    describePlan(planOk({ clicks: 40, durationSec: 30 })),
    / · 30 s · /,
  );
});
