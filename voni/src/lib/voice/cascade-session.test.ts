import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigMessage,
  CascadeSession,
  decodeAudioMessage,
  encodeAudioFrame,
  parseServerMessage,
  type CascadeCallConfig,
} from "./cascade-session";

const CONFIG: CascadeCallConfig = {
  serviceUrl: "ws://127.0.0.1:8766/v1/browser-call",
  pipeline: { llm_model: "m", tts_voice: "v", tts_model: "t", fallback_mode: "cascade" },
  systemPrompt: "Be brief.",
  tools: [],
  agentName: "test",
};

test("config message carries cascade opt-in and prompt", () => {
  const parsed = JSON.parse(buildConfigMessage(CONFIG));
  assert.equal(parsed.type, "config");
  assert.equal(parsed.pipeline.fallback_mode, "cascade");
  assert.equal(parsed.systemPrompt, "Be brief.");
});

test("audio frames encode to base64 data messages", () => {
  const bytes = new Uint8Array([0, 1, 2, 3]).buffer;
  const parsed = JSON.parse(encodeAudioFrame(bytes));
  assert.equal(parsed.type, "audio");
  assert.equal(Buffer.from(parsed.data, "base64").length, 4);
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

type FakeSocket = {
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
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

test("mic frames are forwarded as audio messages", async () => {
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
  mic.onFrame?.(new Uint8Array([5, 6]).buffer);
  assert.equal(socket.sent.length, 2);
  const frame = JSON.parse(socket.sent[1]);
  assert.equal(frame.type, "audio");
  assert.equal(Buffer.from(frame.data, "base64").length, 2);
  await session.stop();
});
