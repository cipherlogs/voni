/**
 * Delivered capture: the dev-only tap after the playout worklet. The worklet
 * side is covered in worklets.test.ts; here is the main-thread handle, the WAV
 * it writes, and the flag that turns it on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorkletPlayout } from "./playout";
import {
  DeliveredCapture,
  deliveredCaptureRequested,
  encodeWavPcm16,
  finishDeliveredCapture,
} from "./delivered-capture";
import { decodeWav } from "@/lib/audio/format-facts";

type Port = {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (message: unknown, transfer?: unknown[]) => void;
};

/** The AudioWorkletNode surface the handle uses, plus a way to speak as the worklet. */
function fakeNode() {
  const posted: unknown[] = [];
  let handler: ((e: { data: unknown }) => void) | null = null;
  const port: Port = {
    get onmessage() {
      return handler;
    },
    set onmessage(fn) {
      handler = fn;
    },
    postMessage: (message) => posted.push(message),
  } as Port;
  return {
    node: { port } as unknown as AudioWorkletNode,
    posted,
    send: (data: unknown) => handler?.({ data }),
  };
}

test("playout tap: forwards each rendered block, then resolves once the worklet acks", async () => {
  const { node, posted, send } = fakeNode();
  const playout = createWorkletPlayout(node);
  const blocks: number[][] = [];
  playout.onTap = (samples) => blocks.push(Array.from(samples));

  await playout.tap(true);
  assert.deepEqual(posted.at(-1), { type: "tap", on: true });

  send({ type: "tap", samples: new Float32Array([0.25, -0.5]) });
  assert.deepEqual(blocks, [[0.25, -0.5]]);

  const done = playout.tap(false);
  assert.deepEqual(posted.at(-1), { type: "tap", on: false });
  let resolved = false;
  void done.then(() => (resolved = true));
  await Promise.resolve();
  assert.equal(resolved, false, "waits for the final block");

  send({ type: "tap-end" });
  await done;
  assert.equal(resolved, true);
});

test("playout tap: tearing down an unresponsive worklet still resolves", async () => {
  const { node } = fakeNode();
  const playout = createWorkletPlayout(node);
  await playout.tap(true);
  const started = Date.now();
  await playout.tap(false);
  assert.ok(Date.now() - started < 1000, "a stopped context cannot hang a hang-up");
});

test("playout tap: level reports still drive the playout while capturing", async () => {
  const { node, send } = fakeNode();
  const playout = createWorkletPlayout(node);
  playout.play(new Uint8Array([0, 0, 0, 0]), 24000);
  assert.equal(playout.settled(), false);
  send({ type: "level", seq: 1, queuedMs: 0, idle: true, consumed: 2 });
  assert.equal(playout.settled(), true);
  assert.equal(playout.consumedSamples?.(), 2);
});

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}

function u16(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);
}

test("delivered WAV: a standard PCM16 WAV at the worklet's rate, samples intact", () => {
  const samples = new Float32Array([0, 0.25, -0.25, 0.5, -1, 0.999]);
  const bytes = encodeWavPcm16(samples, 48000);

  assert.equal(ascii(bytes, 0, 4), "RIFF");
  assert.equal(u32(bytes, 4), bytes.length - 8);
  assert.equal(ascii(bytes, 8, 4), "WAVE");
  assert.equal(ascii(bytes, 12, 4), "fmt ");
  assert.equal(u32(bytes, 16), 16, "PCM fmt chunk");
  assert.equal(u16(bytes, 20), 1, "PCM");
  assert.equal(u16(bytes, 22), 1, "mono");
  assert.equal(u32(bytes, 24), 48000, "the worklet's output rate");
  assert.equal(u32(bytes, 28), 48000 * 2, "byte rate");
  assert.equal(u16(bytes, 32), 2, "block align");
  assert.equal(u16(bytes, 34), 16, "bits per sample");
  assert.equal(ascii(bytes, 36, 4), "data");
  assert.equal(u32(bytes, 40), samples.length * 2);

  // Decoded by the W0 comparison's own reader, not a copy of the encoder.
  const read = decodeWav(bytes);
  assert.equal(read.facts.sampleRate, 48000);
  assert.equal(read.facts.channels, 1);
  assert.equal(read.facts.durationSeconds, samples.length / 48000);
  assert.deepEqual(Array.from(read.samples), [0, 8192, -8192, 16384, -32767, 32734]);
});

