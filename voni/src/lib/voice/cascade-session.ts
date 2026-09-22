/**
 * Browser client for the cascade pipeline service (`voice-pipeline/`).
 *
 * Same mic path as the managed session (shared `./mic-capture`: ownership,
 * constraints, 24 kHz worklet) but a different wire protocol: JSON config +
 * base64 PCM up, captions / base64 audio / metrics down. Server owns
 * turn-taking; this client renders and plays.
 *
 * Service auth: none in dev (localhost). Production deployments must put
 * the service behind the same session gate as the app — the browser never
 * holds vendor keys either way.
 */

import { acquireMicStream, startAudioGraph } from "./mic-capture";
import { releaseMic } from "./mic-owner";

export type CascadeCaption = {
  role: "user" | "agent";
  text: string;
  final: boolean;
};

export type CascadeCallConfig = {
  serviceUrl: string;
  pipeline: {
    llm_model: string;
    tts_voice: string;
    tts_model: string;
    fallback_mode: "cascade";
    language_codes?: string[];
  };
  systemPrompt: string;
  tools?: unknown[];
  agentName?: string;
};

export type CascadeHandlers = {
  onCaption?: (caption: CascadeCaption) => void;
  onAudio?: (pcm: Uint8Array, sampleRate: number) => void;
  onInterrupted?: () => void;
  onMetrics?: (metrics: unknown, turns: number) => void;
  onError?: (message: string) => void;
  onEnd?: (info: { turns: number }) => void;
};

export type ServerEvent =
  | { kind: "caption"; role: "user" | "agent"; text: string; final: boolean }
  | { kind: "interrupted" }
  | { kind: "end"; turns: number; metrics: unknown }
  | { kind: "error"; message: string };

export function buildConfigMessage(config: CascadeCallConfig): string {
  return JSON.stringify({
    type: "config",
    pipeline: {
      ...config.pipeline,
      language_codes: config.pipeline.language_codes ?? ["en"],
    },
    systemPrompt: config.systemPrompt,
    tools: config.tools ?? [],
    agentName: config.agentName ?? "",
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
    case "end":
      return {
        kind: "end",
        turns: typeof record.turns === "number" ? record.turns : 0,
        metrics: record.metrics ?? null,
      };
    case "error":
      return {
        kind: "error",
        message: typeof record.message === "string" ? record.message : "Call failed.",
      };
    default:
      return null;
  }
}

export function decodeAudioMessage(raw: string): {
  pcm: Uint8Array;
  sampleRate: number;
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
  return {
    pcm: base64Decode(record.data),
    sampleRate: typeof record.sample_rate === "number" ? record.sample_rate : 24000,
  };
}

export type MicHandle = {
  stop: () => void;
  audioCtx?: AudioContext | null;
};

export type Playout = {
  play: (pcm: Uint8Array, sampleRate: number) => void;
  flush: () => void;
};

/** Default playout: back-to-back scheduling on the mic context clock. */
export function createBrowserPlayout(audioCtx: AudioContext | null | undefined): Playout {
  if (!audioCtx) return { play: () => {}, flush: () => {} };
  const ctx = audioCtx;
  let playhead = 0;
  let queued: AudioBufferSourceNode[] = [];
  return {
    play(pcm: Uint8Array, sampleRate: number) {
      const frames = Math.floor(pcm.length / 2);
      if (frames === 0) return;
      const buffer = ctx.createBuffer(1, frames, sampleRate);
      const channel = buffer.getChannelData(0);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const startAt = Math.max(playhead, ctx.currentTime);
      node.start(startAt);
      playhead = startAt + buffer.duration;
      queued.push(node);
      node.onended = () => {
        queued = queued.filter((q) => q !== node);
      };
    },
    flush() {
      const dropped = queued;
      queued = [];
      for (const node of dropped) {
        try {
          node.stop();
        } catch {
          // Already ended between scheduling and flush.
        }
      }
      playhead = ctx.currentTime;
    },
  };
}

export type CascadeDeps = {
  socketFactory?: (url: string) => WebSocket;
  startMic?: (owner: string, onFrame: (data: ArrayBuffer) => void) => Promise<MicHandle>;
  createPlayout?: (audioCtx: AudioContext | null | undefined) => Playout;
};

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

  constructor(
    private handlers: CascadeHandlers = {},
    private deps: CascadeDeps = {},
  ) {}

  /**
   * Must be called from inside a user gesture (click/touch): mic and audio
   * startup are gated behind one in every major browser.
   */
  async start(config: CascadeCallConfig, micOwner = "voice-call"): Promise<void> {
    const socketFactory = this.deps.socketFactory ?? ((url: string) => new WebSocket(url));
    const ws = socketFactory(config.serviceUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.sendConfig(config);
    };
    ws.onmessage = (event: MessageEvent) => {
      this.receive(typeof event.data === "string" ? event.data : "");
    };
    ws.onerror = () => {
      this.handlers.onError?.("Connection to the voice service failed.");
    };
    ws.onclose = () => {
      this.finish(0);
    };
    const startMic = this.deps.startMic ?? defaultStartMic;
    const handle = await startMic(micOwner, (data) => {
      if (this.started && ws.readyState === ws.OPEN) this.send(encodeAudioFrame(data));
    });
    this.micStop = handle.stop;
    const createPlayout = this.deps.createPlayout ?? createBrowserPlayout;
    this.playout = createPlayout(handle.audioCtx);
    this.started = true;
    // Socket may already be open (fake sockets, fast localhost): flush config now.
    if (ws.readyState === ws.OPEN) this.sendConfig(config);
  }

  private sendConfig(config: CascadeCallConfig): void {
    if (this.configSent || !this.started) return;
    this.configSent = true;
    this.send(buildConfigMessage(config));
  }

  /** Dispatch one raw server frame. Public so the socket layer stays thin. */
  receive(raw: string): void {
    if (!raw) return;
    const audio = decodeAudioMessage(raw);
    if (audio) {
      this.playout?.play(audio.pcm, audio.sampleRate);
      this.handlers.onAudio?.(audio.pcm, audio.sampleRate);
      return;
    }
    const event = parseServerMessage(raw);
    if (!event) return;
    switch (event.kind) {
      case "caption":
        this.handlers.onCaption?.({ role: event.role, text: event.text, final: event.final });
        break;
      case "interrupted":
        this.playout?.flush();
        this.handlers.onInterrupted?.();
        break;
      case "end":
        this.handlers.onMetrics?.(event.metrics, event.turns);
        this.finish(event.turns);
        break;
      case "error":
        this.handlers.onError?.(event.message);
        break;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      if (this.ws?.readyState === this.ws?.OPEN) this.send(JSON.stringify({ type: "stop" }));
    } catch {
      // Socket already gone; local teardown below still runs.
    }
    this.teardown();
  }

  private send(message: string): void {
    try {
      this.ws?.send(message);
    } catch {
      // Drops on a closing socket are expected during hangup.
    }
  }

  private teardown(): void {
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
}
