/**
 * W1 audition clips (voice-parity ticket 39): regenerate one clip and compare
 * it with the committed asset.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * Ticket 38 made the script the only producer of `public/voices/*.mp3` and
 * proved the plan and the evidence agree. That still trusts the run that wrote
 * the evidence. This module answers the next question: if the voice speaks the
 * line again today, does the committed file still match it? The old clips had
 * drifted — German and Italian greeted in English, levels were pre-gained and
 * six files were re-encoded twice — and nothing compared a fresh render to the
 * committed file.
 *
 * A regenerated take is not a byte copy: the vendor's synthesis is
 * nondeterministic. So the comparison is the named tolerance table on the
 * measured facts (5% duration, 1 LU level, 3 dB crest) plus the identity the
 * clip promises: this voice, this Locale, this line.
 *
 * ── No live call in the test ──────────────────────────────────────────────
 * `readAuditionTake` loads a *committed* take sample and verifies its recorded
 * hash, so the test drives this module with real measured audio and no token,
 * socket or credential. The live path stays with the generator; `--check`
 * verifies the plan, the evidence and the committed bytes without a call.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeWav, type DecodedAudio } from "@/lib/audio/format-facts";
import {
  AUDITION_CHANNELS,
  AUDITION_GENERATOR_COMMAND,
  AUDITION_REGENERATION_CREST_TOLERANCE_DB,
  AUDITION_REGENERATION_DURATION_RATIO,
  AUDITION_REGENERATION_LEVEL_TOLERANCE_LU,
  AUDITION_SAMPLE_RATE,
  auditionClipProblems,
  auditionLineSha256,
  type AuditionClip,
  type AuditionClipRecord,
  type AuditionManifest,
} from "./audition-clips";

/** A committed regeneration sample: a fresh take of one clip's line. */
export type AuditionTakeEvidence = {
  schemaVersion: 1;
  voice: string;
  locale: string;
  line: string;
  lineSha256: string;
  recordedOn: string;
  method: string;
  command: string;
  relation: string;
  audio: {
    file: string;
    sha256: string;
    container: "wav";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    durationMs: number;
  };
};

export type AuditionTake = {
  evidence: AuditionTakeEvidence;
  /** The native render, decoded. Never gained, limited or normalised. */
  audio: DecodedAudio;
  /** The WAV the evidence points at. */
  path: string;
};

export type AuditionTakeErrorCode = "missing" | "unreadable" | "hash-mismatch" | "format" | "line-mismatch";

export class AuditionTakeError extends Error {
  constructor(
    readonly code: AuditionTakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditionTakeError";
  }
}

/**
 * Load a recorded take and prove it is the bytes the evidence records.
 *
 * A missing take is a failure, not a skip: the regeneration gate cannot be
 * quietly absent. A tampered file is refused by hash rather than compared as
 * if it were audio of the claimed line.
 */
export function readAuditionTake(evidencePath: string): AuditionTake {
  let raw: string;
  try {
    raw = readFileSync(evidencePath, "utf8");
  } catch {
    throw new AuditionTakeError(
      "missing",
      `no recorded take at ${evidencePath}: the regeneration gate needs a committed take sample`,
    );
  }

  let evidence: AuditionTakeEvidence;
  try {
    evidence = JSON.parse(raw) as AuditionTakeEvidence;
  } catch (error) {
    throw new AuditionTakeError(
      "unreadable",
      `${evidencePath} is not readable as take evidence: ${String(error)}`,
    );
  }
  if (
    !evidence.audio ||
    typeof evidence.audio.file !== "string" ||
    typeof evidence.audio.sha256 !== "string" ||
    typeof evidence.line !== "string"
  ) {
    throw new AuditionTakeError("unreadable", `${evidencePath} does not name a take file, hash and line`);
  }

  const path = join(dirname(evidencePath), evidence.audio.file);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    throw new AuditionTakeError("missing", `the take's audio is missing: ${path}`);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== evidence.audio.sha256) {
    throw new AuditionTakeError(
      "hash-mismatch",
      `${path} is not the take the evidence records (sha256 ${sha256}): ` +
        "the comparison would measure audio nobody vouched for",
    );
  }

  let audio: DecodedAudio;
  try {
    audio = decodeWav(bytes);
  } catch (error) {
    throw new AuditionTakeError("format", `${path} is not a readable PCM WAV: ${String(error)}`);
  }
  if (audio.facts.sampleRate !== AUDITION_SAMPLE_RATE || audio.facts.channels !== AUDITION_CHANNELS) {
    throw new AuditionTakeError(
      "format",
      `${path} is ${audio.facts.sampleRate} Hz x ${audio.facts.channels}ch, ` +
        `not the session's ${AUDITION_SAMPLE_RATE} Hz mono`,
    );
  }

  if (auditionLineSha256(evidence.line) !== evidence.lineSha256) {
    throw new AuditionTakeError(
      "line-mismatch",
      `${path} records a line that does not hash to its lineSha256: ` +
        "the take and the sentence it claims to speak disagree",
    );
  }

  return { evidence, audio, path };
}

export type AuditionClipMissingCode = "pending" | "unrecorded" | "asset-missing";

/** The regeneration target is absent. A named failure, never a skip. */
export class AuditionClipMissingError extends Error {
  constructor(
    readonly code: AuditionClipMissingCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditionClipMissingError";
  }
}

/**
 * The committed record for one voice, or a named failure.
 *
 * `assetExists` is injected so a caller can test the missing-file branch
 * without moving a committed file.
 */
