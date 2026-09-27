import test from "node:test";
import assert from "node:assert/strict";
import type { AudioGraph } from "./mic-capture";
import {
  buildInlineSessionUpdate,
  buildResumeMessage,
  decideReconnectOnClose,
  SessionGeneration,
  softLimit,
  stripSpokenToolCall,
  VOICE_MIC_CONSTRAINTS,
  VoiceSession,
  CAPTION_MS_PER_CHAR,
  heardWords,
  type TranscriptPartial,
} from "./session";
import {
  buildConversationMessage,
  HOLD_OFF_CONTEXT,
  HOLD_ON_CONTEXT,
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

/** A session mid-reply: the agent holds the floor with audio playing. */
function midReply(
  opts: ConstructorParameters<typeof VoiceSession>[1] = {},
  handlers: ConstructorParameters<typeof VoiceSession>[0] = {},
) {
  const made = makeSession(handlers, opts);
  const played: string[] = [];
  const flushes: number[] = [];
  let settled = false;
  made.internals["playout"] = {
    play: () => {
      played.push("chunk");
      settled = false;
    },
    flush: (fadeS?: number) => {
      flushes.push(fadeS ?? -1);
      settled = true;
    },
    settled: () => settled,
    queuedMs: () => (settled ? 0 : 800),
  };
  made.handle({ type: "session.ready", session_id: "s1" });
  made.handle({ type: "reply.started", reply_id: "r1" });
  made.handle({ type: "transcript.agent.delta", reply_id: "r1", text: "I'd handle booking and reminders" });
  made.handle({ type: "reply.audio", reply_id: "r1", data: "" });
  const messages = () => made.sent.map((raw) => JSON.parse(raw));
  const replyCreates = () => messages().filter((m) => m.type === "reply.create");
  /** The server cuts the agent, then the caller's words land. */
  const serverCut = (text: string) => {
    made.handle({ type: "input.speech.started" });
    made.handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
    made.handle({ type: "input.speech.stopped" });
    made.handle({ type: "transcript.user", item_id: "u1", text });
  };
  return { ...made, played, flushes, replyCreates, messages, serverCut };
}

test("speech starting over the agent never cuts it locally", () => {
  const { handle, flushes } = midReply();
  handle({ type: "input.speech.started" });
  assert.deepEqual(flushes, [], "the server decides; its interrupted reply.done flushes");
});

test("a cut caused by filler resumes, superseding the server's own answer", () => {
  const events: string[] = [];
  const { serverCut, handle, replyCreates, played } = midReply({}, {
    onBargeIn: (event) => events.push(event.verdict),
  });
  serverCut("Okaay so");
  handle({ type: "reply.started", reply_id: "r2" }); // the server answers the filler
  const [create] = replyCreates();
  assert.match(create.instructions, /Pick up where you left off/);
  assert.match(create.instructions, /booking and reminders/, "knows where it was cut");
  const before = played.length;
  handle({ type: "reply.audio", reply_id: "r2", data: "" });
  assert.equal(played.length, before, "the superseded answer never plays");
  handle({ type: "reply.done", reply_id: "r2", status: "completed" });
  handle({ type: "reply.started", reply_id: "r3" });
  handle({ type: "reply.audio", reply_id: "r3", data: "" });
  assert.equal(played.length, before + 1, "the resumed reply plays");
  assert.deepEqual(events, ["ignore"]);
});

test("a resume is sent even if the server never answers the filler", async () => {
  const { serverCut, replyCreates } = midReply();
  serverCut("mm-hmm");
  assert.deepEqual(replyCreates(), []);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.match(replyCreates()[0].instructions, /Pick up where you left off/);
});

test("a cut with no words after it (noise) resumes after ~0.8s, without \"as I was saying\"", async () => {
  // A wheel click or a cough reaches the mic, the server cuts the reply, and
  // no transcript ever follows: Voni used to wait forever in silence.
  const { handle, replyCreates } = midReply();
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(replyCreates(), [], "gives real words time to land");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const [create] = replyCreates();
  assert.match(create?.instructions ?? "", /Pick up where you left off/);
  assert.match(create.instructions, /booking and reminders/);
  assert.match(create.instructions, /without repeating those words or saying "as I was saying"/);
  assert.doesNotMatch(create.instructions, /only said ""/);
});

/** A session whose playout reports played audio, like the real worklet. */
function pacedReply(handlers: ConstructorParameters<typeof VoiceSession>[0] = {}) {
  const made = makeSession(handlers);
  let sent = 0;
  let consumed = 0;
  const flushes: number[] = [];
  made.internals["playout"] = {
    play: () => {
      sent += 24_000; // one second per chunk
    },
    flush: (fadeS?: number) => flushes.push(fadeS ?? -1),
    settled: () => false,
    queuedMs: () => 0,
    sentSamples: () => sent,
    consumedSamples: () => consumed,
  };
  made.handle({ type: "session.ready", session_id: "s1" });
  const playMs = (ms: number) => {
    consumed += (ms / 1000) * 24_000;
  };
  return { ...made, flushes, playMs };
}

test("heardWords: a word shows once its start has played", () => {
  assert.equal(heardWords("Hi there friend", 0), "Hi");
  assert.equal(heardWords("Hi there friend", 3 * CAPTION_MS_PER_CHAR), "Hi there");
  assert.equal(heardWords("Hi there friend", 60_000), "Hi there friend");
  assert.equal(heardWords("", 1000), "");
});

test("agent captions follow the played audio, not the words' early arrival", async () => {
  const partials: TranscriptPartial[] = [];
  const { handle, playMs, session } = pacedReply({ onAgentPartial: (p) => partials.push(p) });
  const lastText = () => partials[partials.length - 1]?.text;
  handle({ type: "reply.started", reply_id: "r1" });
  // The platform sends the whole line up front…
  for (const word of "I can take your bookings every single day".split(" ")) {
    handle({ type: "transcript.agent.delta", reply_id: "r1", delta: word });
  }
  assert.deepEqual(partials, [], "nothing before its audio");
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lastText(), "I", "only the first word at the start of playback");
  playMs(8 * CAPTION_MS_PER_CHAR);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lastText(), "I can take");
  playMs(60_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lastText(), "I can take your bookings every single day");
  const count = partials.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(partials.length, count, "the ticker stops once the line has played");
  await session.stop();
});

