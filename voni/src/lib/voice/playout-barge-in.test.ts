/**
 * The playout's barge-in cost (ticket 29).
 *
 * A barge-in used to end the interrupted reply the only way the worklet knew
 * how: fade the sounding tail, drop the queue, and reset to a cold start. The
 * new reply then had to accumulate a whole fresh target cushion before it could
 * make a sound. Measured on the real worklet with the trace below, that is
 * **0.491 s of silence after the new reply's first audio arrived** — the "half
 * a second before the new reply" the spec records.
 *
 * The fix keeps the cushion across the flush instead of resetting it. The
 * interrupted reply's queued audio is still dropped (it is speech the caller
 * has already talked over, and playing it would be the bug), but the *cushion
 * deadline* survives: a new reply is not charged a second pre-roll. Concretely,
 * the reply may start once the target cushion is buffered **or once the
 * barge-in itself has already cost the target cushion**, whichever comes first.
 * So:
 *
 *   - audio that arrives inside the cushion window still starts on the
 *     remainder of that window, with the cushion it was promised (the flush
 *     preserves the target, it does not shorten it);
 *   - audio that arrives after it — the normal case, because the server has to
 *     end-point, judge and generate — starts at once instead of waiting out a
 *     second, artificial pre-roll.
 *
 * What the caller can depend on:
 *
 *   - the old reply's tail fades over the requested time and is never heard
 *     again (no click, no stale speech);
 *   - the new reply is not amplitude-modulated: the gain is constant, and any
 *     interruption is a network gap of the same shape ticket 27 fixed;
 *   - a deliberate hang-up still clears playback completely and leaves no
 *     credit behind.
 *
 * The seam is ticket 25's: the real `public/playout-processor.js`, unmodified,
 * in a `vm` with the AudioWorkletGlobalScope pieces it uses stubbed. Every
 * "before" number is measured on a copy of today's worklet with the fix
 * textually reverted, and a revert whose anchor has moved is an error rather
 * than a silent pass. Run from `voni/`, because the worklet is read from
 * `public/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { DecodedAudio } from "../audio/format-facts";
import { measureEnvelopeModulation } from "../audio/envelope-modulation";
import { createWorkletPlayout } from "./playout";

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
type PopMessage = { type: "pop"; kind: "jump" | "overload"; size: number; at: number };
type Post = { at: number; message: LevelMessage | PopMessage };

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
/** The barge-in instant, and the main thread's fade (FADE_OUT_S). */
const FLUSH_AT = 0.8;
const FADE_S = 0.04;
/**
 * Extra silence a barge-in may add after the new reply's first audio. One
 * chunk plus a render quantum; the defect measured 0.491 s.
 */
const MAX_BARGE_IN_GAP_S = 0.05;

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
 * The barge-in trace. The interrupted reply's audio has arrived in real time up
 * to the barge-in (the queue therefore holds its ~300 ms pre-roll); the flush
 * lands at FLUSH_AT; the new reply's audio starts arriving at `newReplyAt`, 1.2 s
 * of it, in real time. `newReplyAt` is what the trace varies: inside the
 * cushion window (0.9 s), or after it (1.6 s, the normal case once the server
 * has end-pointed, judged and generated).
 */
function bargeInTrace(newReplyAt: number): Arrival[] {
  return stream(0, FLUSH_AT).concat(stream(0, 1.2, newReplyAt));
}

type Render = { out: Float32Array; posts: Post[]; proc: Processor; scope: { currentTime: number } };

/** Drive the worklet with `arrivals`, flushing at FLUSH_AT with `keepCushion`. */
function render(
  arrivals: Arrival[],
  seconds: number,
  opts: { keepCushion?: boolean; source?: string; probe?: boolean } = {},
): Render {
  const { proc, scope } = load(OUT, opts.source);
  if (opts.probe) proc.port.onmessage!({ data: { type: "probe", on: true } });
  const out = new Float32Array(Math.ceil((seconds * OUT) / QUANTUM) * QUANTUM);
  let seq = 0;
  let next = 0;
  let flushed = false;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / OUT;
    while (next < arrivals.length && arrivals[next]![0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next]![1] } });
      next++;
    }
    if (!flushed && scope.currentTime >= FLUSH_AT) {
      proc.port.onmessage!({
        data: { type: "flush", fadeS: FADE_S, keepCushion: opts.keepCushion ?? true },
      });
      flushed = true;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }
  return { out, posts: proc.port.posted as Post[], proc, scope };
}

