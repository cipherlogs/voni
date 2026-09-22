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
  /** Stop playback plumbing: close the worklet port, disconnect, close context. */
  stop: () => void;
};

/**
 * Build the resampling worklet graph over an open mic stream. Frames arrive
 * as 24 kHz 16-bit PCM ArrayBuffers on `onFrame` (transferred, not copied).
 * On failure the stream tracks stop and the mic claim releases, matching
 * the previous inline behavior in `VoiceSession.start`.
 */
export async function startAudioGraph(
  owner: string,
  stream: MediaStream,
  onFrame: (data: ArrayBuffer) => void,
): Promise<AudioGraph> {
  let audioCtx: AudioContext | null = null;
  try {
    // Default rate on purpose; the worklet resamples. Forcing 24 kHz here is
    // Chromium-only and breaks Firefox's echo canceller and Safari outright.
    audioCtx = new AudioContext();
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("/pcm-processor.js");
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
  const stop = () => {
    try {
      worklet.port.close();
    } catch {
      // Already closed on teardown paths that race stop().
    }
    worklet.disconnect();
    void ctx.close().catch(() => undefined);
  };
  return { audioCtx: ctx, worklet, stop };
}
