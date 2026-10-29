/**
 * One native take → the committed preview, measured.
 *
 * This is the measurement half of `scripts/render-audition-clips.mts`, in one
 * place so the generator and the regeneration test cannot measure different
 * things. It encodes the take exactly as the committed clip is encoded (mono
 * 24 kHz, 160 kbps by default), proves the encode did not move the level, then
 * proves a delivery re-encode at 128 kbps keeps both the level and the
 * waveform's crest. It writes the MP3 and returns the facts the evidence file
 * records.
 *
 * No gain, no limiter, no normalisation: the encoder is a format change and
 * nothing else. The caller supplies the take; this module never synthesises,
 * so it is usable from a test with a committed sample and from the script with
 * a live render.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUDITION_BITRATE_KBPS,
  AUDITION_CHANNELS,
  AUDITION_ENCODE_LEVEL_TOLERANCE_LU,
  AUDITION_SAMPLE_RATE,
  AUDITION_SECOND_ENCODE_KBPS,
  type AuditionClipRecord,
} from "../../src/lib/demo/audition-clips";
import { mp3Facts } from "../../src/lib/demo/mp3-facts";
import { pcm16Wav } from "../../src/lib/demo/reference-render";
import { decodePcm, decodeWav, type DecodedAudio } from "../../src/lib/audio/format-facts";
import { crestFactor } from "../../src/lib/audio/distortion-crest";
import { analyseLevel } from "../../src/lib/audio/level-facts";
import { decodeAuditionMp3, encodeAuditionMp3 } from "./mp3-encode";

export type ProducedAuditionClip = {
  facts: AuditionClipRecord["facts"];
  level: AuditionClipRecord["level"];
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Decode raw s16le at the clip's own format. */
function decodeAtClipFormat(bytes: Uint8Array): DecodedAudio {
  return decodePcm(bytes, { sampleRate: AUDITION_SAMPLE_RATE, channels: AUDITION_CHANNELS });
}

/** Measure a decoded file's level, naming the absence rather than guessing. */
function levelOf(audio: DecodedAudio) {
  const facts = analyseLevel(audio);
  if (!facts.measured) {
    throw new Error(`the render has no measurable level (${facts.absence})`);
  }
  return facts;
}

/** Peak over RMS in dB, the waveform fact a re-encode must not flatten. */
function crestDb(audio: DecodedAudio): number {
  return 20 * Math.log10(crestFactor(audio).crestFactor);
}

export function produceAuditionClip(opts: {
  sourceWav: string;
  output: string;
  bitrateKbps?: number;
}): ProducedAuditionClip {
  const bitrateKbps = opts.bitrateKbps ?? AUDITION_BITRATE_KBPS;
  const scratch = mkdtempSync(join(tmpdir(), "voni-audition-"));
  try {
    const encoded = join(scratch, "clip.mp3");
    encodeAuditionMp3({ input: opts.sourceWav, output: encoded, bitrateKbps });

    const facts = mp3Facts(new Uint8Array(readFileSync(encoded)));
    if (facts.sampleRate !== AUDITION_SAMPLE_RATE || facts.channels !== AUDITION_CHANNELS) {
      throw new Error(`encoder produced ${facts.sampleRate} Hz x ${facts.channels}ch, not 24 kHz mono`);
    }
    if (facts.bitrateKbps !== bitrateKbps) {
      throw new Error(`encoder produced ${facts.bitrateKbps} kbps, not the requested ${bitrateKbps}`);
    }

    const source = levelOf(decodeWav(new Uint8Array(readFileSync(opts.sourceWav))));
    const decoded = decodeAuditionMp3(encoded);
    const assetAudio = decodeAtClipFormat(decoded);
    const asset = levelOf(assetAudio);
    if (Math.abs(asset.integratedLufs - source.integratedLufs) > AUDITION_ENCODE_LEVEL_TOLERANCE_LU) {
      throw new Error(
        `encoding moved the native level by ${(asset.integratedLufs - source.integratedLufs).toFixed(2)} LU`,
      );
    }

    // The delivery re-encode: same audio, 128 kbps, measured again.
    const secondWav = join(scratch, "second.wav");
    writeFileSync(secondWav, pcm16Wav(Buffer.from(decoded)));
    const secondMp3 = join(scratch, "second.mp3");
    encodeAuditionMp3({ input: secondWav, output: secondMp3, bitrateKbps: AUDITION_SECOND_ENCODE_KBPS });
    const secondAudio = decodeAtClipFormat(decodeAuditionMp3(secondMp3));
    const second = levelOf(secondAudio);
    if (Math.abs(second.integratedLufs - asset.integratedLufs) > AUDITION_ENCODE_LEVEL_TOLERANCE_LU) {
      throw new Error(
        `a ${AUDITION_SECOND_ENCODE_KBPS} kbps second encode moves the level by ` +
          `${(second.integratedLufs - asset.integratedLufs).toFixed(2)} LU`,
      );
    }

    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, readFileSync(encoded));
    return {
      facts: {
        sampleRate: facts.sampleRate,
        channels: facts.channels,
        bitrateKbps: facts.bitrateKbps,
        frames: facts.frames,
        durationMs: facts.durationMs,
      },
      level: {
        sourceIntegratedLufs: round(source.integratedLufs),
        assetIntegratedLufs: round(asset.integratedLufs),
        assetTruePeakDbtp: round(asset.truePeakDbtp),
        assetCrestDb: round(crestDb(assetAudio)),
        secondEncodeLufs: round(second.integratedLufs),
        secondEncodeTruePeakDbtp: round(second.truePeakDbtp),
        secondEncodeCrestDb: round(crestDb(secondAudio)),
        // Audit only, filled by the generator from the standalone TTS
        // measurement; it is not the clip's level target.
        referenceIntegratedLufs: null,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
