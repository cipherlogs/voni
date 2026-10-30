/**
 * The W2 cascade re-audition pack (meta-cascade M16, ticket 133).
 *
 * One real cascade call becomes one pack: the subject's own clean cascade
 * artifact, a reference rendering, the delivered capture, the transcript, the
 * W0 two-capture comparison and two independent ballots on the one shared
 * recording. There is no platform leg, because a cascade call has no platform
 * recording (spec W0); the platform leg is a named N/A, never invented.
 *
 * The pack assembles the inputs a verdict must rest on. It does not decide:
 * `accept` / `withdraw` are the owner's recorded statement (ticket 134), and
 * the pack's own verdict stays `unresolved` with `readyForOwner` telling the
 * owner whether the inputs are complete. A missing capture, a missing ballot,
 * an ineligible artifact, a managed artifact or another subject's artifact
 * leaves the pack incomplete and the verdict unresolved — never a pass.
 *
 * The module reads the captures because it must hash and decode them, but it
 * never writes or fabricates audio: a missing file is a named blocker, not a
 * placeholder WAV. The W0 table itself is pure over the decoded samples.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  compareReferenceAndDelivered,
  formatTwoCaptureTable,
  type TwoCaptureComparison,
  type TwoCaptureLine,
  type TwoCaptureRole,
  type TwoCaptureSlot,
} from "../audio/comparison";
import { decodeWav, type AudioFactsError } from "../audio/format-facts";
import {
  contentTurns,
  type ContentTurn,
} from "../voice/content-judge";
import { BALLOT_AXES, BALLOT_REASON_REQUIRED_BELOW, BALLOT_SCALE_MAX, BALLOT_SCALE_MIN, isIsoDate, type BallotAxis } from "./reviewer-pack";
import {
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  isArtifactAbsence,
  subjectOfArtifact,
  type ArtifactCapture,
  type ScoreboardArtifact,
} from "./scoreboard";
import { ArtifactReadError, parseScoreboardArtifact, pipelineOfArtifact } from "./artifact-reader";
import {
  bindCascadeVoice,
  sameSubject,
  UNBOUND_VOICES,
  type SubjectRecord,
} from "./subject";
import { DEMO_VOICE_IDS } from "./voni-agent";

export const CASCADE_REAUDITION_SCHEMA_VERSION = 1;
export const CASCADE_REAUDITION_KIND = "cascade-reaudition-pack";

/** Two independent ears on one shared recording: one ballot per rater. */
export const CASCADE_REAUDITION_BALLOT_COUNT = 2;

/** The one event type that makes a cascade run ineligible. */
const INELIGIBLE_EVENTS = ["provider_fallback", "budget.stopped"] as const;

export function isIneligibleEvent(type: string): boolean {
  return (INELIGIBLE_EVENTS as readonly string[]).includes(type);
}

/** One reviewer's ballot on the delivered recording. */
export type CascadeBallot = {
  /** The named rater; two ballots with the same name are one ear. */
  reviewer: string;
  /** ISO `YYYY-MM-DD`: the date they judged. */
  reviewedOn: string;
  /** The one shared recording every ballot judges: the delivered sha256. */
  recordingSha256: string;
  scores: Record<BallotAxis, number>;
  /** The rater's written reason for this ballot. Required. */
  reason: string;
  /** Per-axis reasons, required on every axis scored below five. */
  axisReasons?: Partial<Record<BallotAxis, string>>;
};

export type CascadeReauditionRequest = {
  /** The subject the pack is about; it must be a cascade browser subject. */
  subject: SubjectRecord;
  /** The subject's own artifact, raw or already parsed. */
  artifact: unknown;
  /** Where the artifact was read from; printed in the pack. */
  artifactPath: string;
  reference: string | null;
  delivered: string | null;
  /** The platform transcript, as text or ordered turns. */
  transcript: string | readonly ContentTurn[];
  /** What part of the delivered capture is the line (the W0 marker). */
  line: TwoCaptureLine | null;
  ballots: readonly CascadeBallot[];
  /**
   * Readiness (ticket 152) assembles tenant subjects eligible under
   * `routing=all` too. The W2 pack stays demo-only by default; a tenant has no
   * demo voice binding to check, so the caller opts in explicitly.
   */
  allowTenantSubject?: boolean;
  /** Clock seam; tests pin the date. */
  now?: () => Date;
};

