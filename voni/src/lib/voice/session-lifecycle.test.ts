import test, { mock } from "node:test";
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
import { DEFAULT_OUTPUT_SAMPLE_RATE } from "./output-format";
import {
  buildConversationMessage,
  HOLD_OFF_CONTEXT,
  HOLD_ON_CONTEXT,
  MICROPHONE_MUTED_CONTEXT,
  MICROPHONE_UNMUTED_CONTEXT,
} from "./context";
import { DEMO_VOICE_IDS, SILENCE_CHECK_IN_INSTRUCTIONS } from "@/lib/demo/voni-agent";
import { evalToolExecutor } from "@/lib/demo/eval-transport";
import { VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "@/lib/agents/voices";
import { decodeWav } from "@/lib/audio/format-facts";

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

/** Poll until a live-session observation lands (the floor ticks on a timer). */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the session");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
  // Like the worklet: reports what has played (nothing yet, by default), so
  // a cut leaves the rest of the line unheard.
  let sentSamples = 0;
  let consumed = 0;
  made.internals["playout"] = {
    play: () => {
      played.push("chunk");
      settled = false;
      sentSamples += 24_000;
    },
    flush: (fadeS?: number) => {
      flushes.push(fadeS ?? -1);
      settled = true;
      consumed = sentSamples;
    },
    settled: () => settled,
    queuedMs: () => (settled ? 0 : 800),
    sentSamples: () => sentSamples,
    consumedSamples: () => consumed,
  };
  /** The queued audio played out: the floor sees playback settled. */
  const drain = () => {
    consumed = sentSamples;
    settled = true;
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
  return { ...made, played, flushes, replyCreates, messages, serverCut, drain };
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
  assert.match(create.instructions, /say exactly this and nothing else, word for word: "I'd handle booking and reminders"/);
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
  assert.match(replyCreates()[0].instructions, /say exactly this and nothing else, word for word: "I'd handle booking and reminders"/);
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
  assert.match(create?.instructions ?? "", /say exactly this and nothing else, word for word: "I'd handle booking and reminders"/);
  assert.match(create.instructions, /booking and reminders/);
  assert.doesNotMatch(create.instructions, /as I was saying/);
  assert.doesNotMatch(create.instructions, /only said ""/);
});

