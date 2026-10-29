/**
 * Seam tests for the two audio worklets in /public. They run the real files
 * in a vm with the AudioWorkletGlobalScope pieces they use stubbed, then
 * check the output for the discontinuities a listener hears as pops.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { DeliveredCapture } from "./delivered-capture";
import { decodeWav } from "@/lib/audio/format-facts";

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = { port: Port; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };

function load(file: string, sampleRate: number, options?: unknown, source?: string) {
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
  vm.runInNewContext(source ?? readFileSync(`public/${file}`, "utf8"), scope);
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

type PlayoutRun = {
  /** [atSeconds, samples] chunks, in order. */
  arrivals: [number, Float32Array][];
  /** Wall-clock seconds to drive the context for. */
  seconds: number;
  flushAt?: number;
  probe?: boolean;
  sourceRate?: number;
  /**
   * Delivered capture: off, on for the whole run, or a list of times at which
   * to toggle it (it starts on, so the first time turns it off). A mid-run off
   * exercises the tap's flush-and-ack path while audio is still playing, not
   * only at teardown.
   */
  tap?: boolean | number[];
  /**
   * Context suspended in this window: no `process` call and a frozen worklet
   * clock, as the browser does when a call is muted or the page is hidden.
   */
  suspend?: [number, number];
  /** Worklet source override, for the mutation proof. */
  source?: string;
};

/** Drive the playout; returns everything the worklet emitted and posted. */
function runPlayout(config: PlayoutRun) {
  const { arrivals, seconds, flushAt, probe = false, sourceRate = SRC, tap = false, suspend } = config;
  const { proc, scope } = load("playout-processor.js", OUT, undefined, config.source);
  if (probe) proc.port.onmessage!({ data: { type: "probe", on: true } });
  let capturing = tap !== false;
  const toggles = Array.isArray(tap) ? [...tap].sort((a, b) => a - b) : [];
  if (capturing) proc.port.onmessage!({ data: { type: "tap", on: true } });
  const out: number[] = [];
  let seq = 0;
  let next = 0;
  let flushed = false;
  let t = 0; // worklet time: frozen while the context is suspended
  for (let q = 0; q * 128 < seconds * OUT; q++) {
    const wall = (q * 128) / OUT;
    if (suspend && wall >= suspend[0] && wall < suspend[1]) continue;
    scope.currentTime = t;
    while (next < arrivals.length && arrivals[next][0] <= t) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: sourceRate, samples: arrivals[next][1] } });
      next++;
    }
    while (toggles.length && toggles[0]! <= t) {
      toggles.shift();
      capturing = !capturing;
      proc.port.onmessage!({ data: { type: "tap", on: capturing } });
    }
    if (flushAt !== undefined && !flushed && t >= flushAt) {
      proc.port.onmessage!({ data: { type: "flush", fadeS: 0.04 } });
      flushed = true;
    }
    const buf = new Float32Array(128);
    proc.process([], [[buf]]);
    out.push(...buf);
    t += 128 / OUT;
  }
  // Capture off, like session teardown: the tap flushes its last partial block
  // and acks, so a capture never loses its tail.
  if (capturing) proc.port.onmessage!({ data: { type: "tap", on: false } });
  return { out, posted: proc.port.posted as PostedTap[] };
}

type PostedTap =
  | { type: "level"; idle: boolean; consumed?: number }
  | { type: "pop"; kind?: string; size?: number }
  | { type: "tap"; samples?: Float32Array }
  | { type: "tap-end" };