export type CascadePackCapture = {
  role: TwoCaptureRole | "platform";
  path: string | null;
  present: boolean;
  bytes: number | null;
  sha256: string | null;
  format: { sampleRate: number; channels: number; durationSeconds: number } | null;
  error: string | null;
  /** The named N/A for the cascade's absent platform leg; null otherwise. */
  absent: string | null;
};

export type CascadeReauditionCaptures = Record<"reference" | "delivered" | "platform", CascadePackCapture>;

export type CascadePackTranscript = {
  turns: ContentTurn[];
  sha256: string;
  agentTurns: number;
  callerTurns: number;
  agentWords: number;
  callerWords: number;
};

export type CascadeBallotSummary = {
  required: number;
  /** Distinct named raters who filed a ballot. */
  recorded: number;
  complete: boolean;
  reviewers: string[];
  /** The one recording every ballot judged; null when none was supplied. */
  sharedRecordingSha256: string | null;
  judged: CascadeBallot[];
};

export type CascadeVerdictInputs = {
  ready: boolean;
  rule: {
    /** ADR 0008's meaning: the content did not hold up. */
    accept: string;
    /** ADR 0008's meaning: the content held up. */
    withdraw: string;
    unresolved: string;
  };
  inputs: {
    artifactClean: boolean;
    artifactPipeline: "cascade" | "managed" | null;
    referencePresent: boolean;
    deliveredPresent: boolean;
    transcriptPresent: boolean;
    comparisonMeasured: boolean;
    ballotsComplete: boolean;
    sharedRecording: boolean;
    noPlatformLeg: boolean;
  };
  blockers: string[];
};

export type CascadeReauditionVerdict = {
  /** The pack cannot decide; the owner records accept/withdraw separately. */
  decision: "unresolved";
  justifiesRenderingLayer: null;
  /** True only when every input is present and the owner can decide. */
  readyForOwner: boolean;
  ownerVerdictRequired: true;
  basis: string[];
  decidedAt: string;
};

export type CascadeReauditionPack = {
  schemaVersion: typeof CASCADE_REAUDITION_SCHEMA_VERSION;
  kind: typeof CASCADE_REAUDITION_KIND;
  status: "complete" | "incomplete";
  recordedAt: string;
  subject: {
    voice: string;
    locale: string;
    transport: string;
    agentKind: SubjectRecord["agent"]["kind"];
    pipeline: "cascade" | null;
  };
  artifact: {
    path: string;
    runId: string | null;
    pipeline: "cascade" | "managed" | null;
    eligible: boolean | null;
    captures: { reference: string | null; delivered: string | null };
  };
  captures: CascadeReauditionCaptures;
  transcript: CascadePackTranscript;
  comparison: {
    status: TwoCaptureComparison["status"];
    unresolvedReasons: string[];
    table: string;
    captures: TwoCaptureComparison["captures"];
    alignment: TwoCaptureComparison["alignment"];
    octaveBandsHz: TwoCaptureComparison["octaveBandsHz"];
    tilt: TwoCaptureComparison["tilt"];
  };
  ballots: CascadeBallotSummary;
  verdictInputs: CascadeVerdictInputs;
  verdict: CascadeReauditionVerdict;
  /** Every reason the pack cannot decide; empty only for a complete pack. */
  blockers: string[];
};

export type CascadeReauditionRosterRow = {
  voice: string;
  locale: string;
  status: "complete" | "incomplete" | "missing" | "open";
  /** Why the subject is not complete; null only for a complete pack. */
  openReason: string | null;
  packStatus: "complete" | "incomplete" | null;
  ballots: number;
};

