/**
 * Live eval of the demo agent's call behavior, driven by real audio.
 *
 * Runs Voni's exact demo body (buildDemoAgentBody) as an inline session, so
 * it needs no demo rate limit and no stored-agent refresh. Caller lines are
 * real speech: a throwaway AssemblyAI session speaks each line as its fixed
 * greeting (sent straight to TTS, no LLM), and those PCM16 frames stream into
 * the demo session as `input.audio`, so turn detection and STT run exactly as
 * on a call. (`conversation.message` with role user is silently dropped by
 * the API, so text injection cannot stand in for a caller.) Ladder rungs use
 * the same `reply.create` instructions the landing UI sends. A few cents a run.
 *
 *   npm run eval:demo-agent -- [--runs 5] [--voice anna] [--scenario hang-up]
 *
 * Scenarios (raw socket):
 *   hang-up       "I want you to hang up." → a real end_call tool call, and
 *                 the tool name is never spoken.
 *   refusal       three refusals through nudge → warning → end rungs → no
 *                 fake / pretend business is ever offered, ends with end_call.
 *
 * Barge-in scenarios drive the REAL VoiceSession (server cut + session
 * recovery, docs/adr/0003-barge-in-recovery.md) over a live socket, with a
 * wall-clock fake playout and Jev called directly through the gateway:
 *   filler-over   "Okaay so" over a long reply → not cut, or cut and resumed.
 *   stop-over     "Wait, stop." over a long reply → cut within ~1.5s, answered.
 *   over-talk     a short answer over the reply → heard (never lost).
 *   hang-up-over  "I want you to hang up this call." over a long reply →
 *                 the call ends, never resumed ("as I was saying").
 *   greeting-cut  "Wait, stop." 1s into the greeting → the greeting is cut.
 *
 * Email-test scenarios (raw socket, the demo's real tools; ticket 03 +
 * docs/adr/0004): tool results go back the way the browser sends them, the
 * moment they are ready (EVAL_HOLD_INTERACTIVE=1 replays the old hold-for-
 * reply.done behaviour that deadlocked the owner's first real call,
 * sess_c477d8f8: a 5s tool timeout during the invite → an invented address):
 *   invite-tag          the show tool is called, the tag is said, no email
 *                       address is spoken or invented, no tool times out.
 *   sent-no-placeholder "I sent it" → any inbox check has no address, never
 *                       "unknown"; no "didn't catch that" (looking is
 *                       optional: the browser polls the tag).
 *   forgot-tag          "I forgot the tag, I used andres at casaverde dot pt"
 *                       → checked with that address.
 *   free-gate           a personal-address result → the gate → "no" → the
 *                       goodbye names hi@voni.cc, end_call, and the goodbye's
 *                       audio arrives in full (≥80% of its speaking time).
 *   late-close          time up, nothing landed → "I'll reply the moment it
 *                       lands", end_call.
 *   returning           a found + returning result → greets Andres as
 *                       returning and never re-invites.
 */
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
import {
  checkEmailInstructions,
  inviteNowInstructions,
  LATE_EMAIL_INSTRUCTIONS,
  testTagContext,
  OPEN_BEAT_GOAL,
  rungInstructions,
} from "../src/lib/demo/voni-agent";
import { CHECK_EMAIL_TOOL, DEMO_VOICE_TOOLS, executeDemoTool, SHOW_TEST_ADDRESS_TOOL } from "../src/lib/demo/demo-tools";
import { checkResultToData, mentionsScreen, normalizeClaim, type CheckEmailResult } from "../src/lib/demo/email-test";
import { buildEndCallSuccess, END_CALL_VOICE_TOOL } from "../src/lib/tools/definitions";
import {
  HELD_RESULT_RELEASE_MS,
  stripSpokenToolCall,
  TARGET_SAMPLE_RATE,
  VoiceSession,
  type BargeInEvent,
} from "../src/lib/voice/session";
import { tryJevGateway } from "../src/lib/voice/voice-judge";

const FAKE = /fake|pretend|hypothetical|make one up|made[- ]up|pick anything|example business|imaginary|role[- ]?play/i;
const WS = "wss://agents.assemblyai.com/v1/ws";
const TURN_TIMEOUT_MS = 25000;
/** 50ms of PCM16 mono at 24kHz. */
const FRAME_BYTES = 2400;
const CALLER_VOICE = "george";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

type Step = { say?: string; instructions?: string };
type Outcome = { agent: string[]; heard: string[]; endCalled: boolean };

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY missing: run with --env-file=.dev.vars");

async function token(): Promise<string> {
  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", "60");
  url.searchParams.set("max_session_duration_seconds", "180");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** Caller speech: a session whose greeting is the line, captured as PCM16. */
const speechCache = new Map<string, Buffer>();
async function speak(line: string): Promise<Buffer> {
  // The throwaway TTS session is infrastructure, not the thing under test:
  // one retry on a timeout keeps a network blip from failing a scenario.
  return speakOnce(line).catch(() => speakOnce(line));
}

async function speakOnce(line: string): Promise<Buffer> {
  const cached = speechCache.get(line);
  if (cached) return cached;
  const ws = new WebSocket(`${WS}?token=${await token()}`);
  const chunks: Buffer[] = [];
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("speech timed out")), TURN_TIMEOUT_MS);
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: { system_prompt: "Stay silent.", greeting: line, output: { voice: CALLER_VOICE } },
        }),
      ),
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "reply.audio") chunks.push(Buffer.from(msg.data, "base64"));
      if (msg.type === "reply.done") {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
    ws.addEventListener("error", () => reject(new Error("speech socket error")));
  });
  ws.send(JSON.stringify({ type: "session.end" }));
  ws.close();
  speechCache.set(line, pcm);
  return pcm;
}