/** Seconds at which the first non-zero sample after `after` is emitted. */
function firstSoundAfter(out: Float32Array, after: number): number {
  const i = out.findIndex((y, idx) => idx / OUT > after && y !== 0);
  return i < 0 ? Infinity : i / OUT;
}

function maxStep(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

/** Inserted silences — exact zeros with sound on both sides — as [startSeconds, durationSeconds]. */
function interiorSilences(out: Float32Array): [number, number][] {
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

/**
 * The barge-in gap: how long after the new reply's first audio the caller hears
 * the new reply. One sentence, naming the measurement — the failure this file
 * exists for reads "the new reply waited 491 ms for a fresh 500 ms pre-roll".
 */
function assertBargeInGap(out: Float32Array, newReplyAt: number, label: string): number {
  const started = firstSoundAfter(out, newReplyAt);
  const gapS = started - newReplyAt;
  console.log(`${label}: new reply's first audio at ${newReplyAt.toFixed(3)}s, ` +
    `first sound at ${started.toFixed(3)}s, barge-in gap ${(gapS * 1000).toFixed(0)} ms`);
  assert.ok(
    gapS >= 0,
    `${label}: the render has no sound after the new reply's first audio at ${newReplyAt.toFixed(3)}s`,
  );
  assert.ok(
    gapS <= MAX_BARGE_IN_GAP_S,
    `${label}: the new reply waited ${(gapS * 1000).toFixed(0)} ms for a fresh ` +
      `${TARGET_CUSHION_S * 1000} ms pre-roll (gate ≤ ${MAX_BARGE_IN_GAP_S * 1000} ms)`,
  );
  return gapS;
}

// --- The fix, on the real worklet ------------------------------------------

test("barge-in: a flush does not charge the new reply a second pre-roll", () => {
  // The normal case: the new reply's audio starts 1.6 s in — 0.8 s after the
  // barge-in, i.e. after the server has end-pointed, judged and generated. The
  // cushion's wait was already paid during that silence.
  const newReplyAt = 1.6;
  const { out } = render(bargeInTrace(newReplyAt), 3.2);
  assertBargeInGap(out, newReplyAt, "barge-in");

  // The interrupted reply never sounds again: from the end of the fade until
  // the new reply, the output is exact zeros.
  const silentFrom = Math.ceil((FLUSH_AT + FADE_S + QUANTUM / OUT) * OUT);
  const silentTo = Math.ceil(newReplyAt * OUT);
  for (let i = silentFrom; i < silentTo; i++) {
    assert.equal(out[i], 0, `stale speech at ${(i / OUT).toFixed(3)}s after the barge-in`);
  }
});

test("barge-in: a new reply arriving inside the cushion window starts on the preserved cushion", () => {
  // The new reply's audio is ready 0.1 s after the barge-in. The flush must not
  // shorten the target: it still waits out the remainder of the cushion (0.4 s)
  // and starts holding ~0.4 s of the new reply's own audio, not a cold start.
  const newReplyAt = 0.9;
  const { out, posts } = render(bargeInTrace(newReplyAt), 2.6);

  const started = firstSoundAfter(out, newReplyAt);
  console.log(
    `barge-in, audio inside the cushion window: first audio at ${newReplyAt.toFixed(3)}s, ` +
      `first sound at ${started.toFixed(3)}s (${((started - newReplyAt) * 1000).toFixed(0)} ms after the audio)`,
  );
  // The cushion's deadline is anchored at the barge-in (0.8 s) and not
  // restarted at the reply's first chunk (0.9 s): 0.8 + 0.5 = 1.3 s.
  assert.ok(
    started >= FLUSH_AT + TARGET_CUSHION_S - CHUNK_S,
    `started at ${started.toFixed(3)}s, under the preserved cushion (${(FLUSH_AT + TARGET_CUSHION_S).toFixed(3)}s)`,
  );
  assert.ok(
    started <= FLUSH_AT + TARGET_CUSHION_S + 0.02,
    `started at ${started.toFixed(3)}s, after the preserved cushion (${(FLUSH_AT + TARGET_CUSHION_S).toFixed(3)}s)`,
  );

  // And it really starts on that cushion: the first sounding report holds about
  // 400 ms of the new reply, not the one or two chunks a cold start would.
  const sounding = posts
    .filter((p) => p.message.type === "level" && p.message.playing && p.at >= newReplyAt)
    .map((p) => p.message as LevelMessage);
  assert.ok(sounding.length > 0, "the new reply reports nothing while sounding");
  assert.ok(
    sounding[0]!.cushionMs >= 350,
    `the new reply started on a ${sounding[0]!.cushionMs.toFixed(0)} ms cushion, not the preserved target`,
  );
});

test("barge-in: the flush fades the sounding tail without a click", () => {
  const { out, posts } = render(bargeInTrace(1.6), 3.2, { probe: true });

  // A 40 ms ramp is a ramp, not a step: no adjacent-sample jump beyond what the
  // clean tone itself produces, at the fade or at the new reply's start ramp.
  assert.ok(maxStep(out) <= CLEAN_STEP, `max step ${maxStep(out).toFixed(5)} > clean ${CLEAN_STEP.toFixed(5)}`);

  // The dev pop recorder agrees: the faded cut is not a click.
  const pops = posts.filter((p): p is { at: number; message: PopMessage } => p.message.type === "pop");
  assert.deepEqual(pops, [], "the fade produced a pop");

  // The fade is a ramp down, not a hard stop: the reply is audible during it and
  // falls monotonically in level.
  const windows: number[] = [];
  const windowSamples = Math.round(0.005 * OUT);
  const fadeFrom = Math.ceil((FLUSH_AT + QUANTUM / OUT) * OUT);
  const fadeTo = (FLUSH_AT + FADE_S) * OUT;
  for (let i = fadeFrom; i + windowSamples < fadeTo; i += windowSamples) {
    let peak = 0;
    for (let j = i; j < i + windowSamples; j++) peak = Math.max(peak, Math.abs(out[j]!));
    windows.push(peak);
  }
  assert.ok(windows.length > 0, "nothing sounded during the fade");
  assert.ok(windows[0]! > 0.1, `the fade starts already silent (${windows[0]})`);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i]! <= windows[i - 1]! + 0.02, `the fade is not monotonic at window ${i}`);
  }
});

