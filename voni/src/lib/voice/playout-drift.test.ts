/**
 * The playout's slow drift correction (ticket 26).
 *
 * A producer and a consumer never share a clock. When the stream arrives a
 * little slower than the device plays, the cushion the reply started on drains
 * away with nothing putting it back: after half a minute the reply is dry and
 * the caller hears a hole. The worklet corrects that by playing very slightly
 * slower (or faster) than real time — a few tenths of a percent — until the
 * cushion is back at its target.
 *
 * The correction has to be inaudible, which sets two hard limits this file
 * pins:
 *
 *   - it never exceeds ±1 % (17 cents: under the pitch difference a listener
 *     can name), and
 *   - it moves at most ~1 % per second, so the pitch glides instead of jumping;
 *     applied over a whole level-report interval that is a hundredth of a
 *     percent.
 *
 * And it has to stay out of the way of everything else: a stream arriving on
 * time is left bit-for-bit alone.
 *
 * The seam is the one ticket 25 established: the real
 * `public/playout-processor.js`, unmodified, in a `vm` with the
 * AudioWorkletGlobalScope pieces it uses stubbed. What is asserted is the
 * cushion the worklet *reports* over time and the correction it reports
 * applying — never an internal variable. Run from `voni/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { DecodedAudio } from "../audio/format-facts";
import { measureEnvelopeModulation } from "../audio/envelope-modulation";

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = {
  port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
type Arrival = [number, Float32Array];
type LevelMessage = {
  type: "level";
  seq: number;
  queuedMs: number;
  cushionMs: number;
  targetCushionMs: number;
  correctionPct: number;
  playing: boolean;
  idle: boolean;
  consumed: number;
};
type Post = { at: number; message: LevelMessage };

const OUT = 48000;
const SRC = 24000;
const QUANTUM = 128;
const HZ = 220;
const AMP = 0.5;
const CHUNK_S = 0.01;
const CHUNK_RATE_HZ = 1 / CHUNK_S;
/**
 * The cushion a reply starts on and drifts around. The owner's call, recorded
 * in the worklet and in `docs/playout-defect-evidence.md` (80 ms broke up on
 * phones), not a number this test reads back from the code.
 */
const TARGET_CUSHION_S = 0.5;
/**
 * The inaudibility bound on the correction itself: ±1 % of playback rate, the
 * top of the 0.5–1 % range the ticket allows. Independent of the worklet's
 * constant on purpose.
 */
const MAX_CORRECTION_PCT = 1;
/**
 * The inaudibility bound on one step. Reports come every eight quanta
 * (21.3 ms), so 0.02 points per report is just under 1 % per second — a glide,
 * not a jump.
 */
const MAX_STEP_PCT = 0.02;

function load(sampleRate: number) {
  const scope = {
    sampleRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port: Port & { postMessage: (m: unknown) => void } = {
        onmessage: null,
        posted: [],
        postMessage(this: Port & { postMessage: (m: unknown) => void }, m: unknown) {
          this.posted.push({ at: scope.currentTime, message: m });
        },
      } as Port & { postMessage: (m: unknown) => void };
    },
    registered: null as null | (new (o?: unknown) => Processor),
    registerProcessor(_name: string, ctor: new (o?: unknown) => Processor) {
      scope.registered = ctor;
    },
  };
  vm.runInNewContext(readFileSync("public/playout-processor.js", "utf8"), scope);
  return { proc: new scope.registered!(), scope };
}

function sineChunk(start: number, n: number) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = AMP * Math.sin((2 * Math.PI * HZ * (start + i)) / SRC);
  return s;
}

/**
 * A live stream whose clock runs `speed` times the device's: `speed` source
 * seconds arrive per wall second. 0.99 is a producer 1 % slow, the mismatch a
 * real link can hold for a whole call; 1 is perfect clock agreement.
 */
function clockTrace(seconds: number, speed: number): Arrival[] {
  const out: Arrival[] = [];
  const n = Math.round(CHUNK_S * SRC);
  for (let pos = 0; pos < Math.round(seconds * SRC); pos += n) {
    out.push([pos / (SRC * speed), sineChunk(pos, n)]);
  }
  return out;
}

/** Drive the real worklet with `arrivals`; returns every sample and every post. */
function render(arrivals: Arrival[], seconds: number) {
  const { proc, scope } = load(OUT);
  const out = new Float32Array(Math.ceil((seconds * OUT) / QUANTUM) * QUANTUM);
  let seq = 0;
  let next = 0;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / OUT;
    while (next < arrivals.length && arrivals[next][0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next][1] } });
      next++;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }
  return { out, posts: proc.port.posted as Post[] };
}

