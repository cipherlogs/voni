/**
 * Shared mic capture for voice sessions (browser-only).
 *
 * Both the managed AssemblyAI session (`session.ts`) and the cascade
 * pipeline client (`cascade-session.ts`) acquire the microphone through
 * here, so the cross-browser resampling rules, the user-gesture-safe error
 * copy, and the single-mic ownership live in exactly one place.
 *
 * Split for the parallel call-start in `VoiceSession.start`: acquire the
 * stream and build the audio graph in two steps so the token fetch can run
 * concurrently with the first.
 */

import { acquireMic, releaseMic } from "./mic-owner";
import { DEFAULT_OUTPUT_SAMPLE_RATE } from "./output-format";
import { createWorkletPlayout, PLAYOUT_MODULE, type WorkletPlayout } from "./playout";
import { openStreamRateContext } from "./stream-rate-context";

export type VoiceErrorCode =
  | "mic"
  | "busy-mic"
  | "auth"
  | "config"
  | "network"
  | "expired";

/** Thrown by capture so callers can report a structured error code. */
export class VoiceStartError extends Error {
  constructor(
    public code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceStartError";
  }
}

export const VOICE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
};

/** 24 kHz PCM: the contract sample rate for every voice path in this app. */
export const TARGET_SAMPLE_RATE = 24000;

/**
 * Turn a getUserMedia failure into something a person can act on. Names the
 * fix, not just the problem — an error the user cannot recover from is a
 * dead end, not feedback.
 */
export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Voni needs your microphone for the call. Allow mic access in your browser — usually the icon in the address bar — then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found. Connect one, or pick a different input device, then try again.";
    case "NotReadableError":
      return "Your microphone is busy in another app. Close it and try again.";
    default:
      return e instanceof Error ? e.message : "Could not start the call.";
  }
}

/**
 * Claim the mic and open the input stream. Throws coded VoiceStartError
 * (`busy-mic` when another session holds it, `mic` with recovery copy when
 * the device fails). The caller owns the stream — and the mic claim — until
 * the tracks stop and `releaseMic(owner)` runs (see `abandon`/teardown in
 * the session, or `stop()` + release below for cascade use).
 */
export async function acquireMicStream(owner: string): Promise<MediaStream> {
  if (!acquireMic(owner)) {
    throw new VoiceStartError(
      "busy-mic",
      "Another voice session is already using the microphone. Stop it first, then try again.",
    );
  }
  try {
    // Both constraint choices matter (see pcm-processor.js): echo
    // cancellation keeps the agent from hearing itself, and the default
    // device rate (never forced) keeps every engine's echo canceller fed.
    return await navigator.mediaDevices.getUserMedia({
      audio: VOICE_MIC_CONSTRAINTS,
    });
  } catch (e) {
    releaseMic(owner);
    throw new VoiceStartError("mic", micErrorMessage(e));
  }
}

export type AudioGraph = {
  audioCtx: AudioContext;
  worklet: AudioWorkletNode;
  /** Agent-voice output on the same context (see playout.ts). */
  playout: WorkletPlayout;
  /** The context's actual rate: the playout worklet's device rate. */
  contextRate: number;
  /** True when the context runs at the stream rate, so the low-pass is idle. */
  atStreamRate: boolean;
  /** Stop playback plumbing: close the worklet port, disconnect, close context. */
  stop: () => void;
};

/**
 * Build the resampling worklet graph over an open mic stream. Frames arrive
 * as 24 kHz 16-bit PCM ArrayBuffers on `onFrame` (transferred, not copied).
 * On failure the stream tracks stop and the mic claim releases, matching
 * the previous inline behavior in `VoiceSession.start`.
 *
 * `streamRate` is the rate the agent's output is expected at (the resolved
 * format once the session confirms it; the API's PCM default before that). The
 * shared context prefers that rate, so the playout never decimates where the
 * platform can render at the stream rate; where it cannot, the context stays at
 * the device rate and the worklet's mandatory low-pass takes over.
 */
export async function startAudioGraph(
  owner: string,
  stream: MediaStream,
  onFrame: (data: ArrayBuffer) => void,
  streamRate: number = DEFAULT_OUTPUT_SAMPLE_RATE,
): Promise<AudioGraph> {
  let audioCtx: AudioContext | null = null;
  let contextRate = 0;
  let atStreamRate = false;
  try {
    // Prefer a context at the stream rate (no decimation), but never trust the
    // request: openStreamRateContext verifies the rate, proves the microphone
    // can join the context, closes one that fails either test, and falls back
    // to the plain device context. The single context is shared by mic and
    // playout so the echo canceller hears what we play; preferring a rate must
    // never split that graph or silence the mic.
    const choice = openStreamRateContext(
      streamRate,
      (options) => new AudioContext(options),
      (candidate) => {
        // Firefox opens the requested rate but cannot connect a getUserMedia
        // source across rates (bug 1674892). Ask before committing.
        candidate.createMediaStreamSource(stream);
      },
    );
    audioCtx = choice.ctx;
    contextRate = choice.rate;
    atStreamRate = choice.atStreamRate;
    await audioCtx.resume();
    await Promise.all([
      audioCtx.audioWorklet.addModule("/pcm-processor.js"),
      audioCtx.audioWorklet.addModule(PLAYOUT_MODULE),
    ]);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    releaseMic(owner);
    throw new Error("Could not start audio. Check your browser and try again.");
  }
  const ctx: AudioContext = audioCtx;
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "pcm-processor", {
    processorOptions: {
      inputSampleRate: ctx.sampleRate,
      targetSampleRate: TARGET_SAMPLE_RATE,
    },
  });
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    onFrame(e.data);
  };
  // Note the worklet is NOT connected to destination: it only taps the mic.
  // Routing it to the speakers would play the caller's own voice back at
  // them and feed the echo canceller a signal it should never see.
  source.connect(worklet);
  const output = new AudioWorkletNode(ctx, "playout-processor", {
    numberOfInputs: 0,
    outputChannelCount: [1],
  });
  output.connect(ctx.destination);
  const stop = () => {
    try {
      worklet.port.close();
    } catch {
      // Already closed on teardown paths that race stop().
    }
    worklet.disconnect();
    output.port.close();
    output.disconnect();
    void ctx.close().catch(() => undefined);
  };
  return {
    audioCtx: ctx,
    worklet,
    playout: createWorkletPlayout(output),
    contextRate,
    atStreamRate,
    stop,
  };
}
