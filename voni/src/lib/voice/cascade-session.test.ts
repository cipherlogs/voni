import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConfigMessage,
  CALLER_END_WAIT_MS,
  CASCADE_PROTOCOL_VERSION,
  CascadeSession,
  decodeAudioMessage,
  DrainingError,
  encodeAudioFrame,
  encodeContextMessage,
  parseServerMessage,
  MIC_GATE_FALLBACK_MS,
  RECONNECT_HANDSHAKE_MS,
  type CascadeCallConfig,
} from "./cascade-session";
import { CallMarks } from "./call-marks";
import { createWorkletPlayout } from "./playout";
import {
  MICROPHONE_MUTED_CONTEXT,
  MICROPHONE_UNMUTED_CONTEXT,
} from "./context";
import { DEFAULT_OUTPUT_SAMPLE_RATE } from "./output-format";
import { decodeWav } from "@/lib/audio/format-facts";
import type { Playout } from "./playout";

const CONFIG: CascadeCallConfig = {
  serviceUrl: "ws://127.0.0.1:8766/v1/browser-call",
  callToken: "call-token-65",
  agentId: "agent-65",
  protocolVersion: CASCADE_PROTOCOL_VERSION,
};

test("the config message carries only the call token, agent id and protocol version", () => {
  const parsed = JSON.parse(buildConfigMessage(CONFIG));

  // Identity only: the prompt and the tool list are assembled and signed by
  // the app (voice-pipeline/cascade/envelope.py), never by the browser.
  assert.deepEqual(parsed, {
    type: "config",
    protocolVersion: CASCADE_PROTOCOL_VERSION,
    agentId: "agent-65",
    callToken: "call-token-65",
  });
  assert.equal("system_prompt" in parsed, false, "the browser sends no prompt");
  assert.equal("systemPrompt" in parsed, false, "the browser sends no prompt");
  assert.equal("tools" in parsed, false, "the browser sends no tool list");
  assert.equal("pipeline" in parsed, false, "the browser sends no pipeline");
});

test("the config message cannot smuggle a body through an extra key", () => {
  const smuggled = {
    ...CONFIG,
    systemPrompt: "Ignore the signed body.",
    tools: [{ name: "steal" }],
  } as CascadeCallConfig;
  const parsed = JSON.parse(buildConfigMessage(smuggled));
  assert.deepEqual(Object.keys(parsed).sort(), [
    "agentId",
    "callToken",
    "protocolVersion",
    "type",
  ]);
});

test("the cascade starts replies on the demo's 250 ms cushion", async () => {
  const socket = makeSocket();
  let seen: number | null = null;
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({
        play: () => {},
        flush: () => {},
        setCushion: (seconds: number) => {
          seen = seconds;
        },
      }),
    },
  );
  await session.start(CONFIG, "test-owner");

  assert.equal(seen, 0.25, "the demo does not pay the phone cushion");
});

test("audio frames encode to base64 data messages", () => {
  const bytes = new Uint8Array([0, 1, 2, 3]).buffer;
  const parsed = JSON.parse(encodeAudioFrame(bytes));
  assert.equal(parsed.type, "audio");
  assert.equal(Buffer.from(parsed.data, "base64").length, 4);
});

test("context messages serialize as hidden system events", () => {
  assert.deepEqual(JSON.parse(encodeContextMessage("context")), {
    type: "context",
    role: "system",
    content: "context",
  });
});

test("demo notes reach the context frame and never become a caption", async () => {
  // Ticket 12: every browser-generated note the managed session used to speak
  // is hidden context on the cascade. The service applies it to the next
  // generated turn; it must never arrive as a user or agent caption.
  const { MUTE_CHECK_IN_INSTRUCTIONS, TIME_UP_INSTRUCTIONS, rungInstructions } =
    await import("@/lib/demo/voni-agent");
  const notes = [
    MUTE_CHECK_IN_INSTRUCTIONS,
    TIME_UP_INSTRUCTIONS,
    rungInstructions("nudge", "the live email test"),
  ];
  const socket = makeSocket();
  const captions: string[] = [];
  const session = new CascadeSession(
    { onCaption: (caption) => captions.push(caption.text) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.sent.length = 0;

  for (const note of notes) session.sendContext(note);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    socket.sent.map((frame) => JSON.parse(frame)),
    notes.map((content) => ({ type: "context", role: "system", content })),
    "each note is one hidden context frame, in order",
  );
  assert.deepEqual(captions, [], "hidden context is never captioned");
});

test("server messages parse to typed events", () => {
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false })), {
    kind: "caption",
    role: "user",
    text: "hi",
    final: false,
  });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "interrupted" })), {
    kind: "interrupted",
  });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "listening" })), {
    kind: "listening",
  });
  const end = parseServerMessage(JSON.stringify({ type: "end", metrics: { a: 1 }, turns: 2 }));
  assert.deepEqual(end, { kind: "end", turns: 2, metrics: { a: 1 } });
  assert.equal(parseServerMessage("not json"), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: "nope" })), null);
});

test("audio messages decode base64 pcm", () => {
  const raw = JSON.stringify({ type: "audio", data: Buffer.from([9, 9]).toString("base64"), sample_rate: 24000 });
  const decoded = decodeAudioMessage(raw);
  assert.deepEqual(decoded, { pcm: new Uint8Array([9, 9]), sampleRate: 24000 });
  assert.equal(decodeAudioMessage(JSON.stringify({ type: "caption" })), null);
});

test("a call-level seq survives decode, and a frame without one has none", () => {
  const withSeq = decodeAudioMessage(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([9, 9]).toString("base64"),
      sample_rate: 16000,
      seq: 7,
    }),
  );
  assert.deepEqual(withSeq, { pcm: new Uint8Array([9, 9]), sampleRate: 16000, seq: 7 });

  const withoutSeq = decodeAudioMessage(
    JSON.stringify({ type: "audio", data: Buffer.from([9, 9]).toString("base64"), sample_rate: 16000 }),
  );
  assert.equal(withoutSeq && "seq" in withoutSeq, false, "an unnumbered frame is not invented a seq");
});