test("a cut line keeps only the heard words, for the resume and the caption", async () => {
  const partials: TranscriptPartial[] = [];
  const { handle, playMs, sent, flushes } = pacedReply({ onAgentPartial: (p) => partials.push(p) });
  handle({ type: "reply.started", reply_id: "r1" });
  handle({ type: "transcript.agent.delta", reply_id: "r1", text: "I'd handle booking and reminders for you" });
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  playMs(14 * CAPTION_MS_PER_CHAR);
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  assert.equal(flushes.length, 1);
  playMs(60_000); // the flush drops the rest; the worklet counts it as consumed
  await new Promise((resolve) => setTimeout(resolve, 1000)); // no words: the noise resume
  const create = sent.map((raw) => JSON.parse(raw)).find((m) => m.type === "reply.create");
  assert.match(create?.instructions ?? "", /heard you up to: "I'd handle booking"/);
  assert.doesNotMatch(create.instructions, /reminders/);
  assert.ok(partials.every((p) => !p.text.includes("reminders")), "the caption never showed unheard words");
});

test("words after a cut are speech: no resume even when the final transcript lands late", async () => {
  // The final can come well after the last partial while the platform waits
  // for the caller to finish; resuming then talked over a real sentence.
  const { handle, replyCreates } = midReply();
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  handle({ type: "transcript.user.delta", item_id: "u1", text: "What does it" });
  await new Promise((resolve) => setTimeout(resolve, 2500)); // caller pauses; no final yet
  assert.deepEqual(replyCreates(), []);
});

test("a noise cut into the goodbye resumes it and still hangs up after", async () => {
  const { session, handle, internals, replyCreates } = midReply();
  withDemoTools(internals, session);
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  internals["lastAudioAt"] = 0;
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e9");
  await settle();
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "bye", status: "interrupted" }); // a cough, no words
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.match(replyCreates().at(-1)?.instructions ?? "", /Pick up where you left off/);
  assert.equal(internals["explicitStop"], false);
  handle({ type: "reply.started", reply_id: "bye2" });
  handle({ type: "reply.audio", reply_id: "bye2", data: "" });
  handle({ type: "reply.done", reply_id: "bye2", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(internals["explicitStop"], true, "the finished goodbye hangs up");
});

test("a caller still talking after a cut is never resumed over", async () => {
  const { handle, replyCreates } = midReply();
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    handle({ type: "transcript.user.delta", item_id: "u1", text: "so what I really want ".repeat(i + 1) });
  }
  assert.deepEqual(replyCreates(), []);
  handle({ type: "transcript.user", item_id: "u1", text: "So what I really want is pricing." });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.deepEqual(replyCreates(), [], "a real point is answered by the server, not resumed");
});

test("replaceNextReply: the platform's next reply is dropped and ours replaces it; the lead-in keeps playing", async () => {
  const { session, handle, replyCreates, played, flushes } = midReply();
  // The lead-in (r1) is still playing when the demo asks for the invite.
  session.replaceNextReply("Invite them now.");
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "auto" }); // the platform's own reply to the tool result
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["Invite them now."]);
  assert.deepEqual(flushes, [], "the lead-in's queued audio is never cut");
  const before = played.length;
  handle({ type: "reply.audio", reply_id: "auto", data: "" });
  assert.equal(played.length, before, "the replaced reply never plays");
  handle({ type: "reply.done", reply_id: "auto", status: "completed" });
  handle({ type: "reply.started", reply_id: "ours" });
  handle({ type: "reply.audio", reply_id: "ours", data: "" });
  assert.equal(played.length, before + 1, "ours plays");
});

