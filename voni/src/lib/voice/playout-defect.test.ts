/**
 * Characterisation of the playout defect ticket 25 removed.
 *
 * THIS TEST PINNED BAD BEHAVIOUR. It is evidence, not a gate: it passed only
 * while the buffer-length envelope still reshaped the voice and the dry-out
 * still inserted its fixed hole. Ticket 25 removed the per-sample envelope, so
 * the starving and dry-out assertions below are no longer true of the worklet
 * and every test in this file is skipped. `voni/docs/playout-defect-evidence.md`
 * keeps the measured numbers (100 Hz at depth 0.212, a 0.511 s hole).
 *
 * Ticket 28 replaces this file with gating assertions — the absence of
 * chunk-rate modulation and of an inserted hole — so it must not be deleted
 * before then. Do not un-skip these tests: they assert the defect, not a
 * contract.
 *
 * The three traces are the same 2.2 s 10 ms-chunked stream, differing only in
 * when its second half arrives:
 *
 *   healthy   no stall                  → cushion holds, no modulation
 *   starving  487 ms stall, never dry   → gain follows the ~3 ms cushion
 *   dry-out   510 ms stall, buffer empty→ 5 ms fade, then a new 500 ms hole
 *
 * The real `public/playout-processor.js` runs in a `vm` with the
 * AudioWorkletGlobalScope pieces it uses stubbed — the same seam as
 * `worklets.test.ts`, copied rather than shared so the two files stay
 * independent. Run from `voni/`, because the worklet is read from `public/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { DecodedAudio } from "../audio/format-facts";
import { measureEnvelopeModulation } from "../audio/envelope-modulation";
import { detectBreakups } from "../audio/breakups";

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = {
  port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
type Arrival = [number, Float32Array];
type Post = { at: number; message: { type: string; idle: boolean; queuedMs: number } };

const OUT = 48000;
const SRC = 24000;
const QUANTUM = 128;
const HZ = 220;
const AMP = 0.5;
/** The platform streams 10 ms chunks, so a buffer-occupancy envelope shows up at this rate. */
const CHUNK_S = 0.01;
const CHUNK_RATE_HZ = 1 / CHUNK_S;
/** The worklet's pre-roll: the cushion a reply starts with, and the hole after a dry-out. */
const PREROLL_S = 0.5;

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

/**
 * The whole stream arriving in real time. The reply starts once 500 ms has
 * accumulated and the cushion then holds for the rest of the stream.
 */
function healthyTrace() {
  return stream(0, 2.2);
}

/**
 * The same stream with a 487 ms stall before its second half. The stall eats
 * all but ~3 ms of the 500 ms cushion, so every later chunk arrives just as
 * the buffer empties and the gain follows the remaining samples.
 */
function starvingTrace() {
  return stream(0, PREROLL_S).concat(stream(PREROLL_S, 2.2, 0.487));
}

/**
 * The same stream with a 510 ms stall. The cushion runs out mid-reply, the
 * worklet goes idle, and it waits for a whole new pre-roll before ramping back in.
 */
function dryOutTrace() {
  return stream(0, PREROLL_S).concat(stream(PREROLL_S, 2.2, 0.51));
}

test.skip("playout defect control: a real-time stream holds the cushion and is not modulated", () => {
  const { audio, out, posts } = render(healthyTrace(), 3.2);
  const reading = measureEnvelopeModulation(played(audio, out));

  assert.equal(reading.rateHz, 0, "a held cushion must not modulate the voice");
  assert.equal(reading.modulated, false);
  // Exactly one idle report: the natural end of the reply.
  assert.equal(posts.filter((p) => p.message.idle).length, 1);
  assert.deepEqual(interiorSilences(out), [], "no hole once the reply has started");
});

test.skip("playout defect: a starving buffer amplitude-modulates the voice at the chunk rate", () => {
  const { audio, out, posts } = render(starvingTrace(), 3.2);
  const reading = measureEnvelopeModulation(played(audio, out));
  const cushion = Math.min(
    ...posts.filter((p) => p.message.type === "level" && !p.message.idle).map((p) => p.message.queuedMs),
  );
  console.log(
    `starving: rate ${reading.rateHz.toFixed(3)} Hz, depth ${reading.depth.toFixed(3)} ` +
      `(${reading.depthDb.toFixed(2)} dB), cushion ${cushion.toFixed(1)} ms`,
  );

  // The modulation is the chunk rate: 10 ms chunks arrive 100 times a second.
  assert.ok(
    Math.abs(reading.rateHz - CHUNK_RATE_HZ) < 1,
    `rate ${reading.rateHz} Hz is not the ${CHUNK_RATE_HZ} Hz chunk rate`,
  );
  // Measured 21% peak-to-trough (3.7 dB): the voice is audibly pumped once per chunk.
  assert.ok(reading.depth > 0.15, `depth ${reading.depth}`);
  assert.equal(reading.modulated, true);

  // It is modulation, not a dropout: the reply never goes silent.
  assert.deepEqual(interiorSilences(out), []);
  // And the buffer never fully empties: the only idle report is the reply's end.
  const idles = posts.filter((p) => p.message.idle).map((p) => p.at);
  assert.equal(idles.length, 1, `idle at ${idles.join(", ")}`);
  // Proof the cushion is the cause: at each arrival the buffer holds a few ms.
  const held = posts.filter((p) => !p.message.idle && p.message.queuedMs < 10);
  assert.ok(held.length > 0, "the trace must hold less than 10 ms of cushion");
});

test.skip("playout defect: a dry-out inserts half a second of silence before resuming", () => {
  const { audio, out } = render(dryOutTrace(), 3.2);
  const [hole] = interiorSilences(out);
  assert.ok(hole, "one inserted silence");
  assert.equal(interiorSilences(out).length, 1, "exactly one inserted silence");

  // The hole the listener hears, from the last non-zero sample to the next.
  assert.ok(Math.abs(hole[1] - 0.51) < 0.02, `hole ${hole[1]}s`);

  // detectBreakups at its default -60 dBFS floor does not report this hole: the
  // worklet's 5 ms fade-out lands in one 10 ms frame just above the floor, so
  // the -12 dB edge rule reads a cut as a natural decay. Recorded for ticket 28.
  assert.equal(detectBreakups(audio).count, 0);

  // 21 dB below the tone, the analyser sees the hole and agrees with the zeros.
  const report = detectBreakups(audio, { silenceFloorDb: -30 });
  assert.equal(report.count, 1);
  assert.ok(Math.abs(report.longestSeconds - hole[1]) < 0.005, `analyser ${report.longestSeconds}s`);

  // The inserted length is the worklet's own pre-roll: it resumes only after a
  // full new cushion has arrived, ~500 ms after the first post-stall chunk.
  const firstPostStall = Math.min(...stream(PREROLL_S, 2.2, 0.51).map(([at]) => at));
  const resumedAt = hole[0] + hole[1];
  console.log(
    `dry-out: hole ${hole[1].toFixed(3)} s at ${hole[0].toFixed(3)} s, ` +
      `refill wait ${(resumedAt - firstPostStall).toFixed(3)} s`,
  );
  assert.ok(Math.abs(resumedAt - firstPostStall - PREROLL_S) < 0.03, "waits for a new pre-roll");
});
