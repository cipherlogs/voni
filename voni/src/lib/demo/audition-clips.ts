/**
 * W1 audition clips: one committed recording per offered voice.
 *
 * ── The contract (voice-parity ticket 38) ─────────────────────────────────
 * The picker's preview is a promise: "the voice you auditioned is the voice you
 * get". The old clips broke that promise six ways — re-encoded twice at a low
 * bitrate, gain baked in, German and Italian greeting in English — and there
 * was no script, so no one could tell a clip had drifted. This module is the
 * plan the checked-in script renders and the test enforces:
 *
 *   voice → its own Locale → the greeting the agent speaks in that Locale
 *         → native level (the session carries no `output.volume`)
 *         → a bitrate that survives one delivery re-encode.
 *
 * The line is not a copy: it is `VONI_GREETINGS[voice.languageCode]`, which is
 * what `voniConfig(voice).greeting` puts on the stored agent body. Changing a
 * greeting changes the plan, and the committed evidence no longer matches, so
 * the test fails until the script is run again.
 *
 * The level is native by construction: the source is the same silent-greeting
 * session the agent speaks through (`silentGreetingSession`), whose payload has
 * `output: { voice }` and nothing else. No gain, no limiter, no normalisation.
 * The clip's measured level is checked against that voice's measured native
 * reference, which is how a pre-gained copy is caught.
 *
 * ── Bitrate ───────────────────────────────────────────────────────────────
 * The clips are mono MPEG-2 Layer III at 24 kHz, so the format's ceiling is
 * 160 kbps. That is the committed bitrate: high enough that the delivery
 * re-encode (128 kbps) does not move the level or the waveform's crest. The
 * old 64 kbps captures were the second encode the owner heard.
 */

import { createHash } from "node:crypto";
import { VOICES, getVoice, type Voice } from "@/lib/agents/voices";
import { VONI_GREETINGS } from "./voni-agent";

/** The session's native output format. A clip is never resampled. */
export const AUDITION_SAMPLE_RATE = 24_000;
export const AUDITION_CHANNELS = 1;

/** MPEG-2 Layer III at 24 kHz tops out at 160 kbps. */
export const AUDITION_BITRATE_KBPS = 160;

/**
 * The bitrate a delivery path may re-encode to. A clip below this has already
 * spent the encode budget the old captures spent twice.
 */
export const MIN_SURVIVING_BITRATE_KBPS = 128;

/** The re-encode the generator actually measures to prove the clip survives. */
export const AUDITION_SECOND_ENCODE_KBPS = 128;

/**
 * How far a clip's measured level may sit from the native render it was
 * encoded from. This is the gate that catches a gain baked into the committed
 * copy: the deleted client gain table moved voices by up to 12 dB.
 *
 * The standalone TTS measurement in `evidence/voice-levels` is NOT the target:
 * measured on 2026-10-29, the session path and the TTS endpoint normalize a
 * voice differently, by −3.2 … +5.2 LU, so comparing the clip to that number
 * would fail a native render for the vendor's path rather than for a gain. The
 * deviation is recorded for the audit trail and is not a gate.
 */
export const AUDITION_LEVEL_TOLERANCE_LU = 0.75;

/**
 * Encoding is not allowed to move the native level, or the delivery re-encode
 * either. MP3's synthesis filterbank reads 0.4–0.6 dB down on a synthetic tone
 * (measured through libmp3lame here), so this covers the codec; a baked-in gain
 * — the deleted table moved voices by up to 12 dB — cannot slip through it.
 */
export const AUDITION_ENCODE_LEVEL_TOLERANCE_LU = 0.75;

/**
 * The waveform's crest must survive the delivery re-encode too. A sharper
 * encoder at a lower rate flattens transients; 160 kbps at 24 kHz mono keeps
 * this inside the codec's own 0.5 dB resolution.
 */
export const AUDITION_CREST_TOLERANCE_DB = 0.75;

/**
 * A regenerated take is not byte-identical: the vendor's synthesis is not
 * deterministic. Measured on two alba takes, duration moved 96 ms (1.8 %).
 * Ticket 39 compares a fresh render within these.
 *
 * The crest gets a wider regeneration tolerance than the encoder's 0.75 dB
 * because the performance itself moves it: three anna takes of the same line
 * measured 15.6, 16.8 and 17.2 dB (a 1.7 dB span). A clipped, gain-baked
 * preview — the old hand captures — collapses to about 7.5 dB when four times
 * the level is clamped, so 3 dB still separates a fresh performance from a
 * flattened preview.
 */
export const AUDITION_REGENERATION_DURATION_RATIO = 0.05;
export const AUDITION_REGENERATION_LEVEL_TOLERANCE_LU = 1;
export const AUDITION_REGENERATION_CREST_TOLERANCE_DB = 3;

