/**
 * The W2 cascade owner verdict (meta-cascade M16, ticket 134).
 *
 * The pack (ticket 133) assembles the inputs and never decides. This module
 * records the owner's statement and nothing else: one named human, one named
 * delivered capture, one date and written reasons, separate from the two
 * ballots. ADR 0008's meanings are fixed here, not supplied by the caller —
 * `accept` means the content did not hold up (the per-locale rendering layer is
 * justified), `withdraw` means it held up (the layer is not justified to fix
 * quality), and `unresolved` means the pack cannot decide, which blocks the
 * Locale and is never a pass.
 *
 * The recorder never fabricates evidence: an incomplete pack, a missing
 * ballot, an unnamed human or a capture that is not the pack's delivered
 * recording is a named error, not a downgraded verdict.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { replaceAdrSection } from "./adr-section";
import { isIsoDate } from "./reviewer-pack";
import type { CascadeReauditionPack } from "./cascade-reaudition";

export const CASCADE_VERDICT_SCHEMA_VERSION = 1;
export const CASCADE_VERDICT_KIND = "cascade-owner-verdict";

/** The ADR 0008 section this record owns; the managed W2 gate has its own. */
export const CASCADE_VERDICT_MARKER = "## W2 cascade re-audition (owner verdict)";

export type CascadeOwnerDecision = "accept" | "withdraw" | "unresolved";

export const CASCADE_OWNER_DECISIONS: readonly CascadeOwnerDecision[] = [
  "accept",
  "withdraw",
  "unresolved",
];

/** ADR 0008's meanings, in one place: the caller never supplies them. */
const MEANINGS: Record<
  CascadeOwnerDecision,
  { justifiesRenderingLayer: boolean | null; blocksLocale: boolean }
> = {
  accept: { justifiesRenderingLayer: true, blocksLocale: false },
  withdraw: { justifiesRenderingLayer: false, blocksLocale: false },
  unresolved: { justifiesRenderingLayer: null, blocksLocale: true },
};

export type CascadeOwnerVerdictInput = {
  /** The owner's decision; its meaning is ADR 0008's, never re-defined here. */
  decision: CascadeOwnerDecision;
  /** ISO `YYYY-MM-DD`: the day the owner listened and decided. */
  decidedOn: string;
  /** The named human whose ear made the verdict. An unnamed check is not one. */
  reviewer: string;
  /**
   * The named delivered capture the verdict rests on, with its sha256. Null is
   * only acceptable for `unresolved` on a pack that never produced a capture.
   */
  capture: { path: string | null; sha256: string };
  /** Written reasons. At least one non-blank reason is required. */
  reasons: readonly string[];
};

export type CascadeOwnerVerdict = {
  schemaVersion: typeof CASCADE_VERDICT_SCHEMA_VERSION;
  kind: typeof CASCADE_VERDICT_KIND;
  decision: CascadeOwnerDecision;
  /** Derived from the decision, never supplied: true for accept, false for withdraw. */
  justifiesRenderingLayer: boolean | null;
  /** One sentence stating what the verdict means for the Locale. */
  sentence: string;
  reviewer: string;
  decidedOn: string;
  reasons: string[];
  capture: { path: string | null; sha256: string };
  subject: { voice: string; locale: string; transport: string };
  pack: { path: string; status: CascadeReauditionPack["status"]; readyForOwner: boolean };
  /** The artifact the verdict rests on (M16 names it explicitly). */
  artifact: { path: string; runId: string | null; eligible: boolean | null };
  /** The two ballots are carried for the record; they are not the verdict. */
  ballots: {
    required: number;
    recorded: number;
    reviewers: string[];
    sharedRecordingSha256: string | null;
  };
  /** An unresolved verdict blocks the Locale; it is not a pass. */
  blocksLocale: boolean;
  /** The pack's own blockers, carried so an unresolved verdict names its gap. */
  packBlockers: string[];
  recordedAt: string;
};

/** Fail closed: a bad or premature verdict is a named error, never a record. */
export class CascadeVerdictError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(
      blockers.length === 1
        ? blockers[0]
        : `owner verdict refused: ${blockers.join("; ")}`,
    );
    this.name = "CascadeVerdictError";
    this.blockers = blockers;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Record the owner's verdict on a pack. `accept`/`withdraw` require a complete
 * pack with two ballots; `unresolved` is recordable on an incomplete pack and
 * blocks the Locale, because the pack could not decide.
 */
