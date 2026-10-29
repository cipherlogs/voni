/**
 * Chime timing (voice-parity 30): the connected chime is triggered by the
 * playout's first audible sample, not by the moment the greeting is scheduled.
 *
 * These run the real worklet in a VM behind the real main-thread handle, so the
 * measurement is of the shipped seam: schedule → pre-roll → first sample the
 * caller hears → trigger. The chime itself is an HTMLAudio earcon the component
 * plays from that trigger, so its duration can never change when the greeting
 * starts sounding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import type { AudioGraph } from "./mic-capture";
import { CascadeSession } from "./cascade-session";
import { createWorkletPlayout, type Playout } from "./playout";
import { VoiceSession } from "./session";

const OUT_RATE = 48000;
const SRC_RATE = 24000;
const QUANTUM = 128;
/** The worklet's level-report interval (LEVEL_EVERY_QUANTA): 8 quanta. */
const REPORT_S = (8 * QUANTUM) / OUT_RATE;

type LevelReport = {
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

type Processor = {
  port: { onmessage: ((e: { data: LevelReport }) => void) | null; postMessage: (m: unknown) => void };
  process: (inputs: unknown, outputs: Float32Array[][]) => boolean;
};

/** Constant PCM16 chunk: a non-zero signal, so any emitted sample is audible. */
function pcm16(value: number, samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(value * 32767), true);
  return out;
}

type Proved = {
  /** Every level report, stamped with the wall time it was delivered. */
  reports: { at: number; playing: boolean }[];
  /** When the first-audible trigger fired, or null if it never did. */
  chimeAt: number | null;
  /** Wall time of the first non-zero output sample (what the caller hears). */
  firstAudibleAt: number;
  /** The rendered output, exactly as the device received it. */
  output: Float32Array;
};

/**
 * Drive the real playout: the real worklet, the real handle, a source that
 * arrives like the platform's (10ms chunks in real time).
 */
function runPlayout(opts: { seconds?: number; trigger?: boolean } = {}): Proved {
  const seconds = opts.seconds ?? 1.2;
  const scope = {
    sampleRate: OUT_RATE,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage() {} };
    },
    registered: null as null | (new () => Processor),
    registerProcessor(_name: string, ctor: new () => Processor) {
      scope.registered = ctor;
    },
  };
  vm.runInNewContext(readFileSync("public/playout-processor.js", "utf8"), scope);
  const proc = new scope.registered!();

  const reports: { at: number; playing: boolean }[] = [];
  const node = {
    port: {
      onmessage: null as ((e: { data: LevelReport }) => void) | null,
      // Main thread → worklet.
      postMessage: (message: unknown) => proc.port.onmessage?.({ data: message as LevelReport }),
    },
  };
  // Worklet → main thread, keeping the real handle's handler wired.
  const workletPost = proc.port.postMessage.bind(proc.port);
  proc.port.postMessage = (message: unknown) => {
    workletPost(message);
    const level = message as LevelReport;
    // A report lands at the end of the block it describes.
    if (level.type === "level") reports.push({ at: scope.currentTime + QUANTUM / OUT_RATE, playing: level.playing });
    node.port.onmessage?.({ data: level });
  };

  const playout = createWorkletPlayout(node as unknown as AudioWorkletNode);
  let chimeAt: number | null = null;
  if (opts.trigger) {
    playout.onFirstAudible = () => {
      chimeAt = scope.currentTime + QUANTUM / OUT_RATE;
    };
  }

  const blocks = Math.ceil((seconds * OUT_RATE) / QUANTUM);
  const output = new Float32Array(blocks * QUANTUM);
  const chunk = pcm16(0.5, (SRC_RATE * 10) / 1000);
  let t = 0;
  let arrivals = 0;
  for (let b = 0; b < blocks; b++) {
    scope.currentTime = t;
    while (arrivals * 0.01 <= t && arrivals * 0.01 < seconds) {
      playout.play(chunk, SRC_RATE);
      arrivals += 1;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    output.set(buf, b * QUANTUM);
    t += QUANTUM / OUT_RATE;
  }

  let firstAudibleAt = Infinity;
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== 0) {
      firstAudibleAt = i / OUT_RATE;
      break;
    }
  }
  return { reports, chimeAt, firstAudibleAt, output };
}

test("the chime fires at the first audible sample, not when the greeting is scheduled", () => {
  const run = runPlayout({ trigger: true });

  // The greeting is scheduled at t=0 but held by the target cushion: the
  // caller hears nothing until it fills (~500ms). That pre-roll is exactly
  // the window the old chime was fired in.
  assert.ok(run.firstAudibleAt > 0.4, `first audible sample at ${run.firstAudibleAt.toFixed(3)}s`);
  const before = run.reports.filter((r) => r.at < run.firstAudibleAt);
  assert.ok(before.length > 0, "the worklet did report during the pre-roll");
  assert.ok(before.every((r) => !r.playing), "no report may call the greeting audible before it sounds");

  assert.notEqual(run.chimeAt, null, "the first audible sample must fire the chime");
  const lag = run.chimeAt! - run.firstAudibleAt;
  assert.ok(lag >= 0, `the chime began ${(-lag * 1000).toFixed(1)}ms before the first word`);
  assert.ok(
    lag <= REPORT_S,
    `the chime trailed the first word by ${(lag * 1000).toFixed(1)}ms, more than one level report`,
  );
  // ...and the trigger is nowhere near the schedule instant.
  assert.ok(run.chimeAt! > 0.4, `the chime fired at ${run.chimeAt!.toFixed(3)}s, not on schedule`);
});