async function runSession(voiceId: string, steps: Step[]): Promise<Outcome> {
  const body = buildDemoAgentBody(voiceId);
  const ws = new WebSocket(`${WS}?token=${await token()}`);
  const outcome: Outcome = { agent: [], heard: [], endCalled: false };
  const send = (message: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  // Real-time mic pump: queued speech, else silence (the API expects a
  // continuous stream and drops audio sent faster than real time).
  let queue = Buffer.alloc(0);
  let ready = false;
  const pump = setInterval(() => {
    if (!ready) return;
    const frame = queue.length > 0 ? queue.subarray(0, FRAME_BYTES) : Buffer.alloc(FRAME_BYTES);
    queue = queue.subarray(frame.length);
    const padded = frame.length === FRAME_BYTES ? frame : Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    send({ type: "input.audio", audio: padded.toString("base64") });
  }, 50);

  let heardUser = false;
  let onReplyDone: (() => void) | null = null;
  const waitReply = (afterUser: boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reply timed out")), TURN_TIMEOUT_MS);
      onReplyDone = () => {
        if (afterUser && !heardUser) return;
        clearTimeout(timer);
        onReplyDone = null;
        resolve();
      };
    });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === "session.ready") ready = true;
    if (msg.type === "transcript.user" && msg.text) {
      outcome.heard.push(msg.text);
      heardUser = true;
    }
    if (msg.type === "transcript.agent" && msg.text) outcome.agent.push(msg.text);
    if (msg.type === "tool.call" && msg.name === END_CALL_VOICE_TOOL.name) {
      outcome.endCalled = true;
      send({
        type: "tool.result",
        call_id: msg.call_id,
        result: JSON.stringify({ ok: true, hangup: true, data: { ended: true } }),
        is_error: false,
      });
    }
    if (msg.type === "reply.done") onReplyDone?.();
    if (msg.type === "error" || msg.type === "session.error") console.error("  session error:", msg.message);
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      send({
        type: "session.update",
        session: {
          system_prompt: body.system_prompt,
          greeting: body.greeting,
          output: { voice: voiceId },
          input: { language_codes: body.input.language_codes, turn_detection: body.input.turn_detection },
          tools: [END_CALL_VOICE_TOOL],
        },
      });
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });

  try {
    await waitReply(false); // greeting
    for (const step of steps) {
      if (outcome.endCalled) break;
      if (step.say) {
        heardUser = false;
        const done = waitReply(true);
        queue = Buffer.concat([queue, await speak(step.say)]);
        await done;
      } else {
        const done = waitReply(false);
        send({ type: "reply.create", instructions: step.instructions });
        await done;
      }
    }
    // Let a pending end_call (and the silent reply after its result) settle.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    clearInterval(pump);
    send({ type: "session.end" });
    ws.close();
  }
  return outcome;
}

/**
 * One call through the real VoiceSession. `script` gets `say(line)` (queues
 * caller speech) and resolves when the scenario has had its moment.
 */
type ClientOutcome = {
  events: (BargeInEvent & { at: number })[];
  cutAt: number | null;
  creates: string[];
  agent: string[];
  heard: string[];
  interruptedReplies: number;
  /** When the session ended, and when the agent's last audio finished playing. */
  endedAt: number | null;
  lastAudioEnd: number;
};

