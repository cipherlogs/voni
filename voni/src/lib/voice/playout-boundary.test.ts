/**
 * The playout's reply boundaries (ticket 27).
 *
 * A reply used to fade its gain from how much audio was left and, once the
 * buffer actually ran dry, wait for a whole fresh target cushion before making
 * a sound again — a fixed half-second hole in the middle of a sentence. The
 * gain no longer follows the buffer (ticket 25). This file pins the other half:
 *
 *   - a dry-out resumes on the next audio that arrives, on the short cushion
 *     that audio provides, and the drift corrector (ticket 26) refills from
 *     there;
 *   - a late chunk that does not drain the buffer is not a boundary at all: no
 *     fade, no hole, no idle;
 *   - a true reply start and a true reply end still fade over the edge time,
 *     and a deliberate flush still fades and drops what was queued, so no
 *     click is traded for the hole.
 *
 * The seam is the one ticket 25 established: the real
 * `public/playout-processor.js`, unmodified, in a `vm` with the
 * AudioWorkletGlobalScope pieces it uses stubbed. Run from `voni/`, because the
 * worklet is read from `public/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
/** Adjacent-sample step of a clean HZ sine at OUT, with headroom. */
const CLEAN_STEP = ((2 * Math.PI * HZ * AMP) / OUT) * 1.2;
/**
 * The cushion a reply starts on: the owner's call, recorded in the worklet and
 * in `docs/playout-defect-evidence.md` (80 ms broke up on phones), not a number
 * this test reads back from the code.
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
 * 2.2 s of audio whose second half arrives 510 ms late: the cushion runs out
 * mid-reply at ~1 s, exactly the trace that measured a 0.511 s hole before
 * ticket 27 (see `docs/playout-defect-evidence.md`).
 */
function dryOutTrace(): Arrival[] {
  return stream(0, TARGET_CUSHION_S).concat(stream(TARGET_CUSHION_S, 2.2, 0.51));
}

/**
 * The same stream with a 487 ms stall — late, but the cushion survives with a
 * few milliseconds to spare. Nothing about this is a reply boundary.
 */
function starvingTrace(): Arrival[] {
  return stream(0, TARGET_CUSHION_S).concat(stream(TARGET_CUSHION_S, 2.2, 0.487));
}

/** Drive the real worklet with `arrivals`; returns every rendered sample and every post. */
function render(arrivals: Arrival[], seconds: number) {
  const { proc, scope } = load(OUT);
  const out = new Float32Array(Math.ceil((seconds * OUT) / QUANTUM) * QUANTUM);
  let seq = 0;
  let next = 0;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / OUT;
    while (next < arrivals.length && arrivals[next]![0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next]![1] } });
      next++;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }
  return { out, posts: proc.port.posted as Post[] };
}

/** Inserted silences — exact zeros with sound on both sides — as [startSeconds, durationSeconds]. */
function interiorSilences(out: Float32Array) {
  const runs: [number, number][] = [];
  let start = -1;
  let sounded = false;
  for (let i = 0; i <= out.length; i++) {
    if (i < out.length && out[i] === 0) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      // A run that reaches the end of the render is the reply finishing, not a hole.
      if (sounded && i < out.length && i - start >= OUT * 0.005) {
        runs.push([start / OUT, (i - start) / OUT]);
      }
      start = -1;
    }
    if (i < out.length) sounded = true;
  }
  return runs;
}

