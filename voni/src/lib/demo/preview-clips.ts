/**
 * W5 parity proof (voice-parity ticket 79): the picker's previews are covered
 * by the clip test.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * `public/voices/<voice>.mp3` is the promise "the voice you auditioned is the
 * voice you get". Ticket 38 proved the plan and the evidence agree; ticket 39
 * regenerates one clip against the committed asset. Neither proves the file
 * the picker actually offers is the right voice: an asset can be swapped, a
 * record can be written for another Locale, or the level the script measured
 * can stop being the level in the file. This module gates the offered preview
 * itself, for every voice in the catalog — not only the featured one.
 *
 * ── What a preview must be ────────────────────────────────────────────────
 * One voice, one Locale (the *Voice binding* in CONTEXT.md): the record's
 * Locale is `voice.languageCode`, never English as a fallback. One voice, one
 * asset: `/voices/<id>.mp3`. The bytes are the recorded format — 24 kHz mono,
 * constant bitrate at the surviving floor — and their duration is the
 * recorded duration. The level is native: the committed asset's measured
 * level sits inside `AUDITION_LEVEL_TOLERANCE_LU` of the native render the
 * voice spoke, and the delivery re-encode does not move it.
 *
 * ── No live call, and no ffmpeg requirement ───────────────────────────────
 * The frame facts and the evidence record need neither a credential nor a
 * decoder. The stronger leg — decode the committed MP3 and re-measure its
 * level — needs ffmpeg; the caller must say which path it is on
 * (`PreviewMeasurement`), so an absent decoder is a named skip rather than an
 * implicit pass. In CI the same absence is a named failure.
 */

import { VOICES, type Voice } from "@/lib/agents/voices";
import {
  AUDITION_LEVEL_TOLERANCE_LU,
  MIN_SURVIVING_BITRATE_KBPS,
  auditionClipFor,
  auditionClipProblems,
  type AuditionClip,
  type AuditionClipRecord,
  type AuditionManifest,
} from "./audition-clips";
import { AuditionClipMissingError, committedClipFor } from "./clip-regeneration";
import { mp3Facts } from "./mp3-facts";

/**
 * How far the frame count's duration may sit from the recorded duration.
 * MPEG-2 Layer III carries 576 samples per frame — 24 ms at 24 kHz — and the
 * encoder pads the last frame, so a few frames is encoder bookkeeping rather
 * than a different recording. This matches the bytes-vs-evidence check in
 * `audition-clips.test.ts`.
 */
export const PREVIEW_FACT_DURATION_TOLERANCE_MS = 100;

/** What a decoded preview measures: the two facts the evidence records. */
export type MeasuredPreview = {
  integratedLufs: number;
  truePeakDbtp: number;
};

/**
 * Which path this gate is on. `pure-mp3` names why the audio was not decoded,
 * so a skipped leg can never read as a measured pass. `decoded` measures the
 * given bytes — never the file on disk, which could change underneath.
 */
export type PreviewMeasurement =
  | { kind: "decoded"; measure: (asset: string, bytes: Uint8Array) => MeasuredPreview }
  | { kind: "pure-mp3"; reason: string };

/** One offered voice's preview and every reason it does not match that voice. */
export type PreviewCheck = {
  voiceId: string;
  /** The voice's one Locale, from the catalog — not the evidence's claim. */
  locale: string;
  asset: string;
  measurement: "decoded" | "pure-mp3";
  /** Why the decoded level leg did not run; `null` when it did. */
  note: string | null;
  problems: string[];
};

export type PreviewGate = {
  checks: PreviewCheck[];
  /** The named failures: a preview that does not match its voice. */
  failures: PreviewCheck[];
};

