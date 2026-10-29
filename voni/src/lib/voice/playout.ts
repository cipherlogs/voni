/**
 * Agent-voice playback for every voice path (managed session and cascade).
 *
 * The DSP lives in `public/playout-processor.js` (jitter pre-roll, continuous
 * resampling, edge fades); this is the thin main-thread handle. The worklet
 * runs on the mic's AudioContext so the echo canceller hears what we play.
 */

export type Playout = {
  /** Queue one little-endian PCM16 mono chunk. */
  play: (pcm: Uint8Array, sampleRate: number) => void;
  /** Fade out and drop everything queued (barge-in, hang-up). */
  flush: (fadeS?: number) => void;
};

export type WorkletPlayout = Playout & {
  /** True when nothing is queued or sounding. */
  settled: () => boolean;
  /** Buffered audio at the worklet's last report (instrumentation). */
  queuedMs: () => number;
  /** Source samples queued so far, all replies. */
  sentSamples?: () => number;
  /** Source samples played (or flushed) at the worklet's last report. */
  consumedSamples?: () => number;
  /** Fires when playback runs dry. The caller decides if that was an underrun. */
  onDrained?: () => void;
  /** Dev pop recorder on/off (worklet flags jumps and overloads). */
  probe: (on: boolean) => void;
  /** A flagged output discontinuity, while the probe is on. */
  onPop?: (pop: { kind: "jump" | "overload"; size: number }) => void;
  /**
   * Dev delivered capture on/off. While on, every rendered block arrives at
   * `onTap`. Turning it off resolves only after the worklet has posted its
   * final partial block, so the caller can close a complete WAV.
   */
  tap: (on: boolean) => Promise<void>;
  /** One block of the output exactly as it was emitted, at the device rate. */
  onTap?: (samples: Float32Array) => void;
};

export const PLAYOUT_MODULE = "/playout-processor.js";

/** Longest a teardown waits for the final tap block before writing anyway. */
const TAP_END_TIMEOUT_MS = 250;

type Level = { type: "level"; seq: number; queuedMs: number; idle: boolean; consumed: number };
type Pop = { type: "pop"; kind: "jump" | "overload"; size: number; at: number };
type Tap = { type: "tap"; samples: Float32Array };
type TapEnd = { type: "tap-end" };

/** Little-endian PCM16 bytes -> float samples in [-1, 1). */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const frames = pcm.length >> 1;
  const out = new Float32Array(frames);
  const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2);
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Wrap a connected `playout-processor` node. */
export function createWorkletPlayout(node: AudioWorkletNode): WorkletPlayout {
  let sent = 0;
  let busy = false;
  let queuedMs = 0;
  let sentSamples = 0;
  let consumed = 0;
  let tapEnded: (() => void) | null = null;
  const playout: WorkletPlayout = {
    play(pcm, sampleRate) {
      const samples = pcm16ToFloat(pcm);
      if (samples.length === 0) return;
      sent += 1;
      sentSamples += samples.length;
      busy = true;
      node.port.postMessage({ type: "play", seq: sent, rate: sampleRate, samples }, [
        samples.buffer,
      ]);
    },
    flush(fadeS = 0.04) {
      node.port.postMessage({ type: "flush", fadeS });
      busy = false;
      queuedMs = 0;
    },
    settled: () => !busy,
    queuedMs: () => queuedMs,
    sentSamples: () => sentSamples,
    consumedSamples: () => consumed,
    probe(on) {
      node.port.postMessage({ type: "probe", on });
    },
    tap(on) {
      node.port.postMessage({ type: "tap", on });
      if (on) return Promise.resolve();
      // A suspended context never acks: a hang-up must not wait on it forever.
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          tapEnded = null;
          resolve();
        }, TAP_END_TIMEOUT_MS);
        tapEnded = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
  node.port.onmessage = (e: MessageEvent<Level | Pop | Tap | TapEnd>) => {
    if (e.data?.type === "tap") {
      playout.onTap?.(e.data.samples);
      return;
    }
    if (e.data?.type === "tap-end") {
      const done = tapEnded;
      tapEnded = null;
      done?.();
      return;
    }
    if (e.data?.type === "pop") {
      playout.onPop?.({ kind: e.data.kind, size: e.data.size });
      return;
    }
    if (e.data?.type !== "level") return;
    queuedMs = e.data.queuedMs;
    consumed = e.data.consumed;
    // Ignore an idle report that predates the latest chunk still in flight.
    if (e.data.idle && e.data.seq === sent && busy) {
      busy = false;
      playout.onDrained?.();
    }
  };
  return playout;
}
