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
 *   npm run eval:demo-agent -- [--runs 5] [--voice <demo-voice-id>] [--scenario hang-up]
 *
 * Every live call prints `  · trace session sess_…` when the session is
 * ready: score-demo chains its Call trace merge from that id, so per-turn
 * Reply gaps come from the merger instead of an estimate.
 *
 * The run ends with one machine-readable `EVAL SUMMARY {...}` line: it proves
 * the runner finished, so scenario failures stay judgment (exit 1) while the
 * scoreboard reports plumbing PASS. Live client runs also print
 * `    playout <ms>ms wall clock`, carried in the summary as report-only
 * timings — never folded into a gate. A crash, kill, or summary-less exit is
 * a harness break; the summary also names trace sessions and agent audio so
 * a silent or untraced run is classified as a harness break too.
 *
 * Each live client call prints one `SILENCE TIMELINE {...}` line: the agent
 * and caller audio windows, every agent reply start / reply.create (coverage),
 * and any check-ins, all call-relative ms. score-demo derives the free-floor
 * silences from it, so dead air is measured from the call's own events rather
 * than typed in by an operator.
 *
 * Each goodbye run prints one `GOODBYE DRAIN {...}` line: the closing reply's
 * turn, its played/expected audio coverage, and whether it named the team
 * inbox (hi@voni.cc, said "hi at voni dot c c"). bye-audio and free-gate both
 * assert the inbox and the 80% coverage bar; score-demo gates the measured
 * numbers and cites the closing turn on a FAIL.
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
 *                 A cut prints the agent line, the words heard before it, and
 *                 the resumed tail, so the scoreboard can prove the exact
 *                 unheard rest played instead of a paraphrase or a skip.
 *   stop-over     "Wait, stop." over a long reply → cut within ~1.5s, answered.
 *   over-talk     a short answer over the reply → heard (never lost), and the
 *                 fake playout records the post-flush residual overlap per
 *                 server cut (caller speech + faded agent audio). Prints one
 *                 `DOUBLE TALK {...}` line and asserts the 400ms bar; time to
 *                 cut stays the barge-in-cut budget, never this one.
 *   hang-up-over  "I want you to hang up this call." over a long reply →
 *                 the call ends, never resumed ("as I was saying").
 *   greeting-cut  "Wait, stop." 1s into the greeting → cut inside the locked
 *                 greeting window; the scenario asserts the ms it prints.
 *   silence-check-in  the caller stays silent on a free floor → exactly one
 *                 check-in after the real 15s; prints `check-ins N at <ms>ms`
 *                 and its events feed the SILENCE TIMELINE / dead-air gate.
 *
 * Cut latency is measured from caller speech start (the pump's first
 * transmitted frame carrying the clip's first voiced sample) to the server
 * cut, never from the enqueue tick. Caller clips are cached as PCM in
 * `.eval-clips/` and fingerprinted (words + bytes + duration + onset), so
 * greeting-cut and real-cut runs speak the identical audio every time.
 * Timing runs beat the scoreboard's one-at-a-time lock (score-demo).
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
import {
  checkEmailInstructions,
  DEMO_VOICE_IDS,
  inviteNowInstructions,
  LATE_EMAIL_INSTRUCTIONS,
  SILENCE_CHECK_IN_INSTRUCTIONS,
  SILENCE_CHECK_IN_MS,
  testTagContext,
  OPEN_BEAT_GOAL,
  rungInstructions,
} from "../src/lib/demo/voni-agent";
import { CHECK_EMAIL_TOOL, DEMO_VOICE_TOOLS, executeDemoTool, SHOW_TEST_ADDRESS_TOOL } from "../src/lib/demo/demo-tools";
import {
  checkResultToData,
  DEMO_INBOX_ADDRESS,
  mentionsScreen,
  normalizeClaim,
  type CheckEmailResult,
} from "../src/lib/demo/email-test";
import { buildEndCallSuccess, END_CALL_VOICE_TOOL } from "../src/lib/tools/definitions";
import {
  HELD_RESULT_RELEASE_MS,
  heardWords,
  stripSpokenToolCall,
  TARGET_SAMPLE_RATE,
  VoiceSession,
  type BargeInEvent,
} from "../src/lib/voice/session";
import { tryJevGateway } from "../src/lib/voice/voice-judge";
import {
  callerClipDrift,
  callerClipFingerprint,
  callerSpeechStart,
  deriveFreeFloorSilence,
  DOUBLE_TALK_EVIDENCE_PREFIX,
  DOUBLE_TALK_FADE_OUT_S,
  DOUBLE_TALK_MAX_OVERLAP_MS,
  EMAIL_INVITE_EVIDENCE_PREFIX,
  fillerHandlingFor,
  GOODBYE_DRAIN_EVIDENCE_PREFIX,
  greetingCutFailure,
  GREETING_CUT_MAX_MS,
  heardPoint,
  namesTeamInbox,
  TEAM_INBOX_ADDRESS,
  isResumeInstructions,
  isSilenceCheckInInstructions,
  judgePostCutAnswer,
  measureCutLatency,
  playoutCutWindow,
  postCutAnswerText,
  postFlushOverlapMs,
  REAL_CUT_ANSWER_PREFIX,
  REAL_CUT_MAX_MS,
  REAL_CUT_SCENARIOS,
  sha256Hex,
  SILENCE_CHECK_IN_MAX_MS,
  SILENCE_CHECK_IN_TARGET_MS,
  SILENCE_TIMELINE_PREFIX,
  type AudibleWindow,
  type CallerClipFingerprint,
  type CallerOnset,
  type DoubleTalkCut,
  type EmailInviteEvidenceFile,
  type FillerAnswerMarker,
  type SilenceTimeline,
} from "../src/lib/demo/scoreboard";

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
type Outcome = { agent: string[]; heard: string[]; endCalled: boolean; sessionId?: string };

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

/**
 * Caller speech: a session whose greeting is the line, captured as PCM16.
 *
 * The clip is fixed by words AND audio: a per-process memory cache plus an
 * on-disk PCM cache keyed by caller voice + words means every run streams the
 * identical bytes, so cut latency stays comparable. Every clip gets a
 * fingerprint (words, bytes, duration, leading silence) printed once; a
 * re-synthesized or edited take is therefore visible in the run output.
 */
const speechCache = new Map<string, Buffer>();
const clipPrints = new Map<string, CallerClipFingerprint>();
const printedClips = new Set<string>();
const CLIP_CACHE_DIR = process.env.EVAL_CLIP_CACHE_DIR || fileURLToPath(new URL("../.eval-clips/", import.meta.url));

function clipCachePath(line: string): string {
  return join(CLIP_CACHE_DIR, `${sha256Hex(`${CALLER_VOICE}\n${line}`)}.pcm`);
}

function rememberClip(line: string, pcm: Buffer, source: "cached" | "synthesized"): CallerClipFingerprint {
  const fingerprint = callerClipFingerprint(line, pcm, TARGET_SAMPLE_RATE);
  const prior = clipPrints.get(line);
  if (prior) {
    const drift = callerClipDrift(prior, fingerprint);
    if (drift) throw new Error(`caller clip "${line}" changed mid-run: ${drift}`);
    return prior;
  }
  clipPrints.set(line, fingerprint);
  if (!printedClips.has(line)) {
    printedClips.add(line);
    console.log(
      `    clip "${line}" sha256=${fingerprint.sha256.slice(0, 12)} ${fingerprint.bytes}B ` +
        `${fingerprint.durationMs}ms onset ${fingerprint.onsetMs.toFixed(1)}ms (${source})`,
    );
  }
  return fingerprint;
}

function readClipCache(line: string): Buffer | null {
  try {
    const pcm = readFileSync(clipCachePath(line));
    return pcm.byteLength > 0 && pcm.byteLength % 2 === 0 ? pcm : null;
  } catch {
    return null;
  }
}

function writeClipCache(line: string, pcm: Buffer): void {
  try {
    mkdirSync(CLIP_CACHE_DIR, { recursive: true });
    writeFileSync(clipCachePath(line), pcm, { mode: 0o600 });
  } catch (error) {
    console.error(`  caller clip cache write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function speak(line: string): Promise<Buffer> {
  const inMemory = speechCache.get(line);
  if (inMemory) return inMemory;
  const onDisk = readClipCache(line);
  if (onDisk) {
    rememberClip(line, onDisk, "cached");
    speechCache.set(line, onDisk);
    return onDisk;
  }
  // The throwaway TTS session is infrastructure, not the thing under test:
  // one retry on a timeout keeps a network blip from failing a scenario.
  const pcm = await speakOnce(line).catch(() => speakOnce(line));
  rememberClip(line, pcm, "synthesized");
  speechCache.set(line, pcm);
  writeClipCache(line, pcm);
  return pcm;
}

async function speakOnce(line: string): Promise<Buffer> {
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
    if (msg.type === "session.ready") {
      ready = true;
      // The id the operator (or score-demo's auto-chain) merges the Call trace with.
      if (typeof msg.session_id === "string" && msg.session_id.length > 0) {
        outcome.sessionId = msg.session_id;
        console.log(`  · trace session ${msg.session_id}`);
      }
    }
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

/** The most recent live client run: playout is reported, never gated. */
let lastClientOutcome: ClientOutcome | null = null;
/** Read the last live client run without control-flow narrowing it to null. */
function latestClientOutcome(): ClientOutcome | null {
  return lastClientOutcome;
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
  /** Final agent turns with their reply id, for separating the cut reply from the answer. */
  agentTurns: { replyId: string | null; text: string; at: number }[];
  /** Final user turns with arrival times, so the answer is the one after the point. */
  heardTurns: { text: string; at: number }[];
  /** The reply the server interrupted, if any. */
  cutReplyId: string | null;
  /** First agent-audio arrival per reply id (cut → resume first audio). */
  replyAudioAt: Record<string, number>;
  /**
   * Played ms of the cut reply at the server cut, from the wall-clock playout
   * (the same source-latency maths the session uses for its heard words).
   * Null when the cut reply never had audio measured.
   */
  cutPlayedMs: number | null;
  interruptedReplies: number;
  /** The live session's id, for the Call trace merge. */
  sessionId: string | null;
  /** When the session ended, and when the agent's last audio finished playing. */
  endedAt: number | null;
  lastAudioEnd: number;
  /** Live-call wall clock from dial to stop, excluding caller clip rendering. */
  wallClockMs: number;
  /** Agent audio chunks received during the call. */
  audioChunks: number;
  /** Fingerprints of the fixed caller clips this call streamed. */
  callerClips: CallerClipFingerprint[];
  /**
   * Post-flush residual overlap per server cut, ms: the time both the caller's
   * speech and the agent's faded playout were still sounding after the flush.
   * Never time-to-cut (that is the barge-in-cut budget, up to 1500ms).
   */
  overlapMs: number[];
  /** The cut windows those overlaps came from (playout timings, for triage). */
  cutWindows: DoubleTalkCut[];
  /** The fade the last flush applied, ms (the worklet's FADE_OUT_S). */
  lastFadeMs: number;
  /** Agent audio playout windows, call-relative ms (the silence timeline). */
  agentWindows: { startMs: number; endMs: number }[];
  /** Agent reply starts / reply.create requests, call-relative ms: coverage. */
  coverageAt: { atMs: number }[];
  /** Silence check-ins that went out, call-relative ms. */
  checkIns: { atMs: number; overCaller: boolean }[];
  /** The call's free-floor silence timeline, built once the call has ended. */
  silenceTimeline: SilenceTimeline | null;
};

/** Options for one call; only the check-in scenario enables the check-in. */
type ClientOptions = {
  /**
   * Wire the demo's own free-floor silence check-in (the same constants the
   * landing UI passes). The live call then needs real silence: the 15s target
   * is never shortened for the eval.
   */
  silenceCheckIn?: boolean;
};

/**
 * One caller utterance handed back by `say`: the enqueue tick, the fixed
 * clip's onset, and the pump's first transmitted frame for that onset. The
 * measurement uses `onset()`, never `enqueuedAt`.
 */
type CallerSpeech = {
  line: string;
  enqueuedAt: number;
  onsetMs: number;
  /** Snapshot for measureCutLatency, filled once the pump transmits the onset. */
  onset: () => CallerOnset;
};

/**
 * The fresh agent line after the cut and the caller's point. Uses the shared
 * selector so the runner and the scoreboard agree on what counts as the
 * answer; the interrupted reply is excluded by id.
 */
function postCutAnswerOf(outcome: ClientOutcome, point: string): string | null {
  return postCutAnswerText({
    cutAt: outcome.cutAt,
    cutReplyId: outcome.cutReplyId,
    point,
    heardTurns: outcome.heardTurns,
    agentTurns: outcome.agentTurns,
  });
}

/**
 * The tail the filler cut interrupted and the resume that followed. The agent
 * line is the cut reply's own transcript, the heard words come from the
 * wall-clock playout at the cut (the same source the session reads), and the
 * resumed words are the first agent line after the cut. Null means the runner
 * could not measure it — never a guessed tail.
 */
function fillerTailOf(outcome: ClientOutcome): {
  agentText: string;
  heardText: string;
  resumedText: string;
  resumeMs: number | null;
} | null {
  const cutAt = outcome.cutAt;
  if (cutAt === null) return null;
  const cutTurn =
    outcome.agentTurns.find((turn) => outcome.cutReplyId !== null && turn.replyId === outcome.cutReplyId) ??
    [...outcome.agentTurns].reverse().find((turn) => turn.at <= cutAt);
  const agentText = cutTurn?.text.trim() ? cutTurn.text : "";
  if (!agentText || outcome.cutPlayedMs === null) return null;
  const resumedTurn = outcome.agentTurns.find(
    (turn) => turn !== cutTurn && turn.replyId !== outcome.cutReplyId && turn.at >= cutAt && turn.text.trim(),
  );
  const firstAudioAt = resumedTurn?.replyId ? (outcome.replyAudioAt[resumedTurn.replyId] ?? null) : null;
  return {
    agentText,
    heardText: heardWords(agentText, outcome.cutPlayedMs),
    resumedText: resumedTurn?.text ?? "",
    resumeMs: firstAudioAt !== null ? Math.max(0, Math.round(firstAudioAt - cutAt)) : null,
  };
}

async function runClient(
  voiceId: string,
  lines: string[],
  script: (ctx: {
    say: (line: string) => CallerSpeech;
    waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
    replies: () => number;
    /** Silence check-ins sent so far (matching the demo's check-in instructions). */
    checkIns: () => number;
    /** Agent audio chunks received so far (the greeting included). */
    audioChunks: () => number;
    /** The session has ended (hung up). */
    ended: () => boolean;
    /** The first fresh agent line after the cut and the point, or null. */
    postCutAnswer: (point: string) => string | null;
    /** Whether a final user transcript carried the given point word. */
    heardPoint: (point: string) => boolean;
  }) => Promise<void>,
  options: ClientOptions = {},
): Promise<ClientOutcome> {
  // Render every caller line before dialing: TTS mid-call skews timing.
  const clips = new Map<string, Buffer>();
  for (const line of lines) clips.set(line, await speak(line));
  // The live call starts here: clip rendering must never inflate playout.
  const liveStartedAt = Date.now();
  // Call-relative origin for the silence timeline and the playout maths.
  const t0 = Date.now();
  const body = buildDemoAgentBody(voiceId);
  const outcome: ClientOutcome = {
    events: [], cutAt: null, creates: [], agent: [], heard: [], agentTurns: [], heardTurns: [], cutReplyId: null,
    replyAudioAt: {}, cutPlayedMs: null,
    interruptedReplies: 0, sessionId: null, endedAt: null, lastAudioEnd: 0,
    wallClockMs: 0, audioChunks: 0, callerClips: lines.map((line) => clipPrints.get(line)!),
    overlapMs: [], cutWindows: [], lastFadeMs: 0, agentWindows: [], coverageAt: [], checkIns: [], silenceTimeline: null,
  };
  let repliesDone = 0;
  let audioChunks = 0;
  const session = new VoiceSession(
    {
      onBargeIn: (event) => outcome.events.push({ ...event, at: Date.now() }),
      // A reply started: the agent is covering the floor. Together with our
      // own reply.create requests this is the dead-air coverage evidence.
      onReplyStarted: () => outcome.coverageAt.push({ atMs: Math.max(0, Date.now() - t0) }),
      // One machine-readable marker per live call: score-demo chains its Call
      // trace merge from it, and the operator can replay the same id.
      onSessionReady: (sessionId) => {
        outcome.sessionId = sessionId;
        console.log(`  · trace session ${sessionId}`);
      },
      onStateChange: (state) => {
        if (state === "ended" && outcome.endedAt === null) outcome.endedAt = Date.now();
      },
      onTranscript: (turn) => {
        (turn.role === "agent" ? outcome.agent : outcome.heard).push(turn.text);
      },
      onAgentTurn: (turn) => {
        outcome.agentTurns.push({ replyId: turn.itemId, text: turn.text, at: Date.now() });
      },
      onUserTurn: (turn) => {
        outcome.heardTurns.push({ text: turn.text, at: Date.now() });
      },
      onReplyDone: (info) => {
        repliesDone += 1;
        if (info.interrupted) {
          outcome.interruptedReplies += 1;
          if (info.replyId) outcome.cutReplyId = info.replyId;
        }
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
  // The landing UI wires the same check-in on demo calls (voice-call.tsx);
  // the eval has no mute/hold/closing state, so it is always allowed here.
  if (options.silenceCheckIn) {
    session.setSilenceCheckIn({
      afterMs: SILENCE_CHECK_IN_MS,
      instructions: SILENCE_CHECK_IN_INSTRUCTIONS,
      allowed: () => true,
    });
  }
  // Wall-clock playout: "sounding" until the received audio has had time to play.
  let playUntil = 0;
  // Source-sample bookkeeping so the fake playout can report what actually
  // played: the session's heard-word maths reads `consumedSamples`, and a
  // playout that cannot report makes the caller "hear" the whole line — a
  // resume would then re-say one word and look exact while skipping the rest.
  let sentSamples = 0;
  const replyAudioStartSamples: Record<string, number> = {};
  let soundingReplyId: string | null = null;
  /** The playout window the last chunk opened, truncated if the flush cuts it. */
  let lastAgentWindow: { startMs: number; endMs: number } | null = null;
  const consumedSamplesNow = () => {
    const queuedMs = Math.max(0, playUntil - Date.now());
    const queuedSamples = Math.ceil((queuedMs / 1000) * TARGET_SAMPLE_RATE);
    return Math.max(0, sentSamples - Math.min(sentSamples, queuedSamples));
  };
  // Teardown flushes the playout too. Only a flush during the live scenario is
  // a server cut; counting the teardown flush would report a never-cut call as
  // a late cut and cite a turn that never lagged.
  let live = true;
  // Caller speech bookkeeping for the double-talk window: each clip's first
  // transmitted frame (the same t0 the cut gate uses) and its speech length.
  type ClipOnset = {
    enqueuedAt: number;
    onsetByte: number;
    onsetMs: number;
    /** Clip-relative end of the spoken audio (whole clip, trailing silence included). */
    durationMs: number;
    firstFrameAt: number | null;
    frameOffsetMs: number | null;
  };
  const onsets: ClipOnset[] = [];
  /** The caller utterance sounding at `at`, from its transmitted onset to its end. */
  const callerWindowAt = (at: number): AudibleWindow | null => {
    for (const onset of onsets) {
      const start = callerSpeechStart({
        enqueuedAt: onset.enqueuedAt,
        firstFrameAt: onset.firstFrameAt,
        onsetMs: onset.onsetMs,
        ...(onset.frameOffsetMs === null ? {} : { frameOffsetMs: onset.frameOffsetMs }),
      });
      if (start === null) continue;
      const end = start + Math.max(0, onset.durationMs - onset.onsetMs);
      if (start <= at && at < end) return { start, end };
    }
    return null;
  };
  internals["playout"] = {
    play: (pcm: Uint8Array, rate: number) => {
      audioChunks += 1;
      sentSamples += pcm.byteLength / 2;
      const startedAt = Math.max(Date.now(), playUntil);
      playUntil = startedAt + (pcm.byteLength / 2 / rate) * 1000;
      outcome.lastAudioEnd = playUntil;
      lastAgentWindow = {
        startMs: Math.max(0, startedAt - t0),
        endMs: Math.max(0, playUntil - t0),
      };
      outcome.agentWindows.push(lastAgentWindow);
    },
    flush: (fadeS = 0) => {
      const at = Date.now();
      // The flush drops whatever had not played: end the sounding window here
      // so the silence timeline never claims audio the caller never heard.
      if (lastAgentWindow) {
        const playedEnd = Math.max(lastAgentWindow.startMs, at - t0);
        lastAgentWindow.endMs = Math.max(lastAgentWindow.startMs, Math.min(lastAgentWindow.endMs, playedEnd));
      }
      if (live) {
        // The session flushes with FADE_OUT_S: what is sounding ramps to
        // silence over the fade and the rest is dropped. Record what the
        // caller actually still heard under their own speech after the flush.
        const fadeMs = Math.max(0, fadeS * 1000);
        outcome.lastFadeMs = fadeMs;
        const window = playoutCutWindow({
          cutAt: at,
          playUntil,
          fadeMs,
          caller: callerWindowAt(at),
        });
        outcome.cutWindows.push(window);
        outcome.overlapMs.push(postFlushOverlapMs(window));
      }
      if (live && outcome.cutAt === null) {
        outcome.cutAt = at;
        const cutReply = outcome.cutReplyId ?? soundingReplyId;
        const start = cutReply !== null ? replyAudioStartSamples[cutReply] : undefined;
        // Played source samples since this reply's first chunk at the same
        // instant the session reads them for its unheard rest.
        if (start !== undefined) {
          outcome.cutPlayedMs = Math.max(0, ((consumedSamplesNow() - start) / TARGET_SAMPLE_RATE) * 1000);
        }
      }
      playUntil = at;
    },
    settled: () => Date.now() >= playUntil,
    queuedMs: () => Math.max(0, playUntil - Date.now()),
    sentSamples: () => sentSamples,
    consumedSamples: () => consumedSamplesNow(),
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
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === "reply.audio") {
      if (typeof msg.reply_id === "string") {
        if (outcome.replyAudioAt[msg.reply_id] === undefined) outcome.replyAudioAt[msg.reply_id] = Date.now();
        // The session's own handler already queued this chunk before ours runs,
        // so this reply's playout start is the running total minus the chunk.
        if (replyAudioStartSamples[msg.reply_id] === undefined) {
          const chunkSamples = Buffer.from(String(msg.data ?? ""), "base64").byteLength / 2;
          replyAudioStartSamples[msg.reply_id] = Math.max(0, sentSamples - chunkSamples);
        }
        soundingReplyId = msg.reply_id;
      }
      if (process.env.EVAL_DEBUG && msg.reply_id !== (globalThis as Record<string, unknown>).lastAudioReply) {
        (globalThis as Record<string, unknown>).lastAudioReply = msg.reply_id;
        console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} first audio of ${msg.reply_id}`);
      }
      return;
    }
    if (!process.env.EVAL_DEBUG) return;
    if (msg.type === "transcript.agent.delta") {
      if (!(globalThis as Record<string, unknown>).sawDelta) console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} first agent delta: ${msg.text}`);
      (globalThis as Record<string, unknown>).sawDelta = true;
      return;
    }
    if (msg.type.endsWith(".delta")) return;
    console.log(`    ${((Date.now() - t0) / 1000).toFixed(2)} ${msg.type} ${msg.text ?? msg.status ?? msg.message ?? ""}`);
  });
  const send = ws.send.bind(ws);
  ws.send = (data: string) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "reply.create") {
      const instructions = String(msg.instructions ?? "");
      outcome.creates.push(instructions);
      const atMs = Math.max(0, Date.now() - t0);
      outcome.coverageAt.push({ atMs });
      // Only the floor's exact check-in instruction counts as a check-in:
      // never a greeting, invite, or resume that mentions being quiet.
      if (isSilenceCheckInInstructions(instructions)) {
        outcome.checkIns.push({ atMs, overCaller: callerWindowAt(Date.now()) !== null });
      }
    }
    if (process.env.EVAL_DEBUG && msg.type !== "input.audio") console.log(`    -> ${msg.type} ${JSON.stringify(msg.session?.input?.turn_detection ?? msg.instructions ?? "")}`);
    send(data);
  };

  // Mic pump: stream 50ms PCM16 frames in real time. `sentQueueBytes` counts
  // only bytes actually dequeued (not the silence padding), so each clip's
  // first transmitted frame can be stamped for the cut-latency t0.
  let queue = Buffer.alloc(0);
  let queuedBytes = 0;
  let sentQueueBytes = 0;
  const pump = setInterval(() => {
    const fromQueue = queue.length > 0;
    const frame = fromQueue ? queue.subarray(0, FRAME_BYTES) : Buffer.alloc(FRAME_BYTES);
    if (fromQueue) {
      const frameStart = sentQueueBytes;
      sentQueueBytes += frame.length;
      const sentAt = Date.now();
      for (const onset of onsets) {
        if (onset.firstFrameAt !== null || sentQueueBytes <= onset.onsetByte) continue;
        // Sub-frame precision: the onset sample sits at a known offset inside
        // the frame that just left, and frames tally with real time.
        onset.firstFrameAt = sentAt;
        onset.frameOffsetMs = Math.max(
          0,
          ((onset.onsetByte - frameStart) / 2 / TARGET_SAMPLE_RATE) * 1000,
        );
      }
    }
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
        const pcm = clips.get(line)!;
        const fingerprint = clipPrints.get(line)!;
        const enqueuedAt = Date.now();
        const onset: ClipOnset = {
          enqueuedAt,
          onsetByte: queuedBytes + Math.round((fingerprint.onsetMs / 1000) * TARGET_SAMPLE_RATE) * 2,
          onsetMs: fingerprint.onsetMs,
          durationMs: (pcm.byteLength / 2 / TARGET_SAMPLE_RATE) * 1000,
          firstFrameAt: null,
          frameOffsetMs: null,
        };
        queuedBytes += pcm.byteLength;
        onsets.push(onset);
        if (process.env.EVAL_DEBUG) console.log(`    >> say "${line}" (${pcm.length / 48000}s)`);
        queue = Buffer.concat([queue, pcm]);
        return {
          line,
          enqueuedAt,
          onsetMs: fingerprint.onsetMs,
          onset: () => ({
            enqueuedAt,
            firstFrameAt: onset.firstFrameAt,
            onsetMs: onset.onsetMs,
            ...(onset.frameOffsetMs === null ? {} : { frameOffsetMs: onset.frameOffsetMs }),
          }),
        };
      },
      waitFor,
      replies: () => repliesDone,
      checkIns: () => outcome.checkIns.length,
      audioChunks: () => audioChunks,
      ended: () => outcome.endedAt !== null,
      postCutAnswer: (point) => postCutAnswerOf(outcome, point),
      heardPoint: (point) => heardPoint(outcome.heard, point),
    });
  } finally {
    live = false;
    clearInterval(pump);
    // The scenario's own end: for the check-in run the deliberate silence is
    // the measured window, so a zero-check-in stretch must not vanish as
    // trailing idle. Every other scenario keeps the audible-only window.
    const observedEndMs = Date.now() - t0;
    await session.stop();
    // The call's own silence timeline: audible agent/caller windows plus the
    // agent reply starts / reply.create requests that covered the floor. It
    // runs from the first to the last audible event, so the scenario's own
    // trailing observation wait is never reported as dead air.
    const callerSpeech = onsets
      .map((onset) => {
        const start = callerSpeechStart({
          enqueuedAt: onset.enqueuedAt,
          firstFrameAt: onset.firstFrameAt,
          onsetMs: onset.onsetMs,
          ...(onset.frameOffsetMs === null ? {} : { frameOffsetMs: onset.frameOffsetMs }),
        });
        if (start === null) return null;
        const end = start + Math.max(0, onset.durationMs - onset.onsetMs);
        return { startMs: Math.max(0, start - t0), endMs: Math.max(0, end - t0) };
      })
      .filter((window): window is { startMs: number; endMs: number } => window !== null && window.endMs > window.startMs);
    const agentAudio = outcome.agentWindows.filter((window) => window.endMs > window.startMs);
    const audible = [...agentAudio, ...callerSpeech];
    const audibleEndMs = audible.length === 0 ? 0 : Math.max(...audible.map((window) => window.endMs));
    outcome.silenceTimeline =
      audible.length === 0
        ? null
        : {
            startedMs: Math.min(...audible.map((window) => window.startMs)),
            endedMs: options.silenceCheckIn ? Math.max(audibleEndMs, observedEndMs) : audibleEndMs,
            agentAudio,
            callerSpeech,
            coverage: outcome.coverageAt,
            checkIns: outcome.checkIns,
          };
    outcome.wallClockMs = Date.now() - liveStartedAt;
    outcome.audioChunks = audioChunks;
    lastClientOutcome = outcome;
  }
  return outcome;
}

const LONG_ASK = "Tell me in detail, step by step, how you would help a dental clinic with its phone calls.";
/** The real point the caller adds after "Wait, stop."; it must be answered, never resumed past. */
const STOP_OVER_POINT = "price";
const STOP_OVER_POINT_LINE = "What is the price?";

/**
 * The measured drain: session close minus the goodbye's audio end, with the
 * call's own session so score-demo can cite that call's closing turn on a
 * slow FAIL instead of guessing one.
 */
function hangUpLine(ms: number, sessionId: string | null): string {
  return `    hung up ${ms}ms after the goodbye finished playing${sessionId ? ` (session ${sessionId})` : ""}`;
}

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
      let said: CallerSpeech | null = null;
      let fillerAt = 0;
      const o = await runClient(voiceIdArg(), [LONG_ASK, "Okaay so"], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        fillerAt = Date.now();
        said = ctx.say("Okaay so");
        await new Promise((resolve) => setTimeout(resolve, 4000));
      });
      // A filler is never supposed to steal the turn. Measure the cut from the
      // caller's transmitted onset (same t0 stop-over uses), and require the
      // answer to keep sounding through the back-channel: the reply was never
      // interrupted, no new answer was created, and audio was still scheduled
      // when the filler landed.
      const measured = measureCutLatency(said!.onset(), o.cutAt);
      const cutObserved = o.cutAt !== null;
      // The session's current resume instruction is "Finish your sentence …
      // word for word"; the shared matcher also accepts the older phrasing, so
      // a live resume is never misread as a derail.
      const resumed = cutObserved && o.creates.some((c) => isResumeInstructions(c));
      const answerStillSounding = o.lastAudioEnd > fillerAt;
      const continued =
        !cutObserved && o.interruptedReplies === 0 && o.creates.length === 0 && answerStillSounding;
      const answer: FillerAnswerMarker = cutObserved
        ? resumed
          ? "resumed"
          : "derailed"
        : continued
          ? "continued"
          : "dropped";
      // The filler verdict resolves to resume-from (or heard-only when the
      // answer never cut), never "answered"; the handling is derived from the
      // observed answer marker, not set by hand.
      const handling = fillerHandlingFor(answer) ?? "unmeasured";
      const tail = cutObserved ? fillerTailOf(o) : null;
      const tailSuffix = tail
        ? `; tail ${JSON.stringify({
            agent: tail.agentText,
            heard: tail.heardText,
            resumed: tail.resumedText,
            resumeMs: tail.resumeMs,
          })}`
        : "";
      const cutLabel = measured.cutMs !== null ? `cut at ${measured.cutMs}ms` : cutObserved ? "cut" : "never cut";
      console.log(
        `    filler ${cutLabel}; events ${JSON.stringify(
          o.events.map((e) => [e.verdict, e.text]),
        )}; handling ${handling}${tailSuffix}`,
      );
      if (cutObserved) {
        return resumed
          ? null
          : `cut and not resumed (events: ${JSON.stringify(o.events.map((e) => [e.verdict, e.text]))})`;
      }
      if (o.interruptedReplies !== 0) {
        return `reply was interrupted without a measured cut (interrupted replies: ${o.interruptedReplies})`;
      }
      if (o.creates.length > 0) {
        return `answered the back-channel as a new turn (creates: ${JSON.stringify(o.creates)})`;
      }
      if (!answerStillSounding) {
        return "the filler landed after the answer ended (no answer to continue)";
      }
      return null; // never cut; the answer continued through the back-channel
    },
  },
  {
    name: "stop-over",
    run: async () => {
      let said: CallerSpeech | null = null;
      const tailMs = Number(process.env.EVAL_TAIL_MS ?? 20_000);
      const o = await runClient(voiceIdArg(), [LONG_ASK, "Wait, stop.", STOP_OVER_POINT_LINE], async (ctx) => {
        await askAndWaitForSpeech(ctx);
        said = ctx.say("Wait, stop.");
        // The same caller turn carries the real point. After the cut the agent
        // must answer it — a resume of the abandoned dental-clinic tail FAILs.
        ctx.say(STOP_OVER_POINT_LINE);
        await ctx.waitFor(() => ctx.heardPoint(STOP_OVER_POINT), tailMs).catch(() => undefined);
        await ctx.waitFor(() => ctx.postCutAnswer(STOP_OVER_POINT) !== null, tailMs).catch(() => undefined);
      });
      // t0 is the transmitted caller onset, never the enqueue tick. The
      // scenario asserts the same quoted budget the scoreboard gates, so a
      // late cut fails here before any plumbing judgment looks healthy.
      const measured = measureCutLatency(said!.onset(), o.cutAt);
      if (measured.cutMs === null) {
        return `never cut (${measured.reason ?? "no cut"}; events: ${JSON.stringify(o.events.map((e) => e.verdict))})`;
      }
      console.log(`    cut ${measured.cutMs}ms after the caller started (budget ${REAL_CUT_MAX_MS}ms)`);
      const answer = judgePostCutAnswer({
        point: STOP_OVER_POINT,
        heard: o.heard,
        answer: postCutAnswerOf(o, STOP_OVER_POINT),
        creates: o.creates,
      });
      if (answer.resumed) {
        console.log(`    resumed instead of answering: "${answer.resumed}"`);
        return `resumed instead of answering: "${answer.resumed}"`;
      }
      if (measured.cutMs > REAL_CUT_MAX_MS) {
        return `cut too late: ${measured.cutMs}ms > ${REAL_CUT_MAX_MS}ms (caller onset → server cut)`;
      }
      if (!answer.answered) {
        const agent = JSON.stringify(o.agent);
        const creates = JSON.stringify(o.creates);
        return `${answer.reason} (agent: ${agent}; creates: ${creates})`;
      }
      console.log(`    ${REAL_CUT_ANSWER_PREFIX} "${answer.answer}"`);
      return null;
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
      // The session's own transcript ledger: the words the call counted.
      console.log(`    heard ledger ${JSON.stringify(o.heard)}`);
      // Real producer for the double-talk gate: the fake playout recorded, for
      // every server cut, how long the caller's speech and the faded agent
      // audio were both still sounding after the flush. That residual — never
      // time-to-cut, which the barge-in-cut gate budgets separately — is what
      // the 400ms bar governs. The line is machine-readable so score-demo
      // scores the same numbers; the scenario asserts them too.
      const overlaps = o.overlapMs;
      const maxOverlap = overlaps.length > 0 ? Math.max(...overlaps) : null;
      console.log(
        `${DOUBLE_TALK_EVIDENCE_PREFIX}${JSON.stringify({
          scenario: "over-talk",
          session: o.sessionId,
          overlapMs: overlaps,
          fadeMs: Math.round(o.lastFadeMs),
        })}`,
      );
      const cuts = overlaps.join(", ");
      console.log(
        `    double talk ${
          maxOverlap === null ? "unmeasured (no cut)" : `${maxOverlap}ms max after ${overlaps.length} cut${overlaps.length === 1 ? "" : "s"}`
        } (cuts: ${cuts || "none"}ms; budget ${DOUBLE_TALK_MAX_OVERLAP_MS}ms; fade ${DOUBLE_TALK_FADE_OUT_S}s)`,
      );
      if (!o.heard.some((t) => /bakery/i.test(t))) {
        return `never heard (heard: ${JSON.stringify(o.heard)})`;
      }
      if (maxOverlap === null) {
        return "never cut under the caller's point (double talk unmeasured)";
      }
      if (maxOverlap > DOUBLE_TALK_MAX_OVERLAP_MS) {
        return `double talk too long: ${maxOverlap}ms > ${DOUBLE_TALK_MAX_OVERLAP_MS}ms after the flush (cuts: ${cuts}ms)`;
      }
      return null;
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
      console.log(hangUpLine(ms, o.sessionId));
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
      if (o.creates.some((c) => isResumeInstructions(c))) return "resumed instead of ending";
      if (o.endedAt === null) return "never hung up";
      console.log(hangUpLine(o.endedAt - o.lastAudioEnd, o.sessionId));
      return null;
    },
  },
  {
    name: "greeting-cut",
    run: async () => {
      let said: CallerSpeech | null = null;
      const o = await runClient(voiceIdArg(), ["Wait, stop."], async (ctx) => {
        await ctx.waitFor(() => ctx.audioChunks() > 0);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        said = ctx.say("Wait, stop.");
        await new Promise((resolve) => setTimeout(resolve, 4000));
      });
      const measured = measureCutLatency(said!.onset(), o.cutAt);
      // The scenario asserts its own latency on the gate voice: a measured
      // cut inside the locked greeting window passes, beyond it fails with
      // the ms the scoreboard will gate. Never an unasserted print.
      const failure = greetingCutFailure(measured.cutMs, measured.reason);
      if (failure) return failure;
      console.log(
        `    greeting cut ${measured.cutMs}ms after the caller started (budget ${GREETING_CUT_MAX_MS}ms)`,
      );
      return null;
    },
  },
  {
    name: "silence-check-in",
    run: async () => {
      // Real silence on a free floor: the greeting ends, the caller says
      // nothing, and the floor's own 15s timer must draw exactly one check-in.
      // The target is never shortened; the golden window's 18s cap is the
      // observation deadline for a missing check-in.
      const o = await runClient(
        voiceIdArg(),
        [],
        async (ctx) => {
          await ctx.waitFor(() => ctx.replies() >= 1); // greeting done, floor free
          await ctx.waitFor(() => ctx.checkIns() >= 1, SILENCE_CHECK_IN_MAX_MS).catch(() => undefined);
        },
        { silenceCheckIn: true },
      );
      const derived = o.silenceTimeline ? deriveFreeFloorSilence(o.silenceTimeline) : null;
      const checkIns = derived?.checkIns ?? [];
      const first = checkIns[0];
      console.log(
        `    check-ins ${checkIns.length} at ${first?.atSilenceMs ?? 0}ms ` +
          `(target ${SILENCE_CHECK_IN_TARGET_MS}ms, latest ${SILENCE_CHECK_IN_MAX_MS}ms)`,
      );
      if (!derived) return "no silence timeline: the call produced no audible window";
      if (checkIns.length !== 1) {
        const seen = checkIns.map((checkIn) => `${checkIn.atSilenceMs}ms`).join(", ") || "none";
        return `silence drew ${checkIns.length} check-ins, want exactly one (${seen})`;
      }
      if (first.atSilenceMs < SILENCE_CHECK_IN_TARGET_MS) {
        return `check-in too early: ${first.atSilenceMs}ms < ${SILENCE_CHECK_IN_TARGET_MS}ms of silence`;
      }
      if (first.atSilenceMs > SILENCE_CHECK_IN_MAX_MS) {
        return `check-in too late: ${first.atSilenceMs}ms > ${SILENCE_CHECK_IN_MAX_MS}ms of silence`;
      }
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
  /** The live session's id, for the Call trace merge. */
  sessionId?: string;
  /** The platform ignored the call's replacement once, so it was resent. */
  resent?: boolean;
  /** Voni announced her screen without the tool; the call put the test up. */
  screenByPhrase?: boolean;
  /**
   * Contact-chip shows the browser would render: one per invite transition
   * (the real component renders one chip while `emailTest.invited`). The
   * eval mirrors that gate so a duplicate show is still detectable.
   */
  chipShows: { address: string; tag: string }[];
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
  const outcome: ToolOutcome = { replies: [], heard: [], tools: [], endCalled: false, slowTurns: 0, chipShows: [] };
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
  // The browser shows the chip once the invite is up (putTestUp); repeated
  // callbacks keep the same single chip, so a transition is one show.
  const showChip = (address: string, tag: string) => {
    if (outcome.chipShows.length > 0) return;
    outcome.chipShows.push({ address, tag });
  };
  const sendResult = (callId: string, result: Record<string, unknown>, record: ToolCallRecord) => {
    record.resultAt = Date.now();
    if (record.name === SHOW_TEST_ADDRESS_TOOL && result.ok === true) {
      // The chip shows what the tool result carried, exactly like the browser.
      const data = (result.data ?? {}) as Record<string, unknown>;
      showChip(
        typeof data.address === "string" ? data.address : DEMO_INBOX_ADDRESS,
        typeof data.testTag === "string" ? data.testTag : TAG,
      );
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
      // One machine-readable marker per live call (same as runClient).
      if (typeof msg.session_id === "string" && msg.session_id.length > 0) {
        outcome.sessionId = msg.session_id;
        console.log(`  · trace session ${msg.session_id}`);
      }
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
        showChip(DEMO_INBOX_ADDRESS, TAG);
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

/**
 * The closing line the visitor heard: the reply that names the team inbox,
 * else the last audible reply (so a goodbye that forgot the inbox is still
 * measured, never excused as "no goodbye").
 */
function goodbyeReply(o: ToolOutcome): ReplyRecord | undefined {
  const audible = o.replies.filter((reply) => !reply.replaced && reply.text.trim().length > 0);
  return (
    audible.find((reply) => namesTeamInbox(reply.text)) ??
    audible.filter((reply) => /voni dot c|hi@voni|voni\.cc|try again/i.test(reply.text)).at(-1) ??
    audible.at(-1)
  );
}

/** What the runner measured about the closing line, for the pass check and evidence. */
function goodbyeReading(o: ToolOutcome): {
  bye: ReplyRecord | undefined;
  turn: number | null;
  coverage: number | null;
  inboxNamed: boolean;
} {
  const bye = goodbyeReply(o);
  if (!bye) return { bye: undefined, turn: null, coverage: null, inboxNamed: false };
  const words = bye.text.split(/\s+/).filter(Boolean).length;
  const expected = words / 3.6; // measured: the greeting speaks ~3.6 words/s
  const played = bye.audioBytes / 48_000;
  return {
    bye,
    turn: o.replies.indexOf(bye) + 1,
    coverage: expected > 0 ? played / expected : null,
    inboxNamed: namesTeamInbox(bye.text),
  };
}

/** The closing line must name the team inbox and its audio must arrive in full. */
function goodbyeCheck(o: ToolOutcome): string | null {
  const reading = goodbyeReading(o);
  if (!reading.bye) return "no goodbye";
  if (!reading.inboxNamed) {
    return `the goodbye never named ${TEAM_INBOX_ADDRESS} as spoken: "${reading.bye.text.trim()}"`;
  }
  if (reading.coverage === null) return null;
  if (reading.coverage >= 0.8) return null;
  const words = reading.bye.text.split(/\s+/).filter(Boolean).length;
  const expected = words / 3.6;
  const played = reading.bye.audioBytes / 48_000;
  return `goodbye audio ${played.toFixed(1)}s for ~${expected.toFixed(1)}s of words: "${reading.bye.text.trim()}"`;
}

/** One machine-readable goodbye measurement per goodbye run, for score-demo. */
function goodbyeDrainLine(scenario: string, o: ToolOutcome): string {
  const reading = goodbyeReading(o);
  return `${GOODBYE_DRAIN_EVIDENCE_PREFIX}${JSON.stringify({
    scenario,
    session: o.sessionId ?? null,
    turn: reading.turn,
    coverage: reading.coverage,
    inboxNamed: reading.inboxNamed,
  })}`;
}

/** Runs whose closing line is scored for the team inbox and full playback. */
const GOODBYE_SCENARIOS = ["bye-audio", "free-gate"] as const;

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
      return [goodbyeCheck(o), o];
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
      return [goodbyeCheck(o), o];
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

/**
 * Machine-readable invite evidence for score-demo's email gate: what Voni
 * audibly said (non-replaced replies only), how many times the show tool ran,
 * the chip shows the browser would render, and each spoken line's session
 * turn (1-based reply, the same numbering as the merged Call trace's VONI
 * rows). No memory fields: the live eval never performs a Hold return, so
 * memory stays honestly unmeasured (the gate then reports INFO, never PASS).
 */
function emailInviteEvidence(outcome: ToolOutcome): EmailInviteEvidenceFile {
  const entries = outcome.replies
    .map((reply, index) => ({ ...reply, turn: index + 1 }))
    .filter((reply) => !reply.replaced && reply.text.trim().length > 0);
  const tagTurn = entries.find((reply) => TAG_WORD.test(reply.text))?.turn ?? null;
  return {
    tag: TAG,
    agentLines: entries.map((reply) => reply.text),
    lineTurns: entries.map((reply) => reply.turn),
    chipShows: outcome.chipShows,
    showToolCalls: outcome.tools.filter((tool) => tool.name === SHOW_TEST_ADDRESS_TOOL).length,
    chipTurn: tagTurn,
    traceSession: outcome.sessionId ?? null,
  };
}

function voiceIdArg(): string {
  return arg("--voice", DEMO_VOICE_IDS[0]);
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
const voiceId = arg("--voice", DEMO_VOICE_IDS[0]);
const only = arg("--scenario", "");
let failures = 0;
/** Per-scenario rows for the final machine-readable summary. */
const scenarioResults: { name: string; passed: number; runs: number }[] = [];
/** Call trace sessions this run opened, deduplicated. */
const traceSessions: string[] = [];
/** Wall-clock playout of live client runs: reported, never a gate. */
const playoutRows: { scenario: string; run: number; wallClockMs: number }[] = [];
/** Fixed caller clips from the real-cut scenarios: the cut's comparability pins. */
const cutClips: CallerClipFingerprint[] = [];
let clientRuns = 0;
let agentAudioChunks = 0;
const noteSession = (sessionId: string | null | undefined) => {
  if (sessionId && !traceSessions.includes(sessionId)) traceSessions.push(sessionId);
};
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
    noteSession(outcome?.sessionId);
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
  scenarioResults.push({ name: scenario.name, passed, runs });
  console.log(`${scenario.name}: ${passed}/${runs}`);
}
for (const scenario of CLIENT_SCENARIOS.filter((s) => !only || s.name === only)) {
  let passed = 0;
  for (let i = 1; i <= runs; i++) {
    let reason: string | null;
    lastClientOutcome = null;
    try {
      reason = await scenario.run();
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    const liveRun = latestClientOutcome();
    if (liveRun) {
      noteSession(liveRun.sessionId);
      clientRuns += 1;
      agentAudioChunks += liveRun.audioChunks;
      playoutRows.push({ scenario: scenario.name, run: i, wallClockMs: liveRun.wallClockMs });
      console.log(`    playout ${liveRun.wallClockMs}ms wall clock`);
      if (liveRun.silenceTimeline) {
        console.log(
          `${SILENCE_TIMELINE_PREFIX}${JSON.stringify({
            scenario: scenario.name,
            session: liveRun.sessionId,
            ...liveRun.silenceTimeline,
          })}`,
        );
      }
      if ((REAL_CUT_SCENARIOS as readonly string[]).includes(scenario.name)) {
        for (const clip of liveRun.callerClips) {
          if (!cutClips.some((seen) => seen.text === clip.text)) cutClips.push(clip);
        }
      }
    }
    if (reason === null) passed += 1;
    else {
      failures += 1;
      console.log(`  ✗ ${scenario.name} #${i}: ${reason}`);
    }
  }
  scenarioResults.push({ name: scenario.name, passed, runs });
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
    noteSession(outcome?.sessionId);
    if (scenario.name === "invite-tag" && outcome) {
      console.log(`${EMAIL_INVITE_EVIDENCE_PREFIX}${JSON.stringify(emailInviteEvidence(outcome))}`);
    }
    if ((GOODBYE_SCENARIOS as readonly string[]).includes(scenario.name) && outcome) {
      console.log(goodbyeDrainLine(scenario.name, outcome));
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
  scenarioResults.push({ name: scenario.name, passed, runs });
  console.log(`${scenario.name}: ${passed}/${runs}`);
}

// One machine-readable line proves the runner finished: scoreboard plumbing is
// PASS whatever the scenario verdicts and exit code, while a crash, kill, or
// missing summary/trace/audio is a harness break. Playout stays report-only.
console.log(
  `EVAL SUMMARY ${JSON.stringify({
    scenario: only || "all",
    runs,
    failures,
    scenarios: scenarioResults,
    traceSessions,
    playout: playoutRows,
    audioChunks: clientRuns > 0 ? agentAudioChunks : null,
    live: scenarioResults.length > 0,
    // Fixed caller clips the real-cut scenarios streamed: the scoreboard
    // compares these fingerprints with the prior run before trusting a cut.
    clips: cutClips.sort((a, b) => a.text.localeCompare(b.text)),
  })}`,
);
process.exit(failures > 0 ? 1 : 0);
