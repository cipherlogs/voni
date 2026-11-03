/**
 * Browser client for the cascade pipeline service (`voice-pipeline/`).
 *
 * Same mic path as the managed session (shared `./mic-capture`: ownership,
 * constraints, 24 kHz worklet) but a different wire protocol: a token-only
 * config plus base64 PCM up, captions / base64 audio / metrics down. Server
 * owns turn-taking; this client renders and plays.
 *
 * The config carries **identity only** (ticket 65): a call token, the agent id
 * and the protocol version. The prompt and the tool list are assembled and
 * signed by the app (voice-pipeline/cascade/envelope.py) and reach the service
 * over the app channel; this client never holds them.
 *
 * Service auth: the call token in dev. Production deployments must put the
 * service behind the same session gate as the app — the browser never holds
 * vendor keys either way.
 */

import BOUNDS from "./cascade-bounds.json";
import { acquireMicStream, startAudioGraph } from "./mic-capture";
import { releaseMic } from "./mic-owner";
import type { Playout, WorkletPlayout } from "./playout";
import { pageClockMs, type CallMarks } from "./call-marks";
import {
  attachDeliveredCapture,
  finishDeliveredCapture,
  postDeliveredCapture,
  type CaptureResult,
  type CaptureWrite,
  type DeliveredCapture,
} from "./delivered-capture";
import {
  buildCascadeContextMessage,
  MICROPHONE_MUTED_CONTEXT,
  MICROPHONE_UNMUTED_CONTEXT,
} from "./context";
import { DEFAULT_OUTPUT_SAMPLE_RATE } from "./output-format";

export type CascadeCaption = {
  role: "user" | "agent";
  text: string;
  final: boolean;
};

/**
 * The protocol this client speaks. The service refuses a missing or unknown
 * version by name (voice-pipeline/cascade/token.py), so a half-deployed pair
 * fails loudly instead of running a different body.
 */
/** The demo's cold-reply cushion: 250 ms, half the phone owner's 500 ms. */
export const DEMO_PLAYOUT_CUSHION_S = 0.25;

export const CASCADE_PROTOCOL_VERSION = 1;

/**
 * How long the microphone waits for the service's `listening` (or first audio)
 * before it speaks anyway. The service now sends `listening` before the
 * greeting opens the gate in a normal call; this only covers a resumed or
 * silent call, so the caller is never left unheard.
 */
export const MIC_GATE_FALLBACK_MS = 8_000;

/**
 * How long one client reconnect may spend minting the resume body and opening
 * the replacement socket before it is a named failure. The bound is the
 * pipeline's recorded reconnect handshake (`reconnect.handshake_ms`), copied
 * once into `cascade-bounds.json`; a reconnect never waits on an invented
 * number.
 */
export const RECONNECT_HANDSHAKE_MS = BOUNDS.reconnectHandshakeMs;

/**
 * How long a caller's hang-up keeps the socket open for the service's `end`.
 * The service writes its end after the stop and then closes; the measured
 * caller-hangup latency is ~250-300 ms, so 500 ms leaves margin without
 * holding a hung-up line open.
 */
export const CALLER_END_WAIT_MS = 500;

/**
 * How long teardown waits for the delivered capture's close before it posts the
 * marks without it. The tap's own ack bound is 250 ms and the dev sink is
 * local; 500 ms covers both. A hung tap or upload must never strand the marks
 * behind a page that is already closing.
 */
export const MARKS_CAPTURE_WAIT_MS = 500;

/** Resolve true when `promise` settles inside `ms`; false at the bound. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (inside: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(inside);
    };
    const timer = setTimeout(() => finish(false), ms);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/**
 * What the browser is allowed to tell the service: identity only. The prompt
 * and the tool list are assembled and signed by the app (ticket 64) and reach
 * the service over the app channel; the browser never holds them.
 */
export type CascadeCallConfig = {
  serviceUrl: string;
  callToken: string;
  agentId: string;
  protocolVersion: number;
};

/** Why a cascade connect never opened the call. */
export type CascadeConnectFailure = "draining" | "managed" | "unavailable" | "protocol";

/**
 * A cascade *connect* failure, typed so the app can name the refusal.
 *
 * `draining` is the service's own refusal during a deploy (ticket 140: a
 * draining instance accepts no new call); `managed` is the service's routing
 * verdict that this call belongs on the managed engine (routing defaults to
 * `off`, so it is the common refusal); `unavailable` is the socket failing or
 * closing before the service accepted the call; `protocol` is the service
 * refusing an unknown or missing protocol version before any call exists.
 *
 * There is no retry verdict: the demo is the cascade's only client and has no
 * managed fallback (demo-cascade spec), so a refused connect is visitor-facing
 * and final.
 */
export class DrainingError extends Error {
  constructor(
    readonly code: CascadeConnectFailure,
    message: string,
  ) {
    super(message);
    this.name = "DrainingError";
  }
}