test("replaceNextReply resends ours when the platform ignored it (nothing starts after the replaced reply)", async () => {
  // Measured live: a reply.create sent at the very start of the platform's
  // reply was sometimes ignored; that reply ran on (and was dropped), so the
  // visitor would hear nothing.
  const { session, handle, replyCreates } = midReply();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  session.replaceNextReply("Invite them now.");
  handle({ type: "reply.started", reply_id: "auto" });
  handle({ type: "reply.done", reply_id: "auto", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(replyCreates().length, 1, "gives ours a moment to start");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["Invite them now.", "Invite them now."]);
  handle({ type: "reply.started", reply_id: "ours" });
  handle({ type: "reply.done", reply_id: "ours", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(replyCreates().length, 2, "never a third");
});

test("replaceNextReply does not resend when the supersede took (the platform ends its reply, then starts ours)", async () => {
  // Measured live order: reply.done(replaced) and reply.started(ours) in the same millisecond, done first.
  const { session, handle, replyCreates } = midReply();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  session.replaceNextReply("Invite them now.");
  handle({ type: "reply.started", reply_id: "auto" });
  handle({ type: "reply.done", reply_id: "auto", status: "completed" });
  handle({ type: "reply.started", reply_id: "ours" });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(replyCreates().length, 1);
});

test("replaceNextReply sends ours anyway when the platform starts no reply", async () => {
  const { session, handle, replyCreates } = midReply();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  session.replaceNextReply("Invite them now.", 300);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["Invite them now."]);
});

test("replaceNextReply's fallback never cuts the line still playing: it waits for reply.done", async () => {
  const { session, handle, replyCreates } = midReply();
  session.replaceNextReply("Invite them now.", 300);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(replyCreates(), [], "the lead-in is still going");
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["Invite them now."]);
});

test("steering after a cut is answered as a normal turn", async () => {
  const events: string[] = [];
  const { serverCut, handle, replyCreates } = midReply({}, { onBargeIn: (e) => events.push(e.verdict) });
  serverCut("Wait, stop.");
  handle({ type: "reply.started", reply_id: "r2" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(replyCreates(), []);
  assert.deepEqual(events, ["yield"]);
});

test("Jev decides ambiguous cut-ins: an aside resumes, a real point is answered", async () => {
  const aside = midReply({ judgeBargeIn: async () => "keep" });
  aside.serverCut("We're a bakery actually.");
  aside.handle({ type: "reply.started", reply_id: "r2" });
  await settle();
  assert.match(aside.replyCreates()[0].instructions, /We're a bakery actually\./);

  const real = midReply({ judgeBargeIn: async () => "yield" });
  real.serverCut("What about pricing?");
  real.handle({ type: "reply.started", reply_id: "r2" });
  await settle();
  assert.deepEqual(real.replyCreates(), []);
});

test("replies and questions never touch turn detection mid-call", () => {
  const { handle, messages } = midReply();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "transcript.agent.delta", reply_id: "r2", delta: "Want details?" });
  assert.deepEqual(messages().filter((m) => m.type === "session.update"), []);
});

test("demo end_call relays to the call-scoped route and hangs up once the goodbye drains", async () => {
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
  // Playback already settled: stop without waiting for the model's empty
  // post-result reply (it used to add ~2s of dead air).
  assert.equal(internals["explicitStop"], true);
});

test("agent mode without a call token answers end_call locally", async () => {
  const { session, sent, handle, internals } = makeSession();
  // No callToken set: the local fallback answers through the same executor
  // as the demo route, so the tool call is not left unanswered.
  (internals["installLocalEndCall"] as () => void).call(session);
  handle({ type: "session.ready", session_id: "s0" });
  endCall(handle, "e0");
  await settle();
  const result = sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "tool.result");
  assert.equal(result?.call_id, "e0");
  assert.equal(result?.is_error, false);
  // Nothing left to play: the result itself hangs up.
  assert.equal(internals["explicitStop"], true);
});

test("a refused demo end_call keeps the caller on the line", async () => {  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session, { ok: false, error: "Say the closing line first.", retryable: true });
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e2", {});
  await settle();
  const result = sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "tool.result");
  assert.equal(result?.is_error, true);
  assert.equal(internals["pendingEndCall"], false);
  assert.equal(internals["explicitStop"], false);
});

test("a cut into the goodbye takes the floor back", async () => {
  const { session, handle, internals, serverCut } = midReply();
  withDemoTools(internals, session);
  endCall(handle, "e3");
  await settle();
  serverCut("Wait, no, one more thing.");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(internals["explicitStop"], false);
});

