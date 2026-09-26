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
 *   greeting-cut  "Wait, stop." 1s into the greeting → the greeting is cut.
 */
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
import { OPEN_BEAT_GOAL, rungInstructions } from "../src/lib/demo/voni-agent";
import { buildEndCallSuccess, END_CALL_VOICE_TOOL } from "../src/lib/tools/definitions";
import { TARGET_SAMPLE_RATE, VoiceSession, type BargeInEvent } from "../src/lib/voice/session";
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
process.exit(failures > 0 ? 1 : 0);