/**
 * What a live call's one reconnect attempt is doing: the transport drop it is
 * answering and which attempt this is (always 1 today).
 */
export type CascadeReconnectRequest = {
  reason: string;
  attempt: number;
};

export type CascadeHandlers = {
  onCaption?: (caption: CascadeCaption) => void;
  onAudio?: (pcm: Uint8Array, sampleRate: number) => void;
  onInterrupted?: () => void;
  /**
   * The reply's audio finished playing *and* its final caption had arrived:
   * both halves of a finished turn. This — never the final caption alone
   * (which streams in while the audio plays) and never a drain alone (a TTS
   * stall drains and then resumes the same reply) — is when the agent stops
   * holding the floor and the caller may answer.
   */
  onSpeechEnd?: () => void;
  onMetrics?: (metrics: unknown, turns: number) => void;
  onError?: (message: string) => void;
  onEnd?: (info: { turns: number }) => void;
  /**
   * The live call could not be resumed: the one attempt timed out, its mint
   * was refused, or a second drop arrived. Fires once with the named cause,
   * immediately before `onEnd`; the visitor is owed the reason.
   */
  onReconnectFailed?: (cause: string) => void;
  /** The playout emitted its first audible sample for this connection (once). */
  onFirstAudible?: () => void;
  /**
   * The call never opened: the service refused it as draining or as a routed-
   * managed call, or the socket failed/closed first. Fires once with the bare
   * cause; the demo has no managed retry. The session is already torn down
   * (socket closed, microphone released).
   */
  onConnectFailure?: (error: DrainingError) => void;
};

export type ServerEvent =
  | { kind: "caption"; role: "user" | "agent"; text: string; final: boolean }
  | { kind: "listening" }
  | { kind: "interrupted" }
  | { kind: "end_call" }
  | { kind: "end"; turns: number; metrics: unknown; protocolVersion?: number }
  | { kind: "error"; message: string; code?: string };

export function buildConfigMessage(config: CascadeCallConfig): string {
  // Identity only, and built explicitly: spreading the caller's object would
  // let a stray `systemPrompt`/`tools`/`pipeline` reach the wire, and the
  // service refuses a client-assembled body by name (ticket 65).
  return JSON.stringify({
    type: "config",
    protocolVersion: config.protocolVersion,
    agentId: config.agentId,
    callToken: config.callToken,
  });
}

const ENCODE_CHUNK = 0x8000;

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK));
  }
  return btoa(binary);
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeAudioFrame(data: ArrayBuffer): string {
  return JSON.stringify({ type: "audio", data: base64Encode(new Uint8Array(data)) });
}

export function encodeContextMessage(content: string): string {
  return JSON.stringify(buildCascadeContextMessage(content));
}

export function parseServerMessage(raw: string): ServerEvent | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  switch (record.type) {
    case "caption":
      if (record.role !== "user" && record.role !== "agent") return null;
      if (typeof record.text !== "string") return null;
      return {
        kind: "caption",
        role: record.role,
        text: record.text,
        final: record.final === true,
      };
    case "interrupted":
      return { kind: "interrupted" };
    case "listening":
      return { kind: "listening" };
    case "end_call":
      return { kind: "end_call" };
    case "end":
      return {
        kind: "end",
        turns: typeof record.turns === "number" ? record.turns : 0,
        metrics: record.metrics ?? null,
        // The service reports the version it spoke (ticket 138). Absent on a
        // service that predates the field; then there is nothing to compare.
        ...(typeof record.protocolVersion === "number"
          ? { protocolVersion: record.protocolVersion }
          : {}),
      };
    case "error":
      return {
        kind: "error",
        message: typeof record.message === "string" ? record.message : "Call failed.",
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
    default:
      return null;
  }
}

export function decodeAudioMessage(raw: string): {
  pcm: Uint8Array;
  sampleRate: number;
  /**
   * The browser session's monotonic number the service stamped (`seq`), when
   * present. Absent on a service that predates the sequence (and in unit
   * fixtures). It continues across a pipeline leg reconnect and restarts with
   * a replacement browser socket, never with the TTS flush.
   */
  seq?: number;
} | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "audio" || typeof record.data !== "string") return null;
  const seq =
    typeof record.seq === "number" && Number.isInteger(record.seq) && record.seq >= 0
      ? record.seq
      : undefined;
  return {
    pcm: base64Decode(record.data),
    // The pipeline's own contract (voice-pipeline/transport.py): every frame
    // stamps the rate the TTS produced, so a frame that omits it can only be
    // our default PCM16 stream. The fallback is output-format's named default,
    // the same rate the managed path resolves when its confirmation carries
    // none — never a second, drifting copy of 24 kHz.
    sampleRate:
      typeof record.sample_rate === "number"
        ? record.sample_rate
        : DEFAULT_OUTPUT_SAMPLE_RATE,
    ...(seq === undefined ? {} : { seq }),
  };
}

