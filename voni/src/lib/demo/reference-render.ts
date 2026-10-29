/**
 * W0 reference capture: render one line in one voice outside a conversation.
 *
 * A reference is the *first* of the three captures a call is judged against
 * (reference, platform recording, delivered audio). It is rendered by the same
 * silent-greeting session mechanism the scoreboard already uses for caller
 * clips — a session that stays silent and speaks the line as its greeting — so
 * it is the voice and the text, with no model and no conversation around it.
 *
 * Cache: keyed by voice AND text, on disk, as a standard PCM WAV. Rerunning a
 * capture is free and byte-identical; changing either input is a new file, not
 * a stale hit. The default line is the voice's own greeting, because that is
 * the sentence that separates "broken from the first word" from "breaks once
 * the model speaks".
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getVoice } from "@/lib/agents/voices";
import { voniConfig } from "./voni-agent";

/** The silent-greeting session's output format: PCM16 mono. */
export const REFERENCE_SAMPLE_RATE = 24_000;
export const REFERENCE_CHANNELS = 1;
export const REFERENCE_BITS_PER_SAMPLE = 16;

const WAV_HEADER_BYTES = 44;

/** Renders the line; injectable so tests never open a socket. */
export type ReferenceSynth = (request: { voiceId: string; text: string }) => Promise<Buffer>;

export type RenderedReference = {
  voiceId: string;
  text: string;
  path: string;
  /** True when the file already existed, so nothing was synthesized. */
  cached: boolean;
  bytes: number;
};

/**
 * The line this voice speaks by default: its own greeting, in its own Locale.
 * An unknown voice is a usage error, never a silent fallback to English.
 */
export function defaultReferenceText(voiceId: string): string {
  if (!getVoice(voiceId)) {
    throw new Error(`unknown voice "${voiceId}": reference capture needs a catalog voice`);
  }
  return voniConfig(voiceId).greeting;
}

/**
 * The line a text file holds, trimmed of the newline an editor adds.
 *
 * A file that cannot be read, or holds nothing but whitespace, is a usage
 * error named as such: silently falling back to the greeting would blame the
 * greeting for a sentence it never spoke.
 */
export function referenceTextFromFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`reference text file not found: ${path}`);
  }
  const text = raw.trim();
  if (!text) throw new Error(`reference text file is empty: ${path}`);
  return text;
}

/** Cache key: the voice and the exact line, so two lines can never collide. */
export function referenceKey(voiceId: string, text: string): string {
  return createHash("sha256").update(`${voiceId}\n${text}`).digest("hex");
}

export function referencePath(dir: string, voiceId: string, text: string): string {
  return join(dir, `${voiceId}-${referenceKey(voiceId, text).slice(0, 16)}.wav`);
}

/** A standard 44-byte-header PCM WAV the comparison can read with any tool. */
export function pcm16Wav(
  pcm: Buffer,
  sampleRate = REFERENCE_SAMPLE_RATE,
  channels = REFERENCE_CHANNELS,
): Buffer {
  if (pcm.byteLength % 2 !== 0) {
    throw new Error(`PCM16 needs an even byte length, got ${pcm.byteLength}`);
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * channels * (REFERENCE_BITS_PER_SAMPLE / 8);
  const blockAlign = channels * (REFERENCE_BITS_PER_SAMPLE / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(REFERENCE_BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function cachedWave(path: string): Buffer | null {
  try {
    const wav = readFileSync(path);
    // A truncated or foreign file is not a cache hit: re-render rather than
    // hand the comparison audio that is not this line in this voice.
    if (wav.byteLength <= WAV_HEADER_BYTES) return null;
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
    if (WAV_HEADER_BYTES + wav.readUInt32LE(40) !== wav.byteLength) return null;
    return wav;
  } catch {
    return null;
  }
}

/**
 * Render (or reuse) one reference. The PCM the synth returns is written
 * verbatim: no gain, no limiter, no normalisation — the file is the voice at
 * its native level, which is the only thing the reference may be.
 */
export async function renderReference(opts: {
  voiceId: string;
  /** The line to render. Mutually exclusive with `textFile`. */
  text?: string;
  /** A file holding the line to render. Mutually exclusive with `text`. */
  textFile?: string;
  dir: string;
  synth: ReferenceSynth;
}): Promise<RenderedReference> {
  if (opts.text !== undefined && opts.textFile !== undefined) {
    throw new Error("reference capture takes one line: text and textFile cannot both be set");
  }
  const text = (opts.textFile === undefined
    ? (opts.text ?? defaultReferenceText(opts.voiceId))
    : referenceTextFromFile(opts.textFile)
  ).trim();
  if (!text) throw new Error("reference capture needs a line to render");

  const path = referencePath(opts.dir, opts.voiceId, text);
  const existing = cachedWave(path);
  if (existing) {
    return { voiceId: opts.voiceId, text, path, cached: true, bytes: existing.byteLength };
  }

  const pcm = await opts.synth({ voiceId: opts.voiceId, text });
  if (pcm.byteLength === 0) throw new Error(`no audio rendered for ${opts.voiceId} "${text}"`);
  const wav = pcm16Wav(pcm);
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(path, wav, { mode: 0o600 });
  return { voiceId: opts.voiceId, text, path, cached: false, bytes: wav.byteLength };
}

/** Sample count of a rendered WAV's data chunk. */
export function referenceDurationMs(path: string): number {
  const wav = readFileSync(path);
  const dataBytes = wav.readUInt32LE(40);
  return Math.round((dataBytes / 2 / REFERENCE_SAMPLE_RATE) * 1000);
}