test("delivered capture: blocks become one WAV named for the call", async () => {
  const writes: { name: string; bytes: Uint8Array }[] = [];
  const capture = new DeliveredCapture({
    sampleRate: 44100,
    write: (name, bytes) => {
      writes.push({ name, bytes });
    },
    now: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
  });
  capture.push(new Float32Array([0.1, 0.2, 0.3]));
  capture.push(new Float32Array([-0.4, -0.5]));
  const result = await capture.finish();

  assert.equal(writes.length, 1, "one file per call");
  assert.match(writes[0]!.name, /^delivered-20261029-140506\.wav$/);
  const read = decodeWav(writes[0]!.bytes);
  assert.equal(read.facts.sampleRate, 44100);
  assert.deepEqual(Array.from(read.samples), [3277, 6553, 9830, -13107, -16383]);
  assert.deepEqual(result, {
    complete: true,
    reason: "",
    name: writes[0]!.name,
    samples: 5,
    bytes: writes[0]!.bytes.length,
  });
});

test("delivered capture (direct path): writes the stream it is handed, never rewrites it", async () => {
  // The worklet is not the only way in: a script or the dev sink can drive
  // `DeliveredCapture` directly, so the same promise has to hold without a
  // live call — the capture reads the blocks, the blocks stay as emitted.
  const stream = [new Float32Array([0.1, -0.2, 0.3]), new Float32Array([0.4, -0.5])];
  const before = stream.map((block) => Array.from(block));
  const writes: Uint8Array[] = [];
  const capture = new DeliveredCapture({
    sampleRate: 48000,
    write: (_name, bytes) => {
      writes.push(bytes);
    },
  });
  for (const block of stream) capture.push(block);
  await capture.finish();

  assert.deepEqual(
    stream.map((block) => Array.from(block)),
    before,
    "the delivered blocks are untouched",
  );
  const quantise = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  assert.deepEqual(Array.from(decodeWav(writes[0]!).samples), before.flat().map(quantise));
});

test("delivered capture flag: on only with ?delivercapture=1, never in production", () => {
  assert.equal(deliveredCaptureRequested("?delivercapture=1", false), true);
  assert.equal(deliveredCaptureRequested("?foo=2&delivercapture=1", false), true);
  assert.equal(deliveredCaptureRequested("", false), false);
  assert.equal(deliveredCaptureRequested("?delivercapture=0", false), false);
  assert.equal(deliveredCaptureRequested("?delivercapture=1", true), false);
});

// ── A capture that is not whole is a named failure (ticket 121) ───────────
// "Missing" and "truncated" must not look like a short but valid recording:
// the W0 comparison would measure a file that is quietly missing its tail and
// call the difference a client defect. The capture names the failure instead.

test("delivered capture: nothing played is a named missing capture, not an empty file", async () => {
  let wrote = false;
  const capture = new DeliveredCapture({
    sampleRate: 48000,
    write: () => {
      wrote = true;
    },
  });
  const result = await capture.finish();
  assert.deepEqual(result, {
    complete: false,
    reason: "no-audio",
    name: null,
    samples: 0,
    bytes: 0,
  });
  assert.equal(wrote, false, "an empty WAV is never written");
});

test("delivered capture: a worklet that never acks is a named truncation, never silently short", async () => {
  const writes: { name: string; bytes: Uint8Array }[] = [];
  const capture = new DeliveredCapture({
    sampleRate: 48000,
    write: (name, bytes) => {
      writes.push({ name, bytes });
    },
    now: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
  });
  capture.push(new Float32Array([0.1, 0.2, 0.3]));

  const result = await finishDeliveredCapture({ tap: async () => ({ ended: false }) }, capture);

  assert.equal(result.complete, false);
  assert.equal(result.reason, "tap-timeout");
  assert.equal(result.name, "delivered-20261029-140506.wav");
  assert.equal(result.samples, 3);
  assert.equal(writes.length, 1, "the partial WAV is kept for triage");
  assert.equal(result.bytes, writes[0]!.bytes.length);
});

test("delivered capture: a complete tap writes the whole stream and says so", async () => {
  const capture = new DeliveredCapture({
    sampleRate: 48000,
    write: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
  });
  capture.push(new Float32Array([0.1, -0.2]));
  const result = await finishDeliveredCapture({ tap: async () => ({ ended: true }) }, capture);
  assert.equal(result.complete, true);
  assert.equal(result.reason, "");
  assert.equal(result.samples, 2);
  assert.match(result.name ?? "", /^delivered-20261029-140506\.wav$/);
});

test("delivered capture: a dev sink that is down is a named write failure, not a blank", async () => {
  const capture = new DeliveredCapture({
    sampleRate: 48000,
    write: () => {
      throw new Error("capture upload failed: 500");
    },
    now: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
  });
  capture.push(new Float32Array([0.1]));
  const result = await finishDeliveredCapture({ tap: async () => ({ ended: true }) }, capture);
  assert.deepEqual(result, {
    complete: false,
    reason: "write-failed",
    name: "delivered-20261029-140506.wav",
    samples: 1,
    bytes: 46,
  });
});
