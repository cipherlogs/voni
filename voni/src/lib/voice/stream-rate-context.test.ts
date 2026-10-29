/**
 * The playout context's rate (ticket 35).
 *
 * The platform streams 24 kHz. A device that runs below that (a Bluetooth
 * headset in headset mode, some phone and desktop routes) forces the worklet to
 * decimate, and ticket 34 made the low-pass before it mandatory. But where the
 * platform can open an audio context at the stream rate, no sample is dropped
 * and no filter is needed at all — so that context is preferred.
 *
 * The choice is a behaviour, not a comment. `openStreamRateContext` is tested
 * against a fake constructor: a platform that honours the requested rate gets a
 * stream-rate context, and a platform that refuses it — throwing, or opening at
 * its own device rate — falls back to the default device context. A refused
 * context is closed, never kept as if it were exact.
 *
 * The preference is not a correctness shortcut. When the fallback is taken, the
 * real `playout-processor.js` still has to reject the alias ticket 34 added the
 * filter for: the fallback context is fed a 10 kHz tone and the 6 kHz fold is
 * measured. At the preferred rate the same tone survives, which is the proof
 * that no decimator is in that path.
 *
 * The echo-canceller constraint is unchanged: the microphone and the playout
 * keep one shared context (the canceller hears what we play), so the graph test
 * asserts a fallback never leaves the mic on the discarded context and never
 * builds a second playback context.
 *
 * Run from `voni/`, because the worklet is read from `public/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  openStreamRateContext,
  type AudioContextFactory,
  type ContextOptions,
} from "./stream-rate-context";
import { startAudioGraph } from "./mic-capture";

const STREAM_RATE = 24_000;
const HEADSET_RATE = 16_000;
const WORKLET = "public/playout-processor.js";
const QUANTUM = 128;
const AMP = 0.5;
const CHUNK_S = 0.01;
/** The reply starts after the 0.5 s cushion; measure after the start ramp. */
const MEASURE_FROM_S = 0.55;
const MEASURE_S = 1;
/** Ticket 34's alias gate, reused: a folded tone may not exceed this. */
const MAX_ALIAS_DBFS = -55;

type FakeCtx = {
  sampleRate: number;
  closed: boolean;
  close: () => Promise<void>;
};

/** A browser whose device runs at `deviceRate`; `honour` decides the option. */
function browser(deviceRate: number, honour: boolean) {
  const created: { options?: ContextOptions; ctx: FakeCtx }[] = [];
  const create: AudioContextFactory = (options) => {
    const sampleRate = honour && options?.sampleRate ? options.sampleRate : deviceRate;
    const ctx: FakeCtx = {
      sampleRate,
      closed: false,
      close: async () => {
        ctx.closed = true;
      },
    };
    created.push({ options, ctx });
    return ctx as unknown as AudioContext;
  };
  return { create, created };
}

// --- The choice ------------------------------------------------------------

test("stream-rate context: a supported platform opens the context at the stream rate", () => {
  // 24 kHz asked for, 24 kHz granted: no sample is dropped, so the worklet's
  // decimator must never be built on this context.
  const { create, created } = browser(48_000, true);
  const choice = openStreamRateContext(STREAM_RATE, create);

  assert.deepEqual(
    created.map((c) => c.options),
    [{ sampleRate: STREAM_RATE }],
    "the preferred context was not requested at the stream rate",
  );
  assert.equal(choice.ctx, created[0]!.ctx as unknown as AudioContext);
  assert.equal(choice.rate, STREAM_RATE);
  assert.equal(choice.atStreamRate, true);
  assert.equal(choice.source, "stream");
  assert.equal(created[0]!.ctx.closed, false, "the honoured context was closed");
});

test("stream-rate context: a refused request falls back to the device context", () => {
  // The platform accepts the option but opens at its own 16 kHz device rate.
  // That is the ticket-34 path: the low-pass is not optional there.
  const { create, created } = browser(HEADSET_RATE, false);
  const choice = openStreamRateContext(STREAM_RATE, create);

  assert.equal(created.length, 2, "the refused context was not replaced by a device context");
  assert.deepEqual(created[0]!.options, { sampleRate: STREAM_RATE });
  assert.equal(created[1]!.options, undefined, "the fallback forced a rate");

  assert.equal(
    created[0]!.ctx.closed,
    true,
    "a context that did not honour the requested rate was kept alive",
  );
  assert.equal(created[1]!.ctx.closed, false, "the device context was closed before use");

  assert.equal(choice.ctx, created[1]!.ctx as unknown as AudioContext);
  assert.equal(choice.rate, HEADSET_RATE);
  assert.equal(choice.atStreamRate, false);
  assert.equal(choice.source, "device");
});