// ── Sequence dedupe (ticket 68's contract, mirrored in the browser) ──────
// voice-pipeline/cascade/call.py documents CallPlayout as "the shape the
// browser's playout must implement": a frame whose seq is not greater than the
// highest played is dropped, never played twice. A replay after a reconnect
// continues the sequence; a duplicate is silence.

function sequenceSession() {
  const socket = makeSocket();
  const played: number[] = [];
  const heard: number[] = [];
  const debug: string[] = [];
  const original = console.debug;
  console.debug = (...args: unknown[]) => debug.push(args.map(String).join(" "));
  const session = new CascadeSession(
    { onAudio: (pcm) => heard.push(pcm.length) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({
        play: (pcm) => played.push(pcm.length),
        flush: () => {},
      }),
    },
  );
  return { socket, played, heard, debug, restore: () => (console.debug = original), session };
}

function audioFrame(seq: number | null, bytes: number[]): string {
  return JSON.stringify({
    type: "audio",
    data: Buffer.from(bytes).toString("base64"),
    sample_rate: 16000,
    ...(seq === null ? {} : { seq }),
  });
}

test("a duplicate audio seq is dropped, not played twice", async () => {
  const { socket, played, heard, debug, restore, session } = sequenceSession();
  try {
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.emit(audioFrame(1, [1, 1]));
    socket.emit(audioFrame(2, [2, 2]));
    socket.emit(audioFrame(2, [2, 2])); // the same frame replayed
    socket.emit(audioFrame(1, [1, 1])); // an older frame, also not newer
    assert.deepEqual(played, [2, 2], "only the newer frames reached the playout");
    assert.deepEqual(heard, [2, 2], "and only those reached the caller");
    assert.ok(
      debug.some((line) => line.includes("dropped") && line.includes("seq=2")),
      `the drop is named in the log: ${JSON.stringify(debug)}`,
    );
  } finally {
    await session.stop();
    restore();
  }
});

test("a seq gap is played through: the call continues after a missing frame", async () => {
  const { socket, played, restore, session } = sequenceSession();
  try {
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.emit(audioFrame(1, [1, 1]));
    socket.emit(audioFrame(4, [4, 4]));
    assert.deepEqual(played, [2, 2], "a gap drops nothing that arrived");
  } finally {
    await session.stop();
    restore();
  }
});

test("an unnumbered audio frame still plays (a service that predates seq)", async () => {
  const { socket, played, restore, session } = sequenceSession();
  try {
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.emit(audioFrame(null, [1, 1]));
    socket.emit(audioFrame(null, [1, 1]));
    assert.deepEqual(played, [2, 2], "without a seq there is nothing to compare");
  } finally {
    await session.stop();
    restore();
  }
});

// ── Guard: the cascade path has its own deliberate rate contract ──────────
// The pipeline stamps every audio frame with its own rate
// (voice-pipeline/transport.py). A frame that omits it can only be our own
// default PCM16 stream, so the fallback is output-format's named default — not
// a literal in this file, which would drift from the managed path's default
// without any test noticing a speed change.

const CASCADE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "cascade-session.ts"),
  "utf8",
);

/** The rate argument of every `play(...)` call in the source. */
function playbackRateArguments(source: string): string[] {
  return [...source.matchAll(/\.play\(([^)]*)\)/g)].map((match) => {
    const args = match[1] ?? "";
    return args.slice(args.lastIndexOf(",") + 1).trim();
  });
}

test("cascade playback takes the frame's rate, never a literal", () => {
  const rates = playbackRateArguments(CASCADE_SOURCE);
  assert.ok(rates.length > 0, "the guard found no cascade playback call");
  for (const rate of rates) {
    assert.doesNotMatch(rate, /\d/, `a literal rate reached the cascade playout: ${rate}`);
    assert.match(rate, /\.sampleRate$/, `the frame's rate did not reach the playout: ${rate}`);
  }
  // The default lives in output-format.ts, behind the resolver; a bare literal
  // here would play a frame at a rate no confirmation resolved.
  assert.doesNotMatch(CASCADE_SOURCE, /24_000|24000/);
});

test("an audio frame with no rate falls back to the named default, not a literal", () => {
  const decoded = decodeAudioMessage(
    JSON.stringify({ type: "audio", data: Buffer.from([9, 9]).toString("base64") }),
  );
  assert.deepEqual(decoded, {
    pcm: new Uint8Array([9, 9]),
    sampleRate: DEFAULT_OUTPUT_SAMPLE_RATE,
  });
});

type FakeSocket = {
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  closed: boolean;
  readyState: number;
  OPEN: number;
  send(message: string): void;
  close(): void;
  emit(data: string): void;
};

function makeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    closed: false,
    readyState: 0,
    OPEN: 1,
    send(message: string) {
      socket.sent.push(message);
    },
    close() {
      socket.closed = true;
    },
    emit(data: string) {
      socket.onmessage?.({ data });
    },
  };
  return socket;
}

