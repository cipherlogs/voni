/**
 * The playout's quality gate (ticket 28).
 *
 * Ticket 07 characterised the defect: a reply's gain followed how much audio
 * was left, so a starving buffer amplitude-modulated the voice at the chunk
 * rate (measured **100 Hz at depth 0.212**), and a buffer that ran dry waited
 * for a whole fresh cushion before resuming (measured a **0.511 s hole**,
 * resuming 0.491 s after the audio arrived). Tickets 25–27 removed both, and
 * the numbers and the measurement recipe stay in
 * `voni/docs/playout-defect-evidence.md`.
 *
 * This file is the gate those numbers were for. It asserts the *absence* of
 * both artefacts on the same three synthetic traces, and it proves the gate can
 * fail by running it against copies of today's worklet with each fix reverted:
 *
 *   gate                                   threshold
 *   ----                                   ---------
 *   modulation on the starving trace       no rate in the 1–150 Hz band, depth ≤ 2 %
 *   hole on the dry-out trace              ≤ 1 interior silence, < 100 ms
 *   resume after the first post-stall      < 50 ms
 *
 * The seam is ticket 25's: the real `public/playout-processor.js`, unmodified,
 * in a `vm` with the AudioWorkletGlobalScope pieces it uses stubbed. Each
 * negative control is the same file with one textual revert applied — and a
 * revert whose anchor has moved is an error, never a silent pass, so the
 * control cannot rot into a tautology. Run from `voni/`.
 *
 * `detectBreakups` at its default -60 dBFS floor cannot see the hole: the
 * worklet fades over 5 ms before going idle, so the cut lands in one 10 ms
 * frame just above the floor and reads as a natural decay. The gate therefore
 * reads the exact-zero run and the resume latency, as recorded in the evidence
 * note; the negative control pins that blindness so nobody "fixes" the gate by
 * trusting the default edge rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { DecodedAudio } from "../audio/format-facts";
import { measureEnvelopeModulation, type EnvelopeModulation } from "../audio/envelope-modulation";
import { detectBreakups } from "../audio/breakups";

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
 * The cushion a reply starts on. The owner's call, recorded in the worklet and
 * in `docs/playout-defect-evidence.md` (80 ms broke up on phones), not a number
 * this test reads back from the code.
 */
const TARGET_CUSHION_S = 0.5;

/** Modulation depth the gate allows: 2 %, a tenth of the defect's measured 21 %. */
const MAX_DEPTH = 0.02;
/** The analyser's band floor: no dominant rate below this, so a flat envelope reads 0 Hz. */
const MAX_RATE_HZ = 1;
/** Interior silences the gate allows on the dry-out trace. */
const MAX_INTERIOR_SILENCES = 1;
/** Longest hole the gate allows: the ~15 ms network gap, not the worklet's half second. */
const MAX_HOLE_S = 0.1;
/** Resume latency the gate allows after the first post-stall chunk arrives. */
const MAX_RESUME_S = 0.05;

const WORKLET = "public/playout-processor.js";

function load(sampleRate: number, source = readFileSync(WORKLET, "utf8")) {
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
  vm.runInNewContext(source, scope);
  return { proc: new scope.registered!(), scope };
}

/**
 * Today's worklet with one fragment replaced: how a negative control is built.
 * The anchor must be present exactly once, so a fix that moves the code makes
 * the control fail loudly instead of quietly measuring nothing.
 */