/** A session whose playout reports played audio, like the real worklet. */
function pacedReply(handlers: ConstructorParameters<typeof VoiceSession>[0] = {}) {
  const made = makeSession(handlers);
  let sent = 0;
  let consumed = 0;
  const flushes: number[] = [];
  const played: string[] = [];
  made.internals["playout"] = {
    play: () => {
      played.push("chunk");
      sent += 24_000; // one second per chunk
    },
    flush: (fadeS?: number) => flushes.push(fadeS ?? -1),
    settled: () => flushes.length > 0,
    queuedMs: () => 0,
    sentSamples: () => sent,
    consumedSamples: () => consumed,
  };
  made.handle({ type: "session.ready", session_id: "s1" });
  const playMs = (ms: number) => {
    consumed += (ms / 1000) * 24_000;
  };
  return { ...made, flushes, playMs, played };
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
  // The rest from the last heard word (it was cut mid-way), never the heard part again.
  assert.match(create?.instructions ?? "", /word for word: "booking and reminders for you"/);
  assert.doesNotMatch(create.instructions, /I'd handle/);
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
  // The held end_call result goes out on the cut: the floor gives the
  // platform's reply to it a moment before the rest of the goodbye.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.match(replyCreates().at(-1)?.instructions ?? "", /Say your short goodbye once more/);
  assert.equal(internals["explicitStop"], false);
  handle({ type: "reply.started", reply_id: "bye2" });
  handle({ type: "reply.audio", reply_id: "bye2", data: "" });
  handle({ type: "reply.done", reply_id: "bye2", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(internals["explicitStop"], true, "the finished goodbye hangs up");
});

test("a goodbye cut by a noise with only its last words left hangs up, not repeated", async () => {
  const { session, handle, internals, replyCreates, played } = midReply();
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  handle({ type: "transcript.agent.delta", reply_id: "bye", text: "Thanks for trying me out today, Nedal. Take care!" });
  endCall(handle, "e9");
  await settle();
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  (internals["playout"] as { consumedSamples: () => number }).consumedSamples = () => 24_000 * 5; // all but "Take care!"
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "bye", status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.deepEqual(replyCreates(), [], "never said again");
  assert.equal(internals["explicitStop"], true);
  assert.ok(played.length > 0);
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

test("the floor: a spoken line waits out a tool call and the platform's reply to its result (the lost reveal)", async () => {
  // sess_aacaf… 164s: a note went out while check_code ran; the reveal was lost.
  const { session, handle, internals, replyCreates, drain } = midReply();
  let release: (r: unknown) => void = () => undefined;
  withDemoTools(internals, session);
  globalThis.fetch = (() => new Promise((resolve) => (release = resolve))) as unknown as typeof fetch;
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "t1" });
  handle({ type: "tool.call", call_id: "c1", name: "check_code", arguments: { code: "8703" } });
  handle({ type: "reply.done", reply_id: "t1", status: "completed" }); // a silent tool-call reply
  session.speak("a note");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(replyCreates(), [], "the tool is still running");
  release(new Response(JSON.stringify({ ok: true, data: { status: "correct" } })));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(replyCreates(), [], "the platform's reply to the result is coming");
  handle({ type: "reply.started", reply_id: "reveal" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(replyCreates(), [], "never over the reveal");
  handle({ type: "reply.done", reply_id: "reveal", status: "completed" });
  drain();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["a note"]);
  await session.stop();
});

test("the floor: never over the caller; a keyed line is said once", async () => {
  const { session, handle, replyCreates, drain } = midReply();
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  drain();
  handle({ type: "input.speech.started" });
  session.speak("invite 1", { key: "invite" });
  session.speak("invite 2", { key: "invite" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(replyCreates(), [], "the caller is talking");
  handle({ type: "transcript.user", item_id: "u1", text: "Hang on." });
  handle({ type: "reply.started", reply_id: "answer" }); // the platform answers them
  handle({ type: "reply.done", reply_id: "answer", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["invite 2"]);
  await session.stop();
});

test("a tool result never makes the session send a line of its own", async () => {
  const { session, handle, internals, replyCreates } = midReply();
  withDemoTools(internals, session, { ok: true, data: { shown: true, testTag: "Lime 42", instructions: "Say the invite." } });
  handle({ type: "tool.call", call_id: "c1", name: "show_test_address", arguments: {} });
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.deepEqual(replyCreates(), [], "the invite is the platform's own reply to the result");
  await session.stop();
});

test("our line cut by a real question is said again, whole, after the answer", async () => {
  const { session, handle, replyCreates, drain } = midReply({ judgeBargeIn: async () => "yield" });
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  drain();
  session.speak("Found it: tell them.");
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle({ type: "reply.started", reply_id: "ours" });
  handle({ type: "transcript.agent.delta", reply_id: "ours", text: "Found it, Nedal. I'm sending you a quick reply now." });
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "ours", status: "interrupted" });
  handle({ type: "transcript.user", item_id: "u1", text: "Wait, what are you sending me exactly?" });
  await settle(); // the judge's verdict
  handle({ type: "reply.started", reply_id: "answer" });
  handle({ type: "reply.done", reply_id: "answer", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(replyCreates().map((c) => c.instructions), ["Found it: tell them.", "Found it: tell them."]);
  await session.stop();
});

test("a noise cut with only a few words left says nothing more", async () => {
  const { session, handle, replyCreates } = midReply();
  handle({ type: "reply.started", reply_id: "g" });
  handle({ type: "transcript.agent.delta", reply_id: "g", text: "Ready?" });
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "g", status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(replyCreates(), [], "the caller got the point");
  await session.stop();
});

test("steering after a cut is answered as a normal turn", async () => {
  const events: string[] = [];
  const { serverCut, handle, replyCreates, played } = midReply({}, { onBargeIn: (e) => events.push(e.verdict) });
  const before = played.length;
  serverCut("Wait, stop.");
  // The judge yields, so the server answers the steering as a fresh turn: its
  // own reply plays. Nothing resumes the line the steering cut.
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "reply.audio", reply_id: "r2", data: "" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(replyCreates(), [], "no tail resume is created");
  assert.deepEqual(events, ["yield"]);
  assert.equal(played.length, before + 1, "the fresh answer turn plays");
});

test("filler after a cut is resumed from, never answered, with the exact unheard tail", async () => {
  const events: string[] = [];
  const { session, handle, sent, playMs, played } = pacedReply({
    onBargeIn: (e) => events.push(`${e.verdict}:${e.source}`),
  });
  const replyCreates = () =>
    sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "reply.create");
  handle({ type: "reply.started", reply_id: "r1" });
  handle({ type: "transcript.agent.delta", reply_id: "r1", text: "I'd handle booking and reminders for you" });
  handle({ type: "reply.audio", reply_id: "r1", data: "" });
  playMs(14 * CAPTION_MS_PER_CHAR); // the caller heard through "booking"
  const before = played.length;
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  playMs(60_000);
  handle({ type: "transcript.user", item_id: "u1", text: "Okaay so" });
  // The platform answers the back-channel as a turn; that answer is superseded
  // before it plays — a filler is never answered.
  handle({ type: "reply.started", reply_id: "r2" });
  handle({ type: "reply.audio", reply_id: "r2", data: "" });
  assert.equal(played.length, before, "the answer to filler never plays");
  const [create] = replyCreates();
  assert.match(create.instructions, /only said "Okaay so"/);
  // Ticket 13's exact-tail rule: re-say the unheard rest, word for word.
  assert.match(create.instructions, /word for word: "booking and reminders for you"/);
  assert.doesNotMatch(create.instructions, /I'd handle/, "the heard part is not repeated");
  assert.deepEqual(events, ["ignore:rule"]);
  handle({ type: "reply.done", reply_id: "r2", status: "completed" });
  handle({ type: "reply.started", reply_id: "r3" });
  handle({ type: "reply.audio", reply_id: "r3", data: "" });
  assert.equal(played.length, before + 1, "the resumed tail plays");
  await session.stop();
});

test("a silence check-in the visitor speaks over is dropped, never resumed, and their point is answered", async () => {
  const events: string[] = [];
  const { session, handle, replyCreates, played, drain } = midReply(
    { judgeBargeIn: async () => "yield" },
    { onBargeIn: (e) => events.push(e.verdict) },
  );
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  drain();
  // The floor's own 15s timer, shortened for the test only: the yield path
  // itself uses no new budget, the server's interrupted reply.done does it.
  session.setSilenceCheckIn({
    afterMs: 250,
    instructions: SILENCE_CHECK_IN_INSTRUCTIONS,
    allowed: () => true,
  });
  await waitUntil(() => replyCreates().length === 1);
  assert.equal(replyCreates()[0].instructions, SILENCE_CHECK_IN_INSTRUCTIONS);

  handle({ type: "reply.started", reply_id: "ci" });
  handle({ type: "transcript.agent.delta", reply_id: "ci", text: "Still with me? Take your time." });
  handle({ type: "reply.audio", reply_id: "ci", data: "" });
  const before = played.length;
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "ci", status: "interrupted" });
  handle({ type: "input.speech.stopped" });
  handle({ type: "transcript.user", item_id: "u1", text: "Wait, stop. What does it cost?" });
  await settle();
  handle({ type: "reply.started", reply_id: "answer" });
  handle({ type: "reply.audio", reply_id: "answer", data: "" });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(
    replyCreates().map((create) => create.instructions),
    [SILENCE_CHECK_IN_INSTRUCTIONS],
    "the check-in is never re-said or resumed over the visitor",
  );
  assert.deepEqual(events, ["yield"], "a real point keeps the floor");
  assert.equal(played.length, before + 1, "their point is answered by the server's own turn");
  await session.stop();
});

test("a filler over the check-in drops it instead of finishing it", async () => {
  const events: string[] = [];
  const { session, handle, replyCreates, drain } = midReply(
    {},
    { onBargeIn: (e) => events.push(e.verdict) },
  );
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  drain();
  session.setSilenceCheckIn({
    afterMs: 250,
    instructions: SILENCE_CHECK_IN_INSTRUCTIONS,
    allowed: () => true,
  });
  await waitUntil(() => replyCreates().length === 1);

  handle({ type: "reply.started", reply_id: "ci" });
  handle({ type: "transcript.agent.delta", reply_id: "ci", text: "Still with me? Take your time." });
  handle({ type: "reply.audio", reply_id: "ci", data: "" });
  handle({ type: "input.speech.started" });
  handle({ type: "reply.done", reply_id: "ci", status: "interrupted" });
  handle({ type: "input.speech.stopped" });
  // The overlap judge calls this filler: normally the line would resume, but
  // an optional check-in is never worth finishing over a visitor who spoke.
  handle({ type: "transcript.user", item_id: "u1", text: "Okaay so" });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(
    replyCreates().map((create) => create.instructions),
    [SILENCE_CHECK_IN_INSTRUCTIONS],
    "the check-in is dropped, not resumed",
  );
  assert.deepEqual(events, ["ignore"]);
  await session.stop();
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

test("a held end_call result is released when the platform waits for it (no goodbye audio at all)", async () => {
  // Measured 1 in 10 live: the platform sometimes holds the goodbye reply
  // open until the result arrives; holding the result then stalled until the
  // tool's timeout (a 12.6s hang-up). A goodbye that has not started is the
  // one case the flat 3s backstop still covers: releasing the result before
  // it begins makes the platform cut it (ADR-0005). Once audio has played,
  // the drain handshake releases it instead (next two tests).
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

test("a held end_call result is released once the goodbye has drained, not on a flat 3s", async () => {
  // Fast hang-up baseline ~4.2s = ~3s held-result release + ~1s drain. The
  // result now goes back on the same handshake the hang-up uses — three
  // settled polls (3 x 250ms) inside the 500ms audio grace — so the goodbye
  // still plays whole and the end lands inside the 1500ms budget. The flat
  // HELD_RESULT_RELEASE_MS stays only for a goodbye that never starts.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    // The mocked clock starts at epoch 0, where lastAudioAt's 0 means "never".
    mock.timers.setTime(1_700_000_000_000);
    const { session, sent, handle, internals } = makeSession();
    withDemoTools(internals, session);
    let settled = false;
    internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => settled, queuedMs: () => 0 };
    handle({ type: "session.ready", session_id: "s1" });
    handle({ type: "reply.started", reply_id: "bye" });
    handle({ type: "reply.audio", reply_id: "bye", data: "" });
    endCall(handle, "e21");
    await new Promise((resolve) => setImmediate(resolve));
    const results = () =>
      sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result" && m.call_id === "e21");

    // Still sounding: a result now would cut the goodbye (ADR-0005).
    mock.timers.tick(2000);
    assert.equal(results().length, 0, "never send the result while the goodbye is sounding");

    const drainedAt = Date.now();
    settled = true; // the last chunk has played out
    mock.timers.tick(500); // two settled polls: not enough
    assert.equal(results().length, 0, "a momentary dry gap between chunks is not the end of the line");
    mock.timers.tick(250); // third settled poll: the line has drained
    assert.equal(results().length, 1, "released on the drain handshake, not after a flat 3s");
    assert.ok(
      Date.now() - drainedAt <= 1000,
      `release stayed inside the 1500ms budget (${Date.now() - drainedAt}ms of the allowance)`,
    );

    // The platform can finish the held reply now; the hang-up lands at once.
    handle({ type: "reply.done", reply_id: "bye", status: "completed" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(internals["explicitStop"], true, "the call ends on the drained goodbye");
  } finally {
    mock.timers.reset();
  }
});

test("fresh goodbye audio resets the drain streak and never releases the held result early", async () => {
  // The streak plus audio grace is what keeps the goodbye whole: two settled
  // polls followed by more audio must start the count again, exactly like
  // the hang-up's own drain.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    mock.timers.setTime(1_700_000_000_000);
    const { session, sent, handle, internals } = makeSession();
    withDemoTools(internals, session);
    let settled = false;
    internals["playout"] = { play: () => undefined, flush: () => undefined, settled: () => settled, queuedMs: () => 0 };
    handle({ type: "session.ready", session_id: "s1" });
    handle({ type: "reply.started", reply_id: "bye" });
    handle({ type: "reply.audio", reply_id: "bye", data: "" });
    endCall(handle, "e22");
    await new Promise((resolve) => setImmediate(resolve));
    const results = () =>
      sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "tool.result" && m.call_id === "e22");

    settled = true;
    mock.timers.tick(500); // two settled polls
    assert.equal(results().length, 0);
    settled = false; // the next chunk arrives and is still queued
    handle({ type: "reply.audio", reply_id: "bye", data: "" });
    mock.timers.tick(250);
    settled = true;
    mock.timers.tick(500); // audio grace elapsed: two settled polls, not three
    assert.equal(results().length, 0, "the streak restarts after fresh audio");
    mock.timers.tick(250); // third settled poll after the last audio
    assert.equal(results().length, 1, "three settled polls after the last audio release it");
  } finally {
    mock.timers.reset();
  }
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

test("a jittery goodbye: late audio restarts the drain streak, and the call still closes inside the budget", async () => {
  // Jittery links report settled between chunks while the last word is still
  // in the worklet, and a late chunk can land after reply.done. One settled
  // poll (or the streak without its grace) chops the goodbye. The streak plus
  // audio grace must restart on every chunk, and the hang-up must still land
  // promptly once the line genuinely drains.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    mock.timers.setTime(1_700_000_000_000);
    const { session, handle, internals } = makeSession();
    withDemoTools(internals, session);
    let settled = false;
    internals["playout"] = {
      play: () => undefined,
      flush: () => undefined,
      settled: () => settled,
      queuedMs: () => 0,
    };
    handle({ type: "session.ready", session_id: "s1" });
    handle({ type: "reply.started", reply_id: "bye" });
    // The goodbye's last chunk has arrived; the playout is still draining.
    handle({ type: "reply.audio", reply_id: "bye", data: "" });
    const firstAudioAt = Date.now();
    endCall(handle, "e23");
    await new Promise((resolve) => setImmediate(resolve));
    handle({ type: "reply.done", reply_id: "bye", status: "completed" });
    assert.equal(internals["explicitStop"], false, "never hang up while the goodbye is sounding");

    settled = true;
    mock.timers.tick(250); // dry buffer, but the 500ms audio grace has not passed
    assert.equal(internals["explicitStop"], false);
    mock.timers.tick(500); // polls at 500 and 750: two settled, one short of the streak
    assert.equal(internals["explicitStop"], false, "two settled polls never chop the goodbye");

    // A late chunk lands after reply.done: the audio grace and the streak both
    // restart, so a drain that looked imminent at 1000ms must not close.
    const lastAudioAt = Date.now();
    handle({ type: "reply.audio", reply_id: "bye", data: "" });
    settled = false;
    mock.timers.tick(250); // still sounding
    settled = true;
    mock.timers.tick(500); // two settled polls since the late chunk
    assert.equal(internals["explicitStop"], false, "the late chunk restarted the streak");
    mock.timers.tick(250); // third settled poll after the last audio, grace passed
    assert.equal(internals["explicitStop"], true, "the call closes once the goodbye drains");

    const closedAfterMs = Date.now() - lastAudioAt;
    assert.ok(
      closedAfterMs >= 750,
      `waited for the settled streak (${closedAfterMs}ms from the last audio)`,
    );
    assert.ok(
      closedAfterMs <= 1500,
      `the hang-up stayed inside the 1500ms drain budget (${closedAfterMs}ms)`,
    );
    assert.ok(
      Date.now() - firstAudioAt < 10_000,
      "the jittered drain closed well inside the 10s timeout",
    );
  } finally {
    mock.timers.reset();
  }
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

/** A session whose playout records the rate every chunk is played at. */
function recordPlayedRates(
  handlers: ConstructorParameters<typeof VoiceSession>[0] = {},
) {
  const made = makeSession(handlers);
  const played: [number, number][] = [];
  made.internals["playout"] = {
    ...fakePlayout().playout,
    play: (pcm: Uint8Array, rate: number) => played.push([pcm.length, rate]),
  };
  const audio = (samples = 480) =>
    made.handle({ type: "reply.audio", data: Buffer.from(new Uint8Array(samples)).toString("base64") });
  return { ...made, played, audio };
}

test("reply audio plays at the resolved rate from the session confirmation", () => {
  const { handle, played, audio } = recordPlayedRates();
  handle({
    type: "session.ready",
    session_id: "s16",
    config: { output: { format: { encoding: "audio/pcm", sample_rate: 16000 } } },
  });
  audio(480);
  // The handle is told 16 kHz, not a module constant: 480 source samples are
  // 30 ms here, not the 20 ms 24 kHz would imply.
  assert.deepEqual(played, [[480, 16000]]);
});

test("a resolved rate other than the default is never replaced by 24 kHz", () => {
  const { handle, played, audio } = recordPlayedRates();
  handle({
    type: "session.ready",
    session_id: "s48",
    config: { output: { format: { encoding: "audio/pcm", sample_rate: 48000 } } },
  });
  audio(960);
  assert.deepEqual(played, [[960, 48000]]);
});

test("a confirmation with no rate plays at the named default", () => {
  const { handle, played, audio } = recordPlayedRates();
  handle({
    type: "session.ready",
    session_id: "s_default",
    config: { output: { format: { encoding: "audio/pcm" } } },
  });
  audio(480);
  assert.deepEqual(played, [[480, DEFAULT_OUTPUT_SAMPLE_RATE]]);
});

test("an unplayable resolved rate is a visible failure, never a guessed speed", () => {
  const errors: { message: string; code?: string }[] = [];
  const { handle, played, audio } = recordPlayedRates({
    onError: (error) => errors.push(error),
  });
  handle({
    type: "session.ready",
    session_id: "s_bad",
    config: { output: { format: { encoding: "audio/pcm", sample_rate: 0 } } },
  });
  audio(480);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "config");
  assert.match(errors[0]?.message ?? "", /sample rate \(0\)/);
  assert.deepEqual(played, []);
});

test("a resume's confirmation never downgrades the resolved rate", () => {
  const { handle, played, audio } = recordPlayedRates();
  handle({
    type: "session.ready",
    session_id: "s16",
    config: { output: { format: { encoding: "audio/pcm", sample_rate: 16000 } } },
  });
  // A resume re-emits session.ready on the same conversation; if that echo
  // carries no config, the rate already resolved still governs playback.
  handle({ type: "session.ready", session_id: "s16" });
  audio(320);
  assert.deepEqual(played, [[320, 16000]]);
});

test("audio is never played before the confirmation resolves a rate", () => {
  const { played, audio } = recordPlayedRates();
  audio(480);
  assert.deepEqual(played, []);
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

test("sensitive capture widens from the adaptive default and restores null", async () => {
  const { session, sent, handle, internals } = makeSession();
  const prepare = (
    session as unknown as {
      prepareSensitiveCapture: () => Promise<unknown>;
    }
  ).prepareSensitiveCapture.bind(session);

  // The production session starts adaptive (activeTurnDetection null).
  assert.equal(internals["activeTurnDetection"] ?? null, null);
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

  // The next final caller turn restores adaptive explicitly (null).
  handle({ type: "transcript.user", item_id: "u-sensitive", text: "value" });
  assert.deepEqual(JSON.parse(sent[1]), {
    type: "session.update",
    session: { input: { turn_detection: null } },
  });
  handle({ type: "session.updated" });
  assert.equal(internals["activeTurnDetection"] ?? null, null);
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

test("the goodbye's own audio still plays when the platform omits its reply id", () => {
  // ADR-0005/ ticket 20: the closing line must play in full. A platform that
  // omits reply_id on the goodbye's own audio cannot be proven to be a later
  // reply while the goodbye still owns the floor, so silence must not win yet.
  const { session, handle, internals, played } = midReply();
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e20", { closing_line: "Okay, bye!" });
  const before = played.length;
  handle({ type: "reply.audio", data: "" }); // no reply_id
  handle({ type: "transcript.agent", text: "Okay, bye!" }); // no reply_id
  assert.ok(played.length > before, "the id-less goodbye audio is heard, not silenced");
  assert.equal(internals["endCallSignaled"], true);
  assert.equal(internals["goodbyeFinished"], false, "the goodbye still owns the floor");
});

test("the goodbye still plays when end_call was spoken without a reply id", () => {
  // A spoken end_call inside a reply that carries no id leaves endCallReplyId
  // null. The goodbye that follows is then unidentifiable; dropping every
  // id-carrying reply would silence it too.
  const captions: string[] = [];
  const { session, handle, internals, played } = midReply({}, {
    onTranscript: (turn) => captions.push(turn.text),
  });
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  handle({ type: "transcript.agent", text: "Thanks for calling. end_call" }); // no reply_id
  const before = played.length;
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "transcript.agent", reply_id: "bye", text: "Okay, bye!" });
  assert.ok(played.length > before, "the goodbye audio plays");
  assert.deepEqual(captions, ["Thanks for calling.", "Okay, bye!"], "the goodbye is captioned");
});

test("a caller's end request hangs up after a spoken goodbye even without a tool call", async () => {
  // Live hang-up-fast: the model said "Alright, bye!" but never called the
  // end tool, so the session stayed open. The caller asked to end; the spoken
  // goodbye must still close the line after it drains.
  const events: string[] = [];
  const { session, handle, internals } = midReply({}, {
    onEndCall: () => events.push("armed"),
    onStateChange: (state) => {
      if (state === "ended") events.push("ended");
    },
  });
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  handle({ type: "transcript.agent", reply_id: "bye", text: "Alright, bye!" });
  session.endAfterReply();
  assert.deepEqual(events, ["armed"], "the hang-up arms on the spoken goodbye");
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "reply.done", reply_id: "bye", status: "completed" });
  // The worklet reports the line drained; the hang-up needs the audio grace.
  (internals["playout"] as { flush: () => void }).flush();
  await waitUntil(() => events.includes("ended"), 3000);
  assert.deepEqual(events, ["armed", "ended"]);
});

test("an id-less reply after the goodbye completes is dropped whole", () => {
  const captions: string[] = [];
  const { session, handle, internals, played } = midReply({}, {
    onTranscript: (turn) => captions.push(turn.text),
  });
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e23", { closing_line: "Okay, bye!" });
  handle({ type: "reply.audio", data: "" }); // the goodbye's id-less audio
  handle({ type: "reply.done", reply_id: "bye", status: "completed" });
  const before = played.length;
  handle({ type: "reply.audio", data: "" });
  handle({ type: "transcript.agent", text: "The call has ended." });
  assert.equal(played.length, before, "nothing after the goodbye plays");
  assert.deepEqual(captions, [], "nothing after the goodbye is captioned");
});

test("a post-goodbye reply that omits its reply id is dropped whole", () => {
  // The drop guards identify the goodbye by reply id. A message that carries
  // no id matched "no id = not dropped", so the model's post-End call line
  // played and captioned. After the goodbye, only the goodbye reply is
  // speakable: silence is the ordering, whatever the message omits.
  const captions: string[] = [];
  const partials: string[] = [];
  const { session, handle, internals, played, replyCreates } = midReply({}, {
    onTranscript: (turn) => captions.push(turn.text),
    onAgentPartial: (partial) => partials.push(partial.text),
  });
  withDemoTools(internals, session);
  handle({ type: "reply.done", reply_id: "r1", status: "completed" });
  handle({ type: "reply.started", reply_id: "bye" });
  endCall(handle, "e9", { closing_line: "Okay, bye!" });
  handle({ type: "reply.audio", reply_id: "bye", data: "" });
  handle({ type: "transcript.agent", reply_id: "bye", text: "Okay, bye!" });
  handle({ type: "reply.done", reply_id: "bye", status: "completed" });
  const before = played.length;
  // The platform auto-fires the post-result reply without a reply id.
  handle({ type: "reply.started" });
  handle({ type: "reply.audio", data: "" });
  handle({ type: "transcript.agent.delta", delta: "The call has" });
  handle({ type: "transcript.agent", text: "The call has ended." });
  assert.equal(played.length, before, "the id-less post-goodbye reply never plays");
  assert.deepEqual(partials, [], "no partial of it is captioned");
  assert.deepEqual(captions, ["Okay, bye!"], "no final line of it is captioned");
  session.requestReply("Say something else.");
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

/**
 * A started session over a fake graph whose playout records the delivered
 * capture tap. The WAV sink is injected so the test never touches the network.
 */
async function captureSession(fields: { capture: boolean; taps: boolean[]; written: { name: string; bytes: Uint8Array }[] }) {
  const g = globalThis as unknown as Record<string, unknown>;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWebSocket = g.WebSocket;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
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
  let onTap: ((samples: Float32Array) => void) | undefined;
  const playout = {
    play() {},
    flush() {},
    settled: () => true,
    queuedMs: () => 0,
    tap(on: boolean) {
      fields.taps.push(on);
      return Promise.resolve();
    },
    get onTap() {
      return onTap;
    },
    set onTap(fn: ((samples: Float32Array) => void) | undefined) {
      onTap = fn;
    },
  };
  const session = new VoiceSession(
    {},
    {
      micOwner: `delivered-capture-${Math.random()}`,
      startGraph: async () =>
        ({
          audioCtx: { sampleRate: 48000, state: "running", resume: async () => undefined, close: async () => undefined },
          worklet: { port: { close() {} }, disconnect() {} },
          playout,
          stop() {},
        }) as unknown as AudioGraph,
      writeCapture: (name, bytes) => {
        fields.written.push({ name, bytes });
      },
    },
  );
  if (fields.capture) session.setDeliveredCapture(true);
  await session.start({ mode: "agent", agentId: "" }, async () => ({ token: "tok", agentId: "a1" }));
  const restore = async () => {
    await session.stop().catch(() => undefined);
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    g.WebSocket = savedWebSocket;
  };
  return { session, pushTap: (samples: Float32Array) => onTap?.(samples), restore };
}

test("delivered capture: flag on taps the worklet and writes its output as a WAV on hang-up", async () => {
  const fields = { capture: true, taps: [] as boolean[], written: [] as { name: string; bytes: Uint8Array }[] };
  const { pushTap, restore } = await captureSession(fields);
  try {
    assert.deepEqual(fields.taps, [true], "the worklet tap starts with the call");
    pushTap(new Float32Array([0.25, -0.25, 0.5]));
    await restore();
    assert.deepEqual(fields.taps, [true, false], "and flushes before teardown");
    assert.equal(fields.written.length, 1);
    assert.match(fields.written[0]!.name, /^delivered-.*\.wav$/);
    const wav = decodeWav(fields.written[0]!.bytes);
    assert.equal(wav.facts.sampleRate, 48000, "at the worklet's output rate");
    assert.deepEqual(Array.from(wav.samples), [8192, -8192, 16384]);
  } finally {
    await restore();
  }
});

test("delivered capture: flag off touches no tap and writes no file", async () => {
  const fields = { capture: false, taps: [] as boolean[], written: [] as { name: string; bytes: Uint8Array }[] };
  const { session, pushTap, restore } = await captureSession(fields);
  try {
    const playout = (session as unknown as { playout: { onTap?: unknown } }).playout;
    assert.equal(playout.onTap, undefined);
    pushTap(new Float32Array([0.25]));
    await restore();
    assert.deepEqual(fields.taps, []);
    assert.deepEqual(fields.written, []);
  } finally {
    await restore();
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

test("inline session update pins the registry output level for every demo voice", () => {
  for (const voiceId of DEMO_VOICE_IDS) {
    const update = buildInlineSessionUpdate({
      mode: "inline",
      systemPrompt: "prompt",
      greeting: "Hi.",
      voiceId,
      tools: [],
    });
    assert.deepEqual(update["output"], { voice: voiceId, volume: VOICE_OUTPUT_VOLUME });
  }
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "prompt",
    greeting: "Hi.",
    voiceId: "lola",
    tools: [],
  });
  assert.deepEqual(update["output"], { voice: "lola", volume: 100 });
});

test("managed session loudness has one stage: registry gain applied once, never compounded", () => {
  const { handle, internals } = makeSession();
  const peaks: number[] = [];
  internals["playout"] = {
    play: (pcm: Uint8Array) => {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
      }
      peaks.push(peak);
    },
    flush: () => undefined,
    settled: () => true,
    queuedMs: () => 0,
  };
  handle({ type: "session.ready", session_id: "s-one-gain" });
  const session = internals as unknown as { setOutputGain: (gain: number) => void };
  // 1000 PCM16 steps, far below the soft knee: gain stays exactly linear.
  const pcm = new Uint8Array([0xe8, 0x03]);
  const base64 = Buffer.from(pcm).toString("base64");
  // No gain was set: the session must not apply a hidden loudness stage.
  handle({ type: "reply.audio", reply_id: "r0", data: base64 });
  assert.equal(peaks[0], 1000, "unset gain plays the server level untouched");
  session.setOutputGain(voicePlaybackGain("juergen"));
  handle({ type: "reply.audio", reply_id: "r1", data: base64 });
  assert.equal(peaks[1], Math.round(1000 * voicePlaybackGain("juergen")));
  // Setting the same registry gain again replaces it; it never stacks.
  session.setOutputGain(voicePlaybackGain("juergen"));
  handle({ type: "reply.audio", reply_id: "r2", data: base64 });
  assert.equal(peaks[2], peaks[1], "gain is one stage, not a new stage per call");
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

test("a bound agent with an injected executor answers every stored tool, never the demo route", async () => {
  // The live eval binds the landing demo's stored agent and answers its tools
  // locally. Bound mode without a call token used to fall to
  // `installLocalEndCall`, which answers only show_test_address/end_call: the
  // other three would stall the turn for 30s.
  const g = globalThis as unknown as Record<string, unknown>;
  const savedWebSocket = g.WebSocket;
  const savedFetch = globalThis.fetch;
  type FakeSocket = { url: string; readyState: number; sent: string[]; emit: (type: string) => void };
  const sockets: FakeSocket[] = [];
  g.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    private listeners = new Map<string, ((event: unknown) => void)[]>();
    constructor(public url: string) {
      sockets.push(this as unknown as FakeSocket);
    }
    addEventListener(type: string, fn: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
    emit(type: string) {
      for (const fn of this.listeners.get(type) ?? []) fn({ data: "", code: 1000 });
    }
  };
  // Any browser tool-route call would be a bug: the eval has no call token.
  globalThis.fetch = (async () => {
    throw new Error("the eval must not call the demo tool route");
  }) as typeof fetch;
  try {
    const answered: string[] = [];
    const executor = evalToolExecutor({
      testTag: "Lime 42",
      checkEmail: async () => ({ ok: true, data: { status: "not_arrived" } }),
    });
    const session = new VoiceSession(
      {},
      {
        toolExecutor: async (call) => {
          answered.push(call.name);
          return executor(call);
        },
      },
    );
    const internals = session as unknown as {
      connect: (token: string, config: unknown, gen: number) => void;
      generation: { begin: () => number };
      handle: (raw: string) => void;
      callToken: string | null;
    };
    // Even with a call token present, an injected executor wins: the caller
    // owns how a bound agent's tools are answered.
    internals.callToken = "call-token";
    internals.connect("tok", { mode: "agent", agentId: "agent_1" }, internals.generation.begin());
    const ws = sockets[0]!;
    ws.emit("open");
    const update = JSON.parse(ws.sent[0]!);
    assert.equal(update.type, "session.update");
    assert.deepEqual(update.session, { agent_id: "agent_1" }, "bound mode sends only the binding");

    const calls: [string, Record<string, unknown>][] = [
      ["show_test_address", {}],
      ["check_email", {}],
      ["send_code_reply", { warm_line: "hi" }],
      ["check_code", { code: "1234" }],
      ["end_call", { closing_line: "Bye!" }],
    ];
    for (const [name, args] of calls) {
      internals.handle(JSON.stringify({ type: "tool.call", call_id: `c-${name}`, name, arguments: args }));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual([...answered].sort(), calls.map(([name]) => name).sort(), "every tool reached the executor");
    const results = ws.sent
      .map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === "tool.result");
    assert.equal(results.length, calls.length, "no tool call is left unanswered");
    const endCall = results.find((msg) => msg.call_id === "c-end_call");
    assert.match(endCall.result, /"hangup":true/);
  } finally {
    g.WebSocket = savedWebSocket;
    globalThis.fetch = savedFetch;
  }
});
