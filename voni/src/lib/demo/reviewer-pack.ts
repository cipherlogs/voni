/**
 * W5 parity proof (voice-parity ticket 58): the reviewer pack and verdict record.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * The acceptance bar is human: a named native reviewer per Locale judges the
 * voice on one recording, at five out of five, with a stated reason whenever the
 * score is below five. That bar needs artifacts, not a conversation: a pack a
 * reviewer can be handed without anyone assembling it, a ballot that cannot be
 * half-filled, and a verdict record that names the reviewer and the date.
 *
 * The pack is built on the **audition clips** (tickets 38/39), not on the
 * content-rendering work, so the parity proof proceeds while a Locale is still
 * being judged. The recording is the committed `public/voices/<voice>.mp3`,
 * referenced by its sha256: two ballots for one Locale judge one shared cut.
 *
 * ── Doctrine this module enforces ─────────────────────────────────────────
 * - **A rating below five blocks, and the rater's reason is recorded.** A
 *   ballot with a four and no reason is refused by axis name; the reason is
 *   evidence about which layer the fix belongs in.
 * - **A pack without a named reviewer and a date is pending, never passing.**
 *   There is no default reviewer and no default date. `packMissing` names what
 *   is still blank and the hand-off sheet prints it.
 * - **Voice binding.** A pack's Locale is the recording's Locale is the voice's
 *   one Locale. A mismatch fails by name instead of judging another language.
 * - **No invented reviewer.** The owner supplies who can staff each Locale
 *   (spec: *Open dependency: named reviewers*); this module never fills it in.
 *
 * ── The third axis and the weighting (tickets 74/75) ──────────────────────
 * The ballot carries timbre, accent and language naturalness. The axis is part
 * of the schema now so a reviewer is asked once and every ballot carries all
 * three. The gate's weighted aggregation (timbre 0.5, accent 0.25, language
 * naturalness 0.25; five out of five passes) lives with the scoreboard
 * (`TIMBRE_BALLOT_AXIS_WEIGHTS`); the naturalness report wiring is ticket 75's.
 * A verdict filed from a pack is the demo voice's one subject ballot on this
 * recording — the shared cut named by the pack's sha256.
 *
 * The module is pure: no audio, no socket, no clock. The checked-in script
 * (`npm run voice:packs`) reads the clip evidence, hashes the committed bytes
 * and writes the packs; the test drives the same functions without a call.
 */
import { createHash } from "node:crypto";
import { getVoice, type Voice } from "@/lib/agents/voices";
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import type { AuditionClipRecord } from "./audition-clips";

export const REVIEWER_PACK_SCHEMA_VERSION = 1;

/** Committed pack evidence: one JSON record and one hand-off sheet per voice. */
export const REVIEWER_PACK_DIR = "evidence/reviewer-packs";

/** The compact index of every pack, its status and its recording hash. */
export const REVIEWER_PACK_INDEX_PATH = `${REVIEWER_PACK_DIR}/packs.json`;

/** The script that is the only producer of the committed packs. */
export const REVIEWER_PACK_COMMAND = "cd voni && npm run voice:packs";

/** The axes a ballot scores. Language naturalness is ticket 75's axis. */
export const BALLOT_AXES = ["timbre", "accent", "languageNaturalness"] as const;
export type BallotAxis = (typeof BALLOT_AXES)[number];

/** The label a reviewer reads on the ballot. */
export const BALLOT_AXIS_LABELS: Record<BallotAxis, string> = {
  timbre: "Timbre",
  accent: "Accent",
  languageNaturalness: "Language naturalness",
};

/** One shared scale for every Locale: five is the bar (spec W5). */
export const BALLOT_SCALE_MIN = 1;
export const BALLOT_SCALE_MAX = 5;
export const BALLOT_PASS_SCORE = 5;

/** Doctrine: a score below five records the rater's stated reason. */
export const BALLOT_REASON_REQUIRED_BELOW = 5;

/** The one recording every ballot for a pack judges, identified by its bytes. */
export type ReviewRecording = {
  /** The voice that speaks it (a voice speaks exactly one Locale). */
  voice: string;
  locale: string;
  /** Repo-relative committed audition clip. */
  asset: string;
  /** The URL the reviewer plays. */
  url: string;
  /** sha256 of the committed bytes: the shared cut. */
  sha256: string;
  /** The exact greeting the reviewer hears, so the ballot is about this line. */
  line: string;
  lineSha256: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  /** Provenance: the committed audition clip, never a capture made for a pack. */
  source: "audition-clip";
};

