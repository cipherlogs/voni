import assert from "node:assert/strict";
import test from "node:test";

import { nextVelocity, TICK_FEEL } from "./call-sounds";

test("tick velocity walks like a hand: bounded, varied, no jumps", () => {
  let v = 0.6;
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const next = nextVelocity(v, TICK_FEEL);
    assert.ok(next >= 0.3 && next <= 1, `velocity ${next} out of range`);
    assert.ok(Math.abs(next - v) <= TICK_FEEL.spread, `jump ${next - v} exceeds spread`);
    seen.add(Math.round(next * 100));
    v = next;
  }
  assert.ok(seen.size > 20, "velocity actually varies");
});

test("a steady hand (spread 0) settles to one velocity", () => {
  let v = 1;
  for (let i = 0; i < 100; i++) v = nextVelocity(v, { ...TICK_FEEL, spread: 0 });
  assert.ok(Math.abs(v - 0.6) < 1e-6);
});