test("an end_call issued before the goodbye's audio waits for that reply to finish", async () => {
  // sess_c477d8f8: the model called end_call before speaking its goodbye in
  // the same reply. The result came back at once, playback was idle and the
  // last audio was seconds old, so the drain passed and the goodbye was cut
  // after "No problem." The result still goes back at once (the server waits
  // for it before speaking); only the hang-up waits for the reply.
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session);
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  internals["lastAudioAt"] = 0;
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e6");
  await settle();
  const results = () => sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result" && m.call_id === "e6");
  // Measured live (eval bye-audio): a result sent mid-goodbye makes the
  // platform cut the goodbye's audio at ~0.7s and speak it again in a new
  // reply (which the session drops). Held to reply.done, the goodbye plays whole.
  assert.equal(results().length, 0, "the result waits for the goodbye reply to finish");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(internals["explicitStop"], false, "never hangs up while the goodbye reply is still streaming");
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "reply.done", reply_id: "bye", status: "completed" });
  assert.equal(results().length, 1, "sent at the goodbye's reply.done");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(internals["explicitStop"], true, "then drains and hangs up");
});

test("a caller cutting into the goodbye: the held result is still sent, and the call stays up", async () => {
  // Measured live (hang-up-over): dropping the held result left the platform
  // waiting until the tool timed out (a 14s hang-up).
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session);
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e8");
  await settle();
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "bye", status: "interrupted" });
  assert.equal(sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result").length, 1, "the platform gets its result");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(internals["explicitStop"], false, "the caller took the floor back: no hang-up");
});

test("a held end_call result is released when the platform waits for it (no goodbye audio for 2s)", async () => {
  // Measured 1 in 10 live: the platform sometimes holds the goodbye reply
  // open until the result arrives; holding the result then stalled until the
  // tool's timeout (a 12.6s hang-up).
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session);
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e7");
  await settle();
  const results = () => sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(results().length, 0, "still held: the goodbye may be slow to start");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(results().length, 1, "released: the platform is waiting on us");
});

test("a demo tool's result waits until Voni's line has played, then goes out", async () => {
  // Live test 2026-09-27: send_code_reply's result landed mid "Found it…
  // sending…", the platform cut the line and Voni said it again.
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session, { ok: true, data: { sent: true } });
  let settled = false;
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => settled, queuedMs: () => 0 };
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "r1" });
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  handle({ type: "tool.call", call_id: "t1", name: "send_code_reply", arguments: { warm_line: "Hi!" } });
  await settle();
  const results = () => sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result" && m.call_id === "t1");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(results().length, 0, "held while the line is still playing");
  settled = true;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(results().length, 1, "sent once the line has played out");
});

test("a demo tool called without a word is released quickly", async () => {
  const { session, sent, handle, internals } = makeSession();
  withDemoTools(internals, session, { ok: true, data: { status: "wrong" } });
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "tool.call", call_id: "t2", name: "check_code", arguments: { code: "1234" } });
  await settle();
  const results = () => sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result" && m.call_id === "t2");
  assert.equal(results().length, 0);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(results().length, 1, "nothing to cut: no dead air waiting for 3s");
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
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  endCall(handle, "e5");
  await settle();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], false);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(internals["explicitStop"], true);
});