export function committedClipFor(
  manifest: AuditionManifest,
  voiceId: string,
  opts: { assetExists: (asset: string) => boolean },
): AuditionClipRecord {
  const record = manifest.clips.find((candidate) => candidate.voice === voiceId);
  if (record) {
    if (!opts.assetExists(record.asset)) {
      throw new AuditionClipMissingError(
        "asset-missing",
        `no committed clip for ${voiceId}: ${record.asset} is recorded but not committed; ` +
          `run ${AUDITION_GENERATOR_COMMAND}`,
      );
    }
    return record;
  }

  const pending = manifest.pending.find((candidate) => candidate.voice === voiceId);
  if (pending) {
    throw new AuditionClipMissingError(
      "pending",
      `no committed clip for ${voiceId}: pending — ${pending.reason}; run ${pending.command}`,
    );
  }

  throw new AuditionClipMissingError(
    "unrecorded",
    `no committed clip for ${voiceId}: the evidence has neither a clip nor a pending entry; ` +
      `run ${AUDITION_GENERATOR_COMMAND}`,
  );
}

/**
 * Why a regenerated take does not match the committed clip, or an empty list.
 *
 * The record's own checks run first (voice, Locale, line, hash, asset, native
 * level, bitrate, true peak), then the regeneration tolerances against the
 * committed asset. A clip whose Locale or level does not match its voice
 * therefore fails here, as does a different performance, a stale greeting, a
 * bitrate too low to survive delivery, and a flattened (clipped) preview.
 */
export function regenerationProblems(
  clip: AuditionClip,
  committed: AuditionClipRecord,
  regenerated: AuditionClipRecord,
): string[] {
  // The committed clip must itself be this voice, Locale and line at native
  // level: a fresh take that matches the plan cannot excuse a wrong asset.
  const problems = auditionClipProblems(clip, committed).map(
    (problem) => `committed clip: ${problem}`,
  );
  problems.push(
    ...auditionClipProblems(clip, regenerated).map((problem) => `regenerated take: ${problem}`),
  );

  const committedDuration = committed.facts.durationMs;
  const regeneratedDuration = regenerated.facts.durationMs;
  if (!Number.isFinite(committedDuration) || committedDuration <= 0) {
    problems.push("the committed clip's duration was not measured");
  } else if (
    Math.abs(regeneratedDuration - committedDuration) / committedDuration >
    AUDITION_REGENERATION_DURATION_RATIO
  ) {
    const ratio = Math.abs(regeneratedDuration - committedDuration) / committedDuration;
    problems.push(
      `the fresh take's duration is ${regeneratedDuration} ms, ` +
        `${(ratio * 100).toFixed(1)}% from the committed ${committedDuration} ms ` +
        `(limit ${(AUDITION_REGENERATION_DURATION_RATIO * 100).toFixed(0)}%): ` +
        "the committed preview is a different performance",
    );
  }

  const committedLevel = committed.level.assetIntegratedLufs;
  const regeneratedLevel = regenerated.level.assetIntegratedLufs;
  if (!Number.isFinite(committedLevel)) {
    problems.push("the committed clip's level was not measured");
  } else if (Number.isFinite(regeneratedLevel)) {
    const gain = regeneratedLevel - committedLevel;
    if (Math.abs(gain) > AUDITION_REGENERATION_LEVEL_TOLERANCE_LU) {
      problems.push(
        `the fresh take encodes to ${regeneratedLevel.toFixed(2)} LUFS, ` +
          `${gain > 0 ? "+" : ""}${gain.toFixed(2)} LU from the committed ` +
          `${committedLevel.toFixed(2)} LUFS (limit ${AUDITION_REGENERATION_LEVEL_TOLERANCE_LU} LU): ` +
          "the committed preview is not this voice at native level",
      );
    }
  }

  const committedCrest = committed.level.assetCrestDb;
  const regeneratedCrest = regenerated.level.assetCrestDb;
  if (!Number.isFinite(committedCrest)) {
    problems.push("the committed clip's crest was not measured");
  } else if (!Number.isFinite(regeneratedCrest)) {
    problems.push("the fresh take's crest was not measured, so a flattened preview cannot be ruled out");
  } else {
    const flattening = regeneratedCrest - committedCrest;
    if (Math.abs(flattening) > AUDITION_REGENERATION_CREST_TOLERANCE_DB) {
      problems.push(
        `the fresh take's crest is ${regeneratedCrest.toFixed(2)} dB, ` +
          `${flattening > 0 ? "+" : ""}${flattening.toFixed(2)} dB from the committed ` +
          `${committedCrest.toFixed(2)} dB (limit ${AUDITION_REGENERATION_CREST_TOLERANCE_DB} dB): ` +
          "the committed preview is flattened",
      );
    }
  }

  return problems;
}

export type RegenerationPrerequisiteDecision =
  | { action: "run" }
  | { action: "skip" | "fail"; reason: string };

/**
 * Fail or skip when a prerequisite is absent — never pass silently.
 *
 * Locally a missing tool is a **named skip**, so a contributor without ffmpeg
 * sees exactly what did not run. In CI it is a **named failure**: the
 * regeneration gate is the point of the run there, and a gate that skips in CI
 * is a gate that cannot fail. (CI installs ffmpeg; see `.github/workflows`.)
 */
export function regenerationPrerequisite(input: {
  name: string;
  present: boolean;
  ci: boolean;
  remedy: string;
}): RegenerationPrerequisiteDecision {
  if (input.present) return { action: "run" };
  const reason =
    `${input.name} is not on PATH: the audition-clip regeneration gate cannot run without it; ` +
    input.remedy;
  return { action: input.ci ? "fail" : "skip", reason };
}