test("session sends config on open and dispatches server events", async () => {
  const socket = makeSocket();
  const captions: Array<{ role: string; text: string; final: boolean }> = [];
  const audio: Array<{ sampleRate: number; length: number }> = [];
  let interrupted = 0;
  let ended: { turns: number } | null = null;
  const session = new CascadeSession(
    {
      onCaption: (c) => captions.push({ role: c.role, text: c.text, final: c.final }),
      onAudio: (pcm, sampleRate) => audio.push({ sampleRate, length: pcm.length }),
      onInterrupted: () => (interrupted += 1),
      onEnd: (info) => (ended = info),
    },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0]).type, "config");

  socket.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));
  socket.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      sample_rate: 24000,
    }),
  );
  socket.emit(JSON.stringify({ type: "interrupted" }));
  socket.emit(JSON.stringify({ type: "end", metrics: {}, turns: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(captions, [{ role: "user", text: "hi", final: false }]);
  assert.deepEqual(audio, [{ sampleRate: 24000, length: 3 }]);
  assert.equal(interrupted, 1);
  assert.deepEqual(ended, { turns: 1 });
  await session.stop();
  assert.equal(socket.closed, true);
});

test("a turn ends when its audio drains, not when its caption finishes", async () => {
  // The live greeting: a 460 ms transcript over 1.76 s of 24 kHz speech. The
  // caption is complete while most of the audio is still queued; only the
  // playout knows when the last sample has sounded.
  const socket = makeSocket();
  let speechEnds = 0;
  const playout: Playout = { play: () => {}, flush: () => {} };
  const session = new CascadeSession(
    { onSpeechEnd: () => (speechEnds += 1) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => playout,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  assert.equal(typeof playout.onDrained, "function", "the session listens for the playout's drain");

  socket.emit(
    JSON.stringify({
      type: "audio",
      seq: 1,
      sample_rate: 24000,
      data: Buffer.alloc(84480).toString("base64"),
    }),
  );
  socket.emit(JSON.stringify({ type: "caption", role: "agent", text: "Hi, I'm Voni.", final: true }));
  assert.equal(speechEnds, 0, "a final caption is text; the turn's audio is still playing");

  playout.onDrained!();
  assert.equal(speechEnds, 1, "the drain is the turn's real end");

  // A second reply is its own turn: the drain fires again for it.
  socket.emit(
    JSON.stringify({
      type: "audio",
      seq: 2,
      sample_rate: 24000,
      data: Buffer.alloc(9600).toString("base64"),
    }),
  );
  playout.onDrained!();
  assert.equal(speechEnds, 2, "each reply's drain is one turn end");
  await session.stop();
});

test("an interruption is not a finished turn: the flush never reports a drain", async () => {
  // A barge-in cuts the reply; the playout marks itself not-busy in the same
  // tick, so the worklet's idle report is ignored. The client must keep the
  // cut and the finish apart: the interrupted path redraws `listening`, the
  // drained path releases the floor.
  const socket = makeSocket();
  const worklet = fakeAudioWorkletNode();
  const playout = createWorkletPlayout(worklet.node);
  let drained = 0;
  let interrupted = 0;
  const session = new CascadeSession(
    { onInterrupted: () => (interrupted += 1) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {}, playout }),
    },
  );
  await session.start(CONFIG, "test-owner");
  // After start: the session installs its own drain listener there.
  playout.onDrained = () => (drained += 1);
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  playout.play(new Uint8Array(2), 24000);
  socket.emit(JSON.stringify({ type: "interrupted" }));
  // The idle report that would have belonged to the flushed reply arrives
  // just after the flush, as the worklet's already-rendered quantum does.
  worklet.send({
    type: "level",
    seq: 1,
    queuedMs: 0,
    cushionMs: 0,
    targetCushionMs: 250,
    correctionPct: 0,
    playing: false,
    idle: true,
    consumed: 1,
  });

  assert.equal(interrupted, 1);
  assert.equal(drained, 0, "a flushed reply is cut, never finished");
  await session.stop();
});


test("mic frames wait for the service's first audio, then are forwarded", async () => {
  const socket = makeSocket();
  const mic: { onFrame: ((data: ArrayBuffer) => void) | null } = { onFrame: null };
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async (_owner, onFrame) => {
        mic.onFrame = onFrame;
        return { stop: () => {} };
      },
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  // The connect is not over: the caller speaking here cannot be heard by a
  // session that does not exist yet, and forwarding it floods the vendor.
  mic.onFrame?.(new Uint8Array([5, 6]).buffer);
  assert.equal(socket.sent.length, 1, "only the config frame went out");

  socket.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      sample_rate: 24000,
    }),
  );
  mic.onFrame?.(new Uint8Array([7, 8]).buffer);
  const frames = socket.sent.map((raw) => JSON.parse(raw));
  const audio = frames.filter((frame) => frame.type === "audio");
  assert.equal(audio.length, 1);
  assert.equal(Buffer.from(audio[0].data, "base64").length, 2);
  await session.stop();
});

test("a call that never speaks still opens the mic after the bound", async () => {
  // A resumed call deliberately speaks no greeting; without the fallback the
  // caller would be heard by nobody. The bound is the only thing that opens it.
  const socket = makeSocket();
  const mic: { onFrame: ((data: ArrayBuffer) => void) | null } = { onFrame: null };
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async (_owner, onFrame) => {
        mic.onFrame = onFrame;
        return { stop: () => {} };
      },
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  const clock = mock.timers;
  clock.enable({ apis: ["setTimeout"] });
  try {
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.onopen?.();
    mic.onFrame?.(new Uint8Array([1]).buffer);
    assert.equal(socket.sent.length, 1, "held before the bound");
    clock.tick(MIC_GATE_FALLBACK_MS);
    mic.onFrame?.(new Uint8Array([2]).buffer);
    assert.equal(socket.sent.length, 2, "released at the bound");
    const stopping = session.stop();
    // The fake clock also owns the bounded wait for the service's end.
    clock.tick(CALLER_END_WAIT_MS);
    await stopping;
  } finally {
    clock.reset();
  }
});

test("a listening event opens the mic before the greeting", async () => {
  // The service sends `listening` before the opening line so a caller who
  // speaks first is heard first and the greeting can be skipped.
  const socket = makeSocket();
  const mic: { onFrame: ((data: ArrayBuffer) => void) | null } = { onFrame: null };
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async (_owner, onFrame) => {
        mic.onFrame = onFrame;
        return { stop: () => {} };
      },
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  mic.onFrame?.(new Uint8Array([1]).buffer);
  assert.equal(socket.sent.length, 1, "held until the service opens the line");

  socket.emit(JSON.stringify({ type: "listening" }));
  mic.onFrame?.(new Uint8Array([2]).buffer);
  assert.equal(socket.sent.length, 2, "released by listening, not by first audio");
  await session.stop();
});

