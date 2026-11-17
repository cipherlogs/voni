/**
 * The volume arithmetic and its gate, proved without Grafana: every interval
 * the panel offers multiplies cleanly by the probe count, and the validator
 * refuses the inputs Grafana would reject or reinterpret.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clicksPerDay,
  FREQUENCY_MINUTES,
  MAX_PROBES_PER_SAVE,
  US_PROBES,
  validateVolume,
} from "./volume";

const MINUTE = 60_000;

test("clicks/day: 5, 15 and 60 minutes at 1 and 4 probes", () => {
  const cases: Array<[minutes: number, probes: number, expected: number]> = [
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

test("clicks/day: nonsense input is zero, never NaN or Infinity", () => {
  for (const [frequencyMs, probes] of [
    [0, 4],
    [-1, 4],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
    [5 * MINUTE, 0],
    [5 * MINUTE, Number.NaN],
  ] as const) {
    assert.equal(clicksPerDay(frequencyMs, probes), 0);
  }
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
    1 * MINUTE,
    2 * MINUTE,
    45 * MINUTE,
    120 * MINUTE,
    0,
    Number.NaN,
  ]) {
    const result = validateVolume({ frequencyMs, probeIds: [7] });
    assert.equal(result.ok, false, `${frequencyMs} ms must be rejected`);
    if (!result.ok) assert.match(result.reason, /5, 10, 15, 30 or 60/);
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
