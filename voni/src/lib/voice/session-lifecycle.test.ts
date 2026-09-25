import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInlineSessionUpdate,
  buildResumeMessage,
  decideReconnectOnClose,
  SessionGeneration,
  VOICE_MIC_CONSTRAINTS,
  VoiceSession,
  type TranscriptPartial,
} from "./session";
import {
  buildConversationMessage,
  MICROPHONE_MUTED_CONTEXT,
  MICROPHONE_UNMUTED_CONTEXT,
} from "./context";

// Minimal WebSocket shape: updateConfig only touches readyState + send.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = { OPEN: 1 };

function makeSession(
  handlers: ConstructorParameters<typeof VoiceSession>[0] = {},
  opts: ConstructorParameters<typeof VoiceSession>[1] = {},
) {
  const session = new VoiceSession(handlers, opts);
  const sent: string[] = [];
  (session as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (message: string) => sent.push(message),
  };
  const handle = (message: Record<string, unknown>) =>
    (session as unknown as { handle: (raw: string) => void }).handle(
      JSON.stringify(message),
    );
  const internals = session as unknown as Record<string, unknown>;
  return { session, sent, handle, internals };
}

test("generation tokens invalidate stale work", () => {
  const gen = new SessionGeneration();
  const first = gen.begin();
  assert.equal(gen.isCurrent(first), true);
  // A second start (immediate restart) kills the first.
  const second = gen.begin();
  assert.equal(gen.isCurrent(first), false);
  assert.equal(gen.isCurrent(second), true);
  // Explicit stop kills everything in flight.
  gen.invalidate();
  assert.equal(gen.isCurrent(second), false);
});

test("resume hello carries the retained session id", () => {
  assert.deepEqual(buildResumeMessage("sess_abc"), {
    type: "session.resume",
    session_id: "sess_abc",
  });
});

test("reconnect decision matrix", () => {
  const base = {
    state: "listening" as const,
    explicitStop: false,
    sessionId: "sess_abc",
    attempts: 0,
  };
  assert.equal(decideReconnectOnClose(base), true);
  // Never reconnect after deliberate endings.
  assert.equal(
    decideReconnectOnClose({ ...base, explicitStop: true }),
    false,
  );
  assert.equal(
    decideReconnectOnClose({ ...base, state: "ended" }),
    false,
  );
  // Nothing resumable before the first session.ready.
  assert.equal(decideReconnectOnClose({ ...base, sessionId: null }), false);
  // Attempts are bounded.
  assert.equal(decideReconnectOnClose({ ...base, attempts: 1 }), true);
  assert.equal(decideReconnectOnClose({ ...base, attempts: 2 }), false);
  assert.equal(
    decideReconnectOnClose({ ...base, attempts: 0, maxAttempts: 1 }),
    true,
  );
});

test("session.ready retains the session id for resume", () => {
  const states: string[] = [];
  const { handle, internals } = makeSession({
    onStateChange: (state) => states.push(state),
  });
  handle({ type: "session.ready", session_id: "sess_xyz" });
  assert.equal(internals["sessionId"], "sess_xyz");
  assert.ok(states.includes("listening"));
});

test("delta transcripts are scoped by item, never concatenated", () => {
  const userPartials: TranscriptPartial[] = [];
  const agentPartials: TranscriptPartial[] = [];
  const finalized: { role: string; text: string }[] = [];
  const { handle } = makeSession({
    onUserPartial: (partial) => userPartials.push(partial),
    onAgentPartial: (partial) => agentPartials.push(partial),
    onTranscript: (turn) => finalized.push(turn),
  });
  handle({ type: "transcript.user.delta", item_id: "u1", text: "hel" });
  handle({ type: "transcript.user.delta", item_id: "u1", text: "hello th" });
  // Latest wins per item — the UI must render userPartials.at(-1), not join.
  assert.deepEqual(userPartials, [
    { itemId: "u1", text: "hel" },
    { itemId: "u1", text: "hello th" },
  ]);
  handle({ type: "transcript.agent.delta", reply_id: "r1", text: "Hi" });
  assert.deepEqual(agentPartials, [{ itemId: "r1", text: "Hi" }]);
  // Finalized turns still arrive separately for captions history.
  handle({ type: "transcript.user", text: "hello there" });
  assert.deepEqual(finalized, [{ role: "user", text: "hello there" }]);
});