export function recordCascadeOwnerVerdict(
  pack: CascadeReauditionPack,
  input: CascadeOwnerVerdictInput,
  packPath: string,
  now: () => Date = () => new Date(),
): CascadeOwnerVerdict {
  const blockers: string[] = [];
  const meaning = MEANINGS[input.decision];
  const decides = input.decision === "accept" || input.decision === "withdraw";
  const packComplete = pack.status === "complete" && pack.verdict.readyForOwner;

  if (meaning === undefined) {
    throw new CascadeVerdictError([
      `decision "${String(input.decision)}" is not one of accept, withdraw, unresolved`,
    ]);
  }

  const reviewer = input.reviewer.trim();
  if (reviewer === "") {
    blockers.push(
      "an unnamed manual check is not a verdict: name the human whose ear made it",
    );
  }

  const capturePath = input.capture.path?.trim() ?? "";
  const captureSha = input.capture.sha256.trim();
  const deliveredSha = pack.captures.delivered.sha256;

  // A verdict on a pack that produced a capture must name that capture. Only
  // the absence of a capture is a reason to record unresolved without one.
  const captureRequired = decides || packComplete;
  if (capturePath === "" && captureRequired) {
    blockers.push(
      decides
        ? "an unnamed capture is not a verdict: name the delivered capture the verdict rests on"
        : "an unresolved verdict on a complete pack still names the capture that could not decide; an unnamed check is not a verdict",
    );
  }

  if (deliveredSha === null) {
    if (decides) {
      blockers.push(
        "the pack carries no delivered capture, so there is no recording to judge; record unresolved instead",
      );
    }
  } else {
    if (captureSha === "" && capturePath !== "") {
      blockers.push("the verdict's delivered capture needs its sha256, not a path alone");
    } else if (captureSha !== "" && captureSha !== deliveredSha) {
      blockers.push(
        `the verdict names a different recording (${captureSha}) than the pack's delivered capture (${deliveredSha}); a verdict must judge the pack's delivered audio`,
      );
    }
    // The pack is hand-readable JSON; make its own hash agree with the file it
    // names, so a misdescribed pack cannot stand in for the recording.
    const deliveredPath = pack.captures.delivered.path;
    if (deliveredPath !== null && existsSync(deliveredPath)) {
      const onDisk = sha256File(deliveredPath);
      if (onDisk !== deliveredSha) {
        blockers.push(
          `the pack's delivered capture (${deliveredPath}) hashes to ${onDisk}, not the recorded ${deliveredSha}; the pack is misdescribed`,
        );
      }
    }
  }

  if (!isIsoDate(input.decidedOn)) {
    blockers.push(`decidedOn "${input.decidedOn}" is not a date (YYYY-MM-DD)`);
  } else if (input.decidedOn > now().toISOString().slice(0, 10)) {
    blockers.push(
      `decidedOn "${input.decidedOn}" is in the future; a verdict cannot precede the listening`,
    );
  }

  const reasons = input.reasons.map((reason) => reason.trim()).filter((reason) => reason !== "");
  if (reasons.length === 0) {
    blockers.push("a verdict needs at least one written reason, not only a decision");
  }

  if (decides && !packComplete) {
    const packBlockers =
      pack.blockers.length > 0
        ? pack.blockers
        : ["no blocker was recorded, but the pack is not complete"];
    blockers.push(
      ...packBlockers.map((blocker) => `${blocker} — a missing capture or ballot is not a pass`),
    );
    blockers.push(
      "an incomplete pack cannot accept or withdraw; record unresolved, which blocks the Locale",
    );
  }

  if (blockers.length > 0) throw new CascadeVerdictError(blockers);

  const subject = `${pack.subject.voice} (${pack.subject.locale})`;
  const sentence =
    input.decision === "accept"
      ? `Content did not hold up for ${subject} on the cascade, so the per-locale rendering layer is justified to fix quality.`
      : input.decision === "withdraw"
        ? `Content held up for ${subject} on the cascade, so the per-locale rendering layer is not justified to fix quality.`
        : `The pack cannot decide for ${subject}; unresolved blocks the Locale and is not a pass.`;

  return {
    schemaVersion: CASCADE_VERDICT_SCHEMA_VERSION,
    kind: CASCADE_VERDICT_KIND,
    decision: input.decision,
    justifiesRenderingLayer: meaning.justifiesRenderingLayer,
    sentence,
    reviewer,
    decidedOn: input.decidedOn,
    reasons,
    capture: { path: capturePath === "" ? null : capturePath, sha256: captureSha },
    subject: {
      voice: pack.subject.voice,
      locale: pack.subject.locale,
      transport: pack.subject.transport,
    },
    pack: {
      path: packPath,
      status: pack.status,
      readyForOwner: pack.verdict.readyForOwner,
    },
    artifact: {
      path: pack.artifact.path,
      runId: pack.artifact.runId,
      eligible: pack.artifact.eligible,
    },
    ballots: {
      required: pack.ballots.required,
      recorded: pack.ballots.recorded,
      reviewers: [...pack.ballots.reviewers],
      sharedRecordingSha256: pack.ballots.sharedRecordingSha256,
    },
    blocksLocale: meaning.blocksLocale,
    packBlockers: [...pack.blockers],
    recordedAt: now().toISOString(),
  };
}

