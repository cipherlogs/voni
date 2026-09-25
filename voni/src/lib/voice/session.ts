/**
 * Browser client for the AssemblyAI Voice Agent API.
 *
 * Audio contract (from the API's audio-format reference):
 *   - Both directions are base64, mono, `audio/pcm` = 16-bit signed LE @ 24 kHz.
 *   - Send `input.audio` continuously at real time; frames beyond ~1s of audio
 *     per second of wall clock are DROPPED, not buffered.
 *   - Wait for `session.ready` before the first chunk or it is discarded.
 *
 * Three things here are easy to get wrong and expensive when you do:
 *
 * 1. `session.end` before `ws.close()`. A bare close leaves the session in a
 *    30-second resume grace window that still bills. HANDOFF (1b) records two
 *    throwaway scripts that billed 30.87s each for under a second of use.
 *    This is wired to explicit hang-up AND to `pagehide`, synchronously.
 * 2. Echo cancellation ON, noise suppression OFF. Without AEC the agent hears
 *    its own voice through the speakers and interrupts every reply. A second
 *    denoiser on top of the server's own costs more accuracy than it buys.
 * 3. Playback through one continuous worklet stream (playout.ts), never one
 *    AudioBufferSourceNode per chunk as in AssemblyAI's browser sample. That
 *    sample has no jitter buffer and resamples each chunk alone, so late
 *    chunks and chunk joins pop. Never schedule with setTimeout either.
 */

import {
  END_CALL_TOOL,
  END_CALL_VOICE_TOOL,
  SENSITIVE_CAPTURE_TOOL,
  type VoiceTool,
} from "@/lib/tools/definitions";
import type { ToolResponse } from "@/lib/tools/execute";
import { ToolCoordinator, type ToolCoordinatorOptions } from "./tool-coordinator";
import {
  buildConversationMessage,
  MICROPHONE_MUTED_CONTEXT,
  MICROPHONE_UNMUTED_CONTEXT,
} from "./context";
import { releaseMic } from "./mic-owner";
import { TRANSCRIPTION_MODE } from "./transcription";
import {
  acquireMicStream,
  startAudioGraph,
  TARGET_SAMPLE_RATE,
  VoiceStartError,
  type VoiceErrorCode,
} from "./mic-capture";
import type { WorkletPlayout } from "./playout";

export { TARGET_SAMPLE_RATE, VOICE_MIC_CONSTRAINTS } from "./mic-capture";

/**
 * Two mutually exclusive ways to configure a session, matching the API:
 *
 * - `inline` sends the prompt from the browser. Fine behind auth, where the
 *   caller owns the agent and is testing an unsaved draft.
 * - `agent` sends only a stored `agent_id`, so the prompt is server-owned.
 *   This is the ONLY safe shape for an unauthenticated public demo — with
 *   inline config, whoever holds a token chooses what the model does.
 *
 * Sending both is rejected by the API.
 */
export type TurnDetection = {
  min_silence: number;
  max_silence: number;
  interrupt_response?: boolean;
  interruption_delay?: number;
};

export type TranscriptionMode = "min_latency" | "balanced" | "max_accuracy";

export type SessionConfig =
  | {
      mode: "inline";
      systemPrompt: string;
      greeting: string;
      voiceId: string;
      /** Empty = automatic detection across all supported languages. */
      languageCodes?: string[];
      /**
       * Speech-recognition context, sent in the FIRST session.update so the
       * first utterance is already tuned — pushing it post-start leaves the
       * opening turn on server defaults (balanced, generic vocabulary).
       */
      transcriptionPrompt?: string;
      /** Vocabulary boosts (≤100). Mutable mid-session via updateConfig. */
      keyterms?: string[];
      /** STT speed/accuracy. Balanced is the voice-agent default: finals the
      screen can trust without paying max_accuracy's endpointing wait. */
      transcriptionMode?: TranscriptionMode;
      /** VAD windows. Defaults to TURN_PRESET; override only in tests. */
      turnDetection?: TurnDetection;
      /** Compiled from the selected on-screen tools, including pacing. */
      tools?: VoiceTool[];
      /** Required by the server to scope signed-in browser tool tests. */
      testAgentId?: string;
    }
  | { mode: "agent"; agentId: string };

/**
 * Where the token comes from. The two endpoints differ in more than their URL:
 * the authed one returns a bare token for an inline session, the public one
 * returns a token, the stored `agent_id` it is allowed to bind to, and the
 * `callToken` that scopes the demo's tool route to this call.
 */
export type TokenFetcher = () => Promise<{ token: string; agentId?: string; callToken?: string }>;

/** VoiceStartError lives in ./mic-capture (shared with the cascade client). */

/**
 * Single-use generation tokens. Every start/resume mints one; stale async
 * work (late token, late mic grant, late socket callbacks) compares and bails
 * instead of opening a session the user already stopped. Test Stop-during-
 * startup and immediate-restart against this, not against timers.
 */
export class SessionGeneration {
  private current = 0;
  begin(): number {
    this.current += 1;
    return this.current;
  }
  invalidate(): void {
    this.current += 1;
  }
  isCurrent(id: number): boolean {
    return id === this.current;
  }
}

/** Pure builder so the resume hello is unit-testable without a socket. */
export function buildResumeMessage(sessionId: string): Record<string, unknown> {
  return { type: "session.resume", session_id: sessionId };
}

/**
 * Pure builder for the FIRST session.update of an inline session. Everything
 * recognition-related ships here — not post-start — so the opening turn runs
 * tuned: fast endpointing, the screen's vocabulary, the screen's scene.
 */
