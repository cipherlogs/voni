/**
 * The volume arithmetic and its gate, proved without Grafana: every interval
 * the panel offers multiplies cleanly by the probe count, and the validator
 * refuses the inputs Grafana would reject or reinterpret.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_TIER_EXECUTIONS_PER_MONTH,
  HIGH_VOLUME_CLICKS_PER_DAY,
  MAX_CLICKS_PER_RUN,
  MAX_PROBES_PER_SAVE,
  US_PROBES,
  clicksPerDay,
  executionsPerMonth,
  FREQUENCY_MINUTES,
  validateVolume,
} from "./volume";

const MINUTE = 60_000;

test("clicks/day: 1, 5, 15 and 60 minutes at 1 and 4 probes", () => {
  const cases: Array<[minutes: number, probes: number, expected: number]> = [
    [1, 1, 1_440],
    [1, 4, 5_760],
    [2, 1, 720],
    [2, 4, 2_880],
    [5, 1, 288],
    [5, 4, 1_152],
    [15, 1, 96],
    [15, 4, 384],
    [60, 1, 24],
    [60, 4, 96],
  ];

  for (const [minutes, probes, expected] of cases) {
    assert.equal(
      clicksPerDay(minutes * MINUTE, probes),
      expected,
      `${minutes} min × ${probes} probe(s)`,
    );
  }
});

test("clicks/day multiplies the clicks one run sends", () => {
  // The 1-minute case is the one that reaches the panel's warnings: four
  // probes at ten clicks each is 57,600 clicks/day.
  const cases: Array<[minutes: number, probes: number, clicks: number, expected: number]> = [
    [1, 1, 10, 14_400],
    [1, 4, 1, 5_760],
    [1, 4, 10, 57_600],
    [5, 4, 3, 3_456],
    [60, 4, 2, 192],
  ];

  for (const [minutes, probes, clicks, expected] of cases) {
    assert.equal(
      clicksPerDay(minutes * MINUTE, probes, clicks),
      expected,
      `${minutes} min × ${probes} probes × ${clicks} clicks`,
    );
  }

  // Absent clicks means one click, not zero: a script without the loop sends one.
  assert.equal(clicksPerDay(5 * MINUTE, 4), 1_152);
});

test("clicks/day: nonsense input is zero, never NaN or Infinity", () => {
  for (const [frequencyMs, probes, clicks] of [
    [0, 4, 1],
    [-1, 4, 1],
    [Number.NaN, 4, 1],
    [Number.POSITIVE_INFINITY, 4, 1],
    [5 * MINUTE, 0, 1],
    [5 * MINUTE, Number.NaN, 1],
    [5 * MINUTE, 4, 0],
    [5 * MINUTE, 4, Number.NaN],
  ] as const) {
    assert.equal(clicksPerDay(frequencyMs, probes, clicks), 0);
  }
});

test("executions/month ignores clicks and counts runs per probe", () => {
  // Grafana bills runs, not clicks: 1-minute on four probes is 172,800/month,
  // over the 100,000 free tier; 5-minute on four probes is 34,560.
  assert.equal(executionsPerMonth(1 * MINUTE, 4), 172_800);
  assert.equal(executionsPerMonth(5 * MINUTE, 4), 34_560);
  assert.equal(executionsPerMonth(5 * MINUTE, 0), 0);
  assert.equal(FREE_TIER_EXECUTIONS_PER_MONTH, 100_000);
  assert.equal(HIGH_VOLUME_CLICKS_PER_DAY, 10_000);
});


test("US_PROBES names the four known probe ids", () => {
  assert.deepEqual(
    US_PROBES.map((probe) => probe.id),
    [7, 13, 15, 18],
  );
  assert.deepEqual(
    US_PROBES.map((probe) => probe.name),
    ["Ohio", "North Virginia", "Oregon", "North California"],
  );
});

test("validateVolume accepts every offered interval and a unique probe set", () => {
  for (const minutes of FREQUENCY_MINUTES) {
    const result = validateVolume({
      frequencyMs: minutes * MINUTE,
      probeIds: [7, 13, 15, 18],
    });
    assert.equal(result.ok, true, `${minutes} min is offered`);
    if (result.ok) {
      assert.deepEqual(result.value.probeIds, [7, 13, 15, 18]);
    }
  }
});

test("validateVolume rejects an interval the panel does not offer", () => {
  for (const frequencyMs of [
    45 * MINUTE,
    120 * MINUTE,
    0,
    Number.NaN,
  ]) {
    const result = validateVolume({ frequencyMs, probeIds: [7] });
    assert.equal(result.ok, false, `${frequencyMs} ms must be rejected`);
    if (!result.ok) assert.match(result.reason, /1, 2, 5, 10, 15, 30 or 60/);
  }
});

test("validateVolume accepts the one- and two-minute floor", () => {
  for (const minutes of [1, 2]) {
    const result = validateVolume({
      frequencyMs: minutes * MINUTE,
      probeIds: [7, 13],
    });
    assert.equal(result.ok, true, `${minutes} min is offered`);
    if (result.ok) {
      assert.equal(result.value.clicksPerRun, 1, "absent clicks means one");
    }
  }
});

test("validateVolume bounds clicks per run at 1..10", () => {
  assert.equal(MAX_CLICKS_PER_RUN, 10);

  const accepted = validateVolume({
    frequencyMs: 5 * MINUTE,
    probeIds: [7],
    clicksPerRun: 10,
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.value.clicksPerRun, 10);

  for (const bad of [0, -1, 11, 2.5, Number.NaN]) {
    const result = validateVolume({
      frequencyMs: 5 * MINUTE,
      probeIds: [7],
      clicksPerRun: bad,
    });
    assert.equal(result.ok, false, `${String(bad)} must be rejected`);
    if (!result.ok) {
      assert.equal(result.code, "invalid_clicks");
      assert.match(result.reason, /whole number from 1 to 10/);
    }
  }
});

test("validateVolume rejects an empty probe set", () => {
  const result = validateVolume({ frequencyMs: 5 * MINUTE, probeIds: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "Pick at least one probe.");
});

test("validateVolume rejects duplicate and non-integer probe ids", () => {
  const duplicate = validateVolume({
    frequencyMs: 5 * MINUTE,
    probeIds: [7, 7],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.code, "duplicate_probe");
    assert.match(duplicate.reason, /once/);
  }

  for (const bad of [1.5, Number.NaN, 0, -3]) {
    const result = validateVolume({
      frequencyMs: 5 * MINUTE,
      probeIds: [7, bad],
    });
    assert.equal(result.ok, false, `${bad} must be rejected`);
    if (!result.ok) {
      assert.equal(result.code, "invalid_probe_id");
      assert.match(result.reason, /positive integers/);
    }
  }
});

test("validateVolume caps one save at ten probes", () => {
  assert.equal(MAX_PROBES_PER_SAVE, 10);

  const atCap = Array.from({ length: MAX_PROBES_PER_SAVE }, (_, i) => i + 1);
  const accepted = validateVolume({
    frequencyMs: 5 * MINUTE,
    probeIds: atCap,
  });
  assert.equal(accepted.ok, true, "exactly ten probes is still allowed");

  const overCap = [...atCap, MAX_PROBES_PER_SAVE + 1];
  const refused = validateVolume({
    frequencyMs: 5 * MINUTE,
    probeIds: overCap,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "too_many_probes");
    assert.match(refused.reason, /at most 10 probes/);
  }

  // Duplicates do not smuggle a bigger set past the cap: the array length is
  // the cost, and a repeated id is still a requested probe.
  const flooded = validateVolume({
    frequencyMs: 5 * MINUTE,
    probeIds: Array.from({ length: 1_000 }, (_, i) => (i % 10) + 1),
  });
  assert.equal(flooded.ok, false);
  if (!flooded.ok) assert.equal(flooded.code, "too_many_probes");
});