test("barge-in: the new reply keeps a constant gain, never buffer-shaped", () => {
  // The barge-in must not bring back the defect tickets 25–28 removed: the new
  // reply's gain is constant, so nothing about the flush shows up as amplitude
  // modulation. The trace is clean (no jitter) so any rate would be the worklet's.
  const newReplyAt = 1.6;
  const { out } = render(bargeInTrace(newReplyAt), 3.2);
  const first = Math.round((firstSoundAfter(out, newReplyAt) + 0.02) * OUT);
  let last = out.length - 1;
  while (last > first && out[last] === 0) last--;
  // The reply a listener hears, without its lead-in or its end.
  const audio: DecodedAudio = decoded(out.subarray(first, last));
  const reading = measureEnvelopeModulation(audio);
  assert.equal(reading.rateHz, 0, `modulated at ${reading.rateHz.toFixed(3)} Hz`);
  assert.equal(reading.depth, 0, `depth ${reading.depth}`);
  assert.equal(reading.modulated, false);

  // And no inserted hole in the new reply of a clean stream.
  assert.deepEqual(
    interiorSilences(out).filter(([at]) => at > newReplyAt),
    [],
    "the new reply is interrupted by silence",
  );
});

test("barge-in: the preserved cushion is one-shot", () => {
  // A third reply after the new one is a normal reply start: the barge-in's
  // credit must not permanently remove the jitter budget. The gap is longer
  // than the resume window, so this is a new reply (the second reply ends at
  // ~2.8 s, the third audio starts at 4.2 s).
  const arrivals = bargeInTrace(1.6).concat(stream(0, 0.6, 4.2));
  const { out } = render(arrivals, 5.4);
  const started = firstSoundAfter(out, 4.2);
  assert.ok(
    started - 4.2 >= TARGET_CUSHION_S - CHUNK_S,
    `a later reply started ${(started - 4.2).toFixed(3)}s after its first audio, under the target`,
  );
  assert.ok(started - 4.2 <= TARGET_CUSHION_S + 0.02, `a later reply started at ${started.toFixed(3)}s, past the target`);
});