/** The ADR 0008 section this verdict owns, in the record's own words. */
export function formatCascadeVerdictSection(record: CascadeOwnerVerdict): string {
  const reviewed =
    record.ballots.recorded === 0
      ? "no ballots recorded"
      : `${record.ballots.recorded} recorded (${record.ballots.reviewers.join(", ")})`;
  const shared =
    record.ballots.sharedRecordingSha256 === null
      ? "no shared recording"
      : `one shared recording (${record.ballots.sharedRecordingSha256})`;
  const localeEffect = record.blocksLocale
    ? `blocks the \`${record.subject.locale}\` Locale; an unresolved pack is not a pass`
    : `none; the \`${record.subject.locale}\` Locale is not blocked by this verdict`;
  const capture =
    record.capture.path === null
      ? `no named capture (sha256 \`${record.capture.sha256 || "unrecorded"}\`)`
      : `\`${record.capture.path}\` (sha256 \`${record.capture.sha256}\`)`;
  const status =
    record.decision === "withdraw"
      ? "- Status: this record changes no ADR status. A withdraw contradicts the managed W2 accept above; whether ADR 0008 is withdrawn is a separate owner decision, not this recorder's."
      : "- Status: this record changes no ADR status.";

  const lines = [
    CASCADE_VERDICT_MARKER,
    "",
    `**Verdict: ${record.decision}** — ${record.decidedOn}. ${record.sentence}`,
    "",
    `- Reviewer: \`${record.reviewer}\` — the owner's ear; this statement is separate from the ballots.`,
    `- Subject: \`${record.subject.voice}\` (\`${record.subject.locale}\`), ${record.subject.transport}, cascade.`,
    `- Pack: \`${record.pack.path}\` (${record.pack.status}; ready for the owner: ${record.pack.readyForOwner}).`,
    `- Artifact: \`${record.artifact.path}\`${record.artifact.runId === null ? "" : ` (run \`${record.artifact.runId}\`)`}${record.artifact.eligible === null ? "" : `, eligible: ${record.artifact.eligible}`}.`,
    `- Delivered capture: ${capture}.`,
    `- Ballots: ${reviewed} on ${shared}; they judge the audio, not this verdict.`,
    `- Reasons: ${record.reasons.join(" ")}`,
  ];
  if (record.packBlockers.length > 0) {
    lines.push(`- Pack blockers: ${record.packBlockers.join("; ")}.`);
  }
  lines.push(`- Locale effect: ${localeEffect}.`, status);
  return `${lines.join("\n")}\n`;
}

/**
 * Write the cascade verdict section into the decision record, replacing an
 * earlier cascade section only. The managed W2 gate section and the document's
 * status line belong to other gates and are left exactly as they are.
 */
export function applyCascadeVerdictToAdr(
  markdown: string,
  record: CascadeOwnerVerdict,
): string {
  return replaceAdrSection(markdown, CASCADE_VERDICT_MARKER, formatCascadeVerdictSection(record));
}