test("stop ends the call at once, session.end before the socket closes", async () => {
  const order: string[] = [];
  const states: string[] = [];
  const { session, internals } = makeSession({ onStateChange: (state) => states.push(state) });
  internals["ws"] = {
    readyState: 1,
    send: (raw: string) => order.push(JSON.parse(raw).type),
    close: () => order.push("close"),
  };
  await session.stop();
  assert.deepEqual(order, ["session.end", "close"]);
  assert.equal(states.at(-1), "ended", "no 2s wait for a session.ended nobody hears");
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
  assert.equal(input["transcription_mode"], "balanced");
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

test("held call drops frames with hold context, then resumes on the same session", () => {
  const { session, sent, handle } = makeSession();
  handle({ type: "session.ready", session_id: "sess_hold" });
  const ingest = (session as unknown as { ingestAudio: (data: ArrayBuffer) => void }).ingestAudio.bind(session);
  ingest(new ArrayBuffer(4));
  assert.equal(sent.length, 1);
  session.setOnHold(true);
  ingest(new ArrayBuffer(4));
  assert.deepEqual(JSON.parse(sent[1]), {
    type: "conversation.message",
    role: "system",
    content: HOLD_ON_CONTEXT,
  });
  assert.equal(sent.length, 2);
  session.setOnHold(false);
  ingest(new ArrayBuffer(4));
  assert.deepEqual(JSON.parse(sent[2]), {
    type: "conversation.message",
    role: "system",
    content: HOLD_OFF_CONTEXT,
  });
  assert.equal(sent.length, 4);
  assert.ok(!sent.some((message) => message.includes("reply.create")));
});

test("hold and mute overlap: frames flow only when neither is set", () => {
  const { session, sent, handle } = makeSession();
  handle({ type: "session.ready", session_id: "sess_overlap" });
  const ingest = (session as unknown as { ingestAudio: (data: ArrayBuffer) => void }).ingestAudio.bind(session);
  const audioFrames = () =>
    sent.filter((raw) => JSON.parse(raw).type === "input.audio").length;
  ingest(new ArrayBuffer(4));
  assert.equal(audioFrames(), 1);
  session.setInputMuted(true);
  session.setOnHold(true);
  session.setOnHold(false);
  ingest(new ArrayBuffer(4));
  assert.equal(audioFrames(), 1, "still muted: no audio frame reaches the wire");
  session.setInputMuted(false);
  ingest(new ArrayBuffer(4));
  assert.equal(audioFrames(), 2, "unmuted and off hold: frames flow again");
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

test("agent word deltas accumulate into the heard line", () => {
  const partials: string[] = [];
  const { handle } = makeSession({ onAgentPartial: (p) => partials.push(p.text) });
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "reply.started", reply_id: "r1" });
  for (const word of ["Hi,", "I'm", "Voni."]) handle({ type: "transcript.agent.delta", reply_id: "r1", delta: word });
  assert.deepEqual(partials, ["Hi,", "Hi, I'm", "Hi, I'm Voni."]);
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "transcript.agent.delta", reply_id: "r2", delta: "Next" });
  assert.equal(partials.at(-1), "Next", "a new reply starts a new line");
});

test("stripSpokenToolCall removes a spoken tool name and flags the hangup", () => {
  assert.deepEqual(stripSpokenToolCall("Understood. Goodbye! end_call"), {
    text: "Understood. Goodbye!",
    endCall: true,
  });
  assert.deepEqual(stripSpokenToolCall('Bye now! end_call{"closing_line": "Bye now!"}'), {
    text: "Bye now!",
    endCall: true,
  });
  assert.deepEqual(stripSpokenToolCall("We can end the call whenever you like."), {
    text: "We can end the call whenever you like.",
    endCall: false,
  });
});

test("a spoken end_call arms the hangup and never reaches the caption", () => {
  const captions: string[] = [];
  const partials: string[] = [];
  let ended = 0;
  const { handle, internals } = makeSession({
    onTranscript: (turn) => captions.push(turn.text),
    onAgentPartial: (partial) => partials.push(partial.text),
    onEndCall: () => (ended += 1),
  });
  internals["playout"] = {
    play: () => undefined,
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "transcript.agent.delta", reply_id: "r1", text: "Goodbye! end_call" });
  handle({ type: "transcript.agent", reply_id: "r1", text: "Goodbye! end_call" });
  assert.deepEqual(partials, ["Goodbye!"]);
  assert.deepEqual(captions, ["Goodbye!"]);
  assert.equal(ended, 1);
  assert.equal(internals["pendingEndCall"], true);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], true);
});

test("an end_call tool call signals the end before its result lands", () => {
  let ended = 0;
  const { session, handle, internals } = makeSession({ onEndCall: () => (ended += 1) });
  withDemoTools(internals, session);
  handle({ type: "session.ready", session_id: "s1" });
  endCall(handle, "e6");
  assert.equal(ended, 1, "fires synchronously on tool.call");
  // A later spoken echo of the same goodbye must not double-signal.
  handle({ type: "transcript.agent", reply_id: "r1", text: "Goodbye! end_call" });
  assert.equal(ended, 1);
});

test("spoken name then a real end_call waits for the tool result", async () => {
  let ended = 0;
  const { session, sent, handle, internals } = makeSession({ onEndCall: () => (ended += 1) });
  internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => true, queuedMs: () => 0 };
  withDemoTools(internals, session);
  handle({ type: "session.ready", session_id: "s1" });
  handle({ type: "transcript.agent", reply_id: "r1", text: "Bye! end_call" });
  endCall(handle, "e7");
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  assert.equal(internals["explicitStop"], false, "never closes before the result is sent");
  await settle();
  assert.ok(sent.some((raw) => JSON.parse(raw).type === "tool.result"));
  assert.equal(internals["explicitStop"], true, "the result itself hangs up");
  assert.equal(ended, 1);
});