test("muting cascade drops mic frames and sends context without stopping playback", async () => {
  const socket = makeSocket();
  const mic: { onFrame: ((data: ArrayBuffer) => void) | null } = { onFrame: null };
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async (_owner, onFrame) => {
        mic.onFrame = onFrame;
        return { stop: () => {} };
      },
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  // The service is live, so the mic gate is open for the mute test itself.
  socket.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([0]).toString("base64"),
      sample_rate: 24000,
    }),
  );
  mic.onFrame?.(new Uint8Array([1]).buffer);
  session.setInputMuted(true);
  mic.onFrame?.(new Uint8Array([2]).buffer);
  session.setInputMuted(false);
  mic.onFrame?.(new Uint8Array([3]).buffer);

  const messages = socket.sent.map((raw) => JSON.parse(raw));
  assert.equal(messages.filter((message) => message.type === "audio").length, 2);
  assert.deepEqual(
    messages.filter((message) => message.type === "context"),
    [
      { type: "context", role: "system", content: MICROPHONE_MUTED_CONTEXT },
      { type: "context", role: "system", content: MICROPHONE_UNMUTED_CONTEXT },
    ],
  );
  assert.ok(!socket.sent.some((message) => message.includes("reply.create")));
  await session.stop();
});

// ── Delivered capture on the cascade path (ticket 121) ────────────────────
// The managed session already writes a delivered WAV; the cascade client had
// no tap at all, so a cascade call could not be judged by the W0 two-capture
// comparison. The capture is the worklet's output, never the wire's 24 kHz
// source: the file must carry the device rate the caller actually heard.

/** A playout whose worklet tap can be driven from the test. */
export function tapPlayout(fields: {
  taps: boolean[];
  onTap: { fn: ((samples: Float32Array) => void) | null };
}) {
  return {
    play() {},
    flush() {},
    tap(on: boolean) {
      fields.taps.push(on);
      return Promise.resolve({ ended: true });
    },
    get onTap() {
      return fields.onTap.fn ?? undefined;
    },
    set onTap(fn: ((samples: Float32Array) => void) | undefined) {
      fields.onTap.fn = fn ?? null;
    },
  };
}

test("delivered capture: the cascade path taps the worklet and writes its WAV", async () => {
  const socket = makeSocket();
  const taps: boolean[] = [];
  const onTap: { fn: ((samples: Float32Array) => void) | null } = { fn: null };
  const written: { name: string; bytes: Uint8Array }[] = [];
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {},
        audioCtx: { sampleRate: 44100 } as unknown as AudioContext,
        playout: tapPlayout({ taps, onTap }) as unknown as Playout,
      }),
      writeCapture: (name, bytes) => {
        written.push({ name, bytes });
      },
    },
  );
  session.setDeliveredCapture(true);
  await session.start(CONFIG, "test-owner");
  assert.deepEqual(taps, [true], "the worklet tap starts with the call");

  onTap.fn?.(new Float32Array([0.25, -0.25, 0.5]));
  await session.stop();

  assert.deepEqual(taps, [true, false], "and flushes before teardown");
  assert.equal(written.length, 1, "one file per cascade call");
  assert.match(written[0]!.name, /^delivered-.*\.wav$/);
  const wav = decodeWav(written[0]!.bytes);
  assert.equal(wav.facts.sampleRate, 44100, "at the worklet's output rate");
  assert.equal(wav.facts.channels, 1);
  assert.equal(wav.facts.bitsPerSample, 16);
  assert.deepEqual(Array.from(wav.samples), [8192, -8192, 16384]);
});

test("delivered capture: enabling the cascade tap changes nothing the worklet plays", async () => {
  // The same server frames, rendered by the same fake worklet twice: capture
  // off, then on. The stream handed to the worklet and the samples the
  // worklet rendered must be identical; only the extra WAV may appear.
  async function run(capture: boolean) {
    const socket = makeSocket();
    const played: { pcm: number[]; rate: number }[] = [];
    const rendered: number[] = [];
    const written: { name: string; bytes: Uint8Array }[] = [];
    const tap = { on: false, fn: null as ((samples: Float32Array) => void) | null };
    const playout = {
      play(pcm: Uint8Array, rate: number) {
        played.push({ pcm: Array.from(pcm), rate });
        // Stand in for the worklet: every played sample is rendered, and the
        // tap copies exactly those rendered samples when it is on.
        const floats = new Float32Array(pcm.length >> 1);
        for (let i = 0; i < floats.length; i++) {
          const at = i * 2;
          const v = (pcm[at]! | (pcm[at + 1]! << 8)) << 16 >> 16;
          floats[i] = v / 32768;
          rendered.push(floats[i]!);
        }
        if (tap.on) tap.fn?.(floats);
      },
      flush() {},
      tap(on: boolean) {
        tap.on = on;
        return Promise.resolve({ ended: true });
      },
      get onTap() {
        return tap.fn ?? undefined;
      },
      set onTap(fn: ((samples: Float32Array) => void) | undefined) {
        tap.fn = fn ?? null;
      },
    };
    const session = new CascadeSession(
      {},
      {
        socketFactory: () => socket as unknown as WebSocket,
        startMic: async () => ({
          stop: () => {},
          audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
          playout: playout as unknown as Playout,
        }),
        writeCapture: (name, bytes) => {
          written.push({ name, bytes });
        },
      },
    );
    if (capture) session.setDeliveredCapture(true);
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.onopen?.();
    for (const samples of [Int16Array.from([1, -2, 3, -4]), Int16Array.from([500, -500, 0])]) {
      socket.emit(
        JSON.stringify({
          type: "audio",
          data: Buffer.from(new Uint8Array(samples.buffer)).toString("base64"),
          sample_rate: 24000,
        }),
      );
    }
    await session.stop();
    return { played, rendered, written };
  }

  const off = await run(false);
  const on = await run(true);

  assert.equal(off.written.length, 0, "capture off writes nothing");
  assert.deepEqual(on.played, off.played, "capture on schedules the same chunks at the same rates");
  assert.deepEqual(on.rendered, off.rendered, "capture on renders the same samples");
  assert.equal(on.written.length, 1, "capture on writes exactly one WAV");

  const wav = decodeWav(on.written[0]!.bytes);
  assert.equal(wav.facts.sampleRate, 48000, "the worklet's device rate, not the wire's 24 kHz");
  // What was heard, at the comparison's 16-bit quantisation, sample for sample.
  const quantise = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  assert.deepEqual(Array.from(wav.samples), on.rendered.map(quantise));
});