export type MicHandle = {
  stop: () => void;
  audioCtx?: AudioContext | null;
  /** Default output: the shared worklet playout on the mic's context. */
  playout?: Playout;
};

export type CascadeDeps = {
  socketFactory?: (url: string) => WebSocket;
  startMic?: (owner: string, onFrame: (data: ArrayBuffer) => void) => Promise<MicHandle>;
  createPlayout?: (audioCtx: AudioContext | null | undefined) => Playout;
  /** Dev delivered capture sink; defaults to the dev-only WAV route. */
  writeCapture?: CaptureWrite;
  /** Capture clock, injectable for a deterministic filename. */
  captureNow?: () => Date;
  /**
   * Dev-only call marks (`?delivercapture=1`), the same recorder the landing
   * page posts on teardown. Absent means the stream is off.
   */
  marks?: CallMarks | null;
  /**
   * Re-mint the resume body for the same call id and return the replacement
   * identity (the hold-return mint the pipeline already supports). Absent means
   * a live drop keeps the old behaviour: the call ends.
   */
  reconnect?: (request: CascadeReconnectRequest) => Promise<CascadeCallConfig>;
};

/** The worklet handle `out` is a `WorkletPlayout`; a test playout may not be. */
type TappablePlayout = Playout &
  Pick<WorkletPlayout, "tap" | "onTap" | "onCaptureStarted">;

function isTappable(playout: Playout | null): playout is TappablePlayout {
  return playout !== null && typeof (playout as Partial<WorkletPlayout>).tap === "function";
}

async function defaultStartMic(
  owner: string,
  onFrame: (data: ArrayBuffer) => void,
): Promise<MicHandle> {
  const stream = await acquireMicStream(owner);
  const graph = await startAudioGraph(owner, stream, onFrame).catch((e) => {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  });
  return {
    audioCtx: graph.audioCtx,
    playout: graph.playout,
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      graph.stop();
      releaseMic(owner);
    },
  };
}