test("stream-rate context: a platform that throws on the option still starts the call", () => {
  // Safari refuses the option outright. That must cost the preference, not the
  // call. The kept context is the plain default, and the rate it reports is the
  // rate the worklet will actually render at.
  const kept: FakeCtx = { sampleRate: 44_100, closed: false, close: async () => undefined };
  const create: AudioContextFactory = (options) => {
    if (options) throw new Error("NotSupportedError: sample rate");
    return kept as unknown as AudioContext;
  };

  const choice = openStreamRateContext(STREAM_RATE, create);
  assert.equal(choice.ctx, kept as unknown as AudioContext);
  assert.equal(choice.rate, 44_100);
  assert.equal(choice.atStreamRate, false);
  assert.equal(choice.source, "device");
});

test("stream-rate context: a device that already runs at the stream rate needs no filter", () => {
  // Safari refuses the option outright, but the platform's own default happens
  // to be the stream rate. No sample is dropped either way, so the choice is
  // observed as at-stream-rate even though it came from the device default.
  const kept: FakeCtx = {
    sampleRate: STREAM_RATE,
    closed: false,
    close: async () => undefined,
  };
  const create: AudioContextFactory = (options) => {
    if (options) throw new Error("NotSupportedError: sample rate");
    return kept as unknown as AudioContext;
  };
  const choice = openStreamRateContext(STREAM_RATE, create);

  assert.equal(choice.ctx, kept as unknown as AudioContext);
  assert.equal(choice.source, "device");
  assert.equal(choice.rate, STREAM_RATE);
  assert.equal(choice.atStreamRate, true);
});

test("stream-rate context: a context that cannot host the microphone is not supported", () => {
  // Firefox honours the sampleRate option but cannot wire a getUserMedia
  // source into a context running at a different rate. Keeping that context
  // would silence the caller's microphone to save a filter, so a caller-supplied
  // probe that throws must reject the preference exactly like a refused rate.
  const { create, created } = browser(HEADSET_RATE, true);
  let probed = 0;
  const choice = openStreamRateContext(STREAM_RATE, create, () => {
    probed += 1;
    throw new Error("Connecting a MediaStream across sample rates is unsupported");
  });

  assert.equal(probed, 1, "the preferred context was never probed");
  assert.equal(created.length, 2, "the unusable context was not replaced");
  assert.equal(created[0]!.ctx.closed, true);
  assert.equal(choice.ctx, created[1]!.ctx as unknown as AudioContext);
  assert.equal(choice.rate, HEADSET_RATE);
  assert.equal(choice.source, "device");
});

test("stream-rate context: a usable preferred context is still preferred", () => {
  // The probe must not become a hair trigger: a context that answers the rate
  // and hosts the microphone is the context the graph keeps.
  const { create, created } = browser(HEADSET_RATE, true);
  let probed = 0;
  const choice = openStreamRateContext(STREAM_RATE, create, () => {
    probed += 1;
  });

  assert.equal(probed, 1);
  assert.equal(created.length, 1);
  assert.equal(choice.ctx, created[0]!.ctx as unknown as AudioContext);
  assert.equal(choice.source, "stream");
  assert.equal(choice.rate, STREAM_RATE);
});

test("stream-rate context: the rate is always the live context's rate, never the request", () => {
  // The invariant behind "no silent wrong-rate playback": whatever is returned
  // as `rate` is what the worklet renders at, so `msg.rate`/device-rate cannot
  // disagree about which one is a lie. A lying constructor is refused.
  const { create } = browser(8_000, false);
  const choice = openStreamRateContext(STREAM_RATE, create);
  assert.equal(choice.rate, choice.ctx.sampleRate);
  assert.notEqual(choice.rate, STREAM_RATE);
});

test("stream-rate context: an invalid stream rate is a programmer error, not a fallback", () => {
  const { create } = browser(HEADSET_RATE, true);
  assert.throws(() => openStreamRateContext(0, create), RangeError);
});

// --- The choice decides whether the low-pass is mandatory ------------------

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = {
  port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

/** The real worklet, with the context rate it would actually run at. */
function loadWorklet(deviceRate: number) {
  const scope = {
    sampleRate: deviceRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port: Port & { postMessage: (m: unknown) => void } = {
        onmessage: null,
        posted: [],
        postMessage(this: Port & { postMessage: (m: unknown) => void }, m: unknown) {
          this.posted.push(m);
        },
      } as Port & { postMessage: (m: unknown) => void };
    },
    registered: null as null | (new () => Processor),
    registerProcessor(_name: string, ctor: new () => Processor) {
      scope.registered = ctor;
    },
  };
  vm.runInNewContext(readFileSync(WORKLET, "utf8"), scope);
  return { proc: new scope.registered!(), scope };
}