test("delivered capture: a cascade tap that never acks is a named failure on the session", async () => {
  // A suspended context does not post its final block. The WAV is still kept
  // for triage, but the session must say the capture is short so the artifact
  // can mark the run ineligible instead of measuring a quietly clipped file.
  const socket = makeSocket();
  const onTap: { fn: ((samples: Float32Array) => void) | null } = { fn: null };
  let tapOff = 0;
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {},
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout: {
          play() {},
          flush() {},
          tap(on: boolean) {
            if (!on) tapOff += 1;
            return Promise.resolve({ ended: on });
          },
          get onTap() {
            return onTap.fn ?? undefined;
          },
          set onTap(fn: ((samples: Float32Array) => void) | undefined) {
            onTap.fn = fn ?? null;
          },
        } as unknown as Playout,
      }),
      writeCapture: () => undefined,
      captureNow: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
    },
  );
  session.setDeliveredCapture(true);
  await session.start(CONFIG, "test-owner");
  onTap.fn?.(new Float32Array([0.5]));
  await session.stop();

  assert.equal(tapOff, 1, "teardown asked the worklet to flush");
  assert.deepEqual(session.deliveredCaptureResult(), {
    complete: false,
    reason: "tap-timeout",
    name: "delivered-20261029-140506.wav",
    samples: 1,
    bytes: 46,
  });
});

// ── The tap's final block must be acked before the graph closes ──────────
// A caller hang-up sends `stop`; the service's `end` can land while the tap's
// final block is still in flight. Teardown then closed the mic's AudioContext
// before the worklet acked, so the WAV lost the last block and the session
// reported a false `tap-timeout`. The graph has to outlive the ack (bounded by
// the tap's own timeout), never the other way round.

/** The AudioWorkletNode surface `createWorkletPlayout` uses, speakable from a test. */
function fakeAudioWorkletNode() {
  let handler: ((e: { data: unknown }) => void) | null = null;
  const port = {
    get onmessage() {
      return handler;
    },
    set onmessage(fn: ((e: { data: unknown }) => void) | null) {
      handler = fn;
    },
    postMessage: () => {},
    close: () => {
      handler = null;
    },
  } as unknown as MessagePort;
  return {
    node: { port } as unknown as AudioWorkletNode,
    send: (data: unknown) => handler?.({ data }),
    close: () => {
      handler = null;
    },
  };
}

test("caller hang-up: the worklet's final block is acked before the graph closes", async () => {
  const socket = makeSocket();
  const worklet = fakeAudioWorkletNode();
  const playout = createWorkletPlayout(worklet.node);
  const written: Uint8Array[] = [];
  let graphStops = 0;
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {
          graphStops += 1;
          // A closed context can no longer deliver a worklet message.
          worklet.close();
        },
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout,
      }),
      writeCapture: (_name, bytes) => {
        written.push(bytes);
      },
    },
  );
  session.setDeliveredCapture(true);
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  worklet.send({ type: "tap", samples: new Float32Array([0.25, -0.25]) });
  const stopping = session.stop();
  // The service's end frame lands first (the race the live run surfaced).
  socket.emit(JSON.stringify({ type: "end", turns: 0, metrics: {} }));
  // The ack and its final block arrive just after that teardown began.
  await new Promise((resolve) => setTimeout(resolve, 40));
  worklet.send({ type: "tap", samples: new Float32Array([0.5]) });
  worklet.send({ type: "tap-end" });
  await stopping;

  assert.equal(graphStops, 1, "the graph is still released exactly once");
  assert.deepEqual(
    session.deliveredCaptureResult(),
    {
      complete: true,
      reason: "",
      name: session.deliveredCaptureResult()!.name,
      samples: 3,
      bytes: written[0]!.length,
    },
    "the final block is in the delivered WAV, never a false timeout",
  );
  assert.deepEqual(Array.from(decodeWav(written[0]!).samples), [8192, -8192, 16384]);
});

test("caller hang-up: a suspended worklet still reports tap-timeout, not a complete capture", async () => {
  // The complement: the graph is kept only until the tap's bound, and a
  // context that emits no final block is still named as a truncation.
  const socket = makeSocket();
  const worklet = fakeAudioWorkletNode();
  const playout = createWorkletPlayout(worklet.node);
  const written: Uint8Array[] = [];
  let graphStops = 0;
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {
          graphStops += 1;
          worklet.close();
        },
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout,
      }),
      writeCapture: (_name, bytes) => {
        written.push(bytes);
      },
    },
  );
  session.setDeliveredCapture(true);
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  worklet.send({ type: "tap", samples: new Float32Array([0.5]) });
  const stopping = session.stop();
  socket.emit(JSON.stringify({ type: "end", turns: 0, metrics: {} }));
  // No tap block and no ack: the context is suspended for the tap's purposes.
  await stopping;

  assert.equal(graphStops, 1, "the suspended graph is released, never held forever");
  assert.deepEqual(session.deliveredCaptureResult(), {
    complete: false,
    reason: "tap-timeout",
    name: session.deliveredCaptureResult()!.name,
    samples: 1,
    bytes: written[0]!.length,
  });
});

// ── Protocol version (ticket 138) ────────────────────────────────────────
// The service refuses a missing or unknown version by name and reports the
// version it speaks in the end message. The client must surface that, not hang
// with a mic open, and must not report a refused connect as a completed call.

