import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInlineSessionUpdate,
  buildResumeMessage,
  VoiceSession,
  type SessionConfig,
} from "./session";
import { buildDemoAgentBody } from "@/lib/demo/stored-agents";

(globalThis as unknown as { WebSocket: unknown }).WebSocket = { OPEN: 1 };

type Payload = Record<string, unknown>;

function sessionUpdates(sent: string[]): Payload[] {
  return sent
    .map((raw) => JSON.parse(raw) as { type?: string; session?: Payload })
    .filter((message) => message.type === "session.update")
    .map((message) => message.session ?? {});
}

/**
 * A `turn_detection` object anywhere in a payload is the thing that switches
 * off adaptive end-of-turn (see ADAPTIVE_TURNS). `null`/absent are adaptive.
 */
function turnDetectionObjects(value: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === "turn_detection") {
        if (child !== null && child !== undefined) found.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}

test("inline sessions never send turn_detection: it switches off adaptive end-of-turn", () => {
  // Any turn_detection object, even interruption_delay alone, measured
  // ~2s slower per reply. See ADAPTIVE_TURNS in ./session.ts.
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "p",
    greeting: "hi",
    voiceId: "v",
  }) as { input: Record<string, unknown> };
  assert.equal("turn_detection" in update.input, false);
});

// Fast-band contract: adaptive end-of-turn is what keeps replies snappy; any
// turn_detection object drops them into the slow band (ADR-0003). The live
// scoreboard measures the milliseconds — these tests only pin the preset, so
// they make no timing claim of their own.
test("the managed preset carries no turn-detection object: intro, resume, and resume hello", () => {
  for (const resume of [false, true]) {
    const body = buildDemoAgentBody("anna", { resume });
    assert.equal(
      body.input.turn_detection,
      null,
      `${resume ? "resume" : "intro"} stored agent stays adaptive`,
    );
    assert.deepEqual(
      turnDetectionObjects(body),
      [],
      `${resume ? "resume" : "intro"} stored agent sends no turn-detection object`,
    );
  }
  const hello = buildResumeMessage("sess_1");
  assert.deepEqual(hello, { type: "session.resume", session_id: "sess_1" });
  assert.deepEqual(turnDetectionObjects(hello), [], "a resume hello re-sends no pacing");
});

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((event?: unknown) => void)[]>();
  constructor(public url: unknown) {
    sockets.push(this);
  }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {}
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const sockets: FakeSocket[] = [];

function connectFresh(config: SessionConfig, resumeSessionId?: string) {
  const session = new VoiceSession();
  const internals = session as unknown as Record<string, unknown>;
  const generation = internals["generation"] as { begin: () => number };
  const connect = (
    session as unknown as {
      connect: (token: string, config: SessionConfig, gen: number, resume?: string) => void;
    }
  ).connect.bind(session);
  connect("token", config, generation.begin(), resumeSessionId);
  const socket = sockets.at(-1);
  assert.ok(socket, "a socket was opened");
  socket.emit("open");
  return socket;
}

test("the first managed session.update sends no turn-detection object, in agent and inline shapes", () => {
  const saved = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  sockets.length = 0;
  try {
    const agent = connectFresh({ mode: "agent", agentId: "agent_1" });
    assert.deepEqual(JSON.parse(agent.sent[0]), {
      type: "session.update",
      session: { agent_id: "agent_1" },
    });
    assert.deepEqual(turnDetectionObjects(JSON.parse(agent.sent[0])), []);

    const inline = connectFresh({
      mode: "inline",
      systemPrompt: "prompt",
      greeting: "Hey, I'm listening.",
      voiceId: "anna",
    });
    assert.equal((JSON.parse(inline.sent[0]) as { type: string }).type, "session.update");
    assert.deepEqual(turnDetectionObjects(JSON.parse(inline.sent[0])), []);
  } finally {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = saved;
  }
});

test("a managed resume sends only the session hello, never a pacing object", () => {
  const saved = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  sockets.length = 0;
  try {
    const resumed = connectFresh({ mode: "agent", agentId: "agent_resume" }, "sess_1");
    assert.equal(resumed.sent.length, 1, "the hello is the only first send");
    assert.deepEqual(JSON.parse(resumed.sent[0]), {
      type: "session.resume",
      session_id: "sess_1",
    });
    assert.deepEqual(turnDetectionObjects(JSON.parse(resumed.sent[0])), []);
  } finally {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = saved;
  }
});

test("bound demo agents get recognition tuning, never turn_detection, after session.ready", () => {
  const session = new VoiceSession();
  const sent: string[] = [];
  const internals = session as unknown as Record<string, unknown>;
  internals["ws"] = { readyState: 1, send: (m: string) => sent.push(m) };
  internals["boundAgent"] = true;
  const handle = (m: Record<string, unknown>) =>
    (session as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(m));

  handle({ type: "session.ready", session_id: "sess_1" });
  assert.deepEqual(JSON.parse(sent[0]), {
    type: "session.update",
    session: {
      input: {
        transcription_mode: "balanced",
        voice_focus: "near-field",
      },
    },
  });
  handle({ type: "session.updated" });
  // A resume re-emits session.ready; the server keeps config, so no resend.
  handle({ type: "session.ready", session_id: "sess_1" });
  assert.equal(sent.length, 1);
});

test("mid-call updates on the managed path never send a turn-detection object", () => {
  const session = new VoiceSession();
  const sent: string[] = [];
  const internals = session as unknown as Record<string, unknown>;
  internals["ws"] = { readyState: 1, send: (m: string) => sent.push(m) };
  internals["boundAgent"] = true;
  const handle = (m: Record<string, unknown>) =>
    (session as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(m));

  // Bound demo session: recognition tuning on ready, then a whole turn.
  handle({ type: "session.ready", session_id: "sess_managed" });
  handle({ type: "session.updated" });
  handle({ type: "reply.started", reply_id: "r1" });
  handle({ type: "transcript.agent.delta", reply_id: "r1", delta: "Hi there." });
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "transcript.user", item_id: "u1", text: "What does it cost?" });
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "transcript.agent.delta", reply_id: "r2", delta: "Nothing yet." });
  handle({ type: "reply.done", reply_id: "r2", status: "completed" });
  void session.updateConfig({ input: { keyterms: ["Voni"] } });
  handle({ type: "session.updated" });

  const updates = sessionUpdates(sent);
  assert.ok(updates.length >= 2, "the ready tuning and a mid-call push both sent updates");
  assert.deepEqual(
    turnDetectionObjects(updates),
    [],
    "no mid-call update may switch adaptive end-of-turn off",
  );
  for (const update of updates) {
    const input = update["input"];
    assert.equal(
      input !== null && typeof input === "object" && "turn_detection" in input,
      false,
    );
  }
});
