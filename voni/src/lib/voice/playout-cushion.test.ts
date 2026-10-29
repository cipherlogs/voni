/**
 * The playout's target cushion (ticket 25).
 *
 * The worklet used to start a reply on whatever had arrived and then shape its
 * gain every sample from how much audio was left, so a starving buffer
 * amplitude-modulated the voice at the chunk rate. This file pins the
 * replacement at the same seam `worklets.test.ts` uses: the real
 * `public/playout-processor.js` runs unmodified in a `vm` with the
 * AudioWorkletGlobalScope pieces it uses stubbed.
 *
 * What a listener can depend on:
 *
 *   - a reply starts only once the target cushion has arrived (or after the
 *     defined lull, for a reply shorter than the cushion);
 *   - once it starts, the gain is constant: the delivered amplitude does not
 *     follow the buffer, so a stall changes no sample;
 *   - the worklet reports the cushion it holds and the target it starts at.
 *
 * The trace builders are copied from `playout-gating.test.ts` — ticket 07's
 * characterisation of the old behaviour, now the gate for its absence — so
 * this file stands alone. Run from `voni/`, because the worklet is read from
 * `public/`.
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
/** The platform streams 10 ms chunks, so a buffer-occupancy envelope shows up at this rate. */
const CHUNK_S = 0.01;
const CHUNK_RATE_HZ = 1 / CHUNK_S;
/**
 * The target cushion a reply must have buffered before it starts. The owner's
 * call, recorded in the worklet and in `docs/playout-defect-evidence.md`
 * (80 ms broke up on phones), not a number this test reads back from the code.
 */
const TARGET_CUSHION_S = 0.5;

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

/** The stream in 10 ms chunks, source `from`..`to`, every arrival `offset` seconds late. */
function stream(from: number, to: number, offset = 0): Arrival[] {
  const out: Arrival[] = [];
  const n = Math.round(CHUNK_S * SRC);
  for (let pos = Math.round(from * SRC); pos < Math.round(to * SRC); pos += n) {
    out.push([pos / SRC + offset, sineChunk(pos, n)]);
  }
  return out;
}

/**
 * The same stream in 10 ms chunks, with everything due inside a stall arriving
 * when the stall ends — a link that runs late, the trace that starved the old
 * buffer. Stalls stay shorter than the defined lull, so nothing may start on
 * them.
 */
function stalledTrace(seconds: number, stallAt: number, stallS: number): Arrival[] {
  const out: Arrival[] = [];
  const n = Math.round(CHUNK_S * SRC);
  for (let pos = 0; pos < Math.round(seconds * SRC); pos += n) {
    const due = pos / SRC;
    out.push([due >= stallAt && due < stallAt + stallS ? stallAt + stallS : due, sineChunk(pos, n)]);
  }
  return out;
}

/**
 * The whole 2.2 s stream arriving in real time. The reply starts once the
 * target cushion has accumulated, and the cushion then holds.
 */
function healthyTrace() {
  return stream(0, 2.2);
}

/**
 * The same stream with a 487 ms stall before its second half — the trace that
 * ate the old cushion down to ~1 ms and modulated the voice once per chunk.
 */
function starvingTrace() {
  return stream(0, TARGET_CUSHION_S).concat(stream(TARGET_CUSHION_S, 2.2, 0.487));
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

/** Drive the real worklet with `arrivals`; returns every rendered sample and every posted message. */
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
  return { audio: decoded(out), posts: proc.port.posted as Post[], out };
}

/** Seconds into the render at which the first non-zero sample was emitted. */
function firstSound(out: Float32Array): number {
  return out.findIndex((y) => y !== 0) / OUT;
}