export class CascadeSession {
  private ws: WebSocket | null = null;
  private micStop: (() => void) | null = null;
  private playout: Playout | null = null;
  private started = false;
  private ended = false;
  private configSent = false;
  private inputMuted = false;
  /**
   * The service is live: its first audio frame has arrived. Microphone frames
   * sent before this are held, never queued:
   *
   * The connect takes seconds (mint, admission, the vendor handshake), and the
   * mic is live for all of it. Whatever the caller says in that window cannot
   * be heard by a session that does not exist yet; forwarding it made the
   * service deliver seconds of backlog at once when the session opened, and the
   * vendor closes a stream that arrives ahead of real time ("Audio processing
   * backlog too large"). A resumed call speaks no greeting, so a bounded timer
   * opens the gate even when no audio ever arrives.
   */
  private micLive = false;
  private micGateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The service accepted the call: any valid server frame arrived. */
  private accepted = false;
  /** The connect failure was already reported (one report per connect). */
  private connectFailureReported = false;
  /**
   * The highest call-level audio `seq` already played. The receiving contract
   * (`CallPlayout` in voice-pipeline/cascade/call.py) is: a frame whose seq is
   * not greater is dropped, never played twice. A gap is played through. The
   * number is per browser session: it continues across a pipeline leg
   * reconnect, and a replacement browser socket starts a fresh `CallSequence`,
   * so a client reconnect resets the high-water mark (no old socket is left to
   * replay a frame).
   */
  private highestPlayedSeq = 0;
  /**
   * Agent-initiated hangup, armed by the server's end_call event. The
   * closing line may still be draining through the worklet, so stop waits
   * for playback to settle (bounded ~10s). Disarmed by caller speech or
   * interruption — the floor changed hands back.
   */
  private endCallArmed = false;
  /** Dev delivered capture (`?delivercapture=1`): off unless the caller sets it. */
  private deliveredCaptureOn = false;
  private deliveredCapture: DeliveredCapture | null = null;
  /** The capture's first written sample is one mark, never one per tap block. */
  private captureStartedMarked = false;
  private captureOutcome: CaptureResult | null = null;
  private captureCallId: string | null = null;
  private teardownMarked = false;
  /**
   * The current agent reply's two turn-end facts, reset together per reply:
   *
   *  - `replyComplete`: the agent's final caption for this turn has arrived, so
   *    no more text — and therefore no more audio — will be produced.
   *  - `replyDrained`: the playout's queue has run dry since the reply started.
   *
   * Either alone is not the end. A drain before the final caption is a TTS
   * stall (the same reply resumes when audio arrives), and a final caption
   * streams in while most of the reply's audio is still playing. The turn ends
   * only when both are true; no timer is involved.
   */
  private replyActive = false;
  private replyComplete = false;
  private replyDrained = false;
  /** The one capture close, so teardown can wait for an in-flight tap ack. */
  private captureClosing: Promise<void> | null = null;
  /** Teardown runs once; all paths await the same completion. */
  private teardownPromise: Promise<void> | null = null;
  /** The service's end frame arrived (never inferred). */
  private endSeen = false;
  /** The caller's `stop` started this ending. */
  private callerStop = false;
  private endMissingMarked = false;
  /** A `stop` waiter for the service's end, resolved by the frame or the bound. */
  private endWaiters: Array<(received: boolean) => void> = [];
  /**
   * One client reconnect per call: a second transport drop ends the call. The
   * count is the attempt number the reconnect marks carry; it resets only with
   * a fresh session.
   */
  private reconnectAttempts = 0;
  /** A reconnect is minting/connecting; the replacement socket has not admitted. */
  private reconnecting = false;
  /** The named reconnect failure was already reported (one report per call). */
  private reconnectFailedReported = false;
  /** The handshake bound that releases a stuck reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly writeCapture: CaptureWrite;
  private readonly captureNow: (() => Date) | undefined;
  private readonly marks: CallMarks | null;

  constructor(
    private handlers: CascadeHandlers = {},
    private deps: CascadeDeps = {},
  ) {
    this.writeCapture = deps.writeCapture ?? postDeliveredCapture;
    this.captureNow = deps.captureNow;
    this.marks = deps.marks ?? null;
  }

  /**
   * Must be called from inside a user gesture (click/touch): mic and audio
   * startup are gated behind one in every major browser.
   */
  async start(config: CascadeCallConfig, micOwner = "voice-call"): Promise<void> {
    this.ended = false;
    this.inputMuted = false;
    this.configSent = false;
    this.micLive = false;
    this.accepted = false;
    this.connectFailureReported = false;
    this.highestPlayedSeq = 0;
    this.teardownMarked = false;
    this.captureStartedMarked = false;
    this.captureClosing = null;
    this.teardownPromise = null;
    this.endSeen = false;
    this.callerStop = false;
    this.endMissingMarked = false;
    this.endWaiters = [];
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.reconnectFailedReported = false;
    this.clearReconnectTimer();
    this.openSocket(config);
    const startMic = this.deps.startMic ?? defaultStartMic;
    const handle = await startMic(micOwner, (data) => {
      // The current socket, never the first one: a reconnect replaces `ws`, and
      // a closure over the dropped socket would leave the caller unheard.
      if (
        this.started &&
        this.micLive &&
        !this.inputMuted &&
        this.ws !== null &&
        this.ws.readyState === this.ws.OPEN
      ) {
        this.send(encodeAudioFrame(data));
      }
    });
    // The connect can fail while the mic prompt is open (a draining service
    // refuses before getUserMedia resolves). The attempt is already torn down;
    // release this late mic and do not mark a dead attempt started.
    if (this.ended) {
      handle.stop();
      return;
    }
    this.micStop = handle.stop;
    this.marks?.mark("microphone_acquired");
    this.playout = this.deps.createPlayout?.(handle.audioCtx) ?? handle.playout ?? null;
    // The cascade is the browser-only demo (ADR-0012). Start its replies on a
    // 250 ms cushion instead of the owner's 500 ms phone cushion: the caller
    // hears the first word 250 ms sooner, and 250 ms is still three times the
    // 80 ms that broke up on phones. The worklet clamps any raise to 500 ms.
    this.playout?.setCushion?.(DEMO_PLAYOUT_CUSHION_S);
    // Dev delivered capture: the worklet's output, at the device rate. It is
    // observation only — the tap copies samples after rendering, so it cannot
    // move a sample, a chunk boundary or a playout deadline.
    if (this.deliveredCaptureOn && isTappable(this.playout)) {
      this.deliveredCapture = attachDeliveredCapture(this.playout, {
        sampleRate: handle.audioCtx?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE,
        write: this.writeCapture,
        ...(this.captureNow === undefined ? {} : { now: this.captureNow }),
        ...(this.captureCallId === null ? {} : { callId: this.captureCallId }),
      });
      // The capture's real clock anchor. It is the playout worklet's first
      // written sample, stamped in the same page clock as the harness
      // timeline and `timeline.spoken[].atMs`; the preview mix places every
      // take at `atMs - capture_started` instead of inferring an origin.
      this.playout.onCaptureStarted = (performanceNowMs) => {
        if (this.captureStartedMarked) return;
        this.captureStartedMarked = true;
        this.marks?.mark("capture_started", { atMs: pageClockMs(performanceNowMs) });
      };
    } else if (this.deliveredCaptureOn) {
      // The capture flag is on but this playout cannot be tapped: a named gap,
      // never a silent absence when the artifact is read.
      this.marks?.mark("delivered_capture", { complete: false, reason: "not-tappable" });
    }
    // Chime trigger: the worklet's first audible sample, not the queued frame.
    if (this.playout) {
      this.playout.onFirstAudible = () => {
        this.marks?.mark("first_audible");
        this.handlers.onFirstAudible?.();
      };
      // One half of a turn end: the queue ran dry after the last sample
      // sounded. A drain before the final caption is a TTS stall — the same
      // reply resumes when audio arrives — so it must not open the caller's
      // turn. `endReplyIfDrained` only ends a reply whose text is complete.
      this.playout.onDrained = () => {
        if (this.ended) return;
        this.replyDrained = true;
        this.endReplyIfDrained();
      };
    }
    this.started = true;
    // A silent or skipped greeting sends `listening` before the line, so the
    // gate opens without an audible sample; the bound still covers a resumed
    // call or a dropped `listening`, so the caller is never silent forever.
    this.micGateTimer = setTimeout(() => this.openMicGate(), MIC_GATE_FALLBACK_MS);
    // Socket may already be open (fake sockets, fast localhost): flush config now.
    if (this.ws !== null && this.ws.readyState === this.ws.OPEN) this.sendConfig(config);
  }

