/**
 * Agent-voice playback for every voice path (managed session and cascade).
 *
 * The DSP lives in `public/playout-processor.js` (jitter pre-roll, continuous
 * resampling, slow drift correction, edge fades); this is the thin main-thread
 * handle. The worklet runs on the mic's AudioContext so the echo canceller
 * hears what we play.
 */

export type Playout = {
  /** Queue one little-endian PCM16 mono chunk. */
  play: (pcm: Uint8Array, sampleRate: number) => void;
  /**
   * Fade out and drop everything queued (barge-in, hang-up). A barge-in keeps
   * the cushion: the interrupted reply's audio is dropped, but the new reply is
   * not charged a second pre-roll. A deliberate hang-up passes `keepCushion:
   * false` and keeps nothing.
   */
  flush: (fadeS?: number, keepCushion?: boolean) => void;
  /**
   * Fires once, when the worklet first emits audio for this playout — the
   * first sample the caller can hear, not when a chunk was queued. The
   * connected chime hangs off this so it marks the agent actually sounding
   * (see call-sounds). Observation only: it never touches the signal path.
   */
  onFirstAudible?: () => void;
};

export type WorkletPlayout = Playout & {
  /** True when nothing is queued or sounding. */
  settled: () => boolean;
  /** Buffered audio at the worklet's last report (instrumentation). */
  queuedMs: () => number;
  /** Audio held ahead of the playhead at the worklet's last report. */
  cushionMs: () => number;
  /** The target cushion a reply starts at, in milliseconds (the named constant). */
  targetCushionMs: () => number;
  /**
   * Playback-rate correction in percent at the worklet's last report: negative
   * while it plays slower to refill a short cushion, zero when the stream needs
   * no correction. Never more than ±1%.
   */
  correctionPct: () => number;
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

type Level = {
  type: "level";
  seq: number;
  queuedMs: number;
  cushionMs: number;
  targetCushionMs: number;
  correctionPct: number;
  playing: boolean;
  idle: boolean;
  consumed: number;
};
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
  let audible = false;
  let queuedMs = 0;
  let cushionMs = 0;
  let targetCushionMs = 0;
  let correctionPct = 0;
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
    flush(fadeS = 0.04, keepCushion = true) {
      node.port.postMessage({ type: "flush", fadeS, keepCushion });
      busy = false;
      queuedMs = 0;
      cushionMs = 0;
      correctionPct = 0;
    },
    settled: () => !busy,
    queuedMs: () => queuedMs,
    cushionMs: () => cushionMs,
    targetCushionMs: () => targetCushionMs,
    correctionPct: () => correctionPct,
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
    cushionMs = e.data.cushionMs;
    targetCushionMs = e.data.targetCushionMs;
    correctionPct = e.data.correctionPct;
    consumed = e.data.consumed;
    // The first report that says the worklet is sounding: the caller's first
    // audible sample. One-shot per playout (one per connection): a later
    // reply, a resume after a dry-out, or a flush must not re-fire the chime.
    if (e.data.playing && !audible) {
      audible = true;
      playout.onFirstAudible?.();
    }
    // Ignore an idle report that predates the latest chunk still in flight.
    if (e.data.idle && e.data.seq === sent && busy) {
      busy = false;
      playout.onDrained?.();
    }
  };
  return playout;
}