test("a protocol-version refusal tears down the socket and microphone", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  const errors: string[] = [];
  let ended = 0;
  let micStops = 0;
  const session = new CascadeSession(
    {
      onConnectFailure: (error) => failures.push(error),
      onError: (message) => errors.push(message),
      onEnd: () => (ended += 1),
    },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => (micStops += 1) }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  const refusal =
    "protocol version 2, which is not one this service speaks; this service speaks protocol version 1 only and never guesses — update the app or the service together";
  socket.emit(JSON.stringify({ type: "error", code: "protocol_version", message: refusal }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(failures.length, 1, "a pre-accept version refusal is one connect cause");
  assert.equal(failures[0].code, "protocol");
  assert.equal(failures[0].message, refusal);
  assert.deepEqual(errors, [], "the generic error path does not paint over the refusal");
  assert.equal(socket.closed, true, "the socket is torn down instead of left hanging");
  assert.equal(micStops, 1, "the microphone is released, never left live");
  assert.equal(ended, 0, "a refused connect is not a completed call");
});

test("the end message's protocol version is checked against this client's", async () => {
  const socket = makeSocket();
  const errors: string[] = [];
  let ended: { turns: number } | null = null;
  const session = new CascadeSession(
    { onError: (message) => errors.push(message), onEnd: (info) => (ended = info) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  socket.emit(
    JSON.stringify({
      type: "end",
      metrics: {},
      turns: 3,
      protocolVersion: CASCADE_PROTOCOL_VERSION + 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(errors.length, 1, "a mismatched end is surfaced");
  assert.match(errors[0], new RegExp(`protocol version ${CASCADE_PROTOCOL_VERSION + 1}`));
  assert.match(errors[0], new RegExp(`${CASCADE_PROTOCOL_VERSION}`));
  assert.deepEqual(ended, { turns: 3 });
});

test("a matching end message is not reported as a mismatch", async () => {
  const socket = makeSocket();
  const errors: string[] = [];
  let ended: { turns: number } | null = null;
  const session = new CascadeSession(
    { onError: (message) => errors.push(message), onEnd: (info) => (ended = info) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  socket.emit(
    JSON.stringify({
      type: "end",
      metrics: {},
      turns: 1,
      protocolVersion: CASCADE_PROTOCOL_VERSION,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, []);
  assert.deepEqual(ended, { turns: 1 });
});

test("a connect refusal reports only its named cause", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  const session = new CascadeSession(
    { onConnectFailure: (error) => failures.push(error) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.emit(JSON.stringify({ type: "error", code: "managed", message: "routed managed" }));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "managed");
  assert.equal(failures[0].message, "routed managed");
});

test("a routed-managed refusal on connect is handed over typed, not shown as a dead end", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  let micStops = 0;
  let errors = 0;
  let ended = 0;
  const session = new CascadeSession(
    {
      onConnectFailure: (error) => failures.push(error),
      onError: () => (errors += 1),
      onEnd: () => (ended += 1),
    },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => (micStops += 1) }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  // The service's routing switch defaults to `off`, so this is the common
  // refusal: a valid call that belongs on the managed engine.
  socket.emit(
    JSON.stringify({
      type: "error",
      code: "managed",
      message: "the routing decision routes this call managed",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(failures.length, 1, "one refusal reports one cause");
  assert.equal(failures[0].code, "managed");
  assert.match(failures[0].message, /managed/);
  assert.equal(errors, 0, "the generic error path is not painted over the fallback");
  assert.equal(ended, 0, "a refused connect is not a completed call");
  assert.equal(socket.closed, true, "the cascade attempt is closed before the retry");
  assert.equal(micStops, 1, "the microphone is released before the retry, never left live");

  // The close the service sends after its refusal is not a second cause.
  socket.onclose?.();
  assert.equal(failures.length, 1);
  assert.equal(ended, 0);
});

test("a managed or draining refusal after acceptance surfaces and never re-routes", async () => {
  // The call already started: re-dialing it on managed would double the call.
  for (const code of ["managed", "draining"] as const) {
    const socket = makeSocket();
    const failures: DrainingError[] = [];
    const messages: string[] = [];
    let micStops = 0;
    let ended = 0;
    const session = new CascadeSession(
      {
        onConnectFailure: (error) => failures.push(error),
        onError: (message) => messages.push(message),
        onEnd: () => (ended += 1),
      },
      {
        socketFactory: () => socket as unknown as WebSocket,
        startMic: async () => ({ stop: () => (micStops += 1) }),
        createPlayout: () => ({ play: () => {}, flush: () => {} }),
      },
    );
    await session.start(CONFIG, "test-owner");
    socket.readyState = socket.OPEN;
    socket.emit(JSON.stringify({ type: "caption", role: "agent", text: "Hi.", final: true }));

    socket.emit(JSON.stringify({ type: "error", code, message: `refused: ${code}` }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(failures.length, 0, `a started call is never re-routed (${code})`);
    assert.deepEqual(messages, [`refused: ${code}`], `the refusal stays visible (${code})`);
    assert.equal(micStops, 0, `the live call keeps its microphone (${code})`);
    assert.equal(socket.closed, false, `the live call keeps its socket (${code})`);
    assert.equal(ended, 0, `the call is not ended by the refusal alone (${code})`);
  }
});

test("a draining refusal on connect is handed over typed, not shown as a dead end", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  let errors = 0;
  let ended = 0;
  const session = new CascadeSession(
    {
      onConnectFailure: (error) => failures.push(error),
      onError: () => (errors += 1),
      onEnd: () => (ended += 1),
    },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  socket.emit(
    JSON.stringify({
      type: "error",
      code: "draining",
      message: "the service is draining (SIGTERM) and accepts no new call",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "draining");
  assert.match(failures[0].message, /draining/);
  assert.equal(errors, 0, "the generic error path is not painted over the fallback");
  assert.equal(ended, 0, "a refused connect is not a completed call");
  assert.equal(socket.closed, true, "the cascade attempt is closed before the retry");
});

test("a socket that fails or closes before acceptance is unavailable, reported once", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  let ended = 0;
  const session = new CascadeSession(
    { onConnectFailure: (error) => failures.push(error), onEnd: () => (ended += 1) },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;

  // A browser fires error and then close for one failed connection.
  socket.onerror?.();
  socket.onclose?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(failures.length, 1, "one failed connection reports one cause");
  assert.equal(failures[0].code, "unavailable");
  assert.equal(ended, 0);
  assert.equal(socket.closed, true);
});

test("a socket that closes after the service accepted the call stays an ordinary end", async () => {
  const socket = makeSocket();
  const failures: DrainingError[] = [];
  let ended: { turns: number } | null = null;
  const session = new CascadeSession(
    {
      onConnectFailure: (error) => failures.push(error),
      onEnd: (info) => (ended = info),
    },
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

  socket.onclose?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(failures, [], "an accepted call ending is not a connect fallback");
  assert.deepEqual(ended, { turns: 0 });
});

// ── One bounded client reconnect after a live socket drop (R2) ─────────────
//
// The demo client used to end a mid-call transport drop as `dropped` with no
// evidence. It now re-mints the resume body for the same call id (the hold
// return the pipeline already supports), reconnects once and re-sends config;
// the resumed body carries no greeting, so nothing is replayed. Every case
// below is a fake socket and a fake mint: no vendor, no browser.

const RESUME_CONFIG: CascadeCallConfig = {
  ...CONFIG,
  serviceUrl: "ws://127.0.0.1:8766/v1/browser-call-resume",
  callToken: "call-token-resumed",
};

function testMarks(callId = "call-reconnect"): CallMarks {
  return new CallMarks({ callId, post: async () => undefined });
}

function namedMarks(marks: CallMarks, name: string) {
  return marks.artifact().marks.filter((mark) => mark.name === name);
}

/** Two fakes plus the factory the session opens them from, in order. */
function socketPair() {
  const sockets = [makeSocket(), makeSocket()];
  let opened = 0;
  return {
    sockets,
    factory: () => sockets[opened++] as unknown as WebSocket,
    get opened() {
      return opened;
    },
  };
}

test("an unexpected drop on a live call reconnects once with the resumed identity", async () => {
  const pair = socketPair();
  const marks = testMarks();
  const requests: Array<{ reason: string; attempt: number }> = [];
  const mic: { onFrame: ((data: ArrayBuffer) => void) | null } = { onFrame: null };
  let micStarts = 0;
  let ended = 0;
  const session = new CascadeSession(
    { onEnd: () => (ended += 1) },
    {
      socketFactory: pair.factory,
      startMic: async (_owner, onFrame) => {
        micStarts += 1;
        mic.onFrame = onFrame;
        return { stop: () => {} };
      },
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async (request) => {
        requests.push(request);
        return RESUME_CONFIG;
      },
    },
  );
  await session.start(CONFIG, "test-owner");
  const first = pair.sockets[0];
  first.readyState = first.OPEN;
  first.onopen?.();
  first.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));
  // The service is live (its first audio opens the mic gate).
  first.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([0]).toString("base64"),
      sample_rate: 24_000,
    }),
  );

  first.onclose?.({ code: 1006, reason: "transport dropped" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [{ reason: "socket-closed", attempt: 1 }]);
  assert.equal(pair.opened, 2, "one replacement socket, never a loop");
  assert.equal(ended, 0, "a call that is reconnecting has not ended");
  assert.equal(micStarts, 1, "the live microphone is kept, never re-acquired");
  assert.equal(pair.sockets[1].sent.length, 0, "nothing is sent before it opens");

  const reconnects = namedMarks(marks, "reconnect");
  assert.equal(reconnects.length, 1);
  assert.deepEqual(reconnects[0].detail, { reason: "socket-closed", attempt: 1, code: 1006 });

  // The resumed call sends config on the new socket and replays nothing: the
  // resume body omits the greeting, so the client has no greeting to re-send.
  const second = pair.sockets[1];
  second.readyState = second.OPEN;
  second.onopen?.();
  assert.deepEqual(
    second.sent.map((raw) => JSON.parse(raw).type),
    ["config"],
    "the reconnected socket opens with config alone",
  );
  assert.deepEqual(JSON.parse(second.sent[0]), {
    type: "config",
    protocolVersion: CASCADE_PROTOCOL_VERSION,
    agentId: CONFIG.agentId,
    callToken: RESUME_CONFIG.callToken,
  });

  // The same microphone now reaches the new socket (the old closure held the
  // first socket and would have gone silent).
  second.emit(JSON.stringify({ type: "caption", role: "agent", text: "go on", final: true }));
  mic.onFrame?.(new Uint8Array([7]).buffer);
  assert.equal(
    second.sent.filter((raw) => JSON.parse(raw).type === "audio").length,
    1,
    "caller audio follows the reconnected socket",
  );
  assert.equal(ended, 0);
});

test("the reconnected session's call sequence restarts and still plays", async () => {
  // The pipeline's `seq` is per browser session, not per call id: a
  // replacement socket's first frame starts again at seq 1. Keeping the first
  // session's high-water mark would drop every frame of the resumed call.
  const pair = socketPair();
  const played: number[] = [];
  const session = new CascadeSession(
    {},
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({
        play: (pcm: Uint8Array) => played.push(pcm[0] ?? -1),
        flush: () => {},
      }),
      reconnect: async () => RESUME_CONFIG,
    },
  );
  await session.start(CONFIG, "test-owner");
  const first = pair.sockets[0];
  first.readyState = first.OPEN;
  first.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));
  first.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([5]).toString("base64"),
      sample_rate: 24_000,
      seq: 5,
    }),
  );
  assert.deepEqual(played, [5]);

  first.onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = pair.sockets[1];
  second.readyState = second.OPEN;
  second.onopen?.();
  second.emit(
    JSON.stringify({
      type: "audio",
      data: Buffer.from([1]).toString("base64"),
      sample_rate: 24_000,
      seq: 1,
    }),
  );

  assert.deepEqual(played, [5, 1], "the resumed session's seq 1 is played, not dropped");
});

test("a caller's stop never reconnects", async () => {
  const pair = socketPair();
  const marks = testMarks();
  let requests = 0;
  const session = new CascadeSession(
    {},
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => {
        requests += 1;
        return RESUME_CONFIG;
      },
    },
  );
  const clock = mock.timers;
  clock.enable({ apis: ["setTimeout"] });
  try {
    await session.start(CONFIG, "test-owner");
    const socket = pair.sockets[0];
    socket.readyState = socket.OPEN;
    socket.onopen?.();
    socket.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

    const stopping = session.stop();
    clock.tick(CALLER_END_WAIT_MS);
    await stopping;
    // The browser fires close after a teardown.
    socket.onclose?.({ code: 1000, reason: "caller hung up" });
    await Promise.resolve();

    assert.equal(requests, 0, "a stop is not a drop");
    assert.equal(namedMarks(marks, "reconnect").length, 0);
    assert.equal(pair.opened, 1, "no second socket is opened");
  } finally {
    clock.reset();
  }
});

test("a connect failure before the call is live never reconnects", async () => {
  const pair = socketPair();
  const marks = testMarks();
  const failures: DrainingError[] = [];
  let requests = 0;
  const session = new CascadeSession(
    { onConnectFailure: (error) => failures.push(error) },
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => {
        requests += 1;
        return RESUME_CONFIG;
      },
    },
  );
  await session.start(CONFIG, "test-owner");
  pair.sockets[0].readyState = pair.sockets[0].OPEN;
  pair.sockets[0].onerror?.();
  pair.sockets[0].onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "unavailable");
  assert.equal(requests, 0, "nothing was live, so there is nothing to resume");
  assert.equal(namedMarks(marks, "reconnect").length, 0);
  assert.equal(pair.opened, 1);
});

test("a failed reconnect ends the call once with its named cause", async () => {
  const pair = socketPair();
  const marks = testMarks();
  const causes: string[] = [];
  let ended = 0;
  const session = new CascadeSession(
    { onEnd: () => (ended += 1), onReconnectFailed: (cause) => causes.push(cause) },
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => {
        throw new Error("the mint refused the resume");
      },
    },
  );
  await session.start(CONFIG, "test-owner");
  const socket = pair.sockets[0];
  socket.readyState = socket.OPEN;
  socket.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

  socket.onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pair.opened, 1, "a refused attempt opens no second socket");
  assert.equal(ended, 1, "the call ends honestly");
  assert.deepEqual(causes, ["mint-failed"]);
  const failed = namedMarks(marks, "reconnect_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].detail?.cause, "mint-failed");
  assert.equal(failed[0].detail?.attempt, 1);
});

test("a second drop ends the call with the named cause, never a third socket", async () => {
  const pair = socketPair();
  const marks = testMarks();
  let requests = 0;
  let ended = 0;
  const session = new CascadeSession(
    { onEnd: () => (ended += 1) },
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => {
        requests += 1;
        return RESUME_CONFIG;
      },
    },
  );
  await session.start(CONFIG, "test-owner");
  const first = pair.sockets[0];
  first.readyState = first.OPEN;
  first.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

  first.onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = pair.sockets[1];
  second.readyState = second.OPEN;
  second.onopen?.();
  second.emit(JSON.stringify({ type: "caption", role: "agent", text: "hello again", final: true }));

  second.onclose?.({ code: 1006, reason: "dropped again" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests, 1, "exactly one reconnect is attempted");
  assert.equal(pair.opened, 2, "the second drop opens no third socket");
  assert.equal(ended, 1);
  const failed = namedMarks(marks, "reconnect_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].detail?.cause, "second-drop");
  assert.equal(failed[0].detail?.attempt, 2);
});

test("a replacement socket that cannot open is a named reconnect failure", async () => {
  const first = makeSocket();
  const marks = testMarks();
  const causes: string[] = [];
  let opened = 0;
  let ended = 0;
  const session = new CascadeSession(
    { onEnd: () => (ended += 1), onReconnectFailed: (cause) => causes.push(cause) },
    {
      socketFactory: () => {
        opened += 1;
        if (opened === 2) throw new Error("malformed service URL");
        return first as unknown as WebSocket;
      },
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => RESUME_CONFIG,
    },
  );
  await session.start(CONFIG, "test-owner");
  first.readyState = first.OPEN;
  first.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

  first.onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(opened, 2, "the replacement was attempted once");
  assert.equal(ended, 1);
  assert.deepEqual(causes, ["socket-error"]);
  assert.equal(namedMarks(marks, "reconnect_failed")[0]?.detail?.cause, "socket-error");
});

test("a reconnect that is never admitted is bounded and names the timeout", async () => {
  const pair = socketPair();
  const marks = testMarks();
  let ended = 0;
  const session = new CascadeSession(
    { onEnd: () => (ended += 1) },
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: () => new Promise<CascadeCallConfig>(() => undefined),
    },
  );
  const clock = mock.timers;
  clock.enable({ apis: ["setTimeout"] });
  try {
    await session.start(CONFIG, "test-owner");
    const socket = pair.sockets[0];
    socket.readyState = socket.OPEN;
    socket.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

    socket.onclose?.({ code: 1006 });
    // The mint hangs; only the recorded handshake bound releases the call.
    clock.tick(RECONNECT_HANDSHAKE_MS);
    await Promise.resolve();

    assert.equal(ended, 1, "a stuck reconnect never holds the call open");
    const failed = namedMarks(marks, "reconnect_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].detail?.cause, "timeout");
    assert.equal(failed[0].detail?.attempt, 1);
    assert.equal(pair.opened, 1, "the socket never opened");
  } finally {
    clock.reset();
  }
});

test("a service refusal during the reconnect is a reconnect failure, not a connect refusal", async () => {
  const pair = socketPair();
  const marks = testMarks();
  const failures: DrainingError[] = [];
  let ended = 0;
  const session = new CascadeSession(
    { onConnectFailure: (error) => failures.push(error), onEnd: () => (ended += 1) },
    {
      socketFactory: pair.factory,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
      marks,
      reconnect: async () => RESUME_CONFIG,
    },
  );
  await session.start(CONFIG, "test-owner");
  const first = pair.sockets[0];
  first.readyState = first.OPEN;
  first.emit(JSON.stringify({ type: "caption", role: "user", text: "hi", final: false }));

  first.onclose?.({ code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = pair.sockets[1];
  second.readyState = second.OPEN;
  second.emit(JSON.stringify({ type: "error", code: "draining", message: "draining now" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(failures, [], "the call was live; this is not a connect refusal");
  assert.equal(ended, 1);
  const failed = namedMarks(marks, "reconnect_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].detail?.cause, "refused:draining");
});