  /**
   * Wire one socket. The drop handlers are the only place a live call decides
   * whether to reconnect; a connect failure before acceptance stays a named
   * refusal, and a caller's stop is never a drop.
   */
  private openSocket(config: CascadeCallConfig): void {
    const socketFactory = this.deps.socketFactory ?? ((url: string) => new WebSocket(url));
    const ws = socketFactory(config.serviceUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.marks?.mark("socket_open");
      this.sendConfig(config);
    };
    ws.onmessage = (event: MessageEvent) => {
      this.receive(typeof event.data === "string" ? event.data : "");
    };
    ws.onerror = () => {
      if (this.reconnecting) {
        this.failReconnect("socket-error");
        return;
      }
      if (!this.accepted) {
        this.failConnect("unavailable", "Connection to the voice service failed.");
        return;
      }
      // An accepted socket's error is followed by close; let that decide
      // between the one reconnect and the end. Reporting it here would paint
      // an error over a call that is about to resume.
      if (this.deps.reconnect !== undefined) return;
      this.handlers.onError?.("Connection to the voice service failed.");
    };
    ws.onclose = (event?: { code?: number; reason?: string }) => {
      if (this.ended) return;
      if (this.reconnecting) {
        // The replacement socket never admitted: the one attempt is over.
        this.failReconnect("socket-closed");
        return;
      }
      if (!this.accepted && !this.connectFailureReported) {
        this.failConnect(
          "unavailable",
          "The voice service closed the connection before the call started.",
        );
        return;
      }
      this.unexpectedDrop(event?.code ?? null);
    };
  }

  /**
   * A socket closed after the call was live and nothing asked it to. Reconnect
   * once; a second drop, or no reconnect seam, ends the call as before.
   */
  private unexpectedDrop(code: number | null): void {
    if (this.ended) return;
    if (
      this.deps.reconnect === undefined ||
      !this.started ||
      this.callerStop ||
      this.endSeen
    ) {
      this.finish(0);
      return;
    }
    if (this.reconnectAttempts === 0) {
      void this.beginReconnect("socket-closed", code);
      return;
    }
    this.failReconnect("second-drop", this.reconnectAttempts + 1);
  }

