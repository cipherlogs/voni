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
  /** Fires when playback runs dry. The caller decides if that was an underrun. */
  onDrained?: () => void;
};

export const PLAYOUT_MODULE = "/playout-processor.js";

type Level = { type: "level"; seq: number; queuedMs: number; idle: boolean };

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
  const playout: WorkletPlayout = {
    play(pcm, sampleRate) {
      const samples = pcm16ToFloat(pcm);
      if (samples.length === 0) return;
      sent += 1;
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
  };
  node.port.onmessage = (e: MessageEvent<Level>) => {
    if (e.data?.type !== "level") return;
    queuedMs = e.data.queuedMs;
    // Ignore an idle report that predates the latest chunk still in flight.
    if (e.data.idle && e.data.seq === sent && busy) {
      busy = false;
      playout.onDrained?.();
    }
  };
  return playout;
}