function revert(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  assert.ok(at >= 0, `negative control: \`${from.trim()}\` is no longer in ${WORKLET}`);
  assert.equal(
    source.indexOf(from, at + 1),
    -1,
    `negative control: \`${from.trim()}\` appears more than once in ${WORKLET}`,
  );
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/** Ticket 07's gain: it follows the queued samples, one cycle per arriving chunk. */
const LEGACY_GAIN = `    const room = Math.max(0, (this.queued + 1 - this.frac) / (EDGE_S * this.rate));
    this.gain = Math.min(room, 1, this.gain + this.gainStep);`;
const GAIN_WITHOUT_BUFFER = "    this.gain = Math.min(1, this.gain + this.gainStep);";

/** Ticket 07's resume: after a dry-out, wait for a whole new target cushion. */
const LEGACY_RESUME_WAIT = `      const buffered = this.queued >= TARGET_CUSHION_S * this.rate;
      if (buffered || lull) this.start();`;
const RESUME_ON_ARRIVAL = `      const resuming = currentTime - this.dryAt <= RESUME_WINDOW_S;
      const cushioned = currentTime >= this.cushionBy;
      const buffered = this.queued >= TARGET_CUSHION_S * this.rate;
      if (resuming || cushioned || buffered || lull) this.start();`;

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
 * 2.2 s of audio whose second half arrives 510 ms late. The cushion runs out
 * mid-reply, the worklet goes idle, and the next audio must resume it at once.
 */
function dryOutTrace(): Arrival[] {
  return stream(0, TARGET_CUSHION_S).concat(stream(TARGET_CUSHION_S, 2.2, 0.51));
}

/**
 * The same stream with a 487 ms stall — the trace that ate the old cushion to
 * ~1 ms and pumped the voice once per chunk. It never runs dry.
 */
function starvingTrace(): Arrival[] {
  return stream(0, TARGET_CUSHION_S).concat(stream(TARGET_CUSHION_S, 2.2, 0.487));
}

/** The whole stream in real time: the control whose cushion holds. */
function healthyTrace(): Arrival[] {
  return stream(0, 2.2);
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

type Render = { audio: DecodedAudio; out: Float32Array; posts: Post[] };

/** Drive the worklet with `arrivals`; returns every rendered sample and every post. */
function render(arrivals: Arrival[], seconds: number, source?: string): Render {
  const { proc, scope } = load(OUT, source);
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
  return { audio: decoded(out), out, posts: proc.port.posted as Post[] };
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

// --- The gates -------------------------------------------------------------

/**
 * Gate 1: a reply that started is not amplitude-modulated. The envelope may
 * carry no rate inside the modulation band, and no depth beyond MAX_DEPTH — a
 * tenth of the 21 % the defect measured at the chunk rate.
 */
function assertNoChunkRateModulation(result: Render, label: string): EnvelopeModulation {
  const reading = measureEnvelopeModulation(played(result.audio, result.out), {
    threshold: MAX_DEPTH,
  });
  console.log(
    `${label}: modulation ${reading.rateHz.toFixed(3)} Hz at depth ${reading.depth.toFixed(3)} ` +
      `(${reading.depthDb.toFixed(2)} dB)`,
  );

  // One sentence, both numbers: "amplitude-modulated at 100.0 Hz … depth 0.212
  // … the chunk rate is 100 Hz" tells the next reader exactly which buffer
  // state shaped the voice again. A rate with no depth is the weaker breach and
  // is only reported when the depth is inside the gate, so one cause is named.
  const breached: string[] = [];
  if (reading.depth > MAX_DEPTH) {
    breached.push(
      `the voice is amplitude-modulated at ${reading.rateHz.toFixed(1)} Hz ` +
        `(depth ${reading.depth.toFixed(3)}, ${reading.depthDb.toFixed(2)} dB)`,
    );
  } else if (reading.rateHz > MAX_RATE_HZ) {
    breached.push(
      `the envelope has a dominant rate of ${reading.rateHz.toFixed(1)} Hz, not a flat one`,
    );
  }
  assert.equal(
    breached.length,
    0,
    `${label}: ${breached.join("; ")} — the chunk rate is ${CHUNK_RATE_HZ} Hz and the gate is ` +
      `depth ≤ ${MAX_DEPTH} with no rate above ${MAX_RATE_HZ} Hz`,
  );
  assert.equal(reading.modulated, false, `${label}: modulated at ${reading.rateHz.toFixed(1)} Hz`);
  return reading;
}

/**
 * Gate 2: a reply that ran dry is interrupted only by the network's gap. At
 * most one interior silence, shorter than MAX_HOLE_S, and the audio that
 * arrives resumes it within MAX_RESUME_S. Waiting for a fresh cushion fails
 * both, and the failure names the measured hole.
 */
function assertNoInsertedHole(
  result: Render,
  firstPostStall: number,
  label: string,
): { holes: [number, number][]; resumeS: number } {
  const holes = interiorSilences(result.out);
  const longest = holes.reduce((m, [, length]) => Math.max(m, length), 0);
  const lastHole = holes[holes.length - 1];
  const firstSound = result.out.findIndex((y) => y !== 0) / OUT;
  const resumedAt = lastHole ? lastHole[0] + lastHole[1] : firstSound;
  const resumeS = Math.max(0, resumedAt - firstPostStall);
  console.log(
    `${label}: ${holes.length} interior silence(s), longest ${longest.toFixed(3)} s, ` +
      `resume ${(resumeS * 1000).toFixed(0)} ms after the audio arrived`,
  );

  assert.ok(
    holes.length <= MAX_INTERIOR_SILENCES,
    `${label}: ${holes.length} interior silences (gate ≤ ${MAX_INTERIOR_SILENCES}): ` +
      holes.map(([at, length]) => `${length.toFixed(3)} s at ${at.toFixed(3)} s`).join(", "),
  );

  // One sentence naming both breaches: the hole length and the wait after the
  // audio arrived. The fixed half second fails both at once.
  const breached: string[] = [];
  if (longest >= MAX_HOLE_S) {
    breached.push(
      `a ${longest.toFixed(3)} s hole at ${(lastHole ? lastHole[0] : 0).toFixed(3)} s`,
    );
  }
  if (resumeS >= MAX_RESUME_S) {
    breached.push(
      `resumed ${(resumeS * 1000).toFixed(0)} ms after the first post-stall chunk arrived`,
    );
  }
  assert.equal(
    breached.length,
    0,
    `${label}: ${breached.join("; ")} — the reply waited for a fresh cushion ` +
      `(gate: one hole under ${MAX_HOLE_S} s, resumed within ${MAX_RESUME_S * 1000} ms)`,
  );
  return { holes, resumeS };
}

/** The worklet with ticket 07's buffer-derived gain restored. */
function withLegacyGain(): string {
  return revert(readFileSync(WORKLET, "utf8"), GAIN_WITHOUT_BUFFER, LEGACY_GAIN);
}

/** The worklet with ticket 07's wait-for-a-fresh-cushion resume restored. */
function withLegacyResumeWait(): string {
  return revert(readFileSync(WORKLET, "utf8"), RESUME_ON_ARRIVAL, LEGACY_RESUME_WAIT);
}

/** The audio the reply is owed, after a stall: the first arrival past the cushion. */
function firstPostStall(arrivals: Arrival[]): number {
  return Math.min(...arrivals.filter(([due]) => due > TARGET_CUSHION_S).map(([due]) => due));
}

// --- The gate, on the real worklet -----------------------------------------

test("gate: a healthy stream holds its cushion and is not modulated", () => {
  const { audio, out, posts } = render(healthyTrace(), 3.2);
  const result = { audio, out, posts };

  const reading = assertNoChunkRateModulation(result, "healthy");
  assert.equal(reading.rateHz, 0, "a held cushion must not modulate the voice");
  assert.equal(reading.depth, 0, "a held cushion must not move the amplitude");

  // One idle report: the natural end of the reply.
  assert.equal(posts.filter((p) => p.message.idle).length, 1);
  assert.deepEqual(interiorSilences(out), [], "no hole once the reply has started");
});

test("gate: a starving buffer does not modulate the voice at the chunk rate", () => {
  const arrivals = starvingTrace();
  const result = render(arrivals, 3.2);

  // The whole gate: no rate in the band, no depth. Before ticket 25 this read
  // 100 Hz at depth 0.212 (see `docs/playout-defect-evidence.md`).
  assertNoChunkRateModulation(result, "starving");

  // It is modulation, not a dropout, that the trace used to cause: the reply
  // never goes silent, and the cushion is genuinely near-empty at the arrival.
  assert.deepEqual(interiorSilences(result.out), [], "the starved reply is interrupted by silence");
  const idles = result.posts.filter((p) => p.message.idle);
  assert.equal(idles.length, 1, `the reply stopped early, at ${idles.map((p) => p.at).join(", ")}`);
  const held = result.posts.filter((p) => !p.message.idle && p.message.queuedMs < 10);
  assert.ok(held.length > 0, "the trace must hold less than 10 ms of cushion, or it proves nothing");
});

test("gate: a dry-out leaves no inserted hole and resumes within 50 ms", () => {
  const arrivals = dryOutTrace();
  const result = render(arrivals, 3.6);
  const first = firstPostStall(arrivals);

  const { holes, resumeS } = assertNoInsertedHole(result, first, "dry-out");
  // The one interruption is the network's: 510 ms of stall against a 500 ms
  // cushion. Before ticket 27 this was 0.511 s at 0.491 s of extra wait.
  assert.ok(holes.length === 1, "the trace must actually run dry, or it proves nothing");
  assert.ok(
    resumeS > 0.0001,
    "the resumed audio arrived while the buffer was still sounding; the trace is not a dry-out",
  );

  // The faded cut is exactly why the breakup analyser cannot be the gate: at
  // its default floor this render reports no breakup at all. The zero run is
  // the measurement, as `docs/playout-defect-evidence.md` records. If ticket
  // 06's analyser ever does see a faded cut, update the evidence note rather
  // than swapping the gate onto the edge rule.
  assert.equal(
    detectBreakups(result.audio).count,
    0,
    "the default floor now sees the faded cut: re-read the evidence note before changing this gate",
  );
});

// --- The negative controls: the gate can fail ------------------------------

test("negative control: buffer-derived gain fails the modulation gate at the chunk rate", () => {
  const result = render(starvingTrace(), 3.2, withLegacyGain());

  // The revert restores the defect, not something else: the envelope swings at
  // the chunk rate. Depth is 0.096 here rather than ticket 07's 0.212 because
  // the drift corrector (ticket 26) holds a higher cushion than the old worklet
  // did, so the same gain rule sees a shallower sawtooth — still four times the
  // gate and twice the analyser's own 5 % "pumped" line.
  const restored = measureEnvelopeModulation(played(result.audio, result.out));
  assert.ok(
    Math.abs(restored.rateHz - CHUNK_RATE_HZ) < 1,
    `the restored defect reads ${restored.rateHz} Hz, not the ${CHUNK_RATE_HZ} Hz chunk rate`,
  );
  assert.ok(restored.depth > 0.05, `the restored defect only reads depth ${restored.depth}`);

  // And the gate refuses it, naming the rate it measured.
  assert.throws(
    () => assertNoChunkRateModulation(result, "negative control"),
    (error: Error) => {
      const named = Number(error.message.match(/amplitude-modulated at ([\d.]+) Hz/)?.[1]);
      assert.ok(
        Math.abs(named - CHUNK_RATE_HZ) < 1,
        `the gate named ${named} Hz, not the ${CHUNK_RATE_HZ} Hz chunk rate`,
      );
      assert.match(error.message, /depth 0\.\d+/);
      assert.match(error.message, /the chunk rate is 100 Hz/);
      return true;
    },
  );
});

test("negative control: waiting for a fresh cushion fails the hole gate", () => {
  const arrivals = dryOutTrace();
  const first = firstPostStall(arrivals);
  const result = render(arrivals, 3.6, withLegacyResumeWait());

  // The revert restores the fixed hole: ~0.5 s, resuming ~0.49 s late.
  const holes = interiorSilences(result.out);
  assert.equal(holes.length, 1, `expected the restored fixed hole, got ${holes.length}`);
  assert.ok(Math.abs(holes[0]![1] - 0.5) < 0.03, `the restored hole is ${holes[0]![1]} s`);
  assert.ok(holes[0]![0] + holes[0]![1] - first > 0.4, "the restored reply does not wait for a cushion");

  // The default breakup edge rule still cannot see that hole — the reason the
  // gate reads the zero run, pinned so the gate is not "simplified" onto it.
  assert.equal(
    detectBreakups(result.audio).count,
    0,
    "the default floor now sees the faded cut: re-read the evidence note before changing this gate",
  );

  // The gate refuses it, naming the hole it measured.
  assert.throws(
    () => assertNoInsertedHole(result, first, "negative control"),
    (error: Error) => {
      assert.match(error.message, /a 0\.5\d\d s hole at 0\.99\d s/);
      assert.match(error.message, /resumed 49\d ms after the first post-stall chunk arrived/);
      assert.match(error.message, /waited for a fresh cushion/);
      return true;
    },
  );
});

test("negative control: a revert whose anchor has moved is an error, not a pass", () => {
  // The controls above are only worth their runtime if the fragments they
  // revert still exist. When a fix moves the code, this is the failure that
  // says so, instead of a control that silently measures the fixed worklet.
  assert.throws(
    () => revert(readFileSync(WORKLET, "utf8"), "a line this worklet does not contain", "x"),
    /no longer in public\/playout-processor\.js/,
  );
});