test("after the goodbye, no other reply is heard, captioned, or requested", () => {
  const captions: string[] = [];
  const { session, handle, internals, played, replyCreates } = midReply({}, {
    onTranscript: (turn) => captions.push(turn.text),
  });
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e8", { closing_line: "Okay, bye!" });
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "transcript.agent", reply_id: "bye", text: "Okay, bye!" });
  handle({ type: "reply.done", reply_id: "bye", status: "completed" });
  const before = played.length;
  // The model speaks again once end_call returns: drop it whole.
  handle({ type: "reply.started", reply_id: "after" });
  handle({ type: "reply.audio", reply_id: "after", data: "" });
  handle({ type: "transcript.agent", reply_id: "after", text: "I'll let you go for now." });
  assert.equal(played.length, before, "the post-goodbye reply never plays");
  assert.deepEqual(captions, ["Okay, bye!"]);
  session.requestReply("The caller is still off-track. Close politely.");
  assert.deepEqual(replyCreates(), [], "nothing supersedes the goodbye");
});

test("a superseded reply's caption is only what the caller heard", () => {
  const captions: string[] = [];
  const { serverCut, handle } = midReply({}, {
    onTranscript: (turn) => turn.role === "agent" && captions.push(turn.text),
  });
  serverCut("Okaay so");
  handle({ type: "reply.started", reply_id: "r2" }); // superseded before a word played
  handle({ type: "transcript.agent", reply_id: "r2", text: "Sure! So what does your business do?" });
  assert.deepEqual(captions, [], "nothing of r2 was heard");
});

test("start connects as soon as the graph is ready (no setup awaits in between)", async () => {
  // Regression: an awaited speaker-enable once sat between graph-ready and
  // connect(), delaying session establishment — and everything timed off it
  // (ringback, greeting) — behind device enumeration. Optional output setup
  // must be fire-and-forget; connect() follows the graph synchronously.
  const g = globalThis as unknown as Record<string, unknown>;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWebSocket = g.WebSocket;
  const constructed: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
    },
    configurable: true,
  });
  g.WebSocket = class {
    static OPEN = 1;
    constructor(url: unknown) {
      constructed.push(String(url));
    }
    addEventListener() {}
    send() {}
    close() {}
  };
  try {
    let resolveGraph!: (graph: AudioGraph) => void;
    const graphReady = new Promise<AudioGraph>((r) => (resolveGraph = r));
    const session = new VoiceSession(
      {},
      {
        micOwner: "start-ordering-test",
        startGraph: () => graphReady,
      },
    );
    const started = session.start({ mode: "agent", agentId: "" }, async () => ({
      token: "tok",
      agentId: "a1",
    }));
    // Token + mic settle while the graph is pending: no connection yet.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(constructed.length, 0);
    resolveGraph({
      audioCtx: null,
      worklet: null,
      playout: {
        play() {},
        flush() {},
        settled: () => true,
        queuedMs: () => 0,
      },
      stop() {},
    } as unknown as AudioGraph);
    await started;
    // Graph resolved → connected, with no further awaits in between.
    assert.equal(constructed.length, 1);
    assert.match(constructed[0] ?? "", /agents\.assemblyai\.com/);
    await session.stop();
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    g.WebSocket = savedWebSocket;
  }
});

test("pre-ready mic frames probe an input-drop instead of vanishing silently", () => {
  const probes: { kind: string; dropped?: number }[] = [];
  const { session } = makeSession({ onAudioProbe: (e) => probes.push(e) });
  const ingest = (session as unknown as { ingestAudio: (data: ArrayBuffer) => void }).ingestAudio.bind(session);
  ingest(new ArrayBuffer(4));
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.kind, "input-drop");
  assert.equal(probes[0]?.dropped, 1);
});

test("inline session update pins loudest output volume", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "prompt",
    greeting: "Hi.",
    voiceId: "lola",
    tools: [],
  });
  assert.deepEqual(update["output"], { voice: "lola", volume: 100 });
});

test("playback gain scales agent audio under a soft knee, never a hard clamp", () => {
  const { handle, internals } = makeSession();
  const played: { len: number; peak: number }[] = [];
  internals["playout"] = {
    play: (pcm: Uint8Array) => {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
      }
      played.push({ len: pcm.length, peak });
    },
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  handle({ type: "session.ready", session_id: "s-gain" });
  const session = internals as unknown as {
    setOutputGain: (gain: number) => void;
  };
  session.setOutputGain(2.0);
  // 1000 * 2 = 2000 stays linear; 20000 * 2 bends under full scale.
  const pcm = new Uint8Array([0xe8, 0x03, 0x20, 0x4e]);
  const base64 = Buffer.from(pcm).toString("base64");
  handle({ type: "reply.audio", reply_id: "r1", data: base64 });
  assert.equal(played.length, 1);
  assert.ok((played[0]?.peak ?? 0) > 30000 && (played[0]?.peak ?? 0) <= 32767, `peak ${played[0]?.peak}`);
});