export type BallotScores = Partial<Record<BallotAxis, number>>;
export type BallotReasons = Partial<Record<BallotAxis, string>>;

/**
 * One reviewer's verdict. `locale` is restated on the verdict so a verdict that
 * judged a different language than the recording names cannot be filed.
 * `reviewer` is the named native reviewer and `reviewedOn` the date they
 * judged — both required, both owner input.
 */
export type ReviewerVerdict = {
  reviewer: string;
  /** ISO `YYYY-MM-DD`; the date the reviewer judged, not the file's date. */
  reviewedOn: string;
  locale: string;
  scores: BallotScores;
  reasons: BallotReasons;
};

export type ReviewerBallot = {
  axes: BallotAxis[];
  scale: { min: number; max: number; pass: number };
  /** A score below this value requires a written reason on that axis. */
  reasonRequiredBelow: number;
};

/**
 * One Locale's reviewer pack. `verdict` is null until a reviewer files one,
 * so an unstaffed Locale is visibly pending rather than quietly complete.
 */
export type ReviewerPack = {
  schemaVersion: typeof REVIEWER_PACK_SCHEMA_VERSION;
  voice: string;
  locale: string;
  /** Null only in a deliberately broken pack, which validation refuses. */
  recording: ReviewRecording | null;
  ballot: ReviewerBallot;
  verdict: ReviewerVerdict | null;
  generatedOn: string;
  /** The evidence file the recording came from. */
  source: string;
};

/** The fields validation can refuse, by name. */
export type ReviewerPackField =
  | "recording"
  | "recording-sha256"
  | "voice"
  | "locale"
  | "reviewer"
  | "reviewedOn"
  | "score"
  | "reason";

export type ReviewerPackProblem = {
  field: ReviewerPackField;
  /** The ballot axis a score/reason problem is about. */
  axis?: BallotAxis;
  message: string;
};