/** A 24 kHz tone arriving in real time in 10 ms chunks, played at `rate`. */
function render(rate: number, hz: number, seconds: number): Float32Array {
  const { proc, scope } = loadWorklet(rate);
  const chunk = Math.round(CHUNK_S * STREAM_RATE);
  const out = new Float32Array(Math.ceil((seconds * rate) / QUANTUM) * QUANTUM);
  let seq = 0;
  let pos = 0;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / rate;
    while (pos / STREAM_RATE <= scope.currentTime && pos < Math.round(seconds * STREAM_RATE)) {
      const samples = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++) {
        samples[i] = AMP * Math.sin((2 * Math.PI * hz * (pos + i)) / STREAM_RATE);
      }
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: STREAM_RATE, samples } });
      pos += chunk;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }
  return out;
}

/** Amplitude of a tone in `samples`, Hann-windowed: 1 Hz bins over one second. */
function toneAmplitude(samples: Float32Array, from: number, count: number, hz: number, rate: number) {
  let re = 0;
  let im = 0;
  let weight = 0;
  for (let i = 0; i < count; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
    const phase = (2 * Math.PI * hz * i) / rate;
    const y = samples[from + i]!;
    re += y * w * Math.cos(phase);
    im -= y * w * Math.sin(phase);
    weight += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / weight;
}

const db = (amplitude: number) => 20 * Math.log10(amplitude);

function measure(samples: Float32Array, hz: number, rate: number) {
  const from = Math.round(MEASURE_FROM_S * rate);
  return db(toneAmplitude(samples, from, Math.round(MEASURE_S * rate), hz, rate));
}

test("stream-rate context: the fallback keeps the low-pass mandatory (10 kHz does not fold to 6 kHz)", () => {
  // Choose the context the way production does, then run the worklet at the
  // rate that context reports. The 10 kHz tone is above the 16 kHz route's
  // Nyquist, so without ticket 34's filter it folds to 6 kHz at full level.
  const { create } = browser(HEADSET_RATE, false);
  const choice = openStreamRateContext(STREAM_RATE, create);
  assert.equal(choice.atStreamRate, false);
  assert.equal(choice.rate, HEADSET_RATE);

  const alias = measure(render(choice.rate, 10_000, 3), 6_000, choice.rate);
  assert.ok(
    alias <= MAX_ALIAS_DBFS,
    `the fallback context folded 10 kHz to a ${alias.toFixed(1)} dBFS alias at 6 kHz ` +
      `(gate ≤ ${MAX_ALIAS_DBFS} dBFS) — the low-pass was skipped on the device-rate path`,
  );
});

test("stream-rate context: the preferred context needs no decimation, so 10 kHz survives", () => {
  // Same tone, same code, a context that runs at the stream rate: nothing is
  // dropped, so nothing can fold. A decimator in this path would have removed
  // the tone (the device filter's passband ends well below 10 kHz).
  const { create } = browser(HEADSET_RATE, true);
  const choice = openStreamRateContext(STREAM_RATE, create);
  assert.equal(choice.atStreamRate, true);

  const delivered = render(choice.rate, 10_000, 3);
  const level = measure(delivered, 10_000, choice.rate);
  const alias = measure(delivered, 6_000, choice.rate);
  assert.ok(
    Math.abs(level - db(AMP)) <= 0.5,
    `10 kHz delivered at ${level.toFixed(1)} dBFS at the stream rate ` +
      `(source ${db(AMP).toFixed(1)} dBFS) — the preferred path filtered it`,
  );
  assert.ok(alias <= -60, `the stream-rate path produced a ${alias.toFixed(1)} dBFS alias at 6 kHz`);
});

// --- The echo-canceller constraint: one context, mic and playout -----------

type FakeGraphContext = {
  sampleRate: number;
  state: string;
  destination: unknown;
  closed: boolean;
  audioWorklet: { addModule: (url: string) => Promise<void> };
  resume: () => Promise<void>;
  close: () => Promise<void>;
  createMediaStreamSource: (stream: unknown) => { connect: () => void };
};

type FakeNode = {
  ctx: unknown;
  name: string;
  port: { onmessage: unknown; postMessage: () => void; close: () => void };
  connect: (target: unknown) => void;
  disconnect: () => void;
  connected: unknown[];
};

/** Install fakes for the two globals `startAudioGraph` constructs. */
function fakeGlobals(
  deviceRate: number,
  honour: boolean,
  micRejects?: (rate: number) => boolean,
) {
  const contexts: FakeGraphContext[] = [];
  const nodes: FakeNode[] = [];

  class Context implements FakeGraphContext {
    sampleRate: number;
    state = "running";
    destination = { kind: "destination" };
    closed = false;
    audioWorklet = { addModule: async (): Promise<void> => undefined };
    constructor(options?: ContextOptions) {
      this.sampleRate = honour && options?.sampleRate ? options.sampleRate : deviceRate;
      contexts.push(this);
    }
    async resume() {}
    async close() {
      this.closed = true;
      this.state = "closed";
    }
    createMediaStreamSource() {
      if (micRejects?.(this.sampleRate)) {
        throw new Error("Connecting a MediaStream across sample rates is unsupported");
      }
      return { connect: () => undefined };
    }
  }

  class Node implements FakeNode {
    ctx: unknown;
    name: string;
    port = { onmessage: null as unknown, postMessage: () => undefined, close: () => undefined };
    connected: unknown[] = [];
    constructor(ctx: unknown, name: string) {
      this.ctx = ctx;
      this.name = name;
      nodes.push(this);
    }
    connect(target: unknown) {
      this.connected.push(target);
    }
    disconnect() {}
  }

  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { AudioContext: globals.AudioContext, AudioWorkletNode: globals.AudioWorkletNode };
  globals.AudioContext = Context;
  globals.AudioWorkletNode = Node;
  const restore = () => {
    globals.AudioContext = previous.AudioContext;
    globals.AudioWorkletNode = previous.AudioWorkletNode;
  };
  return { contexts, nodes, restore };
}

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

test("stream-rate context: mic and playout share the one stream-rate context", async () => {
  // The echo canceller hears what we play only because the playout lives on the
  // mic's context. Preferring a stream rate must not split the graph in two.
  const fakes = fakeGlobals(HEADSET_RATE, true);
  let graph: Awaited<ReturnType<typeof startAudioGraph>> | null = null;
  try {
    graph = await startAudioGraph("test-owner", fakeStream, () => undefined);
    assert.equal(fakes.contexts.length, 1, "a second playback context was opened");
    assert.equal(graph.audioCtx, fakes.contexts[0] as unknown as AudioContext);
    assert.equal(graph.contextRate, STREAM_RATE);
    assert.equal(graph.atStreamRate, true);

    const mic = fakes.nodes.find((n) => n.name === "pcm-processor")!;
    const playout = fakes.nodes.find((n) => n.name === "playout-processor")!;
    assert.equal(mic.ctx, graph.audioCtx, "the microphone left the shared context");
    assert.equal(playout.ctx, graph.audioCtx, "the playout left the shared context");
    assert.deepEqual(playout.connected, [fakes.contexts[0]!.destination]);
  } finally {
    graph?.stop();
    fakes.restore();
  }
});

test("stream-rate context: a fallback moves the whole graph to the device context", async () => {
  // The refused context is closed, and neither the mic nor the playout may stay
  // attached to it: a playback context that is not the mic's is the echo the
  // shared-context rule exists to prevent.
  const fakes = fakeGlobals(HEADSET_RATE, false);
  let graph: Awaited<ReturnType<typeof startAudioGraph>> | null = null;
  try {
    graph = await startAudioGraph("test-owner", fakeStream, () => undefined);
    assert.equal(fakes.contexts.length, 2);
    assert.equal(fakes.contexts[0]!.closed, true, "the refused context was kept");
    assert.equal(graph.audioCtx, fakes.contexts[1] as unknown as AudioContext);
    assert.equal(graph.contextRate, HEADSET_RATE);
    assert.equal(graph.atStreamRate, false);

    for (const node of fakes.nodes) {
      assert.equal(node.ctx, graph.audioCtx, `${node.name} stayed on the refused context`);
    }
  } finally {
    graph?.stop();
    fakes.restore();
  }
});

test("stream-rate context: a mic that cannot attach falls back instead of going silent", async () => {
  // The rate is honoured but the microphone cannot be wired into it (Firefox
  // across rates). The preference must yield: the graph moves as a whole to the
  // device context, so the caller is heard and the playout low-pass carries the
  // resampling.
  const fakes = fakeGlobals(HEADSET_RATE, true, (rate) => rate !== HEADSET_RATE);
  let graph: Awaited<ReturnType<typeof startAudioGraph>> | null = null;
  try {
    graph = await startAudioGraph("test-owner", fakeStream, () => undefined);
    assert.equal(fakes.contexts.length, 2, "the rate-only context was kept");
    assert.equal(fakes.contexts[0]!.closed, true, "the unusable context was kept alive");
    assert.equal(graph.audioCtx, fakes.contexts[1] as unknown as AudioContext);
    assert.equal(graph.contextRate, HEADSET_RATE);
    assert.equal(graph.atStreamRate, false);

    for (const node of fakes.nodes) {
      assert.equal(node.ctx, graph.audioCtx, `${node.name} stayed on the unusable context`);
    }
    assert.equal(
      fakes.nodes.find((n) => n.name === "playout-processor")!.ctx,
      graph.audioCtx,
      "the playout lost the microphone's context",
    );
  } finally {
    graph?.stop();
    fakes.restore();
  }
});