test("softLimit: linear below the knee, smooth and bounded above it", () => {
  assert.equal(softLimit(2000), 2000);
  assert.equal(softLimit(-2000), -2000);
  assert.ok(softLimit(40000) < 32767 && softLimit(40000) > 30000);
  assert.ok(softLimit(1e6) <= 32767);
  assert.ok(softLimit(-1e6) >= -32767);
  // Monotonic: louder in never comes out quieter (no fold-back distortion).
  let last = -Infinity;
  for (let x = 0; x <= 130000; x += 500) {
    assert.ok(softLimit(x) >= last);
    last = softLimit(x);
  }
  // Continuous at the knee: no step where the curve changes.
  const knee = 0.8 * 32767;
  assert.ok(Math.abs(softLimit(knee + 1) - softLimit(knee)) < 2);
});

// ── Hold: park, resume, reload resume, background wake ───────────────────

/**
 * A started demo session over fake sockets. Each `new WebSocket` is kept so
 * a test can open it, feed it server messages, and close it like a phone
 * dropping the connection in the background.
 */
async function startedSession(
  handlers: ConstructorParameters<typeof VoiceSession>[0] = {},
  startOpts: Parameters<VoiceSession["start"]>[2] = {},
) {
  const g = globalThis as unknown as Record<string, unknown>;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWebSocket = g.WebSocket;
  const savedWindow = g.window;
  const windowListeners: string[] = [];
  g.window = { addEventListener: (type: string) => windowListeners.push(type), removeEventListener() {} };
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    configurable: true,
  });
  type FakeSocket = {
    sent: Record<string, unknown>[];
    readyState: number;
    emit: (type: string, event?: unknown) => void;
  };
  const sockets: FakeSocket[] = [];
  g.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    private listeners = new Map<string, ((event: unknown) => void)[]>();
    constructor() {
      sockets.push(this as unknown as FakeSocket);
    }
    addEventListener(type: string, fn: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, event: unknown = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
    }
  };
  const played: string[] = [];
  const session = new VoiceSession(handlers, {
    micOwner: `hold-test-${Math.random()}`,
    startGraph: async () =>
      ({
        audioCtx: { state: "running", resume: async () => undefined, close: async () => undefined },
        worklet: { port: { close() {} }, disconnect() {} },
        playout: {
          play: () => played.push("chunk"),
          flush() {},
          settled: () => true,
          queuedMs: () => 0,
        },
        stop() {},
      }) as unknown as AudioGraph,
  });
  let tokens = 0;
  await session.start(
    { mode: "agent", agentId: "" },
    async () => ({ token: `tok${(tokens += 1)}`, agentId: "a1", callToken: "call" }),
    startOpts,
  );
  const server = (i: number, message: Record<string, unknown>) =>
    sockets[i]?.emit("message", { data: JSON.stringify(message) });
  // Stop first: the mic registry is global, a live session blocks the next test.
  const restore = async () => {
    await session.stop().catch(() => undefined);
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    g.WebSocket = savedWebSocket;
    g.window = savedWindow;
  };
  return { session, sockets, server, played, windowListeners, restore, tokens: () => tokens };
}

test("pagehide never ends the call: no listener, no session.end", async () => {
  const t = await startedSession();
  try {
    assert.equal(t.windowListeners.includes("pagehide"), false);
    t.sockets[0]?.emit("open");
    t.server(0, { type: "session.ready", session_id: "sess_p" });
    assert.ok(!t.sockets[0]?.sent.some((m) => m.type === "session.end"));
  } finally {
    await t.restore();
  }
});

test("a reload inside the grace resumes the saved server session, not a new one", async () => {
  const t = await startedSession({}, { resumeSessionId: "sess_saved" });
  try {
    t.sockets[0]?.emit("open");
    assert.deepEqual(t.sockets[0]?.sent, [{ type: "session.resume", session_id: "sess_saved" }]);
  } finally {
    await t.restore();
  }
});

test("a drop while hidden parks: no resume attempts until the visitor is back", async () => {
  const states: string[] = [];
  let parked = 0;
  const t = await startedSession({ onStateChange: (s) => states.push(s), onParked: () => (parked += 1) });
  try {
    t.sockets[0]?.emit("open");
    t.server(0, { type: "session.ready", session_id: "sess_bg" });
    t.session.setParkOnDrop(true);
    t.sockets[0]?.emit("close", { code: 1006 });
    await settle();
    assert.equal(parked, 1);
    assert.equal(states.at(-1), "reconnecting");
    assert.equal(t.sockets.length, 1, "no resume socket while hidden");
    assert.equal(typeof t.session.parkedForMs(), "number");
    // Back on the page: resume the SAME server session (its real memory).
    await t.session.resume();
    assert.equal(t.sockets.length, 2);
    t.sockets[1]?.emit("open");
    assert.deepEqual(t.sockets[1]?.sent, [{ type: "session.resume", session_id: "sess_bg" }]);
    assert.equal(t.session.parkedForMs(), null, "no longer parked");
    t.server(1, { type: "session.ready", session_id: "sess_bg" });
    assert.equal(states.at(-1), "listening");
  } finally {
    await t.restore();
  }
});