/** Every level report the worklet posted while sounding. */
function levels(posts: Post[]): { at: number; m: LevelMessage }[] {
  return posts.filter((p) => p.message.type === "level" && p.message.playing).map((p) => ({ at: p.at, m: p.message }));
}

function decoded(out: Float32Array): DecodedAudio {
  const samples = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) samples[i] = Math.round(out[i] * 32767);
  return {
    facts: {
      container: "wav",
      sampleRate: OUT,
      channels: 1,
      bitsPerSample: 16,
      byteRate: OUT * 2,
      dataBytes: samples.length * 2,
      frameCount: samples.length,
      durationSeconds: samples.length / OUT,
    },
    samples,
  };
}

/** The rendered stream with its lead-in and tail trimmed: the reply a listener hears. */
function played(audio: DecodedAudio, out: Float32Array): DecodedAudio {
  const first = out.findIndex((y) => y !== 0);
  let last = out.length - 1;
  while (last > first && out[last] === 0) last--;
  const trim = Math.round(0.02 * OUT);
  const samples = audio.samples.subarray(first + trim, last - trim);
  return {
    facts: {
      ...audio.facts,
      frameCount: samples.length,
      dataBytes: samples.length * 2,
      durationSeconds: samples.length / audio.facts.sampleRate,
    },
    samples,
  };
}

test("drift correction: a stream arriving slower than it plays holds the cushion near target", () => {
  // One minute of audio arriving 1 % slow. Uncorrected, the 500 ms cushion
  // drains at 10 ms per second and is empty at 50 s: the reply would go dry
  // mid-call. The correction is the only thing that can hold it up.
  const { posts } = render(clockTrace(60, 0.99), 62);
  const series = levels(posts);
  assert.ok(series.length > 0, "the worklet reports nothing");

  const late = series.filter((s) => s.at >= 20 && s.at <= 60);
  assert.ok(late.length > 100, `only ${late.length} reports after settling`);
  const cushions = late.map((s) => s.m.cushionMs);
  const low = Math.min(...cushions);
  const high = Math.max(...cushions);

  // Near target, and never the slow shrink to nothing: an uncorrected buffer
  // is at 0 ms by 50 s, so a floor of 300 ms one minute in is the correction.
  assert.ok(low >= 300, `the cushion falls to ${low} ms`);
  assert.ok(high <= TARGET_CUSHION_S * 1000 + 20, `the cushion climbs to ${high} ms`);

  // It settles rather than merely draining slowly: the cushion one minute in is
  // where it was twenty seconds in.
  const early = cushions.slice(0, 50);
  const end = cushions.slice(-50);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(
    Math.abs(mean(end) - mean(early)) <= 15,
    `the cushion drifts from ${mean(early)} ms to ${mean(end)} ms`,
  );

  // The correction is what holds it: the consumer plays slower than real time.
  const correction = late.at(-1)!.m.correctionPct;
  assert.ok(correction < -0.5, `correction ${correction}% does not make up a 1% slow stream`);
});

test("drift correction: never more than the inaudible bound, and reached by gliding", () => {
  const { posts } = render(clockTrace(30, 0.99), 31);
  const series = levels(posts);
  assert.ok(series.length > 0, "the worklet reports nothing");

  const corrections = series.map((s) => s.m.correctionPct);
  const biggest = Math.max(...corrections.map(Math.abs));
  assert.ok(biggest <= MAX_CORRECTION_PCT, `the rate moves ${biggest}%, past the 1% bound`);

  // One step is one report, and no step may be audible: at most 0.02 points of
  // rate per 21ms, i.e. a glide under 1% per second. A corrector that jumped to
  // its bound in a quantum would fail here even though its total stays legal.
  let step = 0;
  for (let i = 1; i < corrections.length; i++) {
    step = Math.max(step, Math.abs(corrections[i]! - corrections[i - 1]!));
  }
  assert.ok(step <= MAX_STEP_PCT, `one report moves the rate by ${step} points`);

  // It ramps: the first report that corrects at all corrects by less than a
  // step, so the bound above is met by slewing and not by luck of the sampling.
  const first = corrections.find((c) => c !== 0);
  assert.ok(first !== undefined, "the stream never corrects");
  assert.ok(Math.abs(first) <= MAX_STEP_PCT, `the first correction is already ${first} points`);
});