/** Source samples that have arrived by `at`, in seconds — what a gate could have started on. */
function arrivedBy(arrivals: Arrival[], at: number): number {
  let n = 0;
  for (const [due, chunk] of arrivals) if (due <= at) n += chunk.length;
  return n;
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

test("target cushion: a reply starts only once the target cushion has arrived", () => {
  const arrivals = healthyTrace();
  const { out } = render(arrivals, 3.2);
  const start = firstSound(out);

  // Arrivals are chunk-quantised, so the gate opens within one chunk of the
  // target — never earlier than it.
  assert.ok(
    start >= TARGET_CUSHION_S - CHUNK_S,
    `started at ${start}s, under the ${TARGET_CUSHION_S}s cushion`,
  );
  assert.ok(start <= TARGET_CUSHION_S + 0.02, `started at ${start}s, long after the cushion`);
  const buffered = arrivedBy(arrivals, start);
  assert.ok(buffered >= TARGET_CUSHION_S * SRC, `started with only ${buffered / SRC}s buffered`);
});

test("target cushion: a jitter trace that would starve the old buffer does not start early", () => {
  // 320 ms of nothing after 200 ms of audio: under the cushion, shorter than
  // the defined lull, and exactly the shape that used to start a reply with
  // almost nothing held. Nothing may sound until the cushion is actually there.
  const arrivals = stalledTrace(2, 0.2, 0.32);
  const { out } = render(arrivals, 3);

  // The earliest moment the trace itself can satisfy the cushion.
  let delivered = 0;
  let readyAt = Infinity;
  for (const [due, chunk] of arrivals) {
    delivered += chunk.length;
    if (delivered >= TARGET_CUSHION_S * SRC) {
      readyAt = due;
      break;
    }
  }
  const start = firstSound(out);
  assert.ok(start >= readyAt - 1e-9, `started at ${start}s, before the cushion could arrive (${readyAt}s)`);
  assert.ok(start <= readyAt + 0.02, `started at ${start}s, though the cushion was ready at ${readyAt}s`);
  const buffered = arrivedBy(arrivals, start);
  assert.ok(buffered >= TARGET_CUSHION_S * SRC, `started with only ${buffered / SRC}s buffered`);
});

test("target cushion: a stall that starved the old buffer does not modulate the voice", () => {
  const { audio, out, posts } = render(starvingTrace(), 3.2);
  const reading = measureEnvelopeModulation(played(audio, out));
  assert.equal(reading.rateHz, 0, `modulated at ${reading.rateHz} Hz (chunk rate is ${CHUNK_RATE_HZ} Hz)`);
  assert.equal(reading.depth, 0, `depth ${reading.depth}`);
  assert.equal(reading.modulated, false);

  // It is not a dropout either: the reply never goes silent before its end.
  const sounding = out.findIndex((y) => y !== 0);
  let last = out.length - 1;
  while (last > sounding && out[last] === 0) last--;
  assert.equal(
    out.subarray(sounding, last).some((y) => y === 0),
    false,
    "the reply is interrupted by silence",
  );
  // One idle report: the natural end of the reply, no underrun.
  assert.equal(posts.filter((p) => p.message.idle).length, 1);
});

test("target cushion: the gain is constant, so a stalled stream changes no amplitude", () => {
  // Same audio, same start; only the second half's arrival moves. With the gain
  // derived from the queue every 10 ms window of the stalled reply loses
  // amplitude against the healthy one. With a constant gain the waveform is the
  // same, sample for sample — except in timing: since ticket 26 the cushion
  // also moves the playback *rate* (by at most 1%), so the two renders are the
  // same voice at very nearly the same speed, never the same arrays.
  const healthy = render(healthyTrace(), 3.2);
  const starving = render(starvingTrace(), 3.2);
  const windowSamples = Math.round(CHUNK_S * OUT);
  /** The largest |sample| in a window: what the ear hears as that window's level. */
  const peak = (x: Float32Array, start: number) => {
    let p = 0;
    for (let j = start; j < start + windowSamples; j++) p = Math.max(p, Math.abs(x[j]!));
    return p;
  };
  let worst = 0;
  let at = 0;
  for (let i = 0; i + windowSamples <= Math.round(2.5 * OUT); i += windowSamples) {
    const moved = Math.abs(peak(starving.out, i) - peak(healthy.out, i)) / AMP;
    if (moved > worst) {
      worst = moved;
      at = i / OUT;
    }
  }
  assert.ok(worst <= 0.01, `a 10 ms window at ${at.toFixed(2)}s moves ${(worst * 100).toFixed(1)}% in level`);

  // And the same statement as a listener hears it: every 10 ms window of a
  // starving reply reaches full amplitude, so the voice is not pumped once per
  // chunk.
  const audio = decoded(starving.out);
  const reply = played(audio, starving.out);
  let lowest = Infinity;
  for (let i = 0; i + windowSamples <= reply.samples.length; i += windowSamples) {
    let p = 0;
    for (let j = i; j < i + windowSamples; j++) p = Math.max(p, Math.abs(reply.samples[j]! / 32767));
    lowest = Math.min(lowest, p);
  }
  assert.ok(lowest >= 0.49, `a chunk window only reaches ${lowest} of ${AMP}`);

  // What the stall does move is timing, and only inside the inaudible bound.
  const corrections = starving.posts
    .filter((p) => p.message.type === "level" && p.message.playing)
    .map((p) => Math.abs(p.message.correctionPct));
  assert.ok(corrections.length > 0, "the worklet reports nothing while sounding");
  assert.ok(Math.max(...corrections) <= 1, `the stall moves the rate ${Math.max(...corrections)}%`);
});

test("target cushion: the worklet reports the cushion it holds and the target it starts at", () => {
  const { posts } = render(healthyTrace(), 3.2);
  const levels = posts.filter((p) => p.message.type === "level");
  assert.ok(levels.length > 0, "the worklet reports nothing");

  for (const { message } of levels) {
    assert.equal(message.targetCushionMs, TARGET_CUSHION_S * 1000, "the target is not a named constant");
  }
  const sounding = levels.filter((p) => !p.message.idle && p.message.playing).map((p) => p.message);
  assert.ok(sounding.length > 0, "no report while sounding");
  assert.ok(sounding.some((m) => m.cushionMs > 1), "the worklet never reports a held cushion");
  // A reported cushion is real held audio: it never claims to hold more than
  // the target, and it starts just under it.
  assert.ok(sounding[0]!.cushionMs >= 400, `first report holds ${sounding[0]!.cushionMs} ms`);
  assert.ok(
    Math.max(...sounding.map((m) => m.cushionMs)) <= TARGET_CUSHION_S * 1000 + 20,
    "the worklet claims more cushion than the target",
  );
});

test("target cushion: a reply shorter than the cushion starts after the defined lull", () => {
  // A 120 ms greeting can never reach a 500 ms cushion. It must not be held
  // forever: once arrivals stop for the defined lull, it plays.
  const { out } = render([[0, sineChunk(0, Math.round(0.12 * SRC))]], 1.2);
  const start = firstSound(out);
  assert.ok(start >= TARGET_CUSHION_S - 1e-9, `started at ${start}s, under the lull`);
  assert.ok(start <= TARGET_CUSHION_S + 0.05, `started at ${start}s, long after the lull`);

  let last = out.length - 1;
  while (last > 0 && out[last] === 0) last--;
  const soundedMs = ((last - Math.round(start * OUT)) / OUT) * 1000;
  assert.ok(soundedMs >= 118, `played ${soundedMs}ms of a 120ms reply`);
});