/** Concatenate the tap's posted blocks, as the main thread's capture would. */
function tappedSamples(posted: PostedTap[]): number[] {
  return posted.flatMap((m) => (m.type === "tap" && m.samples ? Array.from(m.samples) : []));
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

test("playout: a wrong rate is a detectable speed change in the delivered capture", () => {
  // The same 200 ms of source audio, declared at 24 kHz and then at 16 kHz.
  // A client that assumes the wrong rate cannot hide it: the delivered
  // capture is 1.5x longer, so a capture comparison sees the speed change.
  const chunk = sineChunk(0, SRC * 0.2);
  const soundingMs = (rate: number) => {
    const { out } = runPlayout({ arrivals: [[0, chunk]], seconds: 1.2, sourceRate: rate });
    return (out.filter((y) => y !== 0).length / OUT) * 1000;
  };
  const at24k = soundingMs(24_000);
  const at16k = soundingMs(16_000);
  assert.ok(Math.abs(at24k - 200) < 10, `24 kHz delivered ${at24k}ms`);
  assert.ok(Math.abs(at16k / at24k - 1.5) < 0.05, `24 kHz ${at24k}ms, 16 kHz ${at16k}ms`);
});

test("playout: jittery chunks play as one seamless stream", () => {
  const { out, posted } = runPlayout({ arrivals: jitteryReply(), seconds: 2 });
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)} > clean ${CLEAN_STEP}`);
  // Exactly one drain: the natural end of the reply, no mid-reply underrun.
  assert.equal(posted.filter((m) => m.type === "level" && m.idle).length, 1);
  // Pre-roll: nothing sounds until 500ms of audio has arrived.
  const arrivals = jitteryReply();
  const firstSound = out.findIndex((y) => y !== 0) / OUT;
  const bufferedAtStart = arrivals
    .filter(([at]) => at <= firstSound)
    .reduce((n, [, chunk]) => n + chunk.length, 0);
  assert.ok(bufferedAtStart >= 0.5 * SRC, `started with ${bufferedAtStart / SRC}s buffered`);
});

test("playout: a stall longer than the buffer fades out and back in", () => {
  const arrivals: [number, Float32Array][] = [
    [0, sineChunk(0, SRC * 0.2)],
    [1.3, sineChunk(SRC * 0.2, SRC * 0.2)], // well after the first ran dry
  ];
  const { out, posted } = runPlayout({ arrivals, seconds: 2.2 });
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);
  assert.equal(posted.filter((m) => m.type === "level" && m.idle).length, 2, "one underrun + the end");
});

/** Real time, as the server streams (10ms chunks every 10ms), with one network hiccup. */
function realTimeReply(seconds: number, hiccupAt: number, hiccupS: number) {
  const arrivals: [number, Float32Array][] = [];
  const n = SRC * 0.01;
  for (let pos = 0; pos < seconds * SRC; pos += n) {
    const due = pos / SRC;
    arrivals.push([due >= hiccupAt && due < hiccupAt + hiccupS ? hiccupAt + hiccupS : due, sineChunk(pos, n)]);
  }
  return arrivals;
}

test("playout: a 400ms network hiccup mid-line is absorbed, no gap", () => {
  const { out, posted } = runPlayout({ arrivals: realTimeReply(2, 0.8, 0.4), seconds: 3 });
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);
  assert.equal(posted.filter((m) => m.type === "level" && m.idle).length, 1, "only the natural end");
});

test("playout: reports how much of the stream it has consumed", () => {
  const { posted } = runPlayout({ arrivals: realTimeReply(1, 9, 0), seconds: 1.2 });
  const levels = posted.filter((m) => m.type === "level") as unknown as { consumed: number }[];
  const consumed = levels.map((m) => m.consumed);
  assert.ok(consumed.every((c, i) => i === 0 || c >= consumed[i - 1]), "never goes back");
  // 1.2s run, sound starts after the 0.5s pre-roll: about 0.7s played.
  assert.ok(Math.abs(consumed.at(-1)! / SRC - 0.7) < 0.05, `consumed ${consumed.at(-1)! / SRC}s`);
});

test("playout: flush fades to silence within 40ms, no click", () => {
  const { out } = runPlayout({ arrivals: [[0, sineChunk(0, SRC)]], seconds: 1.2, flushAt: 0.8 });
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);
  const after = out.slice(Math.ceil((0.8 + 128 / OUT + 0.04) * OUT));
  assert.ok(after.every((y) => y === 0), "silent after the fade");
});

test("playout: a reply right after a flush waits for the tail, never past full scale", () => {
  // Barge-in resume: the superseded reply fades while the next one is ready.
  const loud = (n: number, hz: number) =>
    new Float32Array(n).map((_, i) => 0.95 * Math.sin((2 * Math.PI * hz * i) / SRC));
  const { out, posted } = runPlayout({
    arrivals: [[0, loud(SRC, 180)], [0.8 + 128 / OUT, loud(SRC / 2, 230)]],
    seconds: 2,
    flushAt: 0.8,
    probe: true,
  });
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak <= 1, `peak ${peak}`);
  assert.deepEqual(posted.filter((m) => m.type === "pop"), []);
});

test("pop probe: a clean jittery reply reports nothing", () => {
  const { posted } = runPlayout({ arrivals: jitteryReply(), seconds: 2, probe: true });
  assert.deepEqual(posted.filter((m) => m.type === "pop"), []);
});

test("pop probe: a hard discontinuity in the stream is flagged as a jump", () => {
  const square = new Float32Array(SRC * 0.2).map((_, i) => (Math.floor(i / 12) % 2 ? 0.9 : -0.9));
  const { posted } = runPlayout({ arrivals: [[0, sineChunk(0, SRC * 0.2)], [0.05, square]], seconds: 1.2, probe: true });
  const pops = posted.filter((m): m is Extract<PostedTap, { type: "pop" }> => m.type === "pop" && m.kind === "jump");
  assert.ok(pops.length > 0, "the square edge is flagged");
  assert.ok((pops[0]?.size ?? 0) > 0.3);
});

test("pop probe: off by default, the worklet posts no pop messages", () => {
  const square = new Float32Array(SRC * 0.2).map((_, i) => (Math.floor(i / 12) % 2 ? 0.9 : -0.9));
  const { posted } = runPlayout({ arrivals: [[0, square]], seconds: 1 });
  assert.deepEqual(posted.filter((m) => m.type === "pop"), []);
});

/** Compare two streams sample by sample, reporting the first divergence. */
function assertSameSamples(actual: number[], expected: number[], label: string) {
  assert.equal(actual.length, expected.length, `${label}: ${actual.length} samples, want ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(`${label}: sample ${i} is ${actual[i]}, want ${expected[i]}`);
    }
  }
}

