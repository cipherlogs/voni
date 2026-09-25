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
 * Scenarios:
 *   hang-up   "I want you to hang up." → a real end_call tool call, and the
 *             tool name is never spoken.
 *   refusal   three refusals through nudge → warning → end rungs → no fake /
 *             pretend business is ever offered, and it ends with end_call.
 */
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
import { OPEN_BEAT_GOAL, rungInstructions } from "../src/lib/demo/voni-agent";
import { END_CALL_VOICE_TOOL } from "../src/lib/tools/definitions";

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
process.exit(failures > 0 ? 1 : 0);