/**
 * Test-call language lock. The agent's own picker stays authoritative and
 * passes through untouched; when it is left on Automatic (empty), the test
 * call locks to English instead of paying 18-language auto-detection on
 * every turn. PSTN/provision paths keep passing the raw config untouched.
 */
export function effectiveInlineLanguages(codes: string[] | undefined): string[] {
  return codes && codes.length > 0 ? [...codes] : ["en"];
}

export function buildInlineSessionUpdate(
  config: Extract<SessionConfig, { mode: "inline" }>,
): Record<string, unknown> {
  return {
    system_prompt: config.systemPrompt,
    greeting: config.greeting,
    output: { voice: config.voiceId },
    input: {
      transcription_mode: config.transcriptionMode ?? TRANSCRIPTION_MODE,
      // Close-talking browser mic: isolate the caller with the near-field
      // model. Server default is the same; explicit beats implicit when a
      // second path (stored agents on PSTN) wants far-field.
      voice_focus: "near-field",
      // Omit the key entirely when empty — an empty array and an absent
      // field both mean "detect automatically", but sending the key at all
      // is a needless difference from the default.
      ...(config.transcriptionPrompt ? { transcription_prompt: config.transcriptionPrompt } : {}),
      ...(config.keyterms && config.keyterms.length > 0 ? { keyterms: config.keyterms } : {}),
      ...(config.languageCodes && config.languageCodes.length > 0
        ? { language_codes: config.languageCodes }
        : {}),
      turn_detection: { ...(config.turnDetection ?? TURN_PRESET) },
    },
    ...(config.tools && config.tools.length > 0 ? { tools: config.tools } : {}),
  };
}

/**
 * Reconnect only on unexpected drops of a resumable session. Explicit Stop,
 * server-ended sessions, expiry, sign-out, and idle endings never reconnect;
 * neither do pre-ready drops (nothing to resume) or exhausted attempts.
 */
export function decideReconnectOnClose(opts: {
  state: VoiceState;
  explicitStop: boolean;
  sessionId: string | null;
  attempts: number;
  maxAttempts?: number;
}): boolean {
  if (opts.explicitStop) return false;
  if (opts.state === "ended") return false;
  if (!opts.sessionId) return false;
  return opts.attempts < (opts.maxAttempts ?? 2);
}

/** Default: the signed-in endpoint, used for inline "test this agent" calls. */
export const authedToken: TokenFetcher = async () => {
  const res = await fetch("/api/voice-token");
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: null }));
    const message = error ?? "Could not get a call token.";
    if (res.status === 401) throw new VoiceStartError("auth", message);
    if (res.status === 503) throw new VoiceStartError("config", message);
    throw new VoiceStartError("network", message);
  }
  return res.json();
};

/** Thrown by `demoToken` on a 429, so the UI can show a countdown instead of a generic error. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Public demo: the server picks the prompt (Voni's own), we only name the voice. */
export const demoToken =
  (voiceId: string): TokenFetcher =>
  async () => {
    const res = await fetch("/api/demo/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceId }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: null }));
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        throw new RateLimitError(
          error ?? "Too many demo calls right now.",
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
        );
      }
      const message = error ?? "Could not start the demo call.";
      if (res.status === 401) throw new VoiceStartError("auth", message);
      throw new VoiceStartError("network", message);
    }
    return res.json();
  };

export type Transcript = { role: "user" | "agent"; text: string; overheard?: boolean };

/** Finalized user turn with its id for assent binding. */
export type UserTurn = { itemId: string | null; text: string };
/** Finalized agent turn with its id for readback binding. */
export type AgentTurn = { itemId: string | null; text: string };

/**
 * Live partials are cumulative per turn — the UI renders the latest one for
 * its item and never concatenates. Scoped by item id so overlapping replies
 * can't smear two turns together.
 */
export type TranscriptPartial = { itemId: string | null; text: string };

/** Machine-readable failure kind so the UI can route recovery, not just text. */
export type { VoiceErrorCode } from "./mic-capture";

/** Structured so the UI can tell a rate limit (with a countdown) from any other failure. */
export type VoiceError = {
  message: string;
  retryAfterSeconds?: number;
  code?: VoiceErrorCode;
};

export type SessionEndedInfo = {
  durationSeconds: number | null;
  audioSeconds: number | null;
};

/**
 * Audio-glitch probe event. Instrumentation only — observing these never
 * changes playback. The provider forwards them to console.debug so an owner
 * reproducing pops on-device can line up each click with the exact cut that
 * caused it (barge-in flush, interrupted-reply flush, or something else).
 */
export type AudioProbeEvent = {
  kind: "ready" | "barge-in" | "reply-cut" | "flush" | "underrun";
  /** Wall-clock ms of the event. */
  at: number;
  /** Ms of agent audio buffered at that moment (worklet's last report). */
  queued: number;
  sessionId: string | null;
};

