/**
 * The cascade client's half of the browser call evidence stream: admission,
 * refusal, end receipt, teardown and the delivered capture, all named in the
 * same marks artifact the landing page posts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CallMarks, type CallMarksArtifact } from "./call-marks";
import {
  CALLER_END_WAIT_MS,
  CascadeSession,
  type CascadeCallConfig,
} from "./cascade-session";
import type { Playout } from "./playout";

const CONFIG: CascadeCallConfig = {
  serviceUrl: "ws://127.0.0.1:8766/v1/browser-call",
  callToken: "call-token-05",
  agentId: "demo:audrey",
  protocolVersion: 1,
};

const T0 = Date.UTC(2026, 9, 31, 15, 10, 0);

type FakeSocket = {
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  closed: boolean;
  readyState: number;
  OPEN: number;
  send(message: string): void;
  close(): void;
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
  };
  return socket;
}

function makePlayout() {
  const playout = {
    onFirstAudible: undefined as (() => void) | undefined,
    play() {},
    flush() {},
    settled: () => true,
  };
  return playout as Playout & { onFirstAudible?: () => void };
}

/** A playout with the worklet's tap accessor, plus a way to emit a block. */
function makeTappablePlayout() {
  let collector: ((samples: Float32Array) => void) | undefined;
  const playout = {
    onFirstAudible: undefined as (() => void) | undefined,
    play() {},
    flush() {},
    settled: () => true,
    tap: async () => ({ ended: true }),
    get onTap() {
      return collector;
    },
    set onTap(fn: ((samples: Float32Array) => void) | undefined) {
      collector = fn;
    },
  };
  return {
    playout: playout as unknown as Playout,
    emit: (samples: Float32Array) => collector?.(samples),
  };
}

function recorder(opts: { now?: () => number } = {}) {
  const posted: CallMarksArtifact[] = [];
  const marks = new CallMarks({
    callId: "call-marks-05",
    now: opts.now ?? (() => T0),
    post: async (artifact) => {
      posted.push(artifact);
    },
  });
  return { marks, posted };
}

async function settleMarks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a cascade call names every lifecycle mark in order", async () => {
  const socket = makeSocket();
  const playout = makePlayout();
  const { marks, posted } = recorder();

  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {},
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout,
      }),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({ type: "caption", role: "agent", text: "Hi.", final: true }),
  });
  playout.onFirstAudible?.();
  socket.onmessage?.({ data: JSON.stringify({ type: "end_call" }) });
  // The caller-side stop that follows the drain; the service answers it with
  // its end, as the real one does.
  assert.equal(
    socket.sent.some((frame) => JSON.parse(frame).type === "stop"),
    true,
    "the drain sent the stop",
  );
  socket.onmessage?.({
    data: JSON.stringify({ type: "end", turns: 0, metrics: {}, protocolVersion: 1 }),
  });
  await settleMarks();

  assert.equal(posted.length, 1, "one marks artifact per call");
  assert.deepEqual(
    posted[0]!.marks.map((mark) => mark.name),
    [
      "microphone_acquired",
      "socket_open",
      "config_sent",
      "admitted",
      "first_audible",
      "end_call_received",
      "end_received",
      "teardown",
    ],
  );
  assert.deepEqual(
    posted[0]!.marks.find((mark) => mark.name === "admitted")!.detail,
    { via: "caption" },
    "admission is in the marks so connected can be compared with first audio",
  );
  const relative = posted[0]!.marks.map((mark) => mark.tMs);
  assert.deepEqual(relative, [...relative].sort((a, b) => a - b), "call-relative time never goes backwards");
});

test("a refused connect is in the marks by name and never admitted", async () => {
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({ type: "error", code: "draining", message: "Draining for deploy." }),
  });
  await settleMarks();

  const names = posted[0]!.marks.map((mark) => mark.name);
  assert.ok(names.includes("refused"), "a refusal is named");
  assert.equal(names.includes("admitted"), false, "a refused call was never admitted");
  assert.deepEqual(
    posted[0]!.marks.find((mark) => mark.name === "refused")!.detail,
    { code: "draining" },
  );
  assert.equal(names.at(-1), "teardown");
});

test("only the first accepting frame is admitted; later frames do not repeat it", async () => {
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ type: "interrupted" }) });
  socket.onmessage?.({
    data: JSON.stringify({ type: "caption", role: "user", text: "Hello.", final: true }),
  });
  await session.stop();
  await settleMarks();

  assert.equal(
    posted[0]!.marks.filter((mark) => mark.name === "admitted").length,
    1,
    "admission is one mark",
  );
});

test("the production end message and teardown are both marked", async () => {
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({ type: "end", turns: 2, metrics: { costUsd: 0.02 }, protocolVersion: 1 }),
  });
  await settleMarks();

  const names = posted[0]!.marks.map((mark) => mark.name);
  assert.ok(names.includes("end_received"));
  assert.deepEqual(
    posted[0]!.marks.find((mark) => mark.name === "end_received")!.detail,
    { turns: 2 },
  );
  assert.equal(names.at(-1), "teardown", "teardown follows the end receipt");
});