  /**
   * Spend the call's one reconnect: mint a resume body for the same call id
   * (the hold-return mint), then open a replacement socket and send config.
   * The resumed body omits the greeting, so nothing is replayed; the live
   * microphone, playout and call-level audio sequence are kept.
   */
  private async beginReconnect(reason: string, code: number | null): Promise<void> {
    if (this.reconnecting || this.ended) return;
    const reconnect = this.deps.reconnect;
    if (reconnect === undefined) {
      this.finish(0);
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.marks?.mark("reconnect", {
      reason,
      attempt,
      ...(code === null ? {} : { code }),
    });
    this.reconnectTimer = setTimeout(
      () => this.failReconnect("timeout", attempt),
      RECONNECT_HANDSHAKE_MS,
    );
    let config: CascadeCallConfig;
    try {
      config = await reconnect({ reason, attempt });
    } catch {
      this.failReconnect("mint-failed", attempt);
      return;
    }
    // A caller's stop, a failure or the bound may have landed while minting.
    if (!this.reconnecting || this.ended || this.reconnectAttempts !== attempt) return;
    this.configSent = false;
    this.accepted = false;
    // The replacement socket's pipeline session numbers its audio from the
    // start again; the old socket is gone, so nothing can replay.
    this.highestPlayedSeq = 0;
    try {
      this.openSocket(config);
      if (this.ws !== null && this.ws.readyState === this.ws.OPEN) this.sendConfig(config);
    } catch {
      this.failReconnect("socket-error", attempt);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * The one reconnect is over without a resumed call. Name the cause, tell the
   * visitor, and end the call; no further socket is opened.
   */
  private failReconnect(cause: string, attempt = this.reconnectAttempts): void {
    if (this.reconnectFailedReported || this.ended) return;
    this.reconnectFailedReported = true;
    this.reconnecting = false;
    this.clearReconnectTimer();
    this.marks?.mark("reconnect_failed", { cause, attempt });
    this.handlers.onReconnectFailed?.(cause);
    this.finish(0);
  }

  /**
   * Dev delivered capture (`?delivercapture=1`): set before `start`. Taps the
   * playout worklet's rendered output and writes one WAV on hang-up. The flag
   * parser is inert in a production build, so this never runs there. The call
   * id is the same one the marks artifact carries, so the WAV and the marks
   * can be paired without matching timestamps by hand.
   */
  setDeliveredCapture(on: boolean, callId?: string): void {
    this.deliveredCaptureOn = on;
    this.captureCallId = on ? (callId ?? null) : null;
  }

  /**
   * The last capture's named outcome (`complete`, or why it is missing or
   * short). Null until a capture with the flag on has closed.
   */
  deliveredCaptureResult(): CaptureResult | null {
    return this.captureOutcome;
  }

  /** Drop only microphone frames; keep the socket and agent playback alive. */
  setInputMuted(muted: boolean): void {
    if (this.inputMuted === muted) return;
    this.inputMuted = muted;
    if (this.started && this.configSent && this.ws?.readyState === this.ws?.OPEN) {
      this.sendContext(muted ? MICROPHONE_MUTED_CONTEXT : MICROPHONE_UNMUTED_CONTEXT);
    }
  }

  /** Hidden context is applied to the next generated turn and never captioned. */
  sendContext(content: string): void {
    if (!this.started || !this.configSent || this.ws?.readyState !== this.ws?.OPEN) return;
    this.send(encodeContextMessage(content));
  }

  private sendConfig(config: CascadeCallConfig): void {
    if (this.configSent || !this.started) return;
    this.configSent = true;
    this.send(buildConfigMessage(config));
    this.marks?.mark("config_sent");
  }

  /** Dispatch one raw server frame. Public so the socket layer stays thin. */
  receive(raw: string): void {
    if (!raw) return;
    const audio = decodeAudioMessage(raw);
    if (audio) {
      this.admit("audio");
      this.openMicGate();
      if (audio.seq !== undefined) {
        if (audio.seq <= this.highestPlayedSeq) {
          // The session-level contract: an audio frame that is not newer is
          // never played twice. A duplicate inside one session is dropped; a
          // replacement session resets the mark in `beginReconnect`.
          console.debug(
            `[cascade-session] dropped duplicate audio seq=${audio.seq}; the highest played is ${this.highestPlayedSeq}`,
          );
          return;
        }
        this.highestPlayedSeq = audio.seq;
      }
      // A played frame after a drained reply is either the next turn's first
      // audio or the same reply resuming after a TTS stall. In both cases the
      // queue is no longer empty, so `drained` is no longer true for this
      // reply; a first frame starts a fresh pair.
      if (!this.replyActive) {
        this.replyActive = true;
        this.replyComplete = false;
        this.replyDrained = false;
      } else if (this.replyDrained) {
        this.replyDrained = false;
      }
      this.playout?.play(audio.pcm, audio.sampleRate);
      this.handlers.onAudio?.(audio.pcm, audio.sampleRate);
      return;
    }
    const event = parseServerMessage(raw);
    if (!event) return;
    if (event.kind !== "error") this.admit(event.kind);
    switch (event.kind) {
      case "caption":
        if (event.role === "user") this.endCallArmed = false;
        this.handlers.onCaption?.({ role: event.role, text: event.text, final: event.final });
        // The agent's final caption closes its *text*, not its audio. It is
        // one half of the turn end: the drain is the other. A reply whose
        // audio already drained (a stall the final outlived) ends here.
        if (event.role === "agent" && event.final) {
          this.replyComplete = true;
          this.endReplyIfDrained();
        }
        break;
      case "listening":
        // The service opens the line before the greeting so a caller who
        // speaks first is heard first. Release the microphone now, not on the
        // greeting's first sample.
        this.openMicGate();
        break;
      case "interrupted":
        this.endCallArmed = false;
        // The cut reply never finishes: drop both turn-end facts so the next
        // reply's audio starts a clean pair, never inheriting a final.
        this.replyActive = false;
        this.replyComplete = false;
        this.replyDrained = false;
        this.playout?.flush();
        this.handlers.onInterrupted?.();
        break;
      case "end_call":
        this.marks?.mark("end_call_received");
        this.endCallArmed = true;
        this.drainThenStop();
        break;
      case "end":
        this.endSeen = true;
        this.releaseEndWaiters(true);
        this.marks?.mark("end_received", { turns: event.turns });
        // The service reports the version it spoke (ticket 138). A half-
        // deployed pair fails loudly here too, not only at connect.
        if (
          event.protocolVersion !== undefined &&
          event.protocolVersion !== CASCADE_PROTOCOL_VERSION
        ) {
          this.handlers.onError?.(
            `The voice service speaks protocol version ${event.protocolVersion}; this app speaks ${CASCADE_PROTOCOL_VERSION}. Update the app or the service together.`,
          );
        }
        this.handlers.onMetrics?.(event.metrics, event.turns);
        this.finish(event.turns);
        break;
      case "error":
        // One mark per error frame: the visitor's named state is the fact L10
        // judges. The code is the service's closed vocabulary, never its text.
        this.marks?.mark("error_received", { code: event.code ?? "" });
        // A named refusal before the service accepted the call means the call
        // never opened: `draining` (a deploy), `managed` (routing sent this
        // call to the managed engine — routing defaults to `off`, so this is
        // the common path) and `protocol_version` (a half-deployed pair) are
        // connect failures the app surfaces. Once accepted they are ordinary
        // call errors: the call already started, so a retry would double-dial
        // it. Surface those, never re-route them.
        if (
          !this.accepted &&
          (event.code === "draining" ||
            event.code === "managed" ||
            event.code === "protocol_version")
        ) {
          // A refusal of the replacement socket is a failed reconnect, not a
          // refused connect: the call was already live, so the visitor hears
          // the drop's cause instead of the start's unavailable state.
          if (this.reconnecting || this.reconnectAttempts > 0) {
            this.failReconnect(`refused:${event.code}`, this.reconnectAttempts);
            break;
          }
          this.failConnect(
            event.code === "protocol_version" ? "protocol" : event.code,
            event.message,
          );
          break;
        }
        this.handlers.onError?.(event.message);
        // A version refusal means the service never opened the call. Tear the
        // socket down so the UI is not left waiting with a live microphone.
        if (event.code === "protocol_version") this.abort();
        break;
    }
  }

  /**
   * End the current reply only when both turn-end facts hold: its final
   * caption has arrived (no more audio will be queued) and its playout has
   * drained (the last queued sample sounded). Called from both edges, so the
   * later of the two decides. The pair is consumed here, never reused, and a
   * drain before the final is left as a stall for the resumed audio to clear.
   */
  private endReplyIfDrained(): void {
    if (!this.replyActive || !this.replyComplete || !this.replyDrained) return;
    this.replyActive = false;
    this.replyComplete = false;
    this.replyDrained = false;
    this.handlers.onSpeechEnd?.();
  }

  /** The service accepted the call: the first non-error frame is the admission. */
  private admit(via: string): void {
    if (this.accepted) return;
    this.accepted = true;
    // The replacement admitted inside the bound: the reconnect succeeded and
    // the handshake timer has nothing left to release.
    if (this.reconnecting) {
      this.reconnecting = false;
      this.clearReconnectTimer();
    }
    this.marks?.mark("admitted", {
      via,
      ...(this.reconnectAttempts > 0 ? { attempt: this.reconnectAttempts } : {}),
    });
  }

  /**
   * Let the goodbye finish playing, then hang up. The worklet reports
   * settled() when nothing is queued or sounding; without that signal
   * there is nothing to drain toward, so stop at once. Bounded ~10s —
   * never hold the line for a goodbye.
   */
  private drainThenStop(): void {
    const settled = (
      this.playout as { settled?: () => boolean } | null
    )?.settled;
    const isSettled = () => (settled ? settled.call(this.playout) : true);
    if (!this.started || this.ended || isSettled()) {
      this.endCallArmed = false;
      if (this.started && !this.ended) void this.stop();
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      // Disarmed mid-drain (caller spoke) or already ended: stand down.
      if (!this.endCallArmed || !this.started || this.ended) {
        clearInterval(timer);
        return;
      }
      if (isSettled() || Date.now() - started > 10000) {
        clearInterval(timer);
        this.endCallArmed = false;
        if (this.started && !this.ended) void this.stop();
      }
    }, 250);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.callerStop = true;
    // The visitor hung up: cancel any reconnect that is still minting. A stop
    // is never a drop, so no replacement socket may open after it.
    this.reconnecting = false;
    this.clearReconnectTimer();
    try {
      if (this.ws?.readyState === this.ws?.OPEN) this.send(JSON.stringify({ type: "stop" }));
    } catch {
      // Socket already gone; local teardown below still runs.
    }
    // Start the tap flush first: it must keep the graph alive while the socket
    // stays open for the service's end, and neither may wait on the other.
    void this.closeCapture();
    // The service writes its end after our stop and then closes. Waiting for
    // it is what turns a caller hang-up into an end_received mark instead of a
    // teardown with no ending; the bound never holds a dead line open.
    if (this.ws?.readyState === this.ws?.OPEN) await this.awaitEnd();
    await this.teardown();
  }

  /**
   * Wait, bounded, for the service's end after a caller's stop. The frame
   * resolves this early; a socket close resolves it as "not received" at once;
   * otherwise the bound releases it.
   */
  private awaitEnd(): Promise<boolean> {
    if (this.endSeen) return Promise.resolve(true);
    if (this.ended) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (received: boolean) => {
        clearTimeout(timer);
        resolve(received);
      };
      const timer = setTimeout(() => {
        this.endWaiters = this.endWaiters.filter((entry) => entry !== waiter);
        resolve(false);
      }, CALLER_END_WAIT_MS);
      this.endWaiters.push(waiter);
    });
  }