export type CascadeReauditionRoster = {
  subjects: CascadeReauditionRosterRow[];
  /** True only when every one of the six subjects has a complete pack. */
  ready: boolean;
  blockers: string[];
  /** Locales with no bound cascade voice; empty while all six are bound. */
  openLocales: string[];
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function emptyCapture(role: TwoCaptureRole | "platform", error: string | null): CascadePackCapture {
  return {
    role,
    path: null,
    present: false,
    bytes: null,
    sha256: null,
    format: null,
    error,
    absent: null,
  };
}

/** Read one capture and name what is wrong; never invent a file. */
function readCapture(
  role: TwoCaptureRole,
  path: string | null,
): { capture: CascadePackCapture; reason: string | null } {
  if (!path || path.trim() === "") {
    const reason = `${role} capture missing: no path supplied`;
    return { capture: emptyCapture(role, reason), reason };
  }
  if (!existsSync(path)) {
    const reason = `${role} capture missing: ${path} (no file)`;
    return { capture: { ...emptyCapture(role, reason), path }, reason };
  }
  const size = statSync(path).size;
  if (size === 0) {
    const reason = `${role} capture missing: ${path} (empty file)`;
    return { capture: { ...emptyCapture(role, reason), path, bytes: 0 }, reason };
  }
  try {
    const bytes = readFileSync(path);
    const audio = decodeWav(bytes);
    return {
      capture: {
        role,
        path,
        present: true,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        format: {
          sampleRate: audio.facts.sampleRate,
          channels: audio.facts.channels,
          durationSeconds: Number(audio.facts.durationSeconds.toFixed(3)),
        },
        error: null,
        absent: null,
      },
      reason: null,
    };
  } catch (error) {
    const audioError = error as AudioFactsError;
    const kind = audioError?.name === "AudioFactsError" && audioError.code === "truncated" ? "truncated" : "unreadable";
    const reason = `${role} capture ${kind}: ${path}: ${(error as Error).message}`;
    return { capture: { ...emptyCapture(role, reason), path, bytes: size }, reason };
  }
}

function platformCapture(): CascadePackCapture {
  return {
    role: "platform",
    path: null,
    present: false,
    bytes: null,
    sha256: null,
    format: null,
    error: null,
    absent: CASCADE_PLATFORM_CAPTURE_ABSENCE,
  };
}

function artifactCapture(
  artifact: ScoreboardArtifact | null,
  role: TwoCaptureRole,
): ArtifactCapture {
  if (artifact === null) return null;
  const capture = artifact.captures?.[role];
  if (capture === undefined || capture === null || isArtifactAbsence(capture)) return null;
  return capture;
}

/** The sha256 an artifact claims for a capture leg, or null for a named N/A. */
function claimedSha(capture: ArtifactCapture): string | null {
  if (capture === null || isArtifactAbsence(capture)) return null;
  return capture.sha256;
}

function normalizeTranscript(
  transcript: string | readonly ContentTurn[],
): { transcript: CascadePackTranscript; error: string | null } {
  let turns: ContentTurn[];
  try {
    turns = contentTurns(transcript);
  } catch (error) {
    return {
      transcript: emptyTranscript(),
      error: `transcript invalid: ${(error as Error).message}`,
    };
  }
  if (turns.length === 0) {
    return { transcript: emptyTranscript(), error: "transcript missing: no turns supplied" };
  }
  if (!turns.some((turn) => turn.speaker === "agent")) {
    return {
      transcript: emptyTranscript(),
      error: "transcript missing: no agent turn to judge",
    };
  }
  const agent = turns.filter((turn) => turn.speaker === "agent");
  const caller = turns.filter((turn) => turn.speaker === "caller");
  const text = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
  return {
    transcript: {
      turns,
      sha256: sha256(Buffer.from(text, "utf8")),
      agentTurns: agent.length,
      callerTurns: caller.length,
      agentWords: agent.reduce((sum, turn) => sum + words(turn.text), 0),
      callerWords: caller.reduce((sum, turn) => sum + words(turn.text), 0),
    },
    error: null,
  };
}

function emptyTranscript(): CascadePackTranscript {
  const empty = sha256(Buffer.from("", "utf8"));
  return {
    turns: [],
    sha256: empty,
    agentTurns: 0,
    callerTurns: 0,
    agentWords: 0,
    callerWords: 0,
  };
}

function ballotBlockers(
  ballots: readonly CascadeBallot[],
  deliveredSha: string | null,
): { summary: CascadeBallotSummary; blockers: string[] } {
  const blockers: string[] = [];
  const reviewers: string[] = [];
  const seen = new Map<string, number>();
  const judged: CascadeBallot[] = [];
  const recordingShas = new Set<string>();

  for (const ballot of ballots) {
    const reviewer = ballot.reviewer.trim();
    if (reviewer === "") {
      blockers.push("ballot missing a named reviewer: an unnamed ear is not a ballot");
      continue;
    }
    const prior = seen.get(reviewer) ?? 0;
    seen.set(reviewer, prior + 1);
    if (prior === 0) reviewers.push(reviewer);
    judged.push(ballot);
    recordingShas.add(ballot.recordingSha256);

    if (prior > 0) {
      blockers.push(
        `two independent ballots are required: reviewer "${reviewer}" filed more than one; one ballot per rater`,
      );
    }
    if (!isIsoDate(ballot.reviewedOn)) {
      blockers.push(`ballot ${reviewer}: reviewedOn "${ballot.reviewedOn}" is not a date (YYYY-MM-DD)`);
    }
    if (ballot.reason.trim() === "") {
      blockers.push(`ballot ${reviewer}: a written reason is required on every ballot`);
    }
    if (!/^[0-9a-f]{64}$/.test(ballot.recordingSha256)) {
      blockers.push(
        `ballot ${reviewer}: recordingSha256 "${ballot.recordingSha256}" is not the sha256 of the shared recording`,
      );
    }
    if (deliveredSha !== null && ballot.recordingSha256 !== deliveredSha) {
      blockers.push(
        `ballot ${reviewer} judges a different recording (${ballot.recordingSha256}) than the delivered capture (${deliveredSha}); the ballots must judge one shared recording`,
      );
    }
    for (const axis of BALLOT_AXES) {
      const score = ballot.scores[axis];
      if (!Number.isInteger(score) || score < BALLOT_SCALE_MIN || score > BALLOT_SCALE_MAX) {
        blockers.push(
          `ballot ${reviewer}: ${axis} score must be an int ${BALLOT_SCALE_MIN}-${BALLOT_SCALE_MAX}, got ${String(score)}`,
        );
        continue;
      }
      if (score < BALLOT_REASON_REQUIRED_BELOW && (ballot.axisReasons?.[axis] ?? "").trim() === "") {
        blockers.push(
          `ballot ${reviewer}: a ${axis} score of ${score} needs the rater's written reason`,
        );
      }
    }
  }

  if (reviewers.length < CASCADE_REAUDITION_BALLOT_COUNT) {
    blockers.push(
      `two independent ballots are required on one shared recording; ${reviewers.length} recorded`,
    );
  }
  if (recordingShas.size > 1) {
    blockers.push(
      "ballots judged more than one recording; two independent ballots must judge the one shared delivered capture",
    );
  }

  // One recording means exactly one hash across every filed ballot. More than
  // one hash means the ears judged different audio, which is a blocker.
  const sharedRecordingSha256 =
    recordingShas.size === 1 ? ([...recordingShas][0] ?? null) : null;
  const complete =
    reviewers.length === CASCADE_REAUDITION_BALLOT_COUNT &&
    blockers.length === 0 &&
    sharedRecordingSha256 !== null &&
    sharedRecordingSha256 === deliveredSha;

  return {
    summary: {
      required: CASCADE_REAUDITION_BALLOT_COUNT,
      recorded: reviewers.length,
      complete,
      reviewers,
      sharedRecordingSha256,
      judged,
    },
    blockers,
  };
}

function openReasonFor(voice: string): string | null {
  return UNBOUND_VOICES[voice]?.reason ?? null;
}

/**
 * Assemble one subject's W2 pack. Pure apart from reading the capture bytes:
 * every refusal is a named blocker, and a missing input never becomes a
 * placeholder or a pass.
 */
export function assembleCascadeReauditionPack(
  input: CascadeReauditionRequest,
): CascadeReauditionPack {
  const now = input.now?.() ?? new Date();
  const blockers: string[] = [];
  const subject = input.subject;

  // The subject must be a cascade browser subject with a binding. German is
  // bound to jorg and measured like every other voice; the retired id is
  // refused by name and never measured through another voice.
  const demoVoice = subject.agent.kind === "demo" ? subject.agent.voice : null;
  try {
    const binding = demoVoice === null ? null : bindCascadeVoice(demoVoice);
    if (binding === null) {
      if (!(input.allowTenantSubject === true && subject.agent.kind === "tenant")) {
        blockers.push("subject is not a demo voice; the W2 pack is for a demo cascade subject");
      }
    } else {
      if (binding.locale !== subject.locale) {
        blockers.push(
          `subject locale mismatch: voice "${demoVoice}" speaks ${binding.locale}, not ${subject.locale}`,
        );
      }
    }
  } catch (error) {
    blockers.push((error as Error).message);
  }
  if ((subject.pipeline ?? "managed") !== "cascade") {
    blockers.push(
      "subject pipeline is not cascade: a managed-path verdict does not carry over; a new cascade artifact and verdict are required",
    );
  }
  if (subject.transport !== "browser") {
    blockers.push(
      `subject transport is ${subject.transport}: the cascade has no delivered-audio instrument on the phone path`,
    );
  }

  // The subject's own artifact, read through the one reader. The declared
  // pipeline is inspected before parsing so a managed artifact is refused for
  // the right reason even when its shape is also incomplete.
  const declaredPipeline =
    input.artifact !== null &&
    typeof input.artifact === "object" &&
    !Array.isArray(input.artifact) &&
    ((input.artifact as Record<string, unknown>).pipeline === "managed" ||
      (input.artifact as Record<string, unknown>).pipeline === "cascade")
      ? ((input.artifact as Record<string, unknown>).pipeline as "managed" | "cascade")
      : null;
  if (declaredPipeline === "managed") {
    blockers.push(
      "managed artifact cannot stand in for a cascade artifact; the managed-path verdict does not carry over, so a new cascade artifact and verdict are required",
    );
  }
  let artifact: ScoreboardArtifact | null = null;
  let artifactPipeline: "cascade" | "managed" | null = null;
  let artifactClaimsPlatform = false;
  try {
    artifact = parseScoreboardArtifact(input.artifact, input.artifactPath);
    artifactPipeline = pipelineOfArtifact(artifact, input.artifactPath);
  } catch (error) {
    artifactPipeline = declaredPipeline;
    blockers.push(
      error instanceof ArtifactReadError
        ? `artifact unreadable: ${error.message}`
        : `artifact unreadable: ${(error as Error).message}`,
    );
  }

  const artifactEvents = artifact?.events?.map((event) => event.type) ?? [];
  let artifactClean = false;
  if (artifact !== null) {
    if (artifactPipeline !== "cascade" && declaredPipeline !== "managed") {
      blockers.push(
        `managed artifact cannot stand in for a cascade artifact (pipeline ${artifactPipeline ?? "managed"}); the managed-path verdict does not carry over`,
      );
    }
    const artifactSubject = subjectOfArtifact(artifact);
    if (!sameSubject(artifactSubject, subject)) {
      blockers.push(
        `artifact subject does not match this pack's subject: artifact is ${artifactSubject.agent.kind === "demo" ? artifactSubject.agent.voice : artifactSubject.agent.agentId} (${artifactSubject.locale}, ${artifactSubject.transport}), pack is ${subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId} (${subject.locale}, ${subject.transport})`,
      );
    }
    const platform = artifact.captures?.platform;
    const platformPresent = platform !== undefined && platform !== null && !isArtifactAbsence(platform);
    artifactClaimsPlatform = platformPresent;
    if (platformPresent) {
      blockers.push("artifact claims a platform capture; the cascade carries reference and delivered only");
    }
    if (!artifact.eligibility) {
      blockers.push("artifact has no eligibility verdict; a clean run records whether it is eligible");
    } else if (artifact.eligibility.eligible !== true) {
      const reasons = artifact.eligibility.reasons?.join("; ") ?? "no reason recorded";
      blockers.push(`artifact is ineligible: ${reasons}`);
    }
    const ineligible = artifactEvents.find(isIneligibleEvent);
    if (ineligible !== undefined) {
      blockers.push(
        `artifact carries ${ineligible}; a fallback or budget stop makes the run ineligible, so it cannot be a W2 pack`,
      );
    }
    artifactClean =
      artifactPipeline === "cascade" &&
      sameSubject(artifactSubject, subject) &&
      !platformPresent &&
      artifact.eligibility?.eligible === true &&
      ineligible === undefined;
  }

  const reference = readCapture("reference", input.reference);
  const delivered = readCapture("delivered", input.delivered);
  for (const capture of [reference, delivered]) {
    if (capture.reason !== null) blockers.push(capture.reason);
  }

  // The artifact's capture entries must describe the files the pack measured.
  if (artifact !== null && reference.capture.present && delivered.capture.present) {
    for (const [role, capture] of [
      ["reference", reference.capture],
      ["delivered", delivered.capture],
    ] as const) {
      const claimed = artifactCapture(artifact, role);
      const expected = claimedSha(claimed);
      if (expected === null) {
        blockers.push(
          `artifact carries no ${role} capture; a cascade artifact records {reference, delivered}`,
        );
        continue;
      }
      if (expected !== capture.sha256) {
        blockers.push(
          `${role} capture hash mismatch: artifact says ${expected}, file is ${capture.sha256}; a misdescribed capture cannot be judged`,
        );
      }
    }
  }

  const { transcript, error: transcriptError } = normalizeTranscript(input.transcript);
  if (transcriptError !== null) blockers.push(transcriptError);

  const slots: Record<TwoCaptureRole, TwoCaptureSlot | null> = {
    reference: reference.capture.present
      ? {
          path: reference.capture.path!,
          audio: decodeWav(readFileSync(reference.capture.path!)),
        }
      : null,
    delivered: delivered.capture.present
      ? {
          path: delivered.capture.path!,
          audio: decodeWav(readFileSync(delivered.capture.path!)),
        }
      : null,
  };

  // A different line is unresolved: the transcript's first agent turn is the
  // line the call actually spoke, and it must be the line the reference renders.
  const firstAgentTurn = transcript.turns.find((turn) => turn.speaker === "agent");
  const comparison = compareReferenceAndDelivered({
    reference: slots.reference,
    delivered: slots.delivered,
    line: input.line,
    ...(firstAgentTurn ? { spokenLine: firstAgentTurn.text } : {}),
  });
  if (comparison.status !== "measured") {
    for (const reason of comparison.unresolvedReasons) {
      blockers.push(`comparison unresolved: ${reason}`);
    }
  }

  const ballots = ballotBlockers(input.ballots, delivered.capture.sha256);
  blockers.push(...ballots.blockers);

  const verdictInputs: CascadeVerdictInputs = {
    ready: blockers.length === 0,
    rule: {
      accept:
        "accept means the content did not hold up, so the per-locale rendering layer is justified (ADR 0008's meaning is not flipped)",
      withdraw:
        "withdraw means the content held up, so the per-locale rendering layer is not justified to fix quality",
      unresolved:
        "unresolved means the pack cannot decide; a missing capture or ballot blocks, and it is never a pass",
    },
    inputs: {
      artifactClean,
      artifactPipeline,
      referencePresent: reference.capture.present,
      deliveredPresent: delivered.capture.present,
      transcriptPresent: transcriptError === null,
      comparisonMeasured: comparison.status === "measured",
      ballotsComplete: ballots.summary.complete,
      sharedRecording:
        delivered.capture.sha256 !== null &&
        ballots.summary.sharedRecordingSha256 === delivered.capture.sha256,
      noPlatformLeg: !artifactClaimsPlatform,
    },
    blockers,
  };

  const ready = blockers.length === 0;
  const verdict: CascadeReauditionVerdict = {
    decision: "unresolved",
    justifiesRenderingLayer: null,
    readyForOwner: ready,
    ownerVerdictRequired: true,
    basis: ready
      ? [
          `subject: ${subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId} (${subject.locale}, ${subject.transport}, cascade)`,
          `artifact: ${input.artifactPath}`,
          `comparison: ${comparison.status}; no platform leg on the cascade`,
          `ballots: ${ballots.summary.reviewers.join(", ")} on one shared recording (${ballots.summary.sharedRecordingSha256})`,
          "the owner's accept/withdraw is a separate recorded statement (ticket 134)",
        ]
      : blockers,
    decidedAt: dateOnly(now),
  };

  return {
    schemaVersion: CASCADE_REAUDITION_SCHEMA_VERSION,
    kind: CASCADE_REAUDITION_KIND,
    status: ready ? "complete" : "incomplete",
    recordedAt: now.toISOString(),
    subject: {
      voice: subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId,
      locale: subject.locale,
      transport: subject.transport,
      agentKind: subject.agent.kind,
      pipeline: subject.pipeline === "cascade" ? "cascade" : null,
    },
    artifact: {
      path: input.artifactPath,
      runId: artifact?.runId ?? null,
      pipeline: artifactPipeline,
      eligible: artifact?.eligibility?.eligible ?? null,
      captures: {
        reference: claimedSha(artifactCapture(artifact, "reference")),
        delivered: claimedSha(artifactCapture(artifact, "delivered")),
      },
    },
    captures: {
      reference: reference.capture,
      delivered: delivered.capture,
      platform: platformCapture(),
    },
    transcript,
    comparison: {
      status: comparison.status,
      unresolvedReasons: comparison.unresolvedReasons,
      table: formatTwoCaptureTable(comparison),
      captures: comparison.captures,
      alignment: comparison.alignment,
      octaveBandsHz: comparison.octaveBandsHz,
      tilt: comparison.tilt,
    },
    ballots: ballots.summary,
    verdictInputs,
    verdict,
    blockers,
  };
}

/**
 * The six-subject roster. German is the bound `jorg`, listed like every other
 * subject, never hidden and never replaced by a fabricated clip. A subject with
 * no pack is `missing`, not omitted; one failed subject keeps the roster from
 * ready.
 */
export function cascadeReauditionRoster(
  packs: readonly CascadeReauditionPack[],
): CascadeReauditionRoster {
  const subjects: CascadeReauditionRosterRow[] = DEMO_VOICE_IDS.map((voice) => {
    const pack = packs.find((candidate) => candidate.subject.voice === voice) ?? null;
    const openReason = openReasonFor(voice);
    const locale = openReason !== null ? (UNBOUND_VOICES[voice]?.locale ?? "unknown") : pack?.subject.locale ?? localeForVoice(voice);
    if (openReason !== null && pack === null) {
      return {
        voice,
        locale,
        status: "open",
        openReason,
        packStatus: null,
        ballots: 0,
      };
    }
    if (pack === null) {
      return {
        voice,
        locale,
        status: "missing",
        openReason: "no pack supplied: the subject has no W2 re-audition pack",
        packStatus: null,
        ballots: 0,
      };
    }
    return {
      voice,
      locale,
      status: pack.status,
      openReason: pack.status === "complete" ? null : pack.blockers.join("; "),
      packStatus: pack.status,
      ballots: pack.ballots.recorded,
    };
  });

  const blockers = subjects
    .filter((row) => row.status !== "complete")
    .map(
      (row) =>
        `${row.voice} (${row.locale}): ${row.status}${row.openReason ? ` — ${row.openReason}` : ""}`,
    );
  return {
    subjects,
    ready: blockers.length === 0,
    blockers,
    openLocales: [
      ...new Set(
        subjects.filter((row) => row.status === "open").map((row) => row.locale),
      ),
    ],
  };
}

function localeForVoice(voice: string): string {
  const open = UNBOUND_VOICES[voice];
  if (open !== undefined) return open.locale;
  // The registry is the one authority for a bound voice's Locale.
  try {
    return bindCascadeVoice(voice).locale;
  } catch {
    return "unknown";
  }
}
