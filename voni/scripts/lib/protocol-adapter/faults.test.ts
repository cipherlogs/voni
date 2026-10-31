/**
 * The media seam: faults are deterministic, the soundscape is mixed not
 * normalised, and the uplink decisions are pure enough to pin.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { Fault } from "@/lib/demo/verification/scenarios";

import {
  appliedFaults,
  callDropAtMs,
  decideUplinkFrame,
  mixSoundscape,
  soundscapeGain,
} from "./faults";

function frame(value = 0): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 128; index += 1) view.setInt16(index * 2, value, true);
  return bytes;
}

function int16(bytes: Uint8Array, index: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(index * 2, true);
}

test("an audio dropout is a gap and wins over a delay", () => {
  const faults: readonly Fault[] = [
    { kind: "audio-dropout", atMs: 100, durationMs: 200 },
    { kind: "endpoint-latency", atMs: 100, durationMs: 400 },
  ];
  assert.deepEqual(decideUplinkFrame(faults, 50), { send: true, delayMs: 0, fault: null });
  const inside = decideUplinkFrame(faults, 150);
  assert.equal(inside.send, false);
  assert.equal(inside.fault?.kind, "audio-dropout");
});

test("jitter delays deterministically inside its declared window", () => {
  const faults: readonly Fault[] = [
    { kind: "network-jitter", atMs: 0, durationMs: 120 },
  ];
  const first = decideUplinkFrame(faults, 10);
  const again = decideUplinkFrame(faults, 10);
  assert.deepEqual(first, again, "the same call time yields the same decision");
  assert.equal(first.send, true);
  assert.ok(first.delayMs > 0 && first.delayMs <= 120);
  assert.equal(first.fault?.kind, "network-jitter");
});

test("endpoint latency uses the whole declared delay", () => {
  const decision = decideUplinkFrame(
    [{ kind: "endpoint-latency", atMs: 0, durationMs: 350 }],
    10,
  );
  assert.equal(decision.send, true);
  assert.equal(decision.delayMs, 350);
});

test("the earliest call-drop is the one that ends the call", () => {
  assert.equal(callDropAtMs([]), null);
  assert.equal(
    callDropAtMs([
      { kind: "call-drop", atMs: 900 },
      { kind: "call-drop", atMs: 400 },
    ]),
    400,
  );
});

test("the soundscape is mixed and clipped, never rescaled", () => {
  assert.equal(soundscapeGain(0), 1);
  assert.ok(Math.abs(soundscapeGain(-6.0206) - 0.5) < 0.001);

  const output = frame(30_000);
  const loop = frame(10_000);
  mixSoundscape(output, loop, 0, 0);
  assert.equal(int16(output, 0), 32767, "full scale is clipped, not normalised");

  const half = frame(0);
  mixSoundscape(half, frame(1_000), 0, -6.0206);
  assert.ok(Math.abs(int16(half, 0) - 500) <= 1);
});

test("applied faults say what the seam actually did", () => {
  const faults: readonly Fault[] = [
    { kind: "audio-dropout", atMs: 100, durationMs: 50 },
    { kind: "call-drop", atMs: 900 },
  ];
  const counts = new Map([
    ["audio-dropout@100", 12],
    ["call-drop@900", 1],
  ]);
  const applied = appliedFaults(faults, counts);
  assert.equal(applied[0]?.observed, "12 caller frame(s) dropped");
  assert.match(applied[1]?.observed ?? "", /closed at the fault point/);
});