/** Committed previews, played by the picker at `/voices/<id>.mp3`. */
export const AUDITION_ASSET_DIR = "public/voices";

/** The committed record of what the script rendered and measured. */
export const AUDITION_MANIFEST_PATH = "evidence/audition-clips/clips.json";

/** Gitignored working files: the native renders the MP3s came from. */
export const AUDITION_SOURCE_DIR = ".voice-clips";

/** The script that is the only producer of the committed assets. */
export const AUDITION_GENERATOR_COMMAND = "npm run voice:clips";

export type AuditionClip = {
  voiceId: string;
  /** The voice's one Locale; never a language the voice does not speak. */
  locale: string;
  /** The exact greeting text the agent speaks in that Locale. */
  text: string;
  textSha256: string;
  /** Repo-relative committed asset. */
  asset: string;
  /** The URL the picker plays. */
  url: string;
  /** Native level: the platform's unity, and no client processing. */
  volume: 100;
};

/** One voice's clip, or a visible reason it has none yet. */
export type AuditionPending = {
  voice: string;
  locale: string;
  reason: string;
  /** The exact command another operator runs to finish this voice. */
  command: string;
};

export type AuditionClipFacts = {
  sampleRate: number;
  channels: number;
  /** Read from the committed MP3's frame headers. */
  bitrateKbps: number;
  frames: number;
  durationMs: number;
};

export type AuditionClipLevel = {
  /** The native session render, before encoding. */
  sourceIntegratedLufs: number;
  /** The committed MP3, decoded. */
  assetIntegratedLufs: number;
  assetTruePeakDbtp: number;
  /** Peak over RMS, dB, of the committed MP3 decoded. */
  assetCrestDb: number;
  /** The committed MP3 decoded and re-encoded at the delivery bitrate. */
  secondEncodeLufs: number;
  secondEncodeTruePeakDbtp: number;
  /** Peak over RMS, dB, after the delivery re-encode. */
  secondEncodeCrestDb: number;
  /**
   * Audit only: the standalone TTS measurement from `evidence/voice-levels`,
   * when the voice has one. The two vendor paths normalize differently, so the
   * difference is recorded, never gated.
   */
  referenceIntegratedLufs: number | null;
};

/** The only two ways a committed preview's native audio may have been made. */
export const AUDITION_NATIVE_SOURCES = ["agent-session", "cascade-clip"] as const;
export type AuditionNativeSource = (typeof AUDITION_NATIVE_SOURCES)[number];

export type AuditionClipRecord = {
  voice: string;
  locale: string;
  line: string;
  lineSha256: string;
  asset: string;
  url: string;
  volume: 100;
  facts: AuditionClipFacts;
  level: AuditionClipLevel;
  generatedOn: string;
  /**
   * Where the native render came from. Absent means the silent-greeting Voice
   * Agent session (the default); `cascade-clip` means the vendor's agent API
   * does not serve the voice, so the committed cascade clip of that same voice
   * and line supplied the native audio. This is not a verdict: it names a gap
   * in the managed path, and it must travel with the record so a reviewer sees
   * it instead of a generic "audition-clip" claim.
   */
  source?: AuditionNativeSource;
};

export type AuditionManifest = {
  schemaVersion: 1;
  generatedOn: string;
  /** The command that produced (or last updated) the record. */
  command: string;
  source: string;
  bitrateKbps: number;
  minSurvivingBitrateKbps: number;
  secondEncodeKbps: number;
  levelToleranceLu: number;
  clips: AuditionClipRecord[];
  pending: AuditionPending[];
};

/** Greeting text hash: the evidence's independent check on the committed line. */
export function auditionLineSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clipFor(voice: Voice): AuditionClip {
  const locale = voice.languageCode;
  const text = VONI_GREETINGS[locale];
  if (!text) {
    throw new Error(
      `voice "${voice.id}" speaks ${locale}, but VONI_GREETINGS has no ${locale} greeting: ` +
        "a clip is never a fallback to English",
    );
  }
  return {
    voiceId: voice.id,
    locale,
    text,
    textSha256: auditionLineSha256(text),
    asset: `${AUDITION_ASSET_DIR}/${voice.id}.mp3`,
    url: `/voices/${voice.id}.mp3`,
    volume: 100,
  };
}

/**
 * The clip plan for every offered voice. Defaults to the catalog; a caller may
 * pass a subset (the script's `--voice`), never a voice outside the catalog.
 */
export function auditionClipPlan(voices: readonly Voice[] = VOICES): AuditionClip[] {
  return voices.map(clipFor);
}

/** One voice's planned clip. An unknown voice is a usage error, not a fallback. */
export function auditionClipFor(voiceId: string): AuditionClip {
  const voice = getVoice(voiceId);
  if (!voice) throw new Error(`unknown voice "${voiceId}": audition clips need a catalog voice`);
  return clipFor(voice);
}