test("drift correction: a stream arriving on time is played at exactly its own rate", () => {
  const { posts } = render(clockTrace(6, 1), 7);
  const series = levels(posts);
  assert.ok(series.length > 100, `only ${series.length} reports`);

  // Not "small": none at all. Chunk quantisation and the ±10ms sawtooth of the
  // queue are inside the deadband, so a stream that needs no correction gets
  // none — the samples are the resampler's, untouched.
  for (const { at, m } of series) {
    assert.equal(m.correctionPct, 0, `corrected ${m.correctionPct}% at ${at.toFixed(2)}s with no drift`);
  }
  const cushions = series.filter((s) => s.at >= 1 && s.at <= 5.5).map((s) => s.m.cushionMs);
  assert.ok(Math.min(...cushions) >= TARGET_CUSHION_S * 1000 - 20, `the cushion dips to ${Math.min(...cushions)} ms`);
  assert.ok(Math.max(...cushions) <= TARGET_CUSHION_S * 1000 + 20, `the cushion climbs to ${Math.max(...cushions)} ms`);
});

test("drift correction: correcting the cushion does not modulate the voice at the chunk rate", () => {
  // The ticket 05 metric on a drifting reply: 100 Hz is the chunk rate, the rate
  // the old envelope-from-the-buffer defect pumped at. A rate correction is a
  // pitch glide, not an envelope, so the reading must stay flat.
  const { out } = render(clockTrace(10, 0.99), 11);
  const reading = measureEnvelopeModulation(played(decoded(out), out));
  assert.equal(reading.rateHz, 0, `modulated at ${reading.rateHz} Hz (chunk rate is ${CHUNK_RATE_HZ} Hz)`);
  assert.equal(reading.depth, 0, `depth ${reading.depth}`);
  assert.equal(reading.modulated, false);

  // Nor is it a dropout dressed up as a correction: the reply never goes silent.
  const sounding = out.findIndex((y) => y !== 0);
  let last = out.length - 1;
  while (last > sounding && out[last] === 0) last--;
  assert.equal(out.subarray(sounding, last).some((y) => y === 0), false, "the reply is interrupted by silence");
});

test("drift correction: a cushion knocked short by a stall climbs back toward target", () => {
  // 300 ms of the stream arrives late — no dry-out (the cushion keeps ~200 ms),
  // but a cushion that stays short forever is a hop away from dropping out.
  // With the producer back on time the corrector plays slower until the cushion
  // is back where the reply started: 10 ms a second, inaudibly.
  const arrivals: Arrival[] = [
    ...clockTrace(0.5, 1),
    ...clockTrace(43.5, 1)
      .filter(([at]) => at >= 0.5)
      .map(([at, chunk]): Arrival => [at + 0.3, chunk]),
  ];
  const { posts } = render(arrivals, 44);
  const series = levels(posts);
  const between = (from: number, to: number) => series.filter((s) => s.at >= from && s.at <= to);

  const knocked = between(1, 10);
  assert.ok(knocked.length > 0, "the worklet reports nothing");
  const trough = Math.min(...knocked.map((s) => s.m.cushionMs));
  assert.ok(trough <= 300, `the stall did not knock the cushion down (it held ${trough} ms)`);
  assert.ok(
    knocked.some((s) => s.m.correctionPct <= -0.3),
    "the short cushion is not corrected",
  );

  const recovered = between(35, 42);
  const floor = Math.min(...recovered.map((s) => s.m.cushionMs));
  assert.ok(floor >= 400, `the cushion only climbs back to ${floor} ms`);
});

test("drift correction: a stream arriving faster than it plays does not let latency creep", () => {
  // The other sign of drift: a producer 1 % fast fills the cushion, and an
  // uncorrected buffer grows 10 ms a second into a call-long delay. The
  // corrector plays through it a little faster and holds it near target.
  const { posts } = render(clockTrace(40, 1.01), 41);
  // To 35s: the last 500ms of a trace is the reply ending, where the cushion
  // draining is expected and not latency creep.
  const late = levels(posts).filter((s) => s.at >= 20 && s.at <= 35);
  assert.ok(late.length > 100, `only ${late.length} reports after settling`);
  const cushions = late.map((s) => s.m.cushionMs);

  assert.ok(Math.min(...cushions) >= TARGET_CUSHION_S * 1000, `the cushion dips to ${Math.min(...cushions)} ms`);
  assert.ok(Math.max(...cushions) <= TARGET_CUSHION_S * 1000 + 100, `the cushion climbs to ${Math.max(...cushions)} ms`);
  // An uncorrected 40 s trace is holding 900 ms by now.
  const correction = late.at(-1)!.m.correctionPct;
  assert.ok(correction > 0.5, `correction ${correction}% does not make up a 1% fast stream`);
});
