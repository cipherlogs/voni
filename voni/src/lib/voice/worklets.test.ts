/**
 * Seam tests for the two audio worklets in /public. They run the real files
 * in a vm with the AudioWorkletGlobalScope pieces they use stubbed, then
 * check the output for the discontinuities a listener hears as pops.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = { port: Port; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };

function load(file: string, sampleRate: number, options?: unknown) {
  const scope = {
    sampleRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port: Port = {
        onmessage: null,
        posted: [],
        postMessage(this: Port, m: unknown) {
          this.posted.push(m);
        },
      } as Port & { postMessage: (m: unknown) => void };
    },
    registered: null as null | (new (o?: unknown) => Processor),
    registerProcessor(_name: string, ctor: new (o?: unknown) => Processor) {
      scope.registered = ctor;
    },
  };
  vm.runInNewContext(readFileSync(`public/${file}`, "utf8"), scope);
  const proc = new scope.registered!(options);
  return { proc, scope };
}

/** Largest jump between adjacent samples. */
function maxStep(x: Float32Array | number[]): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

const SRC = 24000;
const OUT = 48000;
const HZ = 220;
const AMP = 0.5;
/** Adjacent-sample step of a clean HZ sine at OUT, with headroom. */
const CLEAN_STEP = ((2 * Math.PI * HZ * AMP) / OUT) * 1.2;

function sineChunk(start: number, n: number) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = AMP * Math.sin((2 * Math.PI * HZ * (start + i)) / SRC);
  return s;
}

/** Drive the playout: `arrivals` are [atSeconds, samples] chunks; returns output. */
function runPlayout(arrivals: [number, Float32Array][], seconds: number, flushAt?: number) {
  const { proc, scope } = load("playout-processor.js", OUT);
  const out: number[] = [];
  let seq = 0;
  let next = 0;
  let flushed = false;
  for (let q = 0; q * 128 < seconds * OUT; q++) {
    scope.currentTime = (q * 128) / OUT;
    while (next < arrivals.length && arrivals[next][0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next][1] } });
      next++;
    }
    if (flushAt !== undefined && !flushed && scope.currentTime >= flushAt) {
      proc.port.onmessage!({ data: { type: "flush", fadeS: 0.04 } });
      flushed = true;
    }
    const buf = new Float32Array(128);
    proc.process([], [[buf]]);
    out.push(...buf);
  }
  return { out, posted: proc.port.posted as { type: string; idle: boolean }[] };
}

/** 1s of sine in chunks of 40–60ms, each up to 70ms late (in order, as over TCP). */
function jitteryReply(seed = 7) {
  let r = seed;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const arrivals: [number, Float32Array][] = [];
  let pos = 0;
  let at = 0;
  while (pos < SRC) {
    const n = Math.round((0.04 + rand() * 0.02) * SRC);
    at = Math.max(at, pos / SRC + rand() * 0.07);
    arrivals.push([at, sineChunk(pos, n)]);
    pos += n;
  }
  return arrivals;
}

test("playout: jittery chunks play as one seamless stream", () => {
  const { out, posted } = runPlayout(jitteryReply(), 1.4);
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)} > clean ${CLEAN_STEP}`);
  // Exactly one drain: the natural end of the reply, no mid-reply underrun.
  assert.equal(posted.filter((m) => m.idle).length, 1);
  // Pre-roll: nothing sounds until 80ms of audio has arrived.
  const arrivals = jitteryReply();
  const firstSound = out.findIndex((y) => y !== 0) / OUT;
  const bufferedAtStart = arrivals
    .filter(([at]) => at <= firstSound)
    .reduce((n, [, chunk]) => n + chunk.length, 0);
  assert.ok(bufferedAtStart >= 0.08 * SRC, `started with ${bufferedAtStart / SRC}s buffered`);
});

test("playout: a stall longer than the buffer fades out and back in", () => {
  const arrivals: [number, Float32Array][] = [
    [0, sineChunk(0, SRC * 0.2)],
    [0.5, sineChunk(SRC * 0.2, SRC * 0.2)], // 300ms after the first ran dry
  ];
  const { out, posted } = runPlayout(arrivals, 1);
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);
  assert.equal(posted.filter((m) => m.idle).length, 2, "one underrun + the end");
});

test("playout: flush fades to silence within 40ms, no click", () => {
  const { out } = runPlayout([[0, sineChunk(0, SRC)]], 0.6, 0.3);
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);
  const after = out.slice(Math.ceil((0.3 + 128 / OUT + 0.04) * OUT));
  assert.ok(after.every((y) => y === 0), "silent after the fade");
});

function runMic(inputRate: number, seconds: number) {
  const { proc } = load("pcm-processor.js", inputRate, {
    processorOptions: { inputSampleRate: inputRate, targetSampleRate: SRC },
  });
  const out: number[] = [];
  let q = 0;
  for (; q * 128 < seconds * inputRate; q++) {
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) block[i] = AMP * Math.sin((2 * Math.PI * HZ * (q * 128 + i)) / inputRate);
    proc.process([[block]], []);
  }
  for (const buf of proc.port.posted as ArrayBuffer[]) {
    for (const v of new Int16Array(buf)) out.push(v / 32767);
  }
  return { out, inputSamples: q * 128 };
}

for (const rate of [44100, 48000]) {
  test(`mic: ${rate} Hz resamples to a continuous 24 kHz stream`, () => {
    const { out, inputSamples } = runMic(rate, 2);
    const expected = (inputSamples * SRC) / rate;
    assert.ok(Math.abs(out.length - expected) <= 1, `${out.length} samples, want ${expected}`);
    const clean = ((2 * Math.PI * HZ * AMP) / SRC) * 1.2;
    assert.ok(maxStep(out) <= clean, `max step ${maxStep(out)} > ${clean}`);
    // Phase stays locked to the input: the last sample matches the true sine.
    const i = out.length - 1;
    assert.ok(Math.abs(out[i] - AMP * Math.sin((2 * Math.PI * HZ * i) / SRC)) < 0.01);
  });
}