function fakePlayout(queuedMs = 0) {
  const flushes: number[] = [];
  const playout = {
    play: () => undefined,
    flush: (fadeS?: number) => flushes.push(fadeS ?? -1),
    settled: () => flushes.length > 0,
    queuedMs: () => queuedMs,
    onDrained: undefined as (() => void) | undefined,
  };
  return { playout, flushes };
}

test("barge-in flushes queued speech immediately", () => {
  const { handle, internals } = makeSession();
  const { playout, flushes } = fakePlayout(200);
  internals["playout"] = playout;
  handle({ type: "input.speech.started" });
  assert.deepEqual(flushes, [0.04]);
});

/**
 * Demo tools: the session relays each tool call to the call-scoped demo
 * route. `fetch` is stubbed to answer like the route would.
 */
function withDemoTools(
  internals: Record<string, unknown>,
  session: VoiceSession,
  reply: Record<string, unknown> = { ok: true, data: { ended: true }, hangup: true },
) {
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(reply));
  }) as typeof fetch;
  internals["callToken"] = "call-tok";
  (internals["installDemoTools"] as () => void).call(session);
  return requests;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function endCall(handle: (message: Record<string, unknown>) => void, callId: string, args: Record<string, unknown> = { closing_line: "Goodbye!" }) {
  handle({ type: "tool.call", call_id: callId, name: "end_call", arguments: args });
}

test("demo end_call relays to the call-scoped route and hangs up on the settled reply", async () => {
  const { session, sent, handle, internals } = makeSession();
  internals["playout"] = {
    play: () => undefined,
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  const requests = withDemoTools(internals, session);
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e1");
  await settle();
  assert.equal(requests[0]?.url, "/api/demo/tools/end_call");
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer call-tok",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    toolCallId: "e1",
    arguments: { closing_line: "Goodbye!" },
  });
  const result = sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "tool.result");
  assert.equal(result?.call_id, "e1");
  assert.equal(result?.is_error, false);
  assert.equal(internals["pendingHangup"], true);
  // Playback already settled: the goodbye lands, then the session stops.
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], true);
});

test("a refused demo end_call keeps the caller on the line", async () => {
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session, { ok: false, error: "Say the closing line first.", retryable: true });
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e2", {});
  await settle();
  const result = sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "tool.result");
  assert.equal(result?.is_error, true);
  assert.equal(internals["pendingHangup"], false);
  assert.equal(internals["explicitStop"], false);
});

test("caller speech over the goodbye disarms the hangup", async () => {
  const { session, handle, internals } = makeSession();
  withDemoTools(internals, session);
  internals["playout"] = {
    play: () => undefined,
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e3");
  await settle();
  assert.equal(internals["pendingHangup"], true);
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  assert.equal(internals["explicitStop"], false);
});

test("hangup waits through flapping playback instead of one settled poll", async () => {
  // A momentary dry gap between chunks reports settled once — stopping on
  // that alone chops the goodbye mid-word (heard on jittery mobile links).
  const { session, handle, internals } = makeSession();
  withDemoTools(internals, session);
  let settled = false;
  internals["playout"] = {
    play: () => undefined,
    flush: () => undefined,
    settled: () => settled,
    queuedMs: () => 0,
  };
  internals["lastAudioAt"] = 0;
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e4");
  await settle();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], false);
  settled = true; // dry gap: must not stop on this alone
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(internals["explicitStop"], false);
  settled = false; // more audio arrived: the streak resets
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(internals["explicitStop"], false);
  settled = true; // genuinely drained now
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(internals["explicitStop"], true);
});