  /** Release every stop waiter; a frame is the service's answer, a close is not. */
  private releaseEndWaiters(received: boolean): void {
    const waiters = this.endWaiters;
    this.endWaiters = [];
    for (const waiter of waiters) waiter(received);
  }

  /** The service is live: release the microphone frames from here on. */
  private openMicGate(): void {
    if (this.micLive) return;
    this.micLive = true;
    if (this.micGateTimer !== null) {
      clearTimeout(this.micGateTimer);
      this.micGateTimer = null;
    }
  }

  private send(message: string): void {
    try {
      this.ws?.send(message);
    } catch {
      // Drops on a closing socket are expected during hangup.
    }
  }

  /**
   * Close the capture before the playout is dropped: tap off flushes the
   * worklet's final partial block, then exactly one WAV is written. Dev-only,
   * best-effort, and idempotent — observation never fails a hang-up.
   */
  private closeCapture(): Promise<void> {
    if (this.captureClosing) return this.captureClosing;
    const capture = this.deliveredCapture;
    const playout = this.playout;
    this.deliveredCapture = null;
    if (!capture) {
      this.captureClosing = Promise.resolve();
      return this.captureClosing;
    }
    this.captureClosing = (async () => {
      try {
        this.captureOutcome = await finishDeliveredCapture(
          isTappable(playout) ? playout : null,
          capture,
        );
        this.marks?.mark("delivered_capture", { ...this.captureOutcome });
      } catch {
        /* capture is dev instrumentation */
      }
    })();
    return this.captureClosing;
  }

