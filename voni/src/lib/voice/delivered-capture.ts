/**
 * Dev-only delivered capture: the WAV written from what the playout worklet
 * actually emitted.
 *
 * The tap itself lives in `public/playout-processor.js` (it copies the output
 * after rendering, so it cannot change a sample). This module is the main
 * thread half: it accumulates the posted blocks and writes one standard
 * 16-bit PCM WAV at the worklet's output rate — the form the W0 comparison
 * (`lib/audio/format-facts`) reads. Both call paths use it: the managed
 * `VoiceSession` and the cascade session (`./cascade-session`).
 *
 * The file is a working artifact only — `voni/.captures/` is gitignored, never
 * evidence committed to the repo.
 */
import type { WorkletPlayout } from "./playout";

/** Query flag, the same shape as the dev pop probe (`?popprobe=1`). */
export const DELIVERED_CAPTURE_QUERY = "delivercapture";
/** Dev sink that writes the WAV; production never receives a call. */
export const DELIVERED_CAPTURE_ENDPOINT = "/api/dev/delivered-capture";
/** Where the dev server writes captures; gitignored working files. */
export const DELIVERED_CAPTURE_DIR = ".captures";
/** A dev sink that is gone must not hold up a hang-up. */
const CAPTURE_UPLOAD_TIMEOUT_MS = 2000;

/** Dev-only switch, inert in a production build. */
export function deliveredCaptureRequested(search: string, production: boolean): boolean {
  if (production) return false;
  return new URLSearchParams(search).get(DELIVERED_CAPTURE_QUERY) === "1";
}

/** One standard WAV: RIFF/WAVE, 16-bit PCM, mono, at `sampleRate`. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  // The device clips at full scale; a sample beyond it is delivered clipped,
  // so the capture records that rather than rescaling the level.
  for (let i = 0; i < samples.length; i++) {
    const y = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(y * 32767), true);
  }
  return bytes;
}

export type CaptureWrite = (name: string, bytes: Uint8Array) => void | Promise<void>;

/**
 * What the capture actually produced. `complete` is true only when at least
 * one sample was written *and* the worklet acked its final block. A capture
 * that is missing (`no-audio`), truncated (`tap-timeout`) or could not be
 * written (`write-failed`) names the failure; it is never presented as a
 * short but valid recording.
 */
export type CaptureResult = {
  complete: boolean;
  reason: "" | "no-audio" | "tap-timeout" | "write-failed";
  name: string | null;
  samples: number;
  bytes: number;
};

/** Accumulate the tap's blocks; `finish` writes at most one WAV. */
export class DeliveredCapture {
  private readonly blocks: Float32Array[] = [];
  private readonly sampleRate: number;
  private readonly write: CaptureWrite;
  private readonly now: () => Date;
  private samples = 0;
  private finished = false;
  private outcome: CaptureResult | null = null;

  constructor(opts: { sampleRate: number; write: CaptureWrite; now?: () => Date }) {
    this.sampleRate = opts.sampleRate;
    this.write = opts.write;
    this.now = opts.now ?? (() => new Date());
  }

  /** One block exactly as the worklet emitted it. */
  push(samples: Float32Array): void {
    if (this.finished || samples.length === 0) return;
    this.blocks.push(samples);
    this.samples += samples.length;
  }

  /**
   * Close the call's capture. `tapEnded` is the worklet's ack: a capture that
   * never got its final block keeps the partial WAV for triage but reports
   * `tap-timeout`, so a comparison can refuse it instead of measuring a
   * quietly short file. No audio means no file, and `no-audio` as the reason.
   */
  async finish(opts: { tapEnded?: boolean } = {}): Promise<CaptureResult> {
    if (this.finished) return this.outcome!;
    this.finished = true;
    if (this.samples === 0) {
      this.outcome = {
        complete: false,
        reason: "no-audio",
        name: null,
        samples: 0,
        bytes: 0,
      };
      return this.outcome;
    }
    const all = new Float32Array(this.samples);
    let at = 0;
    for (const block of this.blocks) {
      all.set(block, at);
      at += block.length;
    }
    const bytes = encodeWavPcm16(all, this.sampleRate);
    const name = captureName(this.now());
    try {
      await this.write(name, bytes);
    } catch {
      // The dev sink is gone: the run has no capture, and that has a name.
      this.outcome = {
        complete: false,
        reason: "write-failed",
        name,
        samples: all.length,
        bytes: bytes.length,
      };
      return this.outcome;
    }
    const complete = opts.tapEnded !== false;
    this.outcome = {
      complete,
      reason: complete ? "" : "tap-timeout",
      name,
      samples: all.length,
      bytes: bytes.length,
    };
    return this.outcome;
  }
}

/** UTC, filename-safe: delivered-20261029-140506.wav */
export function captureName(date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `delivered-${stamp}.wav`;
}

/** Enable the worklet tap and feed every rendered block into a capture. */
export function attachDeliveredCapture(
  playout: Pick<WorkletPlayout, "tap" | "onTap">,
  opts: { sampleRate: number; write: CaptureWrite; now?: () => Date },
): DeliveredCapture {
  const capture = new DeliveredCapture(opts);
  playout.onTap = (samples) => capture.push(samples);
  void playout.tap(true);
  return capture;
}

/**
 * Tap off, wait for the worklet's final block, then write the one WAV. The
 * ack is what separates a whole capture from a truncated one: a stopped
 * context that never acks still gets its partial file, labelled.
 */
export async function finishDeliveredCapture(
  playout: Pick<WorkletPlayout, "tap"> | null,
  capture: DeliveredCapture,
): Promise<CaptureResult> {
  let tapEnded = true;
  if (playout) {
    try {
      // A playout double may resolve without an outcome; only an explicit
      // `ended: false` is a truncation, never a missing value.
      tapEnded = (await playout.tap(false))?.ended !== false;
    } catch {
      tapEnded = false;
    }
  }
  return capture.finish({ tapEnded });
}

/** Browser sink: hand the WAV to the dev-only route that writes it. */
export async function postDeliveredCapture(name: string, bytes: Uint8Array): Promise<void> {
  const url = `${DELIVERED_CAPTURE_ENDPOINT}?name=${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: "POST",
    body: bytes as BodyInit,
    // A dev sink that is gone must not hold up a hang-up.
    signal: AbortSignal.timeout(CAPTURE_UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`capture upload failed: ${response.status}`);
  const saved = (await response.json().catch(() => null)) as { path?: string } | null;
  if (saved?.path) console.info(`[voice-call] delivered capture ${saved.path}`);
}