async function runClient(
  voiceId: string,
  lines: string[],
  script: (ctx: {
    say: (line: string) => number;
    waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
    replies: () => number;
    /** Agent audio chunks received so far (the greeting included). */
    audioChunks: () => number;
    /** The session has ended (hung up). */
    ended: () => boolean;
  }) => Promise<void>,
): Promise<ClientOutcome> {
  // Render every caller line before dialing: TTS mid-call skews timing.
  const clips = new Map<string, Buffer>();
  for (const line of lines) clips.set(line, await speak(line));
  const body = buildDemoAgentBody(voiceId);
  const outcome: ClientOutcome = {
    events: [], cutAt: null, creates: [], agent: [], heard: [], interruptedReplies: 0, endedAt: null, lastAudioEnd: 0,
  };
  let repliesDone = 0;
  let audioChunks = 0;
  const session = new VoiceSession(
    {
      onBargeIn: (event) => outcome.events.push({ ...event, at: Date.now() }),
      onStateChange: (state) => {
        if (state === "ended" && outcome.endedAt === null) outcome.endedAt = Date.now();
      },
      onTranscript: (turn) => {
        (turn.role === "agent" ? outcome.agent : outcome.heard).push(turn.text);
      },
      onReplyDone: (info) => {
        repliesDone += 1;
        if (info.interrupted) outcome.interruptedReplies += 1;
      },
    },
    {
      toolExecutor: async () => buildEndCallSuccess(false),
      judgeBargeIn: async (state) => {
        try {
          const verdict = await tryJevGateway(
            "barge-in",
            { partialText: state.text, agentSpeakingMs: state.agentSpeakingMs, agentText: state.agentText },
            { apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VOICE_JUDGE_API_KEY, timeoutMs: 400 },
          );
          return verdict.decision === "keep-speaking" ? "keep" : "yield";
        } catch {
          return "yield";
        }
      },
    },
  );
  const internals = session as unknown as Record<string, unknown> & {
    connect: (token: string, config: unknown, gen: number) => void;
    ingestAudio: (data: ArrayBuffer) => void;
    generation: { begin: () => number };
    ws: WebSocket | null;
  };
  // Wall-clock playout: "sounding" until the received audio has had time to play.
  let playUntil = 0;
  internals["playout"] = {
    play: (pcm: Uint8Array, rate: number) => {
      audioChunks += 1;
      playUntil = Math.max(Date.now(), playUntil) + (pcm.byteLength / 2 / rate) * 1000;
      outcome.lastAudioEnd = playUntil;
    },
    flush: () => {
      if (outcome.cutAt === null) outcome.cutAt = Date.now();
      playUntil = Date.now();
    },
    settled: () => Date.now() >= playUntil,
    queuedMs: () => Math.max(0, playUntil - Date.now()),
    onDrained: undefined,
  };
  const gen = internals.generation.begin();
  internals.connect(await token(), {
    mode: "inline",
    systemPrompt: body.system_prompt,
    greeting: body.greeting,
    voiceId,
    languageCodes: body.input.language_codes,
    tools: [END_CALL_VOICE_TOOL],
  }, gen);
  const ws = internals.ws!;
  if (process.env.EVAL_DEBUG) {
    const t0 = Date.now();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "reply.audio") {
        if (msg.reply_id !== (globalThis as Record<string, unknown>).lastAudioReply) {
          (globalThis as Record<string, unknown>).lastAudioReply = msg.reply_id;
          console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} first audio of ${msg.reply_id}`);
        }
        return;
      }
      if (msg.type === "transcript.agent.delta") {
        if (!(globalThis as Record<string, unknown>).sawDelta) console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} first agent delta: ${msg.text}`);
        (globalThis as Record<string, unknown>).sawDelta = true;
        return;
      }
      if (msg.type.endsWith(".delta")) return;
      console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} ${msg.type} ${msg.text ?? msg.status ?? msg.message ?? ""}`);
    });
  }
  const send = ws.send.bind(ws);
  ws.send = (data: string) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "reply.create") outcome.creates.push(String(msg.instructions ?? ""));
    if (process.env.EVAL_DEBUG && msg.type !== "input.audio") console.log(`    -> ${msg.type} ${JSON.stringify(msg.session?.input?.turn_detection ?? msg.instructions ?? "")}`);
    send(data);
  };

  let queue = Buffer.alloc(0);
  const pump = setInterval(() => {
    const frame = queue.length > 0 ? queue.subarray(0, FRAME_BYTES) : Buffer.alloc(FRAME_BYTES);
    queue = queue.subarray(frame.length);
    const padded = frame.length === FRAME_BYTES ? frame : Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    internals.ingestAudio(padded.buffer.slice(padded.byteOffset, padded.byteOffset + padded.byteLength));
  }, 50);
  const waitFor = (predicate: () => boolean, timeoutMs = TURN_TIMEOUT_MS) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (predicate()) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error("timed out waiting"));
        }
      }, 50);
    });
  try {
    await script({
      say: (line) => {
        if (process.env.EVAL_DEBUG) console.log(`    >> say "${line}" (${clips.get(line)!.length / 48000}s)`);
        queue = Buffer.concat([queue, clips.get(line)!]);
        return Date.now();
      },
      waitFor,
      replies: () => repliesDone,
      audioChunks: () => audioChunks,
      ended: () => outcome.endedAt !== null,
    });
  } finally {
    clearInterval(pump);
    await session.stop();
  }
  void TARGET_SAMPLE_RATE;
  return outcome;
}

const LONG_ASK = "Tell me in detail, step by step, how you would help a dental clinic with its phone calls.";

/** After the long ask, wait until the agent's answer is audibly under way. */
async function askAndWaitForSpeech(ctx: Parameters<Parameters<typeof runClient>[2]>[0]) {
  await ctx.waitFor(() => ctx.replies() >= 1); // greeting done
  const greetingChunks = ctx.audioChunks();
  ctx.say(LONG_ASK);
  await ctx.waitFor(() => ctx.audioChunks() > greetingChunks + 5);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // mid-sentence
}

const CLIENT_SCENARIOS: { name: string; run: () => Promise<string | null> }[] = [
  {
    name: "filler-over",
    run: async () => {
      const o = await runClient(voiceIdArg(), [LONG_ASK, "Okaay so"], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        ctx.say("Okaay so");
        await new Promise((resolve) => setTimeout(resolve, 4000));
      });
      console.log(`    filler ${o.interruptedReplies === 0 ? "never cut" : "cut"}; events ${JSON.stringify(o.events.map((e) => [e.verdict, e.text]))}`);
      if (o.interruptedReplies === 0) return null; // never cut
      const resumed = o.creates.some((c) => /Pick up where you left off/.test(c));
      return resumed ? null : `cut and not resumed (events: ${JSON.stringify(o.events.map((e) => [e.verdict, e.text]))})`;
    },
  },
  {
    name: "stop-over",
    run: async () => {
      let spokeAt = 0;
      const o = await runClient(voiceIdArg(), [LONG_ASK, "Wait, stop."], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        spokeAt = ctx.say("Wait, stop.");
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.EVAL_TAIL_MS ?? 4000)));
      });
      if (o.cutAt === null || o.cutAt < spokeAt) return `never cut (events: ${JSON.stringify(o.events.map((e) => e.verdict))})`;
      const ms = o.cutAt - spokeAt;
      console.log(`    cut ${ms}ms after the caller started`);
      return ms <= 1500 ? null : `cut too late: ${ms}ms`;
    },
  },
  {
    name: "over-talk",
    run: async () => {
      const o = await runClient(voiceIdArg(), [LONG_ASK, "We're a bakery, actually."], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        ctx.say("We're a bakery, actually.");
        await new Promise((resolve) => setTimeout(resolve, 15000));
      });
      return o.heard.some((t) => /bakery/i.test(t)) ? null : `never heard (heard: ${JSON.stringify(o.heard)})`;
    },
  },
  {
    name: "hang-up-fast",
    run: async () => {
      const o = await runClient(voiceIdArg(), ["I want you to hang up."], async (ctx) => {
        await ctx.waitFor(() => ctx.replies() >= 1);
        ctx.say("I want you to hang up.");
        await ctx.waitFor(ctx.ended, 20000).catch(() => undefined);
      });
      if (o.endedAt === null) return "never hung up";
      const ms = o.endedAt - o.lastAudioEnd;
      console.log(`    hung up ${ms}ms after the goodbye finished playing`);
      return ms <= 1500 ? null : `hang-up too slow: ${ms}ms`;
    },
  },
  {
    name: "hang-up-over",
    run: async () => {
      const o = await runClient(voiceIdArg(), [LONG_ASK, "I want you to hang up this call."], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        ctx.say("I want you to hang up this call.");
        await ctx.waitFor(ctx.ended, 20000).catch(() => undefined);
      });
      if (o.creates.some((c) => /Pick up where you left off/.test(c))) return "resumed instead of ending";
      if (o.endedAt === null) return "never hung up";
      console.log(`    hung up ${o.endedAt - o.lastAudioEnd}ms after the goodbye finished playing`);
      return null;
    },
  },
  {
    name: "greeting-cut",
    run: async () => {
      let spokeAt = 0;
      const o = await runClient(voiceIdArg(), ["Wait, stop."], async (ctx) => {
        await ctx.waitFor(() => ctx.audioChunks() > 0);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        spokeAt = ctx.say("Wait, stop.");
        await new Promise((resolve) => setTimeout(resolve, 4000));
      });
      if (o.cutAt === null || o.cutAt < spokeAt) return "greeting never cut";
      console.log(`    greeting cut ${o.cutAt - spokeAt}ms after the caller started`);
      return null;
    },
  },
];

type ToolCallRecord = { name: string; args: Record<string, unknown>; at: number; resultAt: number | null };
type ReplyRecord = {
  id: string;
  text: string;
  audioBytes: number;
  afterToolResult: boolean;
  /** Replaced by the call's own reply: never played in the browser. */
  replaced?: boolean;
  /** Its final transcript landed (words land as audio plays; final = done playing). */
  final?: boolean;
};
type ToolOutcome = {
  replies: ReplyRecord[];
  heard: string[];
  tools: ToolCallRecord[];
  endCalled: boolean;
  slowTurns: number;
  /** The platform ignored the call's replacement once, so it was resent. */
  resent?: boolean;
  /** Voni announced her screen without the tool; the call put the test up. */
  screenByPhrase?: boolean;
};
type ToolApi = {
  say: (line: string) => Promise<void>;
  instruct: (instructions: string) => Promise<void>;
  /** Wait until a condition on the outcome holds (or the time runs out). */
  until: (done: (o: ToolOutcome) => boolean, ms?: number) => Promise<boolean>;
  outcome: ToolOutcome;
};
/** The call's Test tag in the eval (EVAL_TAG to try another word). */
const TAG = process.env.EVAL_TAG ?? "Lime 42";
const TAG_WORD = new RegExp(`\\b${TAG.split(" ")[0]}\\b`, "i");
const TAG_NUMBER = TAG.split(" ")[1];

/**
 * One demo call with the demo's real tools over a raw socket. `answer` gives
 * each tool's result, sent back the moment it is ready, like the browser.
 */
async function runToolSession(
  voiceId: string,
  answer: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  script: (api: ToolApi) => Promise<void>,
): Promise<ToolOutcome> {
  const body = buildDemoAgentBody(voiceId);
  const ws = new WebSocket(`${WS}?token=${await token()}`);
  const outcome: ToolOutcome = { replies: [], heard: [], tools: [], endCalled: false, slowTurns: 0 };
  const send = (message: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  let queue = Buffer.alloc(0);
  let ready = false;
  const pump = setInterval(() => {
    if (!ready) return;
    const frame = queue.length > 0 ? queue.subarray(0, FRAME_BYTES) : Buffer.alloc(FRAME_BYTES);
    queue = queue.subarray(frame.length);
    const padded = frame.length === FRAME_BYTES ? frame : Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    send({ type: "input.audio", audio: padded.toString("base64") });
  }, 50);

  const modes = new Map(DEMO_VOICE_TOOLS.map((t) => [t.name, t.execution_mode]));
  const t0 = Date.now();
  let replyActive = false;
  let current: ReplyRecord | null = null;
  let lastWasToolResult = false;
  const held: { callId: string; result: Record<string, unknown>; record: ToolCallRecord }[] = [];
  // Like the browser (voice-call.tsx → VoiceSession.replaceNextReply): once
  // the chip is up, the platform's next reply is replaced by the call's
  // invite (it never plays), or the invite is sent if none starts in 1.5s.
  let replaceNext: ReturnType<typeof setTimeout> | null = null;
  let replacing: string | null = null;
  const sendInvite = () => {
    if (process.env.EVAL_DEBUG) console.log(`    → ${((Date.now() - t0) / 1000).toFixed(2)}s reply.create (invite)`);
    send({ type: "reply.create", instructions: inviteNowInstructions(TAG) });
  };
  const sendResult = (callId: string, result: Record<string, unknown>, record: ToolCallRecord) => {
    record.resultAt = Date.now();
    if (record.name === SHOW_TEST_ADDRESS_TOOL && result.ok === true) {
      replaceNext = setTimeout(() => {
        replaceNext = null;
        sendInvite();
      }, 1500);
    }
    if (process.env.EVAL_DEBUG) console.log(`    → ${((Date.now() - t0) / 1000).toFixed(2)}s tool.result ${record.name}`);
    lastWasToolResult = true;
    send({ type: "tool.result", call_id: callId, result: JSON.stringify(result), is_error: result.ok !== true });
  };
  const flushHeld = () => {
    while (!replyActive && held.length > 0) {
      const next = held.shift()!;
      sendResult(next.callId, next.result, next.record);
    }
  };
  let heardUser = false;
  let onReplyDone: (() => void) | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const waitReply = (afterUser: boolean) =>
    new Promise<void>((resolve) => {
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        outcome.slowTurns += 1;
        onReplyDone = null;
        resolve();
      }, TURN_TIMEOUT_MS);
      onReplyDone = () => {
        if (afterUser && !heardUser) return;
        if (waitTimer) clearTimeout(waitTimer);
        onReplyDone = null;
        resolve();
      };
    });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (process.env.EVAL_DEBUG && (process.env.EVAL_DEBUG === "all" || (!String(msg.type).includes("delta") && msg.type !== "reply.audio"))) {
      console.log(`    · ${((Date.now() - t0) / 1000).toFixed(2)}s ${msg.type} ${msg.reply_id ? `[${String(msg.reply_id).slice(-6)}] ` : ""}${JSON.stringify(msg.text ?? msg.name ?? msg.status ?? msg.message ?? "").slice(0, 100)}`);
    }
    if (msg.type === "session.ready") {
      ready = true;
      // Like the browser: the call's tag, before any invite.
      send({ type: "conversation.message", role: "system", content: testTagContext(TAG) });
    }
    if (msg.type === "transcript.user" && msg.text) {
      outcome.heard.push(msg.text);
      heardUser = true;
    }
    if (msg.type === "reply.started") {
      replyActive = true;
      current = { id: String(msg.reply_id), text: "", audioBytes: 0, afterToolResult: lastWasToolResult };
      if (replaceNext) {
        clearTimeout(replaceNext);
        replaceNext = null;
        current.replaced = true;
        replacing = current.id;
        sendInvite();
      } else if (replacing) replacing = null; // ours started
      lastWasToolResult = false;
      outcome.replies.push(current);
    }
    // Words and audio land as playback runs, often for an earlier reply:
    // attribute them by reply_id, never to "the current reply".
    const owner = (id: unknown) => outcome.replies.find((r) => r.id === String(id)) ?? null;
    if (msg.type === "reply.audio") {
      const r = owner(msg.reply_id);
      if (r) r.audioBytes += Buffer.from(String(msg.data), "base64").length;
    }
    if (msg.type === "transcript.agent.delta" && msg.delta) {
      const r = owner(msg.reply_id);
      if (r) r.text = `${r.text} ${msg.delta}`.trim();
    }
    if (msg.type === "transcript.agent" && msg.text) {
      const r = owner(msg.reply_id);
      // Like the browser (VoiceSession.stripSpokenToolCall): a tool call the
      // model spoke as text still hangs up, and never reaches the captions.
      const spoken = stripSpokenToolCall(String(msg.text));
      if (spoken.endCall) outcome.endCalled = true;
      if (r) {
        r.text = spoken.text;
        r.final = true;
      }
      // Like the browser: Voni announced her screen without the show tool.
      if (!outcome.tools.some((t) => t.name === SHOW_TEST_ADDRESS_TOOL) && !outcome.screenByPhrase && mentionsScreen(String(msg.text))) {
        outcome.screenByPhrase = true;
        const sendWhenIdle = () => (replyActive ? setTimeout(sendWhenIdle, 300) : sendInvite());
        setTimeout(sendWhenIdle, 1200);
      }
    }
    if (msg.type === "tool.call") {
      const args = (typeof msg.arguments === "string" ? JSON.parse(msg.arguments || "{}") : msg.arguments ?? {}) as Record<string, unknown>;
      const record: ToolCallRecord = { name: String(msg.name), args, at: Date.now(), resultAt: null };
      outcome.tools.push(record);
      if (record.name === END_CALL_VOICE_TOOL.name) outcome.endCalled = true;
      void answer(record.name, args).then((result) => {
        // EVAL_HOLD_INTERACTIVE=1 replays the old browser behaviour (held for
        // reply.done), which deadlocks: the server waits for the result.
        // Like the browser: end_call's result waits for the goodbye reply to
        // finish (EVAL_END_CALL=now replays the old cut-the-goodbye behaviour).
        const deferEnd = record.name === END_CALL_VOICE_TOOL.name && replyActive && process.env.EVAL_END_CALL !== "now";
        if ((modes.get(record.name) === "interactive" && process.env.EVAL_HOLD_INTERACTIVE) || deferEnd) {
          held.push({ callId: String(msg.call_id), result, record });
          flushHeld();
          if (deferEnd) {
            // Like VoiceSession: no goodbye audio for a while → the platform waits on us.
            let lastBytes = -1;
            let quietSince = Date.now();
            const watch = setInterval(() => {
              const bytes = current?.audioBytes ?? 0;
              if (bytes !== lastBytes) {
                lastBytes = bytes;
                quietSince = Date.now();
              }
              if (!held.length) clearInterval(watch);
              else if (Date.now() - quietSince >= HELD_RESULT_RELEASE_MS) {
                clearInterval(watch);
                const release = held.splice(0);
                for (const h of release) sendResult(h.callId, h.result, h.record);
              }
            }, 250);
          }
        } else sendResult(String(msg.call_id), result, record);
      });
    }
    if (msg.type === "reply.done") {
      replyActive = false;
      if (replacing && replacing === String(msg.reply_id)) {
        // Like VoiceSession: ours should start right after; if not, resend.
        const replaced = replacing;
        setTimeout(() => {
          if (replacing !== replaced) return;
          replacing = null;
          outcome.resent = true;
          sendInvite();
        }, 1000);
      }
      flushHeld();
      onReplyDone?.();
    }
    if (msg.type === "error" || msg.type === "session.error") console.error("  session error:", msg.message);
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      send({
        type: "session.update",
        session: {
          system_prompt: body.system_prompt,
          greeting: body.greeting,
          output: { voice: voiceId },
          input: { language_codes: body.input.language_codes, turn_detection: body.input.turn_detection },
          tools: process.env.EVAL_END_CALL === "interactive"
            ? DEMO_VOICE_TOOLS.map((t) => (t.name === END_CALL_VOICE_TOOL.name ? { ...t, execution_mode: "interactive" } : t))
            : DEMO_VOICE_TOOLS,
        },
      });
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });

  const api: ToolApi = {
    outcome,
    say: async (line) => {
      if (outcome.endCalled) return;
      heardUser = false;
      const done = waitReply(true);
      queue = Buffer.concat([queue, await speak(line)]);
      await done;
    },
    instruct: async (instructions) => {
      if (outcome.endCalled) return;
      const done = waitReply(false);
      send({ type: "reply.create", instructions });
      await done;
    },
    until: async (done, ms = 15000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (done(outcome)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return done(outcome);
    },
  };
  try {
    await waitReply(false); // greeting
    await script(api);
    // Let held results, a pending end_call, and the replies after them settle.
    await api.until((o) => !replyActive && held.length === 0 && o.replies.length > 0, 8000);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    clearInterval(pump);
    send({ type: "session.end" });
    ws.close();
  }
  return outcome;
}

/** The demo tools as the call routes answer them, with a check_email outcome per scenario. */
function demoAnswers(check: (args: Record<string, unknown>) => CheckEmailResult) {
  return async (name: string, args: Record<string, unknown>) => {
    if (name === CHECK_EMAIL_TOOL) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Gmail + Jev
      const result = check(args);
      return { ok: true, data: { ...checkResultToData(result), instructions: checkEmailInstructions(result) } };
    }
    return (await executeDemoTool(name, args, { testTag: TAG })) as Record<string, unknown>;
  };
}

const NOT_LANDED: CheckEmailResult = { status: "not_arrived", address: null, name: null };
const FOUND: CheckEmailResult = {
  status: "found", address: "andres@casaverde.pt", from: "andres@casaverde.pt", name: "Andres", exact: true, messageId: "m", threadId: "t",
};

/** Talk business until Voni invites the test (calls the show tool). */
async function reachInvite(api: ToolApi): Promise<string | null> {
  for (const line of [
    "We run a small travel agency in Lisbon.",
    "Mostly by phone and email, and we miss a lot of calls after hours.",
    "Sure, let's try something.",
    "Okay, show me what you can do.",
  ]) {
    await api.say(line);
    const before = api.outcome.replies.length;
    if (await api.until((o) => o.tools.some((t) => t.name === SHOW_TEST_ADDRESS_TOOL) || Boolean(o.screenByPhrase), 6000)) {
      // A real caller waits for the invite to finish before acting on it:
      // the reply carrying the tag, once its final transcript has landed.
      await api.until((o) => o.replies.slice(before).some((r) => !r.replaced && r.final && TAG_WORD.test(r.text)), 45000);
      return null;
    }
  }
  return "never invited the email test";
}

/** What the caller hears: replaced replies never play. */
const agentText = (o: ToolOutcome) => o.replies.filter((r) => !r.replaced).map((r) => r.text).filter(Boolean);
/** Any spoken email address other than the team's hi@voni.cc. */
const SPOKEN_ADDRESS = /\b[a-z0-9._-]+\s*(?:@|\bat\b)\s*[a-z0-9-]+\s*(?:\.|\bdot\b)\s*[a-z]{2,}/i;
const strayAddress = (o: ToolOutcome) =>
  agentText(o).find((t) => /pilot|voni\.ai|@/i.test(t.replace(/hi@voni\.cc/gi, "")) || SPOKEN_ADDRESS.test(t.replace(/hi at voni dot c ?c/gi, "")));
const timedOutTool = (o: ToolOutcome) =>
  o.tools.find((t) => t.name !== END_CALL_VOICE_TOOL.name && (t.resultAt ?? Date.now()) - t.at > 30_000);

/** The goodbye's audio must arrive in full: ≥80% of its words' speaking time. */
function goodbyeCut(o: ToolOutcome, bye: ReplyRecord | undefined): string | null {
  if (!bye) return "no goodbye";
  const words = bye.text.split(/\s+/).filter(Boolean).length;
  const expected = words / 3.6; // measured: the greeting speaks ~3.6 words/s
  const played = bye.audioBytes / 48_000;
  return played < expected * 0.8 ? `goodbye audio ${played.toFixed(1)}s for ~${expected.toFixed(1)}s of words: "${bye.text.trim()}"` : null;
}

const EMAIL_SCENARIOS: { name: string; run: (voiceId: string) => Promise<[string | null, ToolOutcome | null]> }[] = [
  {
    name: "bye-audio",
    run: async (voice) => {
      const o = await runToolSession(voice, demoAnswers(() => NOT_LANDED), async (api) => {
        await api.say("We run a small travel agency in Lisbon.");
        await api.instruct(rungInstructions("end", OPEN_BEAT_GOAL));
        await api.until((o) => o.endCalled, 20000);
      });
      if (!o.endCalled) return ["never hung up", o];
      const bye = o.replies.find((r) => /voni dot c|hi@voni|voni\.cc|try again/i.test(r.text));
      return [goodbyeCut(o, bye), o];
    },
  },
  {
    name: "invite-tag",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => NOT_LANDED), async (api) => {
        failed = await reachInvite(api);
      });
      if (failed) return [failed, o];
      const late = timedOutTool(o);
      if (late) return [`${late.name} result took ${((late.resultAt ?? 0) - late.at) / 1000}s (timeout 30s)`, o];
      const stray = strayAddress(o);
      if (stray) return [`spoke or invented an address: "${stray}"`, o];
      const spaced = TAG_NUMBER.split("").join(" ");
      const tagLine = agentText(o).find((t) => TAG_WORD.test(t) && (t.includes(TAG_NUMBER) || /[a-z]+[- ][a-z]+/i.test(t)));
      if (!tagLine) return ["never said the tag", o];
      const tagReplies = agentText(o).filter((t) => TAG_WORD.test(t));
      if (tagReplies.length > 1) return [`said the invite ${tagReplies.length} times`, o];
      if (tagLine.includes(spaced)) return [`said the tag digit by digit: "${tagLine}"`, o];
      // Any "tag … <Word> <number>" that isn't this call's tag was made up.
      const invented = agentText(o)
        .flatMap((t) => [...t.matchAll(/\b([A-Za-z]+)[ -]?(\d{1,3})\b/g)])
        .find((m) => /tag|subject/i.test(m.input ?? "") && !TAG_WORD.test(m[1]) && m[2] !== "0");
      if (invented) return [`invented a tag: "${invented[0]}" in "${invented.input}"`, o];
      return [null, o];
    },
  },
  {
    name: "sent-no-placeholder",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => NOT_LANDED), async (api) => {
        failed = await reachInvite(api);
        if (failed) return;
        await api.say("Okay, I sent it.");
        await api.until((o) => o.tools.some((t) => t.name === CHECK_EMAIL_TOOL), 8000);
      });
      if (failed) return [failed, o];
      // Looking is optional (the browser polls the tag); a made-up address is not.
      const checks = o.tools.filter((t) => t.name === CHECK_EMAIL_TOOL);
      const bad = checks.find((t) => typeof t.args.address === "string" && t.args.address.trim() !== "");
      if (bad) return [`looked with an address nobody said: ${JSON.stringify(bad.args.address)}`, o];
      const confused = agentText(o).find((t) => /didn't catch|say (it|that) again|which address/i.test(t));
      if (confused) return [`asked for an address unprompted: "${confused}"`, o];
      return [null, o];
    },
  },
  {
    name: "forgot-tag",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => NOT_LANDED), async (api) => {
        failed = await reachInvite(api);
        if (failed) return;
        await api.say("Oh, I forgot the tag. I sent it from andres at casaverde dot p t.");
        await api.until((o) => o.tools.some((t) => t.name === CHECK_EMAIL_TOOL && t.args.address), 10000);
      });
      if (failed) return [failed, o];
      const check = o.tools.find((t) => t.name === CHECK_EMAIL_TOOL && typeof t.args.address === "string");
      if (!check) return ["never looked with the address they said", o];
      // What speech-to-text heard ("cassiver.pt") is fine: the server's matcher forgives near misses.
      const address = normalizeClaim(String(check.args.address));
      if (!address?.startsWith("andres@") || !address.endsWith(".pt")) return [`looked with ${JSON.stringify(check.args.address)}`, o];
      return [null, o];
    },
  },
  {
    name: "free-gate",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => ({ status: "free", address: "andres@gmail.com" })), async (api) => {
        failed = await reachInvite(api);
        if (failed) return;
        await api.say("Okay, I sent it.");
        // A real caller answers once the question is finished (final transcript).
        await api.until((o) => o.replies.some((r) => r.final && /work email/i.test(r.text)), 25000);
        await api.say("No, I don't have one.");
        await api.until((o) => o.endCalled, 15000);
      });
      if (failed) return [failed, o];
      if (!agentText(o).some((t) => /work email/i.test(t))) return ["never asked for a work email", o];
      if (!o.endCalled) return ["never hung up after the gate", o];
      const bye = o.replies.find((r) => /voni dot c|hi@voni|voni\.cc/i.test(r.text));
      if (!bye) return ["the goodbye never named hi@voni.cc", o];
      const words = bye.text.split(/\s+/).filter(Boolean).length;
      const expected = words / 3.6; // measured: the greeting speaks ~3.6 words/s
      const played = bye.audioBytes / 48_000;
      if (played < expected * 0.8) return [`goodbye audio ${played.toFixed(1)}s for ~${expected.toFixed(1)}s of words: "${bye.text}"`, o];
      return [null, o];
    },
  },
  {
    name: "late-close",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => NOT_LANDED), async (api) => {
        failed = await reachInvite(api);
        if (failed) return;
        await api.instruct(LATE_EMAIL_INSTRUCTIONS);
        await api.until((o) => o.endCalled, 10000);
      });
      if (failed) return [failed, o];
      if (!agentText(o).some((t) => /moment it (lands|arrives)|as soon as it (lands|arrives|comes)|when it (lands|arrives)/i.test(t)))
        return ["never promised to reply when it lands", o];
      if (!o.endCalled) return ["never hung up", o];
      return [null, o];
    },
  },
  {
    name: "returning",
    run: async (voice) => {
      let failed: string | null = null;
      const o = await runToolSession(voice, demoAnswers(() => ({ ...FOUND, returning: true })), async (api) => {
        failed = await reachInvite(api);
        if (failed) return;
        await api.say("Okay, I sent it.");
        await api.until((o) => o.replies.some((r) => r.afterToolResult && /andres/i.test(r.text)), 20000);
      });
      if (failed) return [failed, o];
      const greet = agentText(o).find((t) => /andres/i.test(t));
      if (!greet) return ["never greeted Andres", o];
      if (!agentText(o).some((t) => /again|back|good to hear/i.test(t))) return [`not greeted as returning: "${greet}"`, o];
      if (o.tools.filter((t) => t.name === SHOW_TEST_ADDRESS_TOOL).length > 1) return ["invited the test again", o];
      return [null, o];
    },
  },
];

function voiceIdArg(): string {
  return arg("--voice", "anna");
}

const SCENARIOS: { name: string; steps: Step[]; pass: (o: Outcome) => string | null }[] = [
  {
    name: "hang-up",
    steps: [{ say: "I want you to hang up." }],
    pass: (o) =>
      !o.endCalled
        ? "no end_call tool call"
        : o.agent.some((t) => /end_call/.test(t))
          ? "spoke the tool name"
          : null,
  },
  {
    name: "refusal",
    steps: [
      { say: "What kind of business do I run? I don't want to tell you." },
      { instructions: rungInstructions("nudge", OPEN_BEAT_GOAL) },
      { say: "No. I'm not telling you anything." },
      { instructions: rungInstructions("warning", OPEN_BEAT_GOAL) },
      { say: "Nope, still not telling." },
      { instructions: rungInstructions("end", OPEN_BEAT_GOAL) },
    ],
    pass: (o) => {
      const fake = o.agent.find((t) => FAKE.test(t));
      if (fake) return `offered a pretend business: "${fake}"`;
      if (!o.endCalled) return "never called end_call";
      if (o.agent.some((t) => /end_call/.test(t))) return "spoke the tool name";
      return null;
    },
  },
];

const runs = Number(arg("--runs", "5"));
const voiceId = arg("--voice", "anna");
const only = arg("--scenario", "");
let failures = 0;
for (const scenario of SCENARIOS.filter((s) => !only || s.name === only)) {
  let passed = 0;
  for (let i = 1; i <= runs; i++) {
    let reason: string | null;
    let outcome: Outcome | null = null;
    try {
      outcome = await runSession(voiceId, scenario.steps);
      reason = scenario.pass(outcome);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (reason === null) passed += 1;
    else {
      failures += 1;
      console.log(`  ✗ ${scenario.name} #${i}: ${reason}`);
      if (outcome) {
        console.log(`    heard: ${outcome.heard.map((t) => JSON.stringify(t)).join(" | ")}`);
        console.log(`    agent: ${outcome.agent.map((t) => JSON.stringify(t)).join(" → ")}`);
      }
    }
  }
  console.log(`${scenario.name}: ${passed}/${runs}`);
}
for (const scenario of CLIENT_SCENARIOS.filter((s) => !only || s.name === only)) {
  let passed = 0;
  for (let i = 1; i <= runs; i++) {
    let reason: string | null;
    try {
      reason = await scenario.run();
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (reason === null) passed += 1;
    else {
      failures += 1;
      console.log(`  ✗ ${scenario.name} #${i}: ${reason}`);
    }
  }
  console.log(`${scenario.name}: ${passed}/${runs}`);
}
for (const scenario of EMAIL_SCENARIOS.filter((s) => !only || s.name === only)) {
  let passed = 0;
  for (let i = 1; i <= runs; i++) {
    let reason: string | null;
    let outcome: ToolOutcome | null = null;
    try {
      [reason, outcome] = await scenario.run(voiceId);
      if (outcome?.resent) console.log(`  · ${scenario.name} #${i}: the invite had to be resent`);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (reason === null) passed += 1;
    else {
      failures += 1;
      console.log(`  ✗ ${scenario.name} #${i}: ${reason}`);
      if (outcome) {
        console.log(`    heard: ${outcome.heard.map((t) => JSON.stringify(t)).join(" | ")}`);
        console.log(`    agent: ${agentText(outcome).map((t) => JSON.stringify(t)).join(" → ")}`);
        console.log(`    tools: ${outcome.tools.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(", ")}`);
      }
    }
  }
  console.log(`${scenario.name}: ${passed}/${runs}`);
}
process.exit(failures > 0 ? 1 : 0);