/** Largest jump between adjacent samples. */
function maxStep(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

/** The idles the worklet posted, as seconds. */
function idleTimes(posts: Post[]): number[] {
  return posts.filter((p) => p.message.idle).map((p) => p.at);
}

test("boundary: a dry-out resumes on the next audio, not after a fresh half-second cushion", () => {
  const arrivals = dryOutTrace();
  const { out } = render(arrivals, 3.6);
  const holes = interiorSilences(out);
  assert.equal(holes.length, 1, `expected one interruption, got ${holes.length}: ${JSON.stringify(holes)}`);

  const [at, length] = holes[0]!;
  const firstPostStall = Math.min(...arrivals.filter(([due]) => due > TARGET_CUSHION_S).map(([due]) => due));
  const resumedAt = at + length;
  console.log(
    `dry-out: hole ${length.toFixed(3)} s at ${at.toFixed(3)} s, ` +
      `refill wait ${(resumedAt - firstPostStall).toFixed(3)} s`,
  );

  // The hole is the network's, not the worklet's: the 510 ms stall against a
  // 500 ms cushion leaves a gap of about one chunk. Waiting for a whole new
  // cushion would put this past 0.5 s — the fixed hole ticket 27 removes.
  assert.ok(length < 0.1, `hole ${length}s: still waiting for a fresh cushion`);
  assert.ok(
    resumedAt - firstPostStall < 0.05,
    `resumed ${(resumedAt - firstPostStall).toFixed(3)}s after the audio arrived`,
  );

  // And the interruption is still an edge fade at both ends, not a click.
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)} > clean ${CLEAN_STEP}`);
});

test("boundary: a resumed reply starts on a short cushion and the corrector refills it", () => {
  const arrivals = dryOutTrace();
  const { posts } = render(arrivals, 3.6);

  // One idle at the dry-out, one at the real end: the reply is resumed, not
  // restarted into a second reply.
  assert.equal(idleTimes(posts).length, 2, `idles at ${idleTimes(posts).join(", ")}`);

  const series = posts.filter((p) => p.message.playing).map((p) => ({ at: p.at, m: p.message }));
  const firstPostStall = Math.min(...arrivals.filter(([due]) => due > TARGET_CUSHION_S).map(([due]) => due));
  const after = series.filter((s) => s.at >= firstPostStall);
  assert.ok(after.length > 0, "the resumed reply reports nothing while sounding");

  // It resumes on what arrived, not on a target: a chunk or two of audio.
  assert.ok(after[0]!.m.cushionMs <= 100, `resumed on a ${after[0]!.m.cushionMs} ms cushion`);

  // The short cushion is what the corrector is for: the consumer plays slower
  // to refill, inside the inaudible bound.
  const corrections = after.map((s) => s.m.correctionPct);
  assert.ok(
    corrections.some((c) => c < -0.05),
    `a short cushion is not corrected (${corrections.map((c) => c.toFixed(2)).join(", ")})`,
  );
  const biggest = Math.max(...corrections.map(Math.abs));
  assert.ok(biggest <= 1, `the rate moves ${biggest}%`);

  // No second dry-out on the way: the short cushion is held, not drained again.
  assert.ok(Math.min(...after.map((s) => s.m.cushionMs)) > 0, "the resumed reply runs dry again");
});

test("boundary: a late chunk that does not drain the reply is not a boundary", () => {
  const arrivals = starvingTrace();
  const { out, posts } = render(arrivals, 3.2);

  // Nothing goes silent: no fade-out, no hole. A fade would end in exact zeros.
  assert.deepEqual(interiorSilences(out), []);
  // One idle, at the natural end: the worklet never went into a boundary state.
  assert.equal(idleTimes(posts).length, 1, `idles at ${idleTimes(posts).join(", ")}`);
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);

  // And the late chunk changes no amplitude: every 10 ms window of the reply
  // reaches full level, before and after the stall.
  const first = out.findIndex((y) => y !== 0);
  let last = out.length - 1;
  while (last > first && out[last] === 0) last--;
  const windowSamples = Math.round(CHUNK_S * OUT);
  let lowest = Infinity;
  for (let i = first; i + windowSamples <= last; i += windowSamples) {
    let peak = 0;
    for (let j = i; j < i + windowSamples; j++) peak = Math.max(peak, Math.abs(out[j]!));
    lowest = Math.min(lowest, peak);
  }
  assert.ok(lowest >= 0.49, `a chunk window only reaches ${lowest} of ${AMP}`);
});

test("boundary: audio arriving long after a dry-out is a new reply and gets the cushion", () => {
  // Reply A drains at ~1 s. More than the resume window later (1.6 s), a new
  // turn's audio arrives in real time. It is not the rest of A's sentence, so
  // it waits for the target cushion like any reply start — the jitter budget
  // is not spent on a gap that is really a new turn.
  const arrivals: Arrival[] = stream(0, TARGET_CUSHION_S).concat(stream(0, 1, 2.6));
  const { out } = render(arrivals, 4.5);
  const firstNewTurn = Math.min(...arrivals.filter(([due]) => due >= 2.6).map(([due]) => due));
  const resumed = out.findIndex((y, i) => i > firstNewTurn * OUT && y !== 0) / OUT;
  assert.ok(
    resumed - firstNewTurn >= TARGET_CUSHION_S - 0.05,
    `started ${(resumed - firstNewTurn).toFixed(3)}s after the new turn's audio, under the cushion`,
  );
  assert.ok(
    resumed - firstNewTurn <= TARGET_CUSHION_S + 0.05,
    `started ${(resumed - firstNewTurn).toFixed(3)}s after the new turn's audio, long after the cushion`,
  );
});

test("boundary: a deliberate flush still fades and drops the queue", () => {
  // Reply A is sounding when the caller barges in at 0.8 s; the flush fades it
  // over 40 ms and drops the rest. Reply B was already queued with more than a
  // target cushion, so it is a true reply start: it waits for its cushion and
  // fades in.
  const arrivals: Arrival[] = [[0, sineChunk(0, SRC)], [0.9, sineChunk(0, Math.round(0.6 * SRC))]];
  const { proc, scope } = load(OUT);
  const out = new Float32Array(Math.ceil((2 * OUT) / QUANTUM) * QUANTUM);
  let seq = 0;
  let next = 0;
  let flushed = false;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / OUT;
    while (next < arrivals.length && arrivals[next]![0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next]![1] } });
      next++;
    }
    if (!flushed && scope.currentTime >= 0.8) {
      proc.port.onmessage!({ data: { type: "flush", fadeS: 0.04 } });
      flushed = true;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }

  // No click: the fade is a ramp, and the new reply ramps in too.
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out)}`);

  // The dropped second half of reply A never plays: silence from the end of the
  // flush fade until reply B starts on its own cushion.
  const start = out.findIndex((y) => y !== 0);
  assert.ok(start / OUT < 0.8, `nothing sounded before the flush (first at ${(start / OUT).toFixed(3)}s)`);
  const silentFrom = Math.ceil((0.8 + 0.04 + QUANTUM / OUT) * OUT);
  const silentTo = Math.ceil(0.9 * OUT);
  for (let i = silentFrom; i < silentTo; i++) {
    assert.equal(out[i], 0, `sound at ${(i / OUT).toFixed(3)}s after the flush faded out`);
  }
  const restarted = out.findIndex((y, i) => i > silentTo && y !== 0);
  assert.ok(
    Math.abs(restarted / OUT - 0.9) <= 0.02,
    `the new reply starts at ${(restarted / OUT).toFixed(3)}s, want 0.9s`,
  );
});