test("delivered capture: the tap posts exactly the samples the worklet emitted", () => {
  const { out, posted } = runPlayout({ arrivals: jitteryReply(), seconds: 2, tap: true });
  const captured = tappedSamples(posted);
  assertSameSamples(captured, out, "capture vs emitted stream");
  // The ack follows the final block, so teardown can await a complete file.
  assert.equal(posted.at(-1)?.type, "tap-end");
});

/**
 * Ticket 13, the non-intrusiveness proof. The tap may copy the rendered output
 * and nothing else, so the same synthetic input renders twice — capture off,
 * then on — and the *emitted stream* is compared sample for sample. This is the
 * highest seam that exists without a live call: the real worklet, in the VM,
 * with the AudioWorkletGlobalScope pieces it uses stubbed. The WAV is compared
 * separately below; here the speaker's samples are the subject.
 */
function assertTapInert(name: string, run: (capture: boolean) => PlayoutRun, source?: string) {
  const plain = runPlayout({ ...run(false), source }).out;
  const tapped = runPlayout({ ...run(true), source }).out;
  // A trace that never sounded would pass this comparison trivially.
  assert.ok(plain.some((y) => y !== 0), `${name}: the trace actually sounded`);
  assertSameSamples(tapped, plain, `${name}: tapped vs plain`);
  return { plain, tapped };
}