test("hangup waits out fresh audio even when playback reports settled", async () => {
  // Audio still traveling to the worklet (pre-roll, output/Bluetooth
  // latency) sounds after the settled report — stop too early and the last
  // word is cut.
  const { session, handle, internals } = makeSession();
  withDemoTools(internals, session);
  internals["playout"] = {
    play: () => undefined,
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e5");
  await settle();
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], false);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(internals["explicitStop"], true);
});

test("session.ended reports durations for acceptance tracking", () => {
  const ended: { durationSeconds: number | null; audioSeconds: number | null }[] =
    [];
  const { handle } = makeSession({
    onSessionEnded: (info) => ended.push(info),
  });
  handle({
    type: "session.ended",
    session_duration_seconds: 42.5,
    audio_duration_seconds: 30.0,
  });
  assert.deepEqual(ended, [{ durationSeconds: 42.5, audioSeconds: 30 }]);
});

test("config updates serialize with one acknowledgement outstanding", async () => {
  const { session, sent, handle } = makeSession();
  const first = session.updateConfig({ input: { volume: 1 } });
  const second = session.updateConfig({ input: { volume: 2 } });
  assert.equal(sent.length, 1);
  handle({ type: "session.updated" });
  await first;
  assert.equal(sent.length, 2);
  handle({ type: "session.updated" });
  await second;
});

test("non-coalescible updates queue behind the in-flight one", async () => {
  const { session, sent, handle } = makeSession();
  const first = session.updateConfig({ input: { volume: 1 } });
  const second = session.updateConfig({ input: { volume: 2 } });
  // Nothing lost: the second waits its turn instead of failing.
  assert.equal(sent.length, 1);
  handle({ type: "session.updated" });
  await first;
  assert.equal(sent.length, 2);
  handle({ type: "session.updated" });
  await second;
});

test("coalescible screen updates collapse to the newest", async () => {
  const { session, sent, handle } = makeSession();
  const first = session.updateConfig({ system_prompt: "screen A" });
  const second = session.updateConfig(
    { system_prompt: "screen B" },
    { coalescible: true },
  );
  const third = session.updateConfig(
    { system_prompt: "screen C" },
    { coalescible: true },
  );
  // Screen B never hits the wire: C supersedes it while it waits.
  await assert.rejects(second, /Superseded/);
  handle({ type: "session.updated" });
  await first;
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes("screen C"));
  assert.ok(!sent[1].includes("screen B"));
  handle({ type: "session.updated" });
  await third;
});

test("timed-out acknowledgement marks config uncertain until resync", async () => {
  const uncertainty: boolean[] = [];
  const { session, internals, handle } = makeSession(
    { onConfigUncertainty: (uncertain) => uncertainty.push(uncertain) },
    { updateTimeoutMs: 20 },
  );
  await assert.rejects(
    session.updateConfig({ input: { volume: 1 } }),
    /timed out/,
  );
  assert.equal(internals["configSynced"], false);
  assert.deepEqual(uncertainty, [true]);
  // A later successful update clears the flag so tools re-enable.
  const next = session.updateConfig({ input: { volume: 2 } });
  handle({ type: "session.updated" });
  await next;
  assert.equal(internals["configSynced"], true);
  assert.deepEqual(uncertainty, [true, false]);
});

test("navigation drops queued updates but lets the in-flight one land", async () => {
  const { session, sent, handle } = makeSession();
  const first = session.updateConfig({ system_prompt: "old screen" });
  const second = session.updateConfig(
    { system_prompt: "new screen" },
    { coalescible: true },
  );
  session.invalidatePendingUpdates();
  await assert.rejects(second, /navigation/);
  // The in-flight update still resolves — no dangling promise.
  handle({ type: "session.updated" });
  await first;
  assert.equal(sent.length, 1);
});