test("barge-in: a hang-up flush clears the queue and leaves no credit", () => {
  // The deliberate teardown keeps the old contract: fade, drop, and stay silent.
  // No further audio arrives (the socket is closed on a hang-up), so the queue
  // the worklet dropped is the whole of playback.
  const { out, posts } = render(bargeInTrace(1.6), 1.5, { keepCushion: false });

  const first = out.findIndex((y) => y !== 0);
  assert.ok(first / OUT < FLUSH_AT, "nothing sounded before the flush");
  const after = out.subarray(Math.ceil((FLUSH_AT + FADE_S + QUANTUM / OUT) * OUT));
  assert.ok(after.every((y) => y === 0), "a hang-up flush left audio queued or sounding");

  // Nothing is held: the worklet reports idle with an empty queue after the fade.
  const idle = posts.filter((p) => p.message.type === "level" && p.message.idle) as {
    at: number;
    message: LevelMessage;
  }[];
  assert.ok(idle.length > 0, "the worklet never reports idle after the hang-up");
  assert.equal(idle.at(-1)!.message.queuedMs, 0, "the hang-up left audio in the queue");

  // And no credit: a reply arriving just after the hang-up still pays its own
  // target cushion, rather than inheriting the one the hang-up cancelled.
  const { out: afterHangUp } = render(bargeInTrace(0.9), 2.0, { keepCushion: false });
  const started = firstSoundAfter(afterHangUp, 0.9);
  assert.ok(
    started - 0.9 >= TARGET_CUSHION_S - CHUNK_S,
    `a reply after a hang-up started ${(started - 0.9).toFixed(3)}s after its audio, on an inherited cushion`,
  );
});

// --- The main-thread handle -------------------------------------------------

test("playout handle: a barge-in keeps the cushion and a hang-up clears it", () => {
  // The handle is the only place the two intents are named. A barge-in is the
  // default because it is every flush but teardown; the explicit override is
  // how a teardown says it wants nothing preserved.
  const posted: unknown[] = [];
  const node = {
    port: {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => posted.push(m),
    },
  } as unknown as AudioWorkletNode;
  const playout = createWorkletPlayout(node);

  playout.flush(FADE_S);
  playout.flush(FADE_S, false);
  assert.deepEqual(posted, [
    { type: "flush", fadeS: FADE_S, keepCushion: true },
    { type: "flush", fadeS: FADE_S, keepCushion: false },
  ]);
  // Both settle the handle at once: the queue is gone either way.
  assert.equal(playout.settled(), true);
  assert.equal(playout.queuedMs(), 0);
  assert.equal(playout.cushionMs(), 0);
});

// --- The negative control: the old flush cost a fresh pre-roll --------------

/** The cushioned start gate ticket 29 adds. */
const CUSHIONED_START = `      const cushioned = currentTime >= this.cushionBy;
      const buffered = this.queued >= TARGET_CUSHION_S * this.rate;
      if (resuming || cushioned || buffered || lull) this.start();`;
/** The worklet before this ticket: a flush resets the start gate to a cold start. */
const COLD_START = `      const buffered = this.queued >= TARGET_CUSHION_S * this.rate;
      if (resuming || buffered || lull) this.start();`;

function withColdStartFlush(): string {
  // The credit term is what this ticket added; removing it restores the defect.
  return revert(readFileSync(WORKLET, "utf8"), CUSHIONED_START, COLD_START);
}

test("negative control: the old cold-start flush costs the measured half second", () => {
  const newReplyAt = 1.6;
  const { out } = render(bargeInTrace(newReplyAt), 3.2, { source: withColdStartFlush() });

  // The revert restores the defect, not something else: the reply waits for a
  // whole fresh cushion, measured before this ticket at 0.491 s.
  const gapS = firstSoundAfter(out, newReplyAt) - newReplyAt;
  console.log(`negative control: the old flush costs ${(gapS * 1000).toFixed(0)} ms`);
  assert.ok(
    Math.abs(gapS - TARGET_CUSHION_S) < 0.03,
    `the restored defect costs ${(gapS * 1000).toFixed(0)} ms, not the ${TARGET_CUSHION_S * 1000} ms pre-roll`,
  );

  // And the gate refuses it, naming the fresh pre-roll it paid for.
  assert.throws(
    () => assertBargeInGap(out, newReplyAt, "negative control"),
    (error: Error) => {
      assert.match(error.message, /waited 49\d ms for a fresh 500 ms pre-roll/);
      return true;
    },
  );
});

test("negative control: a revert whose anchor has moved is an error, not a pass", () => {
  assert.throws(
    () => revert(readFileSync(WORKLET, "utf8"), "a line this worklet does not contain", "x"),
    /no longer in public\/playout-processor\.js/,
  );
});