export type VoiceHandlers = {
  onStateChange?: (state: VoiceState) => void;
  onTranscript?: (turn: Transcript) => void;
  /** Latest cumulative user partial for the current turn. */
  onUserPartial?: (partial: TranscriptPartial) => void;
  /** Word-by-word agent captions as it speaks. */
  onAgentPartial?: (partial: TranscriptPartial) => void;
  onError?: (error: VoiceError) => void;
  /** Fires while a `hold`-mode business tool call is in flight during a live call. */
  onToolActivity?: (active: boolean) => void;
  /** Fires when a config update times out (true) and when resync succeeds (false). */
  onConfigUncertainty?: (uncertain: boolean) => void;
  onSessionEnded?: (info: SessionEndedInfo) => void;
  /** Fires on `session.ready` with the id AssemblyAI needs for support. */
  onSessionReady?: (sessionId: string) => void;
  /**
   * WS-level timing hook for CallTimings. Fires for tokenDone, micDone,
   * wsOpen, sessionReady, firstUpdateAck, greetingAudio. Observation only —
   * never blocks the audio path.
   */
  onTiming?: (mark: "tokenDone" | "micDone" | "wsOpen" | "sessionReady" | "firstUpdateAck" | "greetingAudio") => void;
  /** Audio-glitch probe (see AudioProbeEvent). Observation only. */
  onAudioProbe?: (event: AudioProbeEvent) => void;
  /** Finalized turns with ids (assent/readback binding). Partials stay separate. */
  onUserTurn?: (turn: UserTurn) => void;
  onAgentTurn?: (turn: AgentTurn) => void;
  onReplyStarted?: () => void;
  /** The caller started speaking (VAD), before any transcript. */
  onInputSpeechStarted?: () => void;
  onReplyDone?: (info: { replyId: string | null; interrupted: boolean }) => void;
};

export type VoiceState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "speaking"
  | "ended";