  /**
   * End the call. The socket and the playout references go at once, but the
   * audio graph (which owns the tap's worklet) is released only after the
   * capture's final block has been acked. Closing it first was the truncation:
   * a caller hang-up's `end` frame tore the context down while the tap's last
   * block was still in flight, so the WAV lost its tail and the session
   * reported a false `tap-timeout`. The tap's own bound keeps this wait finite,
   * and a genuinely suspended context still reports `tap-timeout`.
   */
  private teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.clearReconnectTimer();
    if (this.micGateTimer !== null) {
      clearTimeout(this.micGateTimer);
      this.micGateTimer = null;
    }
    this.micLive = false;
    // A caller hang-up whose end never arrived has an honest ending mark: the
    // absence itself. A received end is marked in `receive` and never guessed.
    if (this.callerStop && !this.endSeen && !this.endMissingMarked) {
      this.endMissingMarked = true;
      this.marks?.mark("end_missing", { after: "stop" });
    }
    if (!this.teardownMarked) {
      this.teardownMarked = true;
      this.marks?.mark("teardown");
    }
    // A socket drop or the end message can land without an awaited stop;
    // start the capture close before the playout reference goes away. The one
    // marks artifact posts once the capture outcome is known, or once the
    // bound expires, and is never awaited by a caller: a slow or dead sink
    // cannot hold up a hang-up and a closing page still sends it.
    const captureClosed = this.closeCapture();
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
    this.playout = null;
    this.teardownPromise = (async () => {
      const closed = await settlesWithin(captureClosed, MARKS_CAPTURE_WAIT_MS);
      if (!closed) {
        // The outcome may still arrive after this post; it cannot be added to
        // a finished artifact, so the absence is named now, never invented.
        this.marks?.mark("delivered_capture_absent", {
          reason: "not-closed",
          waitedMs: MARKS_CAPTURE_WAIT_MS,
        });
      }
      // Never awaited: a slow or dead sink cannot hold up a hang-up.
      void this.marks?.finish();
      try {
        this.micStop?.();
      } catch {
        // Mic already released on competing teardown paths.
      }
      this.micStop = null;
    })();
    return this.teardownPromise;
  }

  private finish(turns: number): void {
    if (this.ended) return;
    this.ended = true;
    this.started = false;
    this.releaseEndWaiters(false);
    void this.teardown();
    this.handlers.onEnd?.({ turns });
  }

  /**
   * Report a connect failure once, then tear this attempt down. The session
   * only names the cause; the app owns the visitor-facing copy and the demo
   * has no managed retry to decide.
   */
  private failConnect(cause: CascadeConnectFailure, message: string): void {
    if (this.connectFailureReported || this.ended) return;
    this.connectFailureReported = true;
    this.marks?.mark("refused", { code: cause });
    const error = new DrainingError(cause, message);
    this.abort();
    if (this.handlers.onConnectFailure) this.handlers.onConnectFailure(error);
    else this.handlers.onError?.(error.message);
  }

  /**
   * Stop without reporting a completed call: used when the service refused the
   * connect (a protocol-version mismatch, a draining instance, or a routed-
   * managed verdict). The error handler already has the named reason; `onEnd`
   * would read as "the call ran".
   */
  private abort(): void {
    if (this.ended) return;
    this.ended = true;
    this.started = false;
    this.releaseEndWaiters(false);
    void this.teardown();
  }
}