/** The visible way to finish a voice the generator could not render. */
export function auditionPendingCommand(voiceId: string): string {
  return `cd voni && ${AUDITION_GENERATOR_COMMAND} -- --voice ${voiceId}`;
}

/**
 * Why a committed clip does not match its voice, or an empty list. Every
 * problem names the fact, not the file offset: "speaks en, not its own Locale
 * de" is actionable; "bad clip" is not.
 */
export function auditionClipProblems(clip: AuditionClip, record: AuditionClipRecord): string[] {
  const problems: string[] = [];
  if (record.voice !== clip.voiceId) {
    problems.push(`record is for ${record.voice}, not ${clip.voiceId}`);
  }
  if (record.locale !== clip.locale) {
    problems.push(
      `speaks ${record.locale === "en" ? "English" : record.locale}, not its own Locale ${clip.locale}`,
    );
  }
  if (record.line !== clip.text) {
    problems.push(
      `greeting for ${clip.locale} is not the line the agent speaks ` +
        `("${record.line.slice(0, 40)}…" instead of "${clip.text.slice(0, 40)}…")`,
    );
  }
  if (record.lineSha256 !== clip.textSha256) {
    problems.push(`greeting hash does not match the ${clip.locale} line the agent speaks`);
  }
  if (record.asset !== clip.asset || record.url !== clip.url) {
    problems.push(`asset ${record.asset} / ${record.url} is not the picker's ${clip.url}`);
  }
  if (record.volume !== clip.volume) {
    problems.push(`volume ${record.volume} is not native level ${clip.volume}`);
  }
  if (
    record.source !== undefined &&
    !(AUDITION_NATIVE_SOURCES as readonly string[]).includes(record.source)
  ) {
    problems.push(
      `source "${record.source}" is not agent-session or cascade-clip: ` +
        "a preview is either the managed session's native render or the named cascade clip, " +
        "never an undocumented capture",
    );
  }
  if (record.facts.sampleRate !== AUDITION_SAMPLE_RATE) {
    problems.push(`rate ${record.facts.sampleRate} Hz is not the session's ${AUDITION_SAMPLE_RATE} Hz`);
  }
  if (record.facts.channels !== AUDITION_CHANNELS) {
    problems.push(`${record.facts.channels} channel(s) instead of mono`);
  }
  if (record.facts.bitrateKbps < MIN_SURVIVING_BITRATE_KBPS) {
    problems.push(
      `${record.facts.bitrateKbps} kbps does not survive a second encode ` +
        `(needs at least ${MIN_SURVIVING_BITRATE_KBPS} kbps)`,
    );
  }

  const level = record.level;
  if (!Number.isFinite(level.sourceIntegratedLufs) || !Number.isFinite(level.assetIntegratedLufs)) {
    problems.push("level was not measured, so it cannot be shown to be native");
    return problems;
  }
  const gain = level.assetIntegratedLufs - level.sourceIntegratedLufs;
  if (Math.abs(gain) > AUDITION_LEVEL_TOLERANCE_LU) {
    problems.push(
      `level ${level.assetIntegratedLufs.toFixed(2)} LUFS is ${gain > 0 ? "+" : ""}${gain.toFixed(2)} LU ` +
        `from the native render ${level.sourceIntegratedLufs.toFixed(2)} LUFS: a gain is baked in`,
    );
  }
  if (!Number.isFinite(level.secondEncodeLufs)) {
    problems.push("the delivery re-encode was not measured, so survival is unproven");
  } else if (
    Math.abs(level.secondEncodeLufs - level.assetIntegratedLufs) >
    AUDITION_ENCODE_LEVEL_TOLERANCE_LU
  ) {
    problems.push(
      `a ${AUDITION_SECOND_ENCODE_KBPS} kbps second encode moves the level by ` +
        `${(level.secondEncodeLufs - level.assetIntegratedLufs).toFixed(2)} LU: ` +
        "the bitrate does not survive it",
    );
  }
  if (
    Number.isFinite(level.assetCrestDb) &&
    Number.isFinite(level.secondEncodeCrestDb) &&
    Math.abs(level.secondEncodeCrestDb - level.assetCrestDb) > AUDITION_CREST_TOLERANCE_DB
  ) {
    problems.push(
      `a ${AUDITION_SECOND_ENCODE_KBPS} kbps second encode flattens the waveform by ` +
        `${(level.secondEncodeCrestDb - level.assetCrestDb).toFixed(2)} dB of crest: ` +
        "the bitrate does not survive it",
    );
  }
  if (!(level.assetTruePeakDbtp < 0)) {
    problems.push(`true peak ${level.assetTruePeakDbtp} dBTP reaches or passes full scale`);
  }
  return problems;
}
