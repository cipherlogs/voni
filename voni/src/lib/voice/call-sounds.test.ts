import assert from "node:assert/strict";
import test from "node:test";

import { CallSounds, nextVelocity, TICK_FEEL } from "./call-sounds";

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

test("preload warms the one-shot element so play has no construction lag", () => {
  const created: Array<{ url: string; playCalls: number }> = [];
  class FakeAudio {
    url: string;
    volume = 0;
    preload = "none";
    onload: unknown = null;
    onerror: unknown = null;
    playCalls = 0;
    constructor(url: string) {
      this.url = url;
      created.push({ url, playCalls: 0 });
    }
    play(): Promise<void> {
      this.playCalls += 1;
      const record = created.find((c) => c.url === this.url);
      if (record) record.playCalls += 1;
      return Promise.resolve();
    }
    pause(): void {}
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.Audio;
  g.Audio = FakeAudio;
  try {
    const sounds = new CallSounds();
    sounds.preload("connected");
    assert.equal(created.length, 1, "the element is constructed at preload, not at play");
    assert.match(created[0].url, /connected\.mp3/, "the warmed element is the connected chime");
    sounds.play("connected");
    assert.equal(created.length, 1, "play reuses the warmed element instead of constructing one");
    assert.equal(created[0].playCalls, 1, "the warmed element is the one that sounds");
  } finally {
    if (saved === undefined) delete g.Audio;
    else g.Audio = saved;
  }
});