function named(clip: Pick<AuditionClip, "voiceId" | "locale">, problem: string): string {
  return `voice "${clip.voiceId}" (${clip.locale}): ${problem}`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

/**
 * Why the committed bytes are not this voice's preview, beyond what the
 * evidence record can say about itself.
 *
 * The record's own legs (Locale, line, native level, second encode, crest,
 * true peak) come from `auditionClipProblems`, so there is one shape check for
 * a clip and preview alike. This adds what only the bytes can answer: are they
 * the recorded format, and — when decoded — the recorded audio?
 */
export function previewProblems(input: {
  clip: AuditionClip;
  record: AuditionClipRecord;
  bytes: Uint8Array;
  measured: MeasuredPreview | null;
}): string[] {
  const { clip, record, bytes, measured } = input;
  const problems = auditionClipProblems(clip, record).map((problem) => named(clip, problem));

  let facts: ReturnType<typeof mp3Facts>;
  try {
    facts = mp3Facts(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [...problems, named(clip, `${record.asset} is not a readable MP3 preview: ${detail}`)];
  }

  if (facts.sampleRate !== record.facts.sampleRate) {
    problems.push(
      named(clip, `the bytes are ${facts.sampleRate} Hz, the evidence records ${record.facts.sampleRate} Hz`),
    );
  }
  if (facts.channels !== record.facts.channels) {
    problems.push(
      named(clip, `the bytes are ${facts.channels} channel(s), the evidence records ${record.facts.channels}`),
    );
  }
  if (facts.bitrateKbps !== record.facts.bitrateKbps) {
    problems.push(
      named(clip, `the bytes are ${facts.bitrateKbps} kbps, the evidence records ${record.facts.bitrateKbps} kbps`),
    );
  }
  if (facts.bitrateKbps < MIN_SURVIVING_BITRATE_KBPS) {
    problems.push(
      named(
        clip,
        `the bytes are ${facts.bitrateKbps} kbps, below the ${MIN_SURVIVING_BITRATE_KBPS} kbps a delivery encode needs`,
      ),
    );
  }
  if (!facts.constantBitrate) {
    problems.push(named(clip, "the bytes are variable bitrate, not the constant-bitrate preview the script commits"));
  }
  if (Math.abs(facts.durationMs - record.facts.durationMs) > PREVIEW_FACT_DURATION_TOLERANCE_MS) {
    problems.push(
      named(
        clip,
        `the bytes last ${facts.durationMs} ms, the evidence records ${record.facts.durationMs} ms ` +
          `(limit ${PREVIEW_FACT_DURATION_TOLERANCE_MS} ms): a different recording`,
      ),
    );
  }

  if (measured) {
    const recorded = record.level.assetIntegratedLufs;
    if (!Number.isFinite(recorded)) {
      problems.push(named(clip, "the evidence did not measure the preview's level, so the decoded level has no target"));
    } else {
      const drift = measured.integratedLufs - recorded;
      if (Math.abs(drift) > AUDITION_LEVEL_TOLERANCE_LU) {
        problems.push(
          named(
            clip,
            `the committed bytes decode to ${measured.integratedLufs.toFixed(2)} LUFS, ` +
              `${signed(drift)} LU from the ${recorded.toFixed(2)} LUFS the evidence records ` +
              `(limit ${AUDITION_LEVEL_TOLERANCE_LU} LU): the file is not the preview that was measured`,
          ),
        );
      }
    }
    if (!(measured.truePeakDbtp < 0)) {
      problems.push(
        named(clip, `the committed bytes peak at ${measured.truePeakDbtp.toFixed(2)} dBTP, reaching or passing full scale`),
      );
    }
  }

  return problems;
}

/**
 * Gate every offered voice's preview, named. A voice with no committed preview
 * is a failure with the generator's remedy, never a skip: the picker offers
 * the voice, so a missing preview breaks the promise.
 *
 * `readAsset` returns `null` for an uncommitted asset and is called at most
 * once per asset, so the existence check and the bytes read cannot disagree.
 */
export function previewGate(input: {
  manifest: AuditionManifest;
  readAsset: (asset: string) => Uint8Array | null;
  measurement: PreviewMeasurement;
  voices?: readonly Voice[];
}): PreviewGate {
  const voices = input.voices ?? VOICES;
  const readOnce = new Map<string, Uint8Array | null>();
  const read = (asset: string): Uint8Array | null => {
    if (!readOnce.has(asset)) readOnce.set(asset, input.readAsset(asset));
    return readOnce.get(asset) ?? null;
  };
  const assetExists = (asset: string) => read(asset) !== null;

  const checks: PreviewCheck[] = [];

  for (const voice of voices) {
    const clip = auditionClipFor(voice.id);
    const base = {
      voiceId: voice.id,
      locale: clip.locale,
      asset: clip.asset,
      measurement: input.measurement.kind,
      note: input.measurement.kind === "pure-mp3" ? input.measurement.reason : null,
    } as const;

    const records = input.manifest.clips.filter((record) => record.voice === voice.id);
    let record: AuditionClipRecord;
    try {
      record = committedClipFor(input.manifest, voice.id, { assetExists });
    } catch (error) {
      if (error instanceof AuditionClipMissingError) {
        checks.push({ ...base, problems: [named(clip, error.message)] });
        continue;
      }
      throw error;
    }

    const bytes = read(record.asset);
    if (!bytes) {
      // Unreachable: `committedClipFor` just proved the same cached read was
      // non-null. A thrown contract error is better than a silent second read.
      throw new Error(
        `previewGate read ${record.asset} twice with different results: readAsset must be stable`,
      );
    }

    const problems: string[] = [];
    if (records.length !== 1) {
      problems.push(
        named(
          clip,
          `the evidence records this voice ${records.length} times: one voice has one preview, so a second record is a second claim`,
        ),
      );
    }
    let measured: MeasuredPreview | null = null;
    if (input.measurement.kind === "decoded") {
      try {
        measured = input.measurement.measure(record.asset, bytes);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        problems.push(named(clip, `the decoded measurement failed, so the level is unproven: ${detail}`));
      }
    }
    problems.push(...previewProblems({ clip, record, bytes, measured }));
    checks.push({ ...base, problems });
  }

  // An evidence record for a voice the picker does not offer is a preview
  // nobody can reach; name it rather than letting the registry loop hide it.
  for (const record of input.manifest.clips) {
    if (voices.some((voice) => voice.id === record.voice)) continue;
    checks.push({
      voiceId: record.voice,
      locale: record.locale,
      asset: record.asset,
      measurement: input.measurement.kind,
      note: input.measurement.kind === "pure-mp3" ? input.measurement.reason : null,
      problems: [
        `voice "${record.voice}" (${record.locale}): the evidence records a preview for a voice the picker does not offer`,
      ],
    });
  }

  return { checks, failures: checks.filter((check) => check.problems.length > 0) };
}
