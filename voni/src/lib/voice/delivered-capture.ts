/**
 * Dev-only delivered capture: the WAV written from what the playout worklet
 * actually emitted.
 *
 * The tap itself lives in `public/playout-processor.js` (it copies the output
 * after rendering, so it cannot change a sample). This module is the main
 * thread half: it accumulates the posted blocks and writes one standard
 * 32-bit float WAV at the worklet's output rate.
 *
 * Float, not PCM16, on purpose: the capture is evidence about the signal, and
 * quantising it would add distortion of its own to the comparison. The file is
 * a working artifact only — `voni/.captures/` is gitignored, never evidence
 * committed to the repo.
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

/** One standard WAV: RIFF/WAVE, IEEE float32, mono, at `sampleRate`. */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 4;
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
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i]!, true);
  return bytes;
}

/**
 * Read back a mono float WAV (the capture's own format, and what the
 * comparison consumes). Rejects anything else rather than guessing.
 */
export function decodeWav(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  samples: Float32Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === "data") {
      if (format !== 3 || channels !== 1 || bits !== 32) {
        throw new Error(`unsupported WAV: format ${format}, ${channels}ch, ${bits}-bit`);
      }
      const frames = Math.floor(size / 4);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = view.getFloat32(at + 8 + i * 4, true);
      return { sampleRate, channels, samples };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export type CaptureWrite = (name: string, bytes: Uint8Array) => void | Promise<void>;

export type CaptureResult = { name: string; samples: number; bytes: number };

/** Accumulate the tap's blocks; `finish` writes exactly one WAV. */
export class DeliveredCapture {
  private readonly blocks: Float32Array[] = [];
  private readonly sampleRate: number;
  private readonly write: CaptureWrite;
  private readonly now: () => Date;
  private samples = 0;
  private finished = false;

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

  /** Close the call's capture. No audio means no file, not an empty one. */
  async finish(): Promise<CaptureResult | null> {
    if (this.finished) return null;
    this.finished = true;
    if (this.samples === 0) return null;
    const all = new Float32Array(this.samples);
    let at = 0;
    for (const block of this.blocks) {
      all.set(block, at);
      at += block.length;
    }
    const bytes = encodeWavFloat32(all, this.sampleRate);
    const name = captureName(this.now());
    await this.write(name, bytes);
    return { name, samples: all.length, bytes: bytes.length };
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
}