test("a drop on a visible page still auto-resumes at once", async () => {
  const t = await startedSession();
  try {
    t.sockets[0]?.emit("open");
    t.server(0, { type: "session.ready", session_id: "sess_fg" });
    t.sockets[0]?.emit("close", { code: 1006 });
    await settle();
    assert.equal(t.sockets.length, 2, "resume socket opened");
    t.sockets[1]?.emit("open");
    assert.equal(t.sockets[1]?.sent[0]?.type, "session.resume");
  } finally {
    await t.restore();
  }
});

for (const code of ["session_not_found", "session_forbidden", "session_expired"]) {
  test(`resume refused with ${code} is terminal and coded expired (rejoin with call memory)`, async () => {
    const errors: (string | undefined)[] = [];
    const states: string[] = [];
    const t = await startedSession({ onError: (e) => errors.push(e.code), onStateChange: (s) => states.push(s) });
    try {
      t.sockets[0]?.emit("open");
      t.server(0, { type: "session.error", code, message: "nope" });
      await settle();
      assert.deepEqual(errors, ["expired"]);
      assert.equal(states.at(-1), "ended");
    } finally {
      await t.restore();
    }
  });
}

test("hold mid-reply drops the stale reply: it never plays on return", async () => {
  const t = await startedSession();
  try {
    t.sockets[0]?.emit("open");
    t.server(0, { type: "session.ready", session_id: "sess_mid" });
    t.server(0, { type: "reply.started", reply_id: "r1" });
    t.server(0, { type: "reply.audio", reply_id: "r1", data: "" });
    assert.equal(t.played.length, 1);
    t.session.setOnHold(true); // page froze mid-sentence
    t.session.setOnHold(false);
    t.server(0, { type: "reply.audio", reply_id: "r1", data: "" }); // late tail after unfreeze
    assert.equal(t.played.length, 1, "stale tail dropped");
    t.server(0, { type: "reply.done", reply_id: "r1" });
    t.server(0, { type: "reply.started", reply_id: "r2" }); // the welcome-back
    t.server(0, { type: "reply.audio", reply_id: "r2", data: "" });
    assert.equal(t.played.length, 2, "the welcome plays");
  } finally {
    await t.restore();
  }
});

test("a parked drop mid-reply drops the stale reply too", async () => {
  const t = await startedSession();
  try {
    t.sockets[0]?.emit("open");
    t.server(0, { type: "session.ready", session_id: "sess_mid2" });
    t.server(0, { type: "reply.started", reply_id: "r1" });
    t.session.setParkOnDrop(true);
    t.sockets[0]?.emit("close", { code: 1006 });
    await t.session.resume();
    t.sockets[1]?.emit("open");
    t.server(1, { type: "session.ready", session_id: "sess_mid2" });
    t.server(1, { type: "reply.audio", reply_id: "r1", data: "" });
    assert.equal(t.played.length, 0);
  } finally {
    await t.restore();
  }
});

test("requestReply reports a refused send, so the welcome can wait for the socket", () => {
  const { session, internals } = makeSession();
  assert.equal(session.requestReply("hi"), true);
  (internals["ws"] as { readyState: number }).readyState = 3;
  assert.equal(session.requestReply("hi"), false);
});

test("wake resumes a suspended audio context and re-acquires an ended mic", async () => {
  const { session, internals } = makeSession();
  let resumed = 0;
  const connected: unknown[] = [];
  internals["state"] = "listening";
  internals["audioCtx"] = {
    state: "suspended",
    resume: async () => void (resumed += 1),
    createMediaStreamSource: (stream: unknown) => ({ connect: (node: unknown) => connected.push([stream, node]) }),
  };
  const worklet = { port: {} };
  internals["worklet"] = worklet;
  internals["stream"] = { getAudioTracks: () => [{ readyState: "ended" }] };
  const fresh = { getTracks: () => [], getAudioTracks: () => [{ readyState: "live" }] };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => fresh } },
    configurable: true,
  });
  try {
    await session.wake();
    assert.equal(resumed, 1);
    assert.deepEqual(connected, [[fresh, worklet]]);
    assert.equal(internals["stream"], fresh);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});

test("wake reports a mic that cannot come back", async () => {
  const errors: (string | undefined)[] = [];
  const { session, internals } = makeSession({ onError: (e) => errors.push(e.code) });
  internals["state"] = "listening";
  internals["audioCtx"] = { state: "running", resume: async () => undefined };
  internals["worklet"] = { port: {} };
  internals["stream"] = { getAudioTracks: () => [{ readyState: "ended" }] };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => Promise.reject(new Error("NotAllowedError")) } },
    configurable: true,
  });
  try {
    await session.wake();
    assert.deepEqual(errors, ["mic"]);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});