/** Between them, every path a tap could disturb. */
const TAP_INERT_SCENARIOS: { name: string; run: (capture: boolean) => PlayoutRun }[] = [
  {
    name: "a jittery reply",
    run: (capture) => ({ arrivals: jitteryReply(), seconds: 2, tap: capture }),
  },
  {
    // The flush tail is mixed over the following output; capture must not move it.
    name: "a flush mid-reply",
    run: (capture) => ({
      arrivals: [[0, sineChunk(0, SRC)]],
      seconds: 1.2,
      flushAt: 0.8,
      tap: capture,
    }),
  },
  {
    // The tap's off path posts its final partial block and acks mid-call, then
    // the tap starts again: the flush/ack must not touch the stream either.
    name: "the tap off and on again mid-call",
    run: (capture) => ({ arrivals: jitteryReply(), seconds: 2, tap: capture ? [0.7, 1.1] : false }),
  },
  {
    // A suspended context: no renders, a frozen clock, the tap's partial block
    // carried across the gap.
    name: "a suspended and resumed context",
    run: (capture) => ({
      arrivals: realTimeReply(2, 9, 0),
      seconds: 2,
      suspend: [0.5, 1.1],
      tap: capture,
    }),
  },
];

for (const scenario of TAP_INERT_SCENARIOS) {
  test(`delivered capture: the tap is inert — ${scenario.name}`, () => {
    assertTapInert(scenario.name, scenario.run);
  });
}

test("delivered capture: the inertness proof fails on a one-sample change in the tap", () => {
  // The tap's only work is the copy `this.tapBuf[this.tapLen++] = out[i]`.
  // This injects the smallest change a capture bug could make: one sample of
  // the emitted stream slipped by a single 16-bit LSB, once. It is inaudible,
  // so if the proof above cannot see it the proof proves nothing. The mutation
  // is applied at the seam — the worklet source the VM loads — not to the
  // shipped file.
  const source = readFileSync("public/playout-processor.js", "utf8");
  const mutated = source.replace(
    "      this.tapBuf[this.tapLen++] = out[i];",
    "      this.tapBuf[this.tapLen++] = out[i];\n" +
      "      if (!this.slipped && out[i] !== 0) { this.slipped = true; out[i] += 1 / 32768; }",
  );
  assert.notEqual(mutated, source, "the mutation site was found");
  assert.throws(
    () =>
      assertTapInert(
        "mutated tap",
        (capture) => ({ arrivals: jitteryReply(), seconds: 2, tap: capture }),
        mutated,
      ),
    /mutated tap: tapped vs plain: sample \d+ is/,
  );
});

test("delivered capture: a flush mid-reply is captured through its fade", () => {
  const { out, posted } = runPlayout({ arrivals: [[0, sineChunk(0, SRC)]], seconds: 1.2, flushAt: 0.8, tap: true });
  assertSameSamples(tappedSamples(posted), out, "capture across a flush");
});

test("delivered capture: off by default, no tap buffers are posted", () => {
  const { posted } = runPlayout({ arrivals: jitteryReply(), seconds: 1.5 });
  assert.deepEqual(posted.filter((m) => m.type === "tap" || m.type === "tap-end"), []);
});

test("delivered capture: a tapped run writes a readable WAV of what the speaker got", async () => {
  const { out, posted } = runPlayout({ arrivals: jitteryReply(), seconds: 1.5, tap: true });
  const files: Uint8Array[] = [];
  const capture = new DeliveredCapture({
    sampleRate: OUT,
    write: (_name, bytes) => {
      files.push(bytes);
    },
    now: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
  });
  for (const message of posted) {
    if (message.type === "tap" && message.samples) capture.push(message.samples);
  }
  const result = await capture.finish();
  assert.equal(result?.name, "delivered-20261029-140506.wav");
  const wav = decodeWav(files[0]!);
  assert.equal(wav.facts.sampleRate, OUT);
  // 16-bit PCM is the comparison's format: compare the file to the emitted
  // stream at that quantisation, sample for sample.
  const quantise = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  assertSameSamples(Array.from(wav.samples), out.map(quantise), "WAV vs emitted stream");
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
