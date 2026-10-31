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

import { acquireMicStream, startAudioGraph } from "./mic-capture";
import { releaseMic } from "./mic-owner";
import type { Playout, WorkletPlayout } from "./playout";
import type { CallMarks } from "./call-marks";
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

export type CascadeHandlers = {
  onCaption?: (caption: CascadeCaption) => void;
  onAudio?: (pcm: Uint8Array, sampleRate: number) => void;
  onInterrupted?: () => void;
  onMetrics?: (metrics: unknown, turns: number) => void;
  onError?: (message: string) => void;
  onEnd?: (info: { turns: number }) => void;
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
   * The call-level monotonic number the service stamped (`seq`), when present.
   * Absent on a service that predates the sequence (and in unit fixtures).
   * It belongs to the call, not the TTS flush, so a reconnect continues it.
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
};

/** The worklet handle `out` is a `WorkletPlayout`; a test playout may not be. */
type TappablePlayout = Playout & Pick<WorkletPlayout, "tap" | "onTap">;

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
  /** The service accepted the call: any valid server frame arrived. */
  private accepted = false;
  /** The connect failure was already reported (one report per connect). */
  private connectFailureReported = false;
  /**
   * The highest call-level audio `seq` already played. The receiving contract
   * (`CallPlayout` in voice-pipeline/cascade/call.py) is: a frame whose seq is
   * not greater is dropped, never played twice. A gap is played through; the
   * number is per call, so a reconnect continues it. Reset with the session,
   * because one connection is one call.
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
  private captureOutcome: CaptureResult | null = null;
  private captureCallId: string | null = null;
  private teardownMarked = false;
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
    this.accepted = false;
    this.connectFailureReported = false;
    this.highestPlayedSeq = 0;
    this.teardownMarked = false;
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
      if (!this.accepted) {
        this.failConnect("unavailable", "Connection to the voice service failed.");
        return;
      }
      this.handlers.onError?.("Connection to the voice service failed.");
    };
    ws.onclose = () => {
      if (!this.accepted && !this.ended && !this.connectFailureReported) {
        this.failConnect(
          "unavailable",
          "The voice service closed the connection before the call started.",
        );
        return;
      }
      this.finish(0);
    };
    const startMic = this.deps.startMic ?? defaultStartMic;
    const handle = await startMic(micOwner, (data) => {
      if (this.started && !this.inputMuted && ws.readyState === ws.OPEN) {
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
    }
    this.started = true;
    // Socket may already be open (fake sockets, fast localhost): flush config now.
    if (ws.readyState === ws.OPEN) this.sendConfig(config);
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
      if (audio.seq !== undefined) {
        if (audio.seq <= this.highestPlayedSeq) {
          // The call-level contract: an audio frame that is not newer is never
          // played twice. A replay after a reconnect arrives as an old seq, so
          // this is also the reconnect guard.
          console.debug(
            `[cascade-session] dropped duplicate audio seq=${audio.seq}; the highest played is ${this.highestPlayedSeq}`,
          );
          return;
        }
        this.highestPlayedSeq = audio.seq;
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
        break;
      case "interrupted":
        this.endCallArmed = false;
        this.playout?.flush();
        this.handlers.onInterrupted?.();
        break;
      case "end_call":
        this.marks?.mark("end_call_received");
        this.endCallArmed = true;
        this.drainThenStop();
        break;
      case "end":
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

  /** The service accepted the call: the first non-error frame is the admission. */
  private admit(via: string): void {
    if (this.accepted) return;
    this.accepted = true;
    this.marks?.mark("admitted", { via });
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
    try {
      if (this.ws?.readyState === this.ws?.OPEN) this.send(JSON.stringify({ type: "stop" }));
    } catch {
      // Socket already gone; local teardown below still runs.
    }
    await this.closeCapture();
    this.teardown();
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
    const capture = this.deliveredCapture;
    const playout = this.playout;
    this.deliveredCapture = null;
    if (!capture) return Promise.resolve();
    return (async () => {
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
  }

  private teardown(): void {
    if (!this.teardownMarked) {
      this.teardownMarked = true;
      this.marks?.mark("teardown");
    }
    // A socket drop or the end message can land without an awaited stop;
    // start the capture close before the playout reference goes away. The one
    // marks artifact posts once the capture outcome is known, and is never
    // awaited: a slow or dead sink cannot hold up a hang-up.
    void this.closeCapture().then(() => void this.marks?.finish());
    try {
      this.micStop?.();
    } catch {
      // Mic already released on competing teardown paths.
    }
    this.micStop = null;
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
    this.playout = null;
  }

  private finish(turns: number): void {
    if (this.ended) return;
    this.ended = true;
    this.started = false;
    this.teardown();
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
    this.teardown();
  }
}