test("session.ready reports its id and probes the moment", () => {
  const ready: string[] = [];
  const probes: { kind: string; sessionId: string | null; queued: number }[] = [];
  const { handle } = makeSession({
    onSessionReady: (id) => ready.push(id),
    onAudioProbe: (event) => probes.push(event),
  });
  handle({ type: "session.ready", session_id: "sess_probe" });
  assert.deepEqual(ready, ["sess_probe"]);
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.kind, "ready");
  assert.equal(probes[0]?.sessionId, "sess_probe");
  assert.equal(probes[0]?.queued, 0);
});

test("barge-in probes the cut before flushing", () => {
  const kinds: string[] = [];
  const queuedCounts: number[] = [];
  const { handle, internals } = makeSession({
    onAudioProbe: (event) => {
      kinds.push(event.kind);
      queuedCounts.push(event.queued);
    },
  });
  const { playout, flushes } = fakePlayout(120);
  internals["playout"] = playout;
  handle({ type: "input.speech.started" });
  assert.equal(flushes.length, 1);
  // The cut is observed first (120ms buffered), then the flush reports the drop.
  assert.deepEqual(kinds, ["barge-in", "flush"]);
  assert.deepEqual(queuedCounts, [120, 120]);
});

test("interrupted reply probes the cut before flushing", () => {
  const kinds: string[] = [];
  const { handle, internals } = makeSession({
    onAudioProbe: (event) => kinds.push(event.kind),
  });
  internals["playout"] = fakePlayout().playout;
  handle({ type: "reply.done", status: "interrupted", reply_id: "r1" });
  assert.deepEqual(kinds, ["reply-cut", "flush"]);
  // A completed reply probes nothing — no cut happened.
  handle({ type: "reply.done", status: "completed", reply_id: "r2" });
  assert.deepEqual(kinds, ["reply-cut", "flush"]);
});

test("reply audio goes to the playout at 24 kHz", () => {
  const { handle, internals } = makeSession();
  const played: [number, number][] = [];
  internals["playout"] = {
    ...fakePlayout().playout,
    play: (pcm: Uint8Array, rate: number) => played.push([pcm.length, rate]),
  };
  handle({ type: "reply.audio", data: Buffer.from(new Uint8Array(480)).toString("base64") });
  assert.deepEqual(played, [[480, 24000]]);
});

test("first session.update ships recognition tuning, not defaults", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "prompt",
    greeting: "Hey, I'm listening.",
    voiceId: "ivy",
    transcriptionPrompt: "A user giving voice commands.",
    keyterms: ["Voni", "Voice copilot"],
    transcriptionMode: "min_latency",
    turnDetection: { min_silence: 500, max_silence: 2000, interrupt_response: true, interruption_delay: 0 },
    tools: [],
  });
  const input = update["input"] as Record<string, unknown>;
  assert.equal(update["system_prompt"], "prompt");
  assert.equal(update["greeting"], "Hey, I'm listening.");
  assert.equal(input["transcription_mode"], "min_latency");
  assert.equal(input["transcription_prompt"], "A user giving voice commands.");
  assert.deepEqual(input["keyterms"], ["Voni", "Voice copilot"]);
  assert.deepEqual(input["turn_detection"], {
    min_silence: 500,
    max_silence: 2000,
    interrupt_response: true,
    interruption_delay: 0,
  });
});

test("first session.update omits empty recognition keys", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "prompt",
    greeting: "Hey, I'm listening.",
    voiceId: "ivy",
    keyterms: [],
    languageCodes: [],
    tools: [],
  });
  const input = update["input"] as Record<string, unknown>;
  assert.equal(input["transcription_mode"], "max_accuracy");
  assert.equal(input["voice_focus"], "near-field");
  assert.ok(!("keyterms" in input));
  assert.ok(!("language_codes" in input));
  assert.ok(!("tools" in (update as Record<string, unknown>)));
});

test("browser capture enables echo cancellation and automatic gain without browser denoising", () => {
  assert.deepEqual(VOICE_MIC_CONSTRAINTS, {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
  });
});

