import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSilentGreeting,
  GreetingSessionError,
  silentGreetingSession,
  type GreetingSocket,
} from "./silent-greeting";

type Listener = (event: { data: unknown }) => void;

/** Minimal fake of the parts of `WebSocket` the greeting path uses. */
class FakeSocket implements GreetingSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: "open" | "message" | "error", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "open" | "message" | "error", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

test("a silent-greeting session speaks the line as its greeting at the voice's native level", () => {
  assert.deepEqual(silentGreetingSession({ voiceId: "lola", text: "Hola, soy Voni." }), {
    type: "session.update",
    session: {
      system_prompt: "Stay silent.",
      greeting: "Hola, soy Voni.",
      output: { voice: "lola" },
    },
  });
});

test("a session.error is refused by name instead of timing out", async () => {
  const socket = new FakeSocket();
  const greeting = collectSilentGreeting({
    voiceId: "jorg",
    text: "Hallo.",
    token: "tok",
    socketFactory: () => socket,
  });

  socket.emit("open");
  socket.emit(
    "message",
    JSON.stringify({
      type: "session.error",
      code: "invalid_value",
      message: "Invalid voice 'jorg'. Must be one of: alba, anna, …",
      param: "output.voice",
    }),
  );

  await assert.rejects(greeting, (error: unknown) => {
    assert.ok(error instanceof GreetingSessionError);
    assert.equal(error.code, "invalid_value");
    assert.equal(error.param, "output.voice");
    assert.match(error.message, /Invalid voice 'jorg'/);
    return true;
  });
  assert.equal(socket.closed, true);
});

test("the greeting's reply.audio frames come back as one unmodified PCM buffer", async () => {
  const socket = new FakeSocket();
  const frames = [Buffer.from([0x01, 0x02, 0x03, 0x04]), Buffer.from([0xff, 0x7f])];
  const constructed: string[] = [];

  const greeting = collectSilentGreeting({
    voiceId: "anna",
    text: "Hi, I'm Voni!",
    token: "tok",
    socketFactory: (url) => {
      constructed.push(url);
      return socket;
    },
  });

  assert.equal(constructed.length, 1);
  assert.match(constructed[0]!, /^wss:\/\/agents\.assemblyai\.com\/v1\/ws\?token=tok$/);

  socket.emit("open");
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    type: "session.update",
    session: {
      system_prompt: "Stay silent.",
      greeting: "Hi, I'm Voni!",
      output: { voice: "anna" },
    },
  });

  for (const frame of frames) {
    socket.emit("message", JSON.stringify({ type: "reply.audio", data: frame.toString("base64") }));
  }
  socket.emit("message", JSON.stringify({ type: "reply.done" }));

  const pcm = await greeting;
  assert.equal(Buffer.compare(pcm, Buffer.concat(frames)), 0);
  assert.deepEqual(JSON.parse(socket.sent[1]!), { type: "session.end" });
  assert.equal(socket.closed, true);
});