type QueuedUpdate = {
  session: Record<string, unknown>;
  coalescible: boolean;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

const SENSITIVE_TURN_DETECTION: TurnDetection = {
  min_silence: 1400,
  max_silence: 4000,
  interrupt_response: true,
  interruption_delay: 0,
};

/**
 * The turn preset: the ONE turn-taking dial for demo calls, test calls, and
 * the copilot. Tune speed here and every surface follows.
 *
 * - `min_silence` 100: after a sentence that clearly ended (terminal
 *   punctuation), reply almost at once. The punctuation check is what keeps
 *   an unfinished "I was thinking…" from being answered.
 * - `max_silence` 1000: an unclear ending waits at most this long — the docs'
 *   voice-agent starting point. Lower splits phone numbers and emails across
 *   turns; raise mid-call for entity capture instead.
 * - `interruption_delay` 500: the mode default. Coughs, breath, and "uh-huh"
 *   end before the first partial fires, so junk rarely cuts the agent off;
 *   real barge-in still does.
 *
 * Only `prepareSensitiveCapture` departs from it, for one card-field turn.
 */
export const TURN_PRESET: TurnDetection = {
  min_silence: 100,
  max_silence: 1000,
  interrupt_response: true,
  interruption_delay: 500,
};

/**
 * Barge-in fade. The playout ramps what is sounding to silence over this long
 * instead of a hard-stop click; short enough to still feel instant.
 */
const FADE_OUT_S = 0.04;

/**
 * Goodbye drain handshake. `settled` only means the worklet's buffer is
 * momentarily empty — which also happens between chunks on a jittery link,
 * during the pre-roll wait, and while the resampler tail still holds sound —
 * so a single settled poll can stop mid-word (the caller hears the goodbye
 * chopped). Stop requires HANGUP_SETTLE_POLLS consecutive settled polls AND
 * HANGUP_AUDIO_GRACE_MS since the last audio arrived (covers audio still
 * traveling to the worklet plus output latency, Bluetooth included).
 * HANGUP_DRAIN_TIMEOUT_MS stays the fail-safe: never hold the line longer.
 */
const HANGUP_POLL_MS = 250;
const HANGUP_SETTLE_POLLS = 3;
const HANGUP_AUDIO_GRACE_MS = 500;
const HANGUP_DRAIN_TIMEOUT_MS = 10000;

export class VoiceSession {
  private ws: WebSocket | null = null;  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private ready = false;
  /** Agent-voice output; lives on the mic's context. */
  private playout: WorkletPlayout | null = null;
  private state: VoiceState = "idle";
  private onPageHide = () => this.sendEnd();
  private toolCoordinator: ToolCoordinator | null = null;
  /** Exact turn-detection state to restore after one sensitive value turn. */
  private pendingTurnDetectionRestore: TurnDetection | null | undefined;
  /**
   * Agent-initiated hangup, armed by an end_call result and acted on at the
   * next settled reply — so the spoken closing line finishes playing before
   * the session tears down. Disarmed the moment the caller speaks again
   * (they took the floor back; the agent re-decides).
   */
  private pendingHangup = false;
  private hangupTimer: ReturnType<typeof setInterval> | null = null;
  /** Last `reply.audio` arrival: the drain handshake waits out fresh audio. */
  private lastAudioAt = 0;

  /** Disarm an agent-initiated hangup: the caller took the floor back. */
  private disarmHangup(): void {
    this.pendingHangup = false;
    if (this.hangupTimer) {
      clearInterval(this.hangupTimer);
      this.hangupTimer = null;
    }
  }
  /** Last server-acknowledged turn-detection state. Null means adaptive defaults. */
  private activeTurnDetection: TurnDetection | null = null;
  /** Bound to a stored agent (demo): the preset is pushed after session.ready. */
  private boundAgent = false;
  /** Resume handle from `session.ready`. Null until the first ready. */
  private sessionId: string | null = null;
  private tokenFetcher: TokenFetcher | null = null;
  /** Demo call scope for `/api/demo/tools`; refreshed with every token. */
  private callToken: string | null = null;
  private generation = new SessionGeneration();
  /** True once the user (or expiry/sign-out/idle) deliberately ends things. */
  private explicitStop = false;
  private resumeAttempts = 0;
  private readonly micOwner: string;
  private readonly updateTimeoutMs: number;
  private injectedExecutor: ((call: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolResponse>) | null;
  private updateInFlight: QueuedUpdate | null = null;
  private updateQueue: QueuedUpdate[] = [];
  private configSynced = true;
  /** First config ack + first agent audio fire timing marks once per start. */
  private firstUpdateAcked = false;
  private greetingAudioSent = false;
  /** session.ready re-fires on resume — timing still marks once per start. */
  private sessionReadySent = false;

  constructor(
    private handlers: VoiceHandlers = {},
    opts: {
      micOwner?: string;
      updateTimeoutMs?: number;
      /**
       * Client-side tool implementation (the copilot bus). When set, model
       * tool calls execute here with coordinator timing; the phone-agent
       * server path below stays the default for existing callers.
       */
      toolExecutor?: (call: {
        callId: string;
        name: string;
        arguments: Record<string, unknown>;
      }) => Promise<ToolResponse>;
    } = {},
  ) {
    this.micOwner = opts.micOwner ?? "voice-call";
    this.updateTimeoutMs = opts.updateTimeoutMs ?? 3000;
    this.injectedExecutor = opts.toolExecutor ?? null;
  }

  private setState(next: VoiceState) {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onStateChange?.(next);
  }

  /**
   * Must be called from inside a user gesture (click/touch): every major
   * browser gates getUserMedia and AudioContext startup behind one, and Safari
   * is strictest about it.
   */
  async start(
    config: SessionConfig,
    getToken: TokenFetcher = authedToken,
  ): Promise<void> {
    // A second start (e.g. immediate restart) invalidates this one: every
    // await below re-checks, so late acquisitions release instead of opening
    // a session the user already stopped.
    const gen = this.generation.begin();
    const alive = () => this.generation.isCurrent(gen);
    this.explicitStop = false;
    this.resumeAttempts = 0;
    this.sessionId = null;
    this.micReleased = false;
    this.inputMuted = false;
    this.firstUpdateAcked = false;
    this.greetingAudioSent = false;
    this.sessionReadySent = false;
    if (!this.configSynced) {
      this.configSynced = true;
      this.handlers.onConfigUncertainty?.(false);
    }
    this.setState("connecting");

    // Locally acquired resources, released on the abort path below when a
    // newer generation superseded this start before it finished connecting.
    let acquiredStream: MediaStream | null = null;
    let acquiredCtx: AudioContext | null = null;
    const abandon = () => {
      acquiredStream?.getTracks().forEach((t) => t.stop());
      acquiredStream = null;
      void acquiredCtx?.close().catch(() => undefined);
      acquiredCtx = null;
      releaseMic(this.micOwner);
    };

    try {
      // Fail fast on a held mic before spending a single-use token, then run
      // the token fetch and mic acquisition concurrently: they are
      // independent and together dominate call-startup latency. Error mapping
      // preserves the sequential version exactly (auth/rate-limit rethrown,
      // mic failures coded); a superseded generation releases silently.
      // Shared capture lives in ./mic-capture (also used by the cascade client).
      type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
      // ES2017-safe allSettled: never rejects, so one failure cannot mask the
      // other and partial acquisitions always reach the cleanup below.
      const settle = async <T>(promise: Promise<T>): Promise<Settled<T>> => {
        try {
          return { ok: true, value: await promise };
        } catch (error) {
          return { ok: false, error };
        }
      };
      const tokenPromise = settle(getToken()).then((r) => {
        // Late arrivals from a superseded start must not mark the new
        // conversation's timings — check the generation, not just ok.
        if (r.ok && alive()) this.handlers.onTiming?.("tokenDone");
        return r;
      });
      const micPromise = settle(acquireMicStream(this.micOwner)).then((r) => {
        if (r.ok && alive()) this.handlers.onTiming?.("micDone");
        return r;
      });
      const [tokenSettled, micSettled] = await Promise.all([tokenPromise, micPromise]);
      // Park a won mic stream where abandon() releases it (stops tracks,
      // releases the mic) instead of leaking it on the failure paths below.
      const parkMicStream = () => {
        if (micSettled.ok) acquiredStream = micSettled.value;
      };
      if (!alive()) {
        parkMicStream();
        abandon();
        return;
      }
      if (!tokenSettled.ok) {
        parkMicStream();
        abandon();
        const e = tokenSettled.error;
        if (e instanceof RateLimitError || e instanceof VoiceStartError) throw e;
        throw new VoiceStartError("network", "Could not get a call token.");
      }
      if (!micSettled.ok) {
        abandon();
        // acquireMicStream throws already-coded VoiceStartError.
        throw micSettled.error;
      }
      const { token, agentId, callToken } = tokenSettled.value;
      this.callToken = callToken ?? null;
      acquiredStream = micSettled.value;
      if (!alive()) {
        abandon();
        return;
      }
      this.tokenFetcher = getToken;

      // In agent mode the id is the server's to choose, not the caller's — so
      // whatever the token endpoint returned wins over anything passed in.
      const resolved: SessionConfig =
        config.mode === "agent" && agentId
          ? { mode: "agent", agentId }
          : config;
      this.activeTurnDetection =
        resolved.mode === "inline"
          ? { ...(resolved.turnDetection ?? TURN_PRESET) }
          : null;
      this.boundAgent = resolved.mode === "agent";
      this.pendingTurnDetectionRestore = undefined;

      // Mic stream and token were acquired concurrently above; the stream is
      // already parked in acquiredStream for the handoff below.
      this.stream = acquiredStream;
      acquiredStream = null;

      let graph;
      try {
        graph = await startAudioGraph(this.micOwner, this.stream, (data) => {
          this.ingestAudio(data);
        });
      } catch (e) {
        this.stream = null;
        throw e;
      }
      if (!alive()) {
        graph.stop();
        releaseMic(this.micOwner);
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        return;
      }
      this.audioCtx = graph.audioCtx;
      this.worklet = graph.worklet;
      this.playout = graph.playout;
      // Ran dry before reply.done: the network stalled mid-reply.
      this.playout.onDrained = () => {
        if (this.state === "speaking") this.probe("underrun");
      };
      this.connect(token, resolved, gen);
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", this.onPageHide);
      }
    } catch (e) {
      this.handlers.onError?.({
        message: e instanceof Error ? e.message : "Could not start the call.",
        retryAfterSeconds: e instanceof RateLimitError ? e.retryAfterSeconds : undefined,
        code: e instanceof VoiceStartError ? e.code : undefined,
      });
      await this.cleanup();
    }
  }

  private connect(token: string, config: SessionConfig, gen: number) {
    const url = new URL("wss://agents.assemblyai.com/v1/ws");
    url.searchParams.set("token", token);
    const ws = new WebSocket(url);
    this.ws = ws;

    if (config.mode === "inline") {
      const testAgentId = config.testAgentId;
      this.installTools(config.tools ?? [], async (call) => {
        if (this.injectedExecutor) return this.injectedExecutor(call);
        if (call.name === SENSITIVE_CAPTURE_TOOL) {
          return this.prepareSensitiveCapture();
        }
        if (!testAgentId) {
          return {
            ok: false,
            error: "Save this agent before testing business tools.",
            retryable: false,
          };
        }
        return postTool(`/api/tools/${encodeURIComponent(call.name)}`, {
          toolCallId: call.callId,
          arguments: call.arguments,
          context: { kind: "test", agentId: testAgentId },
        });
      });
    } else if (this.callToken) {
      this.installDemoTools();
    }

    ws.addEventListener("open", () => {
      if (!this.generation.isCurrent(gen)) return;
      this.handlers.onTiming?.("wsOpen");
      const session =
        config.mode === "agent"
          ? // Stored agent: the browser supplies nothing but the binding.
            { agent_id: config.agentId }
          : buildInlineSessionUpdate(config);
      ws.send(JSON.stringify({ type: "session.update", session }));
    });

    this.wireSocket(ws, gen);
  }

  /**
   * Rejoin a live session after an unexpected drop. Fetches a FRESH token —
   * the old one is single-use and already redeemed — and resumes inside the
   * server's 30-second grace window. Never called for explicit Stop, expiry,
   * sign-out, or idle endings (see onSocketClose).
   */
  async resume(): Promise<void> {
    if (!this.sessionId || !this.tokenFetcher || this.explicitStop) return;
    const gen = this.generation.begin();
    this.setState("reconnecting");
    try {
      const { token, callToken } = await this.tokenFetcher();
      if (!this.generation.isCurrent(gen)) return;
      if (callToken) this.callToken = callToken;
      const url = new URL("wss://agents.assemblyai.com/v1/ws");
      url.searchParams.set("token", token);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        if (!this.generation.isCurrent(gen)) return;
        ws.send(JSON.stringify(buildResumeMessage(this.sessionId as string)));
      });
      this.wireSocket(ws, gen);
    } catch {
      if (!this.generation.isCurrent(gen)) return;
      this.handlers.onError?.({
        message: "Could not rejoin the call. Check your connection and start again.",
        code: "network",
      });
      await this.cleanup();
    }
  }

  /** Shared socket wiring with stale-generation guards on every callback. */
  private wireSocket(ws: WebSocket, gen: number): void {
    ws.addEventListener("message", (event) => {
      if (!this.generation.isCurrent(gen)) return;
      this.handle(event.data);
    });

    ws.addEventListener("error", () => {
      if (!this.generation.isCurrent(gen)) return;
      this.handlers.onError?.({
        message: "The call connection failed.",
        code: "network",
      });
    });

    ws.addEventListener("close", (event) => {
      if (!this.generation.isCurrent(gen)) return;
      this.onSocketClose(event.code);
    });
  }

  private onSocketClose(code: number): void {
    this.ready = false;
    if (this.state === "ended" || this.explicitStop) {
      void this.cleanup();
      return;
    }
    if (code === 1008) {
      // Protocol-level refusal (auth, unknown/foreign session, expiry): the
      // server will not take us back, so don't burn resume attempts on it.
      this.explicitStop = true;
      this.handlers.onError?.({
        message: "The call ended unexpectedly. Try starting a new call.",
        code: "expired",
      });
      void this.cleanup();
      return;
    }
    if (
      decideReconnectOnClose({
        state: this.state,
        explicitStop: this.explicitStop,
        sessionId: this.sessionId,
        attempts: this.resumeAttempts,
      })
    ) {
      this.resumeAttempts += 1;
      void this.resume();
      return;
    }
    this.handlers.onError?.({
      message: "The call connection was lost.",
      code: "network",
    });
    void this.cleanup();
  }

  private handle(raw: string) {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case "session.ready":
        this.ready = true;
        if (typeof msg.session_id === "string" && msg.session_id.length > 0) {
          const id: string = msg.session_id;
          this.sessionId = id;
          this.handlers.onSessionReady?.(id);
        }
        // Once per start: a resume re-emits session.ready on the same
        // conversation, and CallTimings must see a single sessionReady.
        if (!this.sessionReadySent) {
          this.sessionReadySent = true;
          this.handlers.onTiming?.("sessionReady");
          // A stored agent can't carry input fields in its binding update, and
          // its cached server copy would go stale — so the turn preset rides a
          // follow-up update instead (verified to ack on a bound session).
          if (this.boundAgent) {
            this.updateConfig({
              input: {
                transcription_mode: TRANSCRIPTION_MODE,
                voice_focus: "near-field",
                turn_detection: { ...TURN_PRESET },
              },
            }).catch(() => undefined);
          }
        }
        this.probe("ready");
        this.resumeAttempts = 0;
        this.setState("listening");
        break;

      case "reply.audio":
        this.setState("speaking");
        this.lastAudioAt = Date.now();
        if (!this.greetingAudioSent) {
          this.greetingAudioSent = true;
          this.handlers.onTiming?.("greetingAudio");
        }
        this.schedule(msg.data as string);
        break;

      case "reply.done":
        if (msg.status === "interrupted") {
          // The server stopped generating, so anything still queued is stale
          // speech the caller has already talked over. Cancel it and reset the
          // cursor, or it plays on top of the next reply.
          this.probe("reply-cut");
          this.flush();
          // A caller talking over the goodbye takes the floor back — the
          // agent re-decides instead of hanging up under them.
          this.disarmHangup();
        }
        this.toolCoordinator?.onReplyDone(
          msg.reply_id ?? null,
          msg.status === "interrupted",
        );
        this.handlers.onReplyDone?.({
          replyId: msg.reply_id ?? null,
          interrupted: msg.status === "interrupted",
        });
        this.setState("listening");
        if (this.pendingHangup && msg.status !== "interrupted") {
          this.pendingHangup = false;
          // The closing line is scheduled but may still be playing —
          // reply.done only means generation finished. Let it drain first
          // (bounded: never hold the line more than ~10s for a goodbye).
          this.settleThenStop();
        }
        break;
      case "reply.started":
        this.toolCoordinator?.onReplyStarted(msg.reply_id ?? null);
        this.handlers.onReplyStarted?.();
        break;

      case "input.speech.started":
        // Barge-in: drop queued speech NOW so the user never talks over stale
        // audio. The interrupted `reply.done` flush below stays as a backstop.
        this.probe("barge-in");
        this.flush();
        this.disarmHangup();
        this.toolCoordinator?.onInputSpeechStarted();
        this.handlers.onInputSpeechStarted?.();
        break;

      case "transcript.user.delta":
        // Cumulative running partial for the turn — render the latest one,
        // never concatenate. Final assent must come from `transcript.user`.
        this.handlers.onUserPartial?.({
          itemId: typeof msg.item_id === "string" ? msg.item_id : null,
          text: typeof msg.text === "string" ? msg.text : "",
        });
        break;

      case "transcript.agent.delta":
        this.handlers.onAgentPartial?.({
          itemId:
            typeof msg.reply_id === "string"
              ? msg.reply_id
              : typeof msg.item_id === "string"
                ? msg.item_id
                : null,
          text: typeof msg.text === "string" ? msg.text : "",
        });
        break;

      case "tool.call":
        this.toolCoordinator?.onToolCall(msg);
        break;

      case "session.updated":
        this.resolveUpdate();
        break;

      case "transcript.user":
        this.handlers.onTranscript?.({ role: "user", text: msg.text });
        this.handlers.onUserTurn?.({
          itemId: typeof msg.item_id === "string" ? msg.item_id : null,
          text: typeof msg.text === "string" ? msg.text : "",
        });
        if (this.pendingTurnDetectionRestore !== undefined) {
          const turnDetection = this.pendingTurnDetectionRestore;
          this.pendingTurnDetectionRestore = undefined;
          void this.updateConfig({
            input: {
              turn_detection: turnDetection,
            },
          }).catch((error: unknown) =>
            this.handlers.onError?.({
              message: error instanceof Error ? error.message : "Could not restore call pacing.",
            }),
          );
        }
        break;

      case "transcript.agent":
        this.handlers.onTranscript?.({ role: "agent", text: msg.text });
        this.handlers.onAgentTurn?.({
          itemId:
            typeof msg.reply_id === "string"
              ? msg.reply_id
              : typeof msg.item_id === "string"
                ? msg.item_id
                : null,
          text: typeof msg.text === "string" ? msg.text : "",
        });
        break;

      case "session.error":
      case "error":
        if (!this.rejectUpdate(msg.message ?? "Could not update call pacing.")) {
          const expired = msg.code === "session_expired";
          if (expired) this.explicitStop = true;
          this.handlers.onError?.({
            message: msg.message ?? "The call ended unexpectedly.",
            code: expired ? "expired" : undefined,
          });
          if (expired) void this.cleanup();
        }
        break;

      case "session.ended":
        this.explicitStop = true;
        this.handlers.onSessionEnded?.({
          durationSeconds:
            typeof msg.session_duration_seconds === "number"
              ? msg.session_duration_seconds
              : null,
          audioSeconds:
            typeof msg.audio_duration_seconds === "number"
              ? msg.audio_duration_seconds
              : null,
        });
        void this.cleanup();
        break;
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("The call connection is closed.");
    }
    this.ws.send(JSON.stringify(message));
  }

  private async prepareSensitiveCapture() {
    try {
      const previous = this.activeTurnDetection
        ? { ...this.activeTurnDetection }
        : null;
      await this.updateConfig({
        input: {
          turn_detection: SENSITIVE_TURN_DETECTION,
        },
      });
      this.pendingTurnDetectionRestore = previous;
      return {
        ok: true as const,
        data: { ready: true, instruction: "Ask for the sensitive field now." },
      };
    } catch {
      return {
        ok: false as const,
        error: "Could not prepare sensitive capture. Ask the caller to repeat slowly.",
        retryable: true,
      };
    }
  }

  /**
   * Public serialized config update. One acknowledgement outstanding; the
   * rest wait in order. Screen-context pushes pass `coalescible: true` so a
   * burst of navigation/state updates collapses to the newest instead of
   * replaying stale screens.
   */
  updateConfig(
    session: Record<string, unknown>,
    opts: { coalescible?: boolean } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (opts.coalescible) {
        for (const queued of this.updateQueue) {
          if (queued.coalescible && !queued.started) {
            queued.reject(new Error("Superseded by a newer update."));
          }
        }
        this.updateQueue = this.updateQueue.filter((queued) => queued.started);
      }
      this.updateQueue.push({
        session,
        coalescible: opts.coalescible ?? false,
        started: false,
        timer: null,
        resolve,
        reject,
      });
      this.pumpUpdates();
    });
  }

  /**
   * Drop queued-but-unsent updates — call on route change so a late ack can't
   * configure the new screen with the old one. The in-flight update still
   * resolves normally; tools are swapped separately by the caller.
   */
  invalidatePendingUpdates(): void {
    for (const queued of this.updateQueue) {
      if (!queued.started) {
        if (queued.timer) clearTimeout(queued.timer);
        queued.reject(new Error("Superseded by navigation."));
      }
    }
    this.updateQueue = this.updateQueue.filter((queued) => queued.started);
  }

  /** True while the last config change is acknowledged. Bus reads this. */
  isConfigSynced(): boolean {
    return this.configSynced;
  }

  private pumpUpdates(): void {
    if (this.updateInFlight || this.updateQueue.length === 0) return;
    const item = this.updateQueue.shift() as QueuedUpdate;
    item.started = true;
    this.updateInFlight = item;
    item.timer = setTimeout(() => {
      this.updateInFlight = null;
      this.configSynced = false;
      this.handlers.onConfigUncertainty?.(true);
      item.reject(new Error("Call setting update timed out."));
      this.pumpUpdates();
    }, this.updateTimeoutMs);
    try {
      this.send({ type: "session.update", session: item.session });
    } catch (error) {
      if (item.timer) clearTimeout(item.timer);
      this.updateInFlight = null;
      item.reject(error instanceof Error ? error : new Error("Call update failed."));
      this.pumpUpdates();
    }
  }

  private resolveUpdate() {
    if (!this.updateInFlight) return;
    const item = this.updateInFlight;
    if (item.timer) clearTimeout(item.timer);
    this.updateInFlight = null;
    if (!this.firstUpdateAcked) {
      this.firstUpdateAcked = true;
      this.handlers.onTiming?.("firstUpdateAck");
    }
    const input = item.session.input;
    if (input && typeof input === "object" && "turn_detection" in input) {
      const turnDetection = (input as { turn_detection?: unknown })
        .turn_detection;
      this.activeTurnDetection =
        turnDetection && typeof turnDetection === "object"
          ? { ...(turnDetection as TurnDetection) }
          : null;
    }
    item.resolve();
    if (!this.configSynced) {
      this.configSynced = true;
      this.handlers.onConfigUncertainty?.(false);
    }
    this.pumpUpdates();
  }

  private rejectUpdate(message: string) {
    if (!this.updateInFlight) return false;
    const item = this.updateInFlight;
    if (item.timer) clearTimeout(item.timer);
    this.updateInFlight = null;
    item.reject(new Error(message));
    this.pumpUpdates();
    return true;
  }

  /** True when no agent audio is queued or still playing (queue drains on end). */
  playbackSettled(): boolean {
    return this.playout?.settled() ?? true;
  }

  /**
   * One coordinator per connection, for either mode: it times results
   * against replies, and an end_call result arms the drain-then-hangup.
   */
  private installTools(tools: VoiceTool[], execute: ToolCoordinatorOptions["execute"]): void {
    const modes = new Map(tools.map((tool) => [tool.name, tool.execution_mode]));
    this.toolCoordinator = new ToolCoordinator({
      send: (message) => this.send(message),
      modeFor: (name) => modes.get(name) ?? "interactive",
      onActivityChange: (active) => this.handlers.onToolActivity?.(active),
      onResult: (name, result) => {
        if (name === END_CALL_TOOL && result.ok && result.hangup === true) {
          this.pendingHangup = true;
        }
      },
      execute,
    });
  }

  /**
   * Demo: the stored agent's tools run on the call-scoped demo route, with
   * the latest call token (a resume mints a new one). The prompt is
   * server-owned; the browser only relays.
   */
  private installDemoTools(): void {
    this.installTools([END_CALL_VOICE_TOOL], (call) =>
      postTool(
        `/api/demo/tools/${encodeURIComponent(call.name)}`,
        { toolCallId: call.callId, arguments: call.arguments },
        { Authorization: `Bearer ${this.callToken}` },
      ),
    );
  }

  /**
   * Let the goodbye finish playing, then hang up. Polls playback (bounded
   * ~10s) because reply.done only means generation finished — the closing
   * line may still be draining through the worklet. See HANGUP_SETTLE_POLLS:
   * one settled poll is not proof of silence, so stop needs a streak.
   */
  private settleThenStop(): void {
    if (!this.ready || this.state === "ended") return;
    this.disarmHangupTimer();
    const audioQuiet = () =>
      Date.now() - this.lastAudioAt >= HANGUP_AUDIO_GRACE_MS;
    if (this.playbackSettled() && audioQuiet()) {
      void this.stop();
      return;
    }
    const started = Date.now();
    let settledPolls = 0;
    this.hangupTimer = setInterval(() => {
      // Disarmed mid-drain (caller spoke) or already ended: stand down.
      if (this.hangupTimer === null || !this.ready || this.isEnded()) {
        this.disarmHangupTimer();
        return;
      }
      settledPolls =
        this.playbackSettled() && audioQuiet() ? settledPolls + 1 : 0;
      if (
        settledPolls >= HANGUP_SETTLE_POLLS ||
        Date.now() - started > HANGUP_DRAIN_TIMEOUT_MS
      ) {
        this.disarmHangupTimer();
        this.stopIfLive();
      }
    }, HANGUP_POLL_MS);
  }

  /** Stop only while the session is still live (narrowing-safe). */
  private stopIfLive(): void {
    if (this.ready && !this.isEnded()) void this.stop();
  }

  private isEnded(): boolean {
    return this.state === "ended";
  }

  private disarmHangupTimer(): void {
    if (this.hangupTimer) {
      clearInterval(this.hangupTimer);
      this.hangupTimer = null;
    }
  }

  /** True while the user muted their mic: frames are dropped, the call stays up. */
  private inputMuted = false;

  /**
   * Mute/unmute the mic without tearing down the call. The worklet keeps
   * running (re-acquiring costs a permission round-trip and a reconnect);
   * frames are simply dropped while muted.
   */
  setInputMuted(muted: boolean): void {
    if (this.inputMuted === muted) return;
    this.inputMuted = muted;
    if (this.ready) {
      this.sendContext(muted ? MICROPHONE_MUTED_CONTEXT : MICROPHONE_UNMUTED_CONTEXT);
    }
  }

  /** Send hidden context without asking the agent to generate a reply. */
  sendContext(content: string): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.send(buildConversationMessage(content));
    } catch {
      // Context is best-effort if the session has already ended.
    }
  }

  /** Single choke point for mic frames, so mute is unit-testable. */
  private ingestAudio(data: ArrayBuffer) {
    if (!this.ready || this.inputMuted || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "input.audio",
        audio: toBase64(new Uint8Array(data)),
      }),
    );
  }

  /**
   * Ask the agent to speak right now (idle check-ins, status updates).
   * Best-effort: a dead session just means the idle timer will end things.
   */
  requestReply(instructions: string): void {
    try {
      this.send({ type: "reply.create", instructions });
    } catch {
      /* Session gone — nothing to nudge. */
    }
  }

  /** Queue one base64 PCM16 chunk on the playout worklet. */
  private schedule(base64: string) {
    this.playout?.play(fromBase64(base64), TARGET_SAMPLE_RATE);
  }

  /**
   * Drop everything queued. Used on barge-in and teardown. The worklet fades
   * what is sounding over FADE_OUT_S instead of a hard-stop click, and the
   * next reply starts from a clean buffer.
   */
  private flush() {
    const dropped = this.playout?.queuedMs() ?? 0;
    this.playout?.flush(FADE_OUT_S);
    this.probe("flush", dropped);
  }

  /** Emit one probe event. Never throws, never affects playback. */
  private probe(kind: AudioProbeEvent["kind"], queued = this.playout?.queuedMs() ?? 0) {
    try {
      this.handlers.onAudioProbe?.({
        kind,
        at: Date.now(),
        queued,
        sessionId: this.sessionId,
      });
    } catch {
      // Observation must not break the call.
    }
  }

  /**
   * Synchronous on purpose: this is also called from `pagehide`, where anything
   * async will not finish before the socket is torn down.
   */
  private sendEnd() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "session.end" }));
    }
  }

  /** Hang up. The server replies `session.ended`, and cleanup runs there. */
  async stop(): Promise<void> {
    // Invalidate first: an in-flight start (token/mic pending) aborts instead
    // of opening a session after the user stopped, and stale socket callbacks
    // from the dying connection are ignored from here on.
    this.explicitStop = true;
    this.generation.invalidate();
    // The mic releases synchronously so a preempting session (copilot <->
    // agent-test handoff) can acquire it immediately instead of racing a
    // 2s session.ended fallback. Idempotent; cleanup repeats it harmlessly.
    this.releaseMicNow();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendEnd();
      // Don't wait forever for session.ended — if it never arrives we still
      // need the mic released and the context closed.
      setTimeout(() => void this.cleanup(), 2000);
      return;
    }
    await this.cleanup();
  }

  private micReleased = false;

  /** Stop mic tracks + release registry ownership. Sync and idempotent. */
  private releaseMicNow(): void {
    if (!this.micReleased) {
      this.micReleased = true;
      this.stream?.getTracks().forEach((t) => t.stop());
      releaseMic(this.micOwner);
    }
  }

  private async cleanup(): Promise<void> {
    if (this.state === "ended") return;
    this.disarmHangup();
    this.setState("ended");
    this.ready = false;
    this.sessionId = null;
    this.lastAudioAt = 0;
    this.inputMuted = false;
    this.releaseMicNow();
    this.toolCoordinator?.clear();
    this.toolCoordinator = null;
    this.rejectUpdate("The call ended before its settings changed.");
    this.invalidatePendingUpdates();

    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    const wasSpeaking = !this.playbackSettled();
    this.flush();
    // Hang-up mid-reply: let the fade finish before the context closes.
    if (wasSpeaking) await new Promise((r) => setTimeout(r, FADE_OUT_S * 1000));

    try {
      this.worklet?.port.close();
      this.worklet?.disconnect();
    } catch {
      /* already torn down */
    }
    // Releasing the mic tracks is what turns off the browser's recording
    // indicator — skipping it leaves the tab looking like it's still listening.
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.audioCtx?.close();
    } catch {
      /* already closed */
    }

    this.ws = null;
    this.worklet = null;
    this.stream = null;
    this.audioCtx = null;
    this.playout = null;
  }
}

/** POST one tool call to a tool route; transport failures become retryable errors. */
async function postTool(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ToolResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!result || typeof result.ok !== "boolean") {
      throw new Error("The tool server returned an invalid response.");
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DOMException && error.name === "AbortError"
          ? "The tool timed out."
          : "The tool server is unavailable.",
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Chunk the conversion: String.fromCharCode(...bytes) blows the stack on big inputs. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