test("a chime longer than the pre-roll never starts before the greeting's first words", () => {
  const CHIME_S = 0.8; // the README's maximum, longer than the 500ms cushion
  assert.ok(CHIME_S > 0.5, "the chime must outlast the scheduling delay to reproduce the defect");

  const run = runPlayout({ trigger: true });
  const chimeStart = run.chimeAt!;

  // Negative control: the old trigger was the schedule instant, and that really
  // is before the first word — so the assertion below can fail.
  const scheduledAt = 0;
  assert.ok(
    scheduledAt < run.firstAudibleAt,
    "firing on schedule would truly begin before the first word",
  );
  assert.ok(
    chimeStart >= run.firstAudibleAt,
    `the chime started ${((run.firstAudibleAt - chimeStart) * 1000).toFixed(1)}ms before the first word`,
  );
  assert.ok(
    chimeStart - run.firstAudibleAt <= REPORT_S,
    "the chime is synchronized to the first word, not merely late",
  );
});

test("the trigger never alters or delays the greeting's audio", () => {
  const withTrigger = runPlayout({ trigger: true });
  const without = runPlayout({ trigger: false });
  assert.equal(
    withTrigger.firstAudibleAt,
    without.firstAudibleAt,
    "the chime cannot move when the greeting starts sounding",
  );
  assert.equal(withTrigger.output.length, without.output.length);
  assert.ok(
    Buffer.from(withTrigger.output.buffer).equals(Buffer.from(without.output.buffer)),
    "the greeting's delivered samples are bit-identical with the chime trigger attached",
  );
});

/** A fake worklet node for testing the handle's one-shot without the DSP. */
function manualHandle() {
  const node = {
    port: {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage() {},
    },
  };
  const playout = createWorkletPlayout(node as unknown as AudioWorkletNode);
  const deliver = (playing: boolean, idle: boolean) =>
    node.port.onmessage?.({
      data: {
        type: "level",
        seq: 1,
        queuedMs: idle ? 0 : 500,
        cushionMs: idle ? 0 : 500,
        targetCushionMs: 500,
        correctionPct: 0,
        playing,
        idle,
        consumed: 0,
      } satisfies LevelReport,
    });
  return { playout, deliver };
}

test("a greeting that never becomes audible does not fire the chime", () => {
  // Nothing scheduled at all: a refused format or an empty greeting.
  const silent = manualHandle();
  let fired = 0;
  silent.playout.onFirstAudible = () => {
    fired += 1;
  };
  assert.equal(fired, 0, "no reports, no chime");

  // Scheduled but never audible: the pre-roll and an idle teardown only.
  for (let i = 0; i < 25; i++) silent.deliver(false, false);
  silent.deliver(false, true);
  assert.equal(fired, 0, "a greeting that never sounds cannot chime");

  // A refused/flushed reply: the playout goes idle without ever playing.
  const flushed = manualHandle();
  let flushedFired = 0;
  flushed.playout.onFirstAudible = () => {
    flushedFired += 1;
  };
  flushed.playout.flush();
  flushed.deliver(false, true);
  assert.equal(flushedFired, 0, "a reply flushed before it sounds cannot chime");
});

test("the first-audible signal fires once, on the first sounding report", () => {
  const { playout, deliver } = manualHandle();
  let fired = 0;
  playout.onFirstAudible = () => {
    fired += 1;
  };
  deliver(false, false); // pre-roll
  assert.equal(fired, 0);
  deliver(true, false); // the first audible sample
  assert.equal(fired, 1);
  deliver(true, false);
  deliver(true, false);
  assert.equal(fired, 1, "one chime per connection");
});

test("both sessions forward first audible audio to the call", async () => {
  // Cascade: the simplest transport to stand up without browser globals.
  let cascadePlayout: Playout | null = null;
  let cascadeAudible = 0;
  const cascade = new CascadeSession(
    { onFirstAudible: () => (cascadeAudible += 1) },
    {
      socketFactory: () =>
        ({ readyState: 1, OPEN: 1, send() {}, close() {} }) as unknown as WebSocket,
      startMic: async () => ({ stop() {} }),
      createPlayout: () => {
        const playout: Playout = { play() {}, flush() {} };
        cascadePlayout = playout;
        return playout;
      },
    },
  );
  await cascade.start({
    serviceUrl: "ws://localhost/cascade",
    pipeline: { llm_model: "m", tts_voice: "v", tts_model: "t", fallback_mode: "cascade" },
    systemPrompt: "p",
  });
  cascadePlayout!.onFirstAudible!();
  assert.equal(cascadeAudible, 1);
  await cascade.stop().catch(() => undefined);

  // Managed session: the main call path.
  const g = globalThis as unknown as Record<string, unknown>;
  const savedWebSocket = g.WebSocket;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    configurable: true,
  });
  g.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    addEventListener() {}
    send() {}
    close() {
      this.readyState = 3;
    }
  };
  let managedPlayout: Playout | null = null;
  let managedAudible = 0;
  const managed = new VoiceSession(
    { onFirstAudible: () => (managedAudible += 1) },
    {
      micOwner: `chime-test-${Math.random()}`,
      startGraph: async () =>
        ({
          audioCtx: null,
          worklet: null,
          playout: (managedPlayout = { play() {}, flush() {} }),
          stop() {},
        }) as unknown as AudioGraph,
    },
  );
  try {
    await managed.start({ mode: "agent", agentId: "" }, async () => ({ token: "tok", agentId: "a1" }));
    managedPlayout!.onFirstAudible!();
    assert.equal(managedAudible, 1);
  } finally {
    await managed.stop().catch(() => undefined);
    g.WebSocket = savedWebSocket;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});