/** A refused pack: every problem is named, so the operator knows what to fix. */
export class ReviewerPackError extends Error {
  constructor(
    readonly problems: ReviewerPackProblem[],
    context = "",
  ) {
    super(
      `${context ? `${context}: ` : ""}${problems
        .map((problem) => problem.message)
        .join(" | ")}`,
    );
    this.name = "ReviewerPackError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD`, so `2026-13-01` is refused too. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The hash a recording is referenced by: the committed bytes, nothing derived. */
export function recordingSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isConversationLocale(locale: string): boolean {
  return (CONVERSATION_LANGUAGES as readonly string[]).includes(locale);
}

function recordingFor(clip: AuditionClipRecord, sha256: string): ReviewRecording {
  return {
    voice: clip.voice,
    locale: clip.locale,
    asset: clip.asset,
    url: clip.url,
    sha256,
    line: clip.line,
    lineSha256: clip.lineSha256,
    durationMs: clip.facts.durationMs,
    sampleRate: clip.facts.sampleRate,
    channels: clip.facts.channels,
    bitrateKbps: clip.facts.bitrateKbps,
    source: "audition-clip",
  };
}

/**
 * Why a pack cannot be handed to a reviewer, or an empty list: the recording
 * is absent, its hash is not a sha256, or the pack's Locale is not the voice's
 * and the recording's one Locale.
 */
export function recordingProblems(pack: ReviewerPack): ReviewerPackProblem[] {
  const problems: ReviewerPackProblem[] = [];
  const recording = pack.recording;
  if (!recording) {
    problems.push({
      field: "recording",
      message:
        "recording is missing: a ballot judges one committed audition clip, and this pack names none",
    });
    return problems;
  }

  if (!SHA256.test(recording.sha256)) {
    problems.push({
      field: "recording-sha256",
      message: `recording sha256 "${recording.sha256}" is not a sha256: the shared cut must be identified by its bytes`,
    });
  }

  const known: Voice | undefined = getVoice(pack.voice);
  if (!known) {
    problems.push({
      field: "voice",
      message: `unknown voice "${pack.voice}": a pack judges a catalog voice, not an invented one`,
    });
  }

  if (recording.voice !== pack.voice) {
    problems.push({
      field: "voice",
      message: `recording is for voice "${recording.voice}", not "${pack.voice}"`,
    });
  }

  const voiceLocale = known?.languageCode;
  if (voiceLocale !== undefined && voiceLocale !== pack.locale) {
    problems.push({
      field: "locale",
      message: `${pack.voice} speaks ${voiceLocale}, not ${pack.locale} (voice binding: a voice speaks exactly one Locale)`,
    });
  }
  if (recording.locale !== pack.locale) {
    problems.push({
      field: "locale",
      message: `the recording is the ${recording.locale} clip, but the pack judges ${pack.locale}: a mismatched Locale would judge another language`,
    });
  }
  if (!isConversationLocale(pack.locale)) {
    problems.push({
      field: "locale",
      message: `unknown Locale "${pack.locale}": pick one of ${CONVERSATION_LANGUAGES.join(", ")}`,
    });
  }
  return problems;
}

/**
 * Why a filed verdict is not yet a verdict, or an empty list. Every problem
 * names its field — `reviewer`, `reviewedOn`, `locale`, `score:timbre`,
 * `reason:accent` — so a half-filled ballot cannot pass as a complete one.
 */
export function verdictProblems(pack: ReviewerPack, verdict: ReviewerVerdict): ReviewerPackProblem[] {
  const problems: ReviewerPackProblem[] = [];

  if (verdict.reviewer.trim() === "") {
    problems.push({
      field: "reviewer",
      message:
        "reviewer is missing: a verdict must name the native reviewer who judged this Locale",
    });
  }
  if (verdict.reviewedOn.trim() === "") {
    problems.push({
      field: "reviewedOn",
      message: "reviewedOn is missing: a verdict needs the date the reviewer judged",
    });
  } else if (!isIsoDate(verdict.reviewedOn)) {
    problems.push({
      field: "reviewedOn",
      message: `reviewedOn "${verdict.reviewedOn}" is not a date: write it as YYYY-MM-DD`,
    });
  }
  if (verdict.locale !== pack.locale) {
    problems.push({
      field: "locale",
      message: `the verdict judges locale ${verdict.locale}, but this pack is locale ${pack.locale} (${pack.voice})`,
    });
  }

  for (const axis of BALLOT_AXES) {
    const score = verdict.scores[axis];
    if (score === undefined) {
      problems.push({
        field: "score",
        axis,
        message: `${axis} score is missing: every ballot scores ${BALLOT_AXES.join(", ")}`,
      });
      continue;
    }
    if (!Number.isInteger(score) || score < BALLOT_SCALE_MIN || score > BALLOT_SCALE_MAX) {
      problems.push({
        field: "score",
        axis,
        message: `${axis} score must be an int ${BALLOT_SCALE_MIN}-${BALLOT_SCALE_MAX}, got ${score}`,
      });
      continue;
    }
    // Doctrine: a rating below five blocks, and the rater's reason is recorded.
    if (score < BALLOT_REASON_REQUIRED_BELOW && (verdict.reasons[axis] ?? "").trim() === "") {
      problems.push({
        field: "reason",
        axis,
        message:
          `reason for ${axis} is missing: a score of ${score} is below ${BALLOT_REASON_REQUIRED_BELOW}, ` +
          "and doctrine requires the rater's stated reason with the score",
      });
    }
  }
  return problems;
}

/**
 * Every reason this pack is not complete, or an empty list for a complete pack.
 * A pack with no verdict is not a failure — it is pending owner input — so its
 * absent reviewer is reported by `packMissing`, not as a defect.
 */
export function reviewerPackProblems(pack: ReviewerPack): ReviewerPackProblem[] {
  const problems = recordingProblems(pack);
  if (pack.verdict) problems.push(...verdictProblems(pack, pack.verdict));
  return problems;
}

/** The required fields still blank. Empty only when the pack is complete. */
export function packMissing(pack: ReviewerPack): string[] {
  const missing: string[] = [];
  if (!pack.verdict || pack.verdict.reviewer.trim() === "") missing.push("reviewer");
  if (!pack.verdict || pack.verdict.reviewedOn.trim() === "") missing.push("reviewedOn");
  return missing;
}

export type PackStatus =
  /** No verdict yet: awaiting the named reviewer and date (owner input). */
  | "pending"
  /** A recording, verdict or field is wrong: not a pass. */
  | "incomplete"
  /** A named reviewer, a date and five-out-of-five with reasons. */
  | "complete";

export function packStatus(pack: ReviewerPack): PackStatus {
  if (recordingProblems(pack).length > 0) return "incomplete";
  if (!pack.verdict) return "pending";
  return reviewerPackProblems(pack).length === 0 ? "complete" : "incomplete";
}

/**
 * The recording is the bytes the pack records, or a named problem. The script
 * hashes the committed file; the test drives this with a known-wrong hash.
 */
export function recordingBytesProblem(
  pack: ReviewerPack,
  actualSha256: string,
): ReviewerPackProblem | null {
  if (!pack.recording) {
    return {
      field: "recording",
      message: "recording is missing: there are no bytes to hash",
    };
  }
  if (pack.recording.sha256 !== actualSha256) {
    return {
      field: "recording-sha256",
      message:
        `the pack's recording sha256 ${pack.recording.sha256} does not match the committed bytes ` +
        `${actualSha256}: the ballot would judge audio nobody hears`,
    };
  }
  return null;
}

/**
 * Build a pending pack for one committed clip. It never invents a reviewer or
 * a score; the caller may file a verdict afterwards with `fileVerdict`.
 */
export function reviewerPackFor(
  clip: AuditionClipRecord,
  sha256: string,
  opts: { generatedOn?: string; source?: string } = {},
): ReviewerPack {
  const known = getVoice(clip.voice);
  if (!known) {
    throw new ReviewerPackError(
      [{ field: "voice", message: `unknown voice "${clip.voice}": a pack needs a catalog voice` }],
      "reviewer pack",
    );
  }
  if (known.languageCode !== clip.locale) {
    throw new ReviewerPackError(
      [
        {
          field: "locale",
          message: `${clip.voice} speaks ${known.languageCode}, not ${clip.locale} (voice binding: a voice speaks exactly one Locale)`,
        },
      ],
      "reviewer pack",
    );
  }
  if (!SHA256.test(sha256)) {
    throw new ReviewerPackError(
      [
        {
          field: "recording-sha256",
          message: `"${sha256}" is not the sha256 of a committed recording`,
        },
      ],
      "reviewer pack",
    );
  }

  return {
    schemaVersion: REVIEWER_PACK_SCHEMA_VERSION,
    voice: clip.voice,
    locale: clip.locale,
    recording: recordingFor(clip, sha256),
    ballot: {
      axes: [...BALLOT_AXES],
      scale: { min: BALLOT_SCALE_MIN, max: BALLOT_SCALE_MAX, pass: BALLOT_PASS_SCORE },
      reasonRequiredBelow: BALLOT_REASON_REQUIRED_BELOW,
    },
    verdict: null,
    generatedOn: opts.generatedOn ?? new Date().toISOString().slice(0, 10),
    source: opts.source ?? "evidence/audition-clips/clips.json",
  };
}

/**
 * File a verdict, refusing a half-filled or mismatched one by name. This is the
 * only way a pack acquires a reviewer: there is no default name and no default
 * date.
 */
export function fileVerdict(pack: ReviewerPack, verdict: ReviewerVerdict): ReviewerPack {
  const filed: ReviewerPack = { ...pack, verdict };
  const problems = reviewerPackProblems(filed);
  if (problems.length > 0) {
    throw new ReviewerPackError(problems, `reviewer pack ${pack.voice} (${pack.locale})`);
  }
  return filed;
}

/**
 * Regeneration policy: a verdict belongs to the bytes the reviewer heard. A new
 * clip invalidates it (the reviewer judged audio nobody can hear now); the same
 * clip keeps it, so the daily or per-voice regeneration never loses a verdict.
 */
export function carryVerdict(previous: ReviewerPack | null, next: ReviewerPack): ReviewerPack {
  const verdict = previous?.verdict;
  if (!verdict) return next;
  if (!previous?.recording || !next.recording) return { ...next, verdict: null };
  if (previous.recording.sha256 !== next.recording.sha256) return { ...next, verdict: null };
  if (previous.locale !== next.locale || previous.voice !== next.voice) {
    return { ...next, verdict: null };
  }
  return { ...next, verdict };
}

function statusLine(pack: ReviewerPack): string {
  const status = packStatus(pack);
  if (status === "complete") {
    return "**complete** — a named reviewer judged this recording at five out of five.";
  }
  if (status === "pending") {
    return (
      "**pending — not complete**: the reviewer and the date are still blank. " +
      "A pack is never a pass without a named native reviewer and the date they judged."
    );
  }
  const problems = reviewerPackProblems(pack);
  return `**incomplete — not a pass**: ${problems.map((problem) => problem.message).join("; ")}`;
}

/**
 * The hand-off sheet: the recording, the ballot and the signature block on one
 * page, so a reviewer can be handed the pack without further assembly. It is
 * generated from the same record, so the sheet cannot disagree with the JSON.
 */
export function formatReviewerPack(pack: ReviewerPack): string {
  const recording = pack.recording;
  const verdict = pack.verdict;
  const lines: string[] = [
    `# Parity proof — reviewer pack: ${pack.voice} (${pack.locale})`,
    "",
    `Status: ${statusLine(pack)}`,
    "",
    "## The recording — one shared cut",
    "",
    "Every ballot for this Locale judges these exact bytes, so two independent reviews are comparable.",
    "",
  ];

  if (recording) {
    lines.push(
      `- Voice: ${recording.voice} (${recording.locale})`,
      `- Play: \`${recording.url}\` (committed as \`${recording.asset}\`)`,
      `- sha256: \`${recording.sha256}\``,
      `- Line: “${recording.line}”`,
      `- Format: ${recording.durationMs} ms, ${recording.sampleRate} Hz, ${recording.channels === 1 ? "mono" : `${recording.channels} channels`}, ${recording.bitrateKbps} kbps`,
      `- Provenance: ${recording.source} (the picker's preview, at native level)`,
    );
  } else {
    lines.push("- **Recording missing.** This pack cannot be judged; regenerate it before handing it out.");
  }

  lines.push(
    "",
    "## The ballot",
    "",
    `Score each axis ${BALLOT_SCALE_MIN}–${BALLOT_SCALE_MAX}. Five is the bar.`,
    "",
    `**A score below ${BALLOT_REASON_REQUIRED_BELOW} must record your written reason on that axis.** ` +
      "The reason is kept with the score: a rating below five blocks, and a reason that repeats across iterations " +
      "means the fix is at the wrong layer.",
    "",
    `| Axis | Score (${BALLOT_SCALE_MIN}–${BALLOT_SCALE_MAX}) | Written reason (required below ${BALLOT_REASON_REQUIRED_BELOW}) |`,
    "| --- | --- | --- |",
  );
  for (const axis of pack.ballot.axes) {
    const score = verdict?.scores[axis];
    const reason = verdict?.reasons[axis] ?? "";
    lines.push(`| ${BALLOT_AXIS_LABELS[axis]} | ${score ?? ""} | ${reason} |`);
  }

  lines.push(
    "",
    "## The verdict record",
    "",
    "Both fields are required. A pack without them is pending, not a pass.",
    "",
    `Reviewer (named native reviewer):${verdict ? ` ${verdict.reviewer}` : ""}`,
    `Date:${verdict ? ` ${verdict.reviewedOn}` : ""}`,
    "",
    `File the verdict in \`${REVIEWER_PACK_DIR}/${pack.voice}.json\` (the \`verdict\` object), then run ` +
      `\`${REVIEWER_PACK_COMMAND} -- --check\`.`,
    "",
  );
  return lines.join("\n");
}

export type ReviewerPackIndexEntry = {
  voice: string;
  locale: string;
  asset: string | null;
  url: string | null;
  recordingSha256: string | null;
  status: PackStatus;
  reviewer: string | null;
  reviewedOn: string | null;
  pack: string;
};

export type ReviewerPackIndex = {
  schemaVersion: typeof REVIEWER_PACK_SCHEMA_VERSION;
  generatedOn: string;
  command: string;
  /** The evidence the recordings come from. */
  source: string;
  counts: { total: number; pending: number; complete: number; incomplete: number };
  packs: ReviewerPackIndexEntry[];
};

/** The compact record of every pack: who is pending, who judged what, on which bytes. */
export function buildPackIndex(
  packs: readonly ReviewerPack[],
  opts: { generatedOn?: string; source?: string } = {},
): ReviewerPackIndex {
  const entries = packs.map((pack): ReviewerPackIndexEntry => {
    return {
      voice: pack.voice,
      locale: pack.locale,
      asset: pack.recording?.asset ?? null,
      url: pack.recording?.url ?? null,
      recordingSha256: pack.recording?.sha256 ?? null,
      status: packStatus(pack),
      // Owner input only: never a placeholder, never a default name.
      reviewer: pack.verdict?.reviewer ?? null,
      reviewedOn: pack.verdict?.reviewedOn ?? null,
      pack: `${REVIEWER_PACK_DIR}/${pack.voice}.json`,
    };
  });
  return {
    schemaVersion: REVIEWER_PACK_SCHEMA_VERSION,
    generatedOn: opts.generatedOn ?? new Date().toISOString().slice(0, 10),
    command: REVIEWER_PACK_COMMAND,
    source: opts.source ?? "evidence/audition-clips/clips.json",
    counts: {
      total: entries.length,
      pending: entries.filter((entry) => entry.status === "pending").length,
      complete: entries.filter((entry) => entry.status === "complete").length,
      incomplete: entries.filter((entry) => entry.status === "incomplete").length,
    },
    packs: entries,
  };
}