test("sensitive capture widens once and restores the exact prior pacing", async () => {
  const { session, sent, handle, internals } = makeSession();
  internals["activeTurnDetection"] = {
    min_silence: 500,
    max_silence: 2000,
    interrupt_response: true,
    interruption_delay: 0,
  };
  const prepare = (
    session as unknown as {
      prepareSensitiveCapture: () => Promise<unknown>;
    }
  ).prepareSensitiveCapture.bind(session);

  const prepared = prepare();
  assert.deepEqual(JSON.parse(sent[0]), {
    type: "session.update",
    session: {
      input: {
        turn_detection: {
          min_silence: 1400,
          max_silence: 4000,
          interrupt_response: true,
          interruption_delay: 0,
        },
      },
    },
  });
  handle({ type: "session.updated" });
  await prepared;

  handle({ type: "transcript.user", item_id: "u-sensitive", text: "value" });
  assert.deepEqual(JSON.parse(sent[1]), {
    type: "session.update",
    session: {
      input: {
        turn_detection: {
          min_silence: 500,
          max_silence: 2000,
          interrupt_response: true,
          interruption_delay: 0,
        },
      },
    },
  });
  handle({ type: "session.updated" });
  assert.deepEqual(internals["activeTurnDetection"], {
    min_silence: 500,
    max_silence: 2000,
    interrupt_response: true,
    interruption_delay: 0,
  });
});

test("muted mic drops frames without tearing down the call", () => {
  const { session, sent, handle } = makeSession();
  handle({ type: "session.ready", session_id: "sess_mute" });
  const ingest = (session as unknown as { ingestAudio: (data: ArrayBuffer) => void }).ingestAudio.bind(session);
  ingest(new ArrayBuffer(4));
  assert.equal(sent.length, 1);
  session.setInputMuted(true);
  ingest(new ArrayBuffer(4));
  assert.deepEqual(JSON.parse(sent[1]), {
    type: "conversation.message",
    role: "system",
    content: MICROPHONE_MUTED_CONTEXT,
  });
  assert.equal(sent.length, 2);
  // Unmuting resumes the same session — no reconnect, no new greeting.
  session.setInputMuted(false);
  ingest(new ArrayBuffer(4));
  assert.deepEqual(JSON.parse(sent[2]), {
    type: "conversation.message",
    role: "system",
    content: MICROPHONE_UNMUTED_CONTEXT,
  });
  assert.equal(sent.length, 4);
  assert.ok(!sent.some((message) => message.includes("reply.create")));
});

test("managed context serializes as a hidden system conversation message", () => {
  assert.deepEqual(buildConversationMessage("context"), {
    type: "conversation.message",
    role: "system",
    content: "context",
  });
});

test("session.ready marks timing once per start", () => {
  const marks: string[] = [];
  const { handle } = makeSession({ onTiming: (m) => marks.push(m) });
  // A resume re-emits session.ready on the same conversation — still one mark.
  handle({ type: "session.ready", session_id: "sess_timing" });
  handle({ type: "session.ready", session_id: "sess_timing" });
  assert.equal(marks.filter((m) => m === "sessionReady").length, 1);
});

test("WS timing marks fire once per start", () => {
  const marks: string[] = [];
  const { handle, internals } = makeSession({ onTiming: (m) => marks.push(m) });
  handle({ type: "session.ready", session_id: "sess_timing" });
  const session = internals as unknown as { resolveUpdate: () => void; updateInFlight: unknown };
  // Simulate an in-flight config update acking once.
  session.updateInFlight = { session: {}, coalescible: false, started: true, timer: null, resolve: () => undefined, reject: () => undefined };
  (internals as unknown as { resolveUpdate: () => void }).resolveUpdate?.();
  handle({ type: "reply.audio", data: "AAAA" });
  handle({ type: "reply.audio", data: "BBBB" });
  assert.ok(marks.includes("sessionReady"), `got ${JSON.stringify(marks)}`);
  assert.equal(marks.filter((m) => m === "firstUpdateAck").length, 1);
  assert.equal(marks.filter((m) => m === "greetingAudio").length, 1);
});