test("the delivered WAV and the marks artifact share the call id", async () => {
  const socket = makeSocket();
  const written: { name: string; bytes: Uint8Array }[] = [];
  const { marks, posted } = recorder();
  const { playout, emit } = makeTappablePlayout();

  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {},
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout,
      }),
      writeCapture: (name, bytes) => {
        written.push({ name, bytes });
      },
      captureNow: () => new Date(Date.UTC(2026, 9, 29, 14, 5, 6)),
      marks,
    },
  );
  session.setDeliveredCapture(true, "call-marks-05");
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({ type: "caption", role: "agent", text: "Hi.", final: true }),
  });
  emit(new Float32Array([0.25, -0.25]));
  await session.stop();
  await settleMarks();

  assert.equal(written.length, 1);
  assert.equal(written[0]!.name, "delivered-call-marks-05-20261029-140506.wav");
  const captureMark = posted[0]!.marks.find((mark) => mark.name === "delivered_capture");
  assert.ok(captureMark, "the capture outcome is in the marks");
  assert.deepEqual(captureMark!.detail, {
    complete: true,
    reason: "",
    name: written[0]!.name,
    samples: 2,
    bytes: written[0]!.bytes.length,
  });
  assert.equal(posted[0]!.callId, "call-marks-05");
  assert.ok(written[0]!.name.includes(posted[0]!.callId), "the WAV name carries the same call id");
});

test("a caller hang-up waits (bounded) for the service's end and marks it", async () => {
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  const stopping = session.stop();
  // The real service writes its end after the caller's stop, then closes.
  // Only a client that keeps the socket open can receive it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (!socket.closed) {
    socket.onmessage?.({
      data: JSON.stringify({ type: "end", turns: 3, metrics: {}, protocolVersion: 1 }),
    });
  }
  await stopping;
  await settleMarks();

  const names = posted[0]!.marks.map((mark) => mark.name);
  assert.ok(names.includes("end_received"), "the service's end is the ending mark");
  assert.equal(names.includes("end_missing"), false, "a received end is never also named missing");
  assert.deepEqual(
    posted[0]!.marks.find((mark) => mark.name === "end_received")!.detail,
    { turns: 3 },
    "the mark carries the service's real turn count",
  );
  assert.equal(names.at(-1), "teardown");
});

test("a caller hang-up whose end never arrives is named, never invented", async () => {
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  const started = Date.now();
  await session.stop();
  assert.ok(
    Date.now() - started < CALLER_END_WAIT_MS + 500,
    "the wait for the end is bounded, never an open-ended hang",
  );
  await settleMarks();

  const names = posted[0]!.marks.map((mark) => mark.name);
  assert.equal(names.includes("end_received"), false, "no end was received, so none is claimed");
  const missing = posted[0]!.marks.find((mark) => mark.name === "end_missing");
  assert.ok(missing, "the absent end is named instead of silently omitted");
  assert.deepEqual(missing.detail, { after: "stop" });
  assert.equal(missing.tMs >= 0, true);
  assert.equal(names.at(-1), "teardown");
});

test("a fast hang-up posts the marks even when the capture's close never settles", async () => {
  // The page can be gone as soon as the visitor hangs up. The marks must not
  // wait behind an unbounded tap flush or WAV upload, or the artifact is lost
  // with the page. The capture outcome is still included when it arrives
  // inside the bound; a capture that never closes is named as absent, never
  // invented as a delivered_capture the client did not see.
  const socket = makeSocket();
  const { marks, posted } = recorder();
  const hangingPlayout = {
    onFirstAudible: undefined,
    play() {},
    flush() {},
    settled: () => true,
    tap: () => new Promise<{ ended: boolean }>(() => {}),
    onTap: undefined,
  };
  let micStops = 0;
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({
        stop: () => {
          micStops += 1;
        },
        audioCtx: { sampleRate: 48000 } as unknown as AudioContext,
        playout: hangingPlayout as unknown as Playout,
      }),
      writeCapture: () => undefined,
      marks,
    },
  );
  session.setDeliveredCapture(true, "call-marks-05");
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  const stopping = session.stop();
  const bounded = await Promise.race([
    stopping.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
  ]);
  assert.equal(bounded, true, "teardown is bounded, never held open by a hung capture");
  assert.equal(posted.length, 1, "the marks artifact was posted before the page could close");
  const names = posted[0]!.marks.map((mark) => mark.name);
  assert.equal(names.includes("delivered_capture"), false, "no capture outcome was invented");
  assert.ok(
    names.includes("delivered_capture_absent"),
    "the capture that never closed is named as absent",
  );
  assert.equal(micStops, 1, "the graph is still released after the bound");
});

test("a hanging marks writer never blocks hang-up", async () => {
  const socket = makeSocket();
  const marks = new CallMarks({
    callId: "call-hanging",
    now: () => T0,
    post: () => new Promise(() => {}),
  });
  const session = new CascadeSession(
    {},
    {
      socketFactory: () => socket as unknown as WebSocket,
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => makePlayout(),
      marks,
    },
  );
  await session.start(CONFIG, "test-owner");
  socket.readyState = socket.OPEN;
  socket.onopen?.();

  const started = Date.now();
  await session.stop();
  assert.ok(Date.now() - started < 1000, "teardown never waits on the marks sink");
  assert.equal(socket.closed, true, "the call still tore down");
});
