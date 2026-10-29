/**
 * The W2 re-audition pack (voice-parity ticket 41).
 *
 * One real non-English call becomes one evidence pack: the three capture
 * files, the platform transcript, the deterministic counters and the
 * target-language content judgement. A single rule turns that evidence into a
 * verdict on the locale-rendering decision (ADR 0008):
 *
 * - `accept`   — the content did not hold up; the per-locale rendering layer is
 *               justified, so the decision stands.
 * - `withdraw` — the content held up; the rendering layer is not justified to
 *               fix quality, so the decision is withdrawn.
 * - `unresolved` — the pack is incomplete or no content judgement exists. A
 *               missing capture is never a pass, and no synthetic or partial
 *               pack can produce accept/withdraw.
 *
 * The pack is a working artifact (`voni/reaudition-runs/`, gitignored) because
 * it carries call audio and a visitor's words. The automated verdict is
 * written into the decision record; the judge remains a machine (ceiling 4),
 * so a named native reviewer still owns the five-out-of-five sign-off.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { CAPTURE_ROLES, type CaptureRole } from "../audio/comparison";
import { decodeAudioFile } from "../audio/format-facts";
import {
  countEnglishLeak,
  type AgentTurn,
  type EnglishLeakCount,
} from "./english-leak";
import {
  contentTurns,
  type ContentBaseline,
  type ContentJudgement,
  type ContentTurn,
} from "../voice/content-judge";

export const REAUDITION_SCHEMA_VERSION = 1;
export const REAUDITION_KIND = "voice-reaudition-pack";
export const REAUDITION_GATE_MARKER = "## Re-audition (W2 gate)";

export type ReauditionDecision = "accept" | "withdraw" | "unresolved";
export type ReauditionStatus = "complete" | "incomplete" | "pending-live-call";

export type ReauditionRequest = {
  /** Demo voice id, e.g. `lola`. */
  voice: string;
  /** Target Locale, e.g. `es`. */
  locale: string;
  /** The English rendering of the same content the judge scores against. */
  baseline: ContentBaseline;
  /** The platform transcript: raw text or ordered turns. */
  transcript: string | readonly ContentTurn[];
  /** The judged content; `null` means it has not been scored. */
  judgement: ContentJudgement | null;
  /** Paths to the three captures. All three are required for a complete pack. */
  captures: Partial<Record<CaptureRole, string>>;
  /** Where `pack.json`, `README.md` and `captures/` are written. */
  outDir: string;
  sessionId?: string | null;
  /** Emit a template for a call that has not happened yet. */
  pending?: boolean;
  /** Repo root for relative evidence paths in the decision record. */
  root?: string;
  /** Clock seam; tests pin the date. */
  now?: () => Date;
};

export type MissingCapture = {
  role: CaptureRole;
  path: string | null;
  /** Names the role, the path and the reason. */
  error: string;
};

export type ReauditionCapture = {
  role: CaptureRole;
  /** The source the pack was assembled from. */
  path: string | null;
  present: boolean;
  bytes: number | null;
  sha256: string | null;
  format: {
    sampleRate: number;
    channels: number;
    durationSeconds: number;
  } | null;
  /** The self-contained copy inside the pack, when the pack is complete. */
  file: string | null;
  error: string | null;
};

export type ReauditionCounters = {
  agentTurns: number;
  callerTurns: number;
  agentWords: number;
  callerWords: number;
  /** Machine scores; `null` until the content is judged. */
  naturalness: number | null;
  codeSwitching: number | null;
  englishLeaks: number | null;
  englishLeakWords: number | null;
  /** The leaked text exactly as the judge quoted it. */
  leakTexts: string[];
  /**
   * Ticket 76's deterministic counter, beside the judge's reading. It is
   * report-only and never moves the verdict.
   */
  englishLeakCounter: EnglishLeakCount;
  /**
   * Ticket 77 has not landed. The gap is named, never recorded as a zero that
   * could be mistaken for a clean count.
   */
  answeredQuestions: {
    status: "not-implemented";
    count: null;
    ticket: 77;
    reason: string;
  };
  /** Both counters are report-only until their English false-positive rate is known. */
  gating: "report-only";
};

export type ReauditionVerdict = {
  decision: ReauditionDecision;
  /** `true` only for accept, `false` only for withdraw, `null` for unresolved. */
  justifiesRenderingLayer: boolean | null;
  /** One sentence stating what the evidence supports. */
  sentence: string;
  /** Every fact the decision rests on, including named blockers. */
  basis: string[];
  evidencePaths: string[];
  decidedAt: string;
  /** The judge is never a native reviewer; the five-out-of-five stays open. */
  machineOnly: true;
  nativeReviewRequired: true;
};

export type ReauditionPack = {
  schemaVersion: typeof REAUDITION_SCHEMA_VERSION;
  kind: typeof REAUDITION_KIND;
  status: ReauditionStatus;
  recordedAt: string;
  subject: {
    voice: string;
    locale: string;
    sessionId: string | null;
  };
  baseline: ContentBaseline;
  transcript: {
    turns: ContentTurn[];
    sha256: string;
    agentTurns: number;
    callerTurns: number;
    agentWords: number;
    callerWords: number;
  };
  captures: Record<CaptureRole, ReauditionCapture>;
  counters: ReauditionCounters;
  content: ContentJudgement | null;
  completeness: {
    complete: boolean;
    missing: MissingCapture[];
    /** Every reason the pack cannot decide, including transcript/judgement gaps. */
    blockers: string[];
  };
  verdict: ReauditionVerdict;
  operator: {
    steps: string[];
    commands: string[];
    /** The one command that reproduces this pending pack. */
    reproduce: string;
  } | null;
};

export type ReauditionAssembly = {
  pack: ReauditionPack;
  packDir: string;
  packPath: string;
  readmePath: string;
};

/** Fail closed for callers that require a complete pack before deciding. */
export class ReauditionIncompleteError extends Error {
  readonly blockers: string[];

  constructor(pack: ReauditionPack) {
    const blockers =
      pack.completeness.blockers.length > 0
        ? pack.completeness.blockers
        : ["no blocker was recorded, but the pack is not complete"];
    super(
      `re-audition pack incomplete (${pack.status}): ${blockers.join("; ")}. A missing capture is never a pass.`,
    );
    this.name = "ReauditionIncompleteError";
    this.blockers = blockers;
  }
}

/** Throw unless the pack can produce a decision; never returns a partial pass. */
export function assertReauditionComplete(pack: ReauditionPack): void {
  if (pack.status !== "complete" || pack.verdict.decision === "unresolved") {
    throw new ReauditionIncompleteError(pack);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Repo-relative when the path is inside the root, otherwise absolute. */
export function evidencePath(path: string, root = process.cwd()): string {
  const absolute = resolve(path);
  const rel = relative(resolve(root), absolute);
  return rel && !rel.startsWith("..") ? rel : absolute;
}

function captureError(role: CaptureRole, path: string, reason: string): string {
  return `${role} capture unreadable: ${path}: ${reason}`;
}

function readCapture(
  role: CaptureRole,
  path: string | undefined,
): { capture: ReauditionCapture; missing: MissingCapture | null } {
  if (!path || path.trim().length === 0) {
    return {
      capture: {
        role,
        path: null,
        present: false,
        bytes: null,
        sha256: null,
        format: null,
        file: null,
        error: `${role} capture missing: no path supplied`,
      },
      missing: {
        role,
        path: null,
        error: `${role} capture missing: no path supplied`,
      },
    };
  }

  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    const error = `${role} capture missing: ${absolute} (no file)`;
    return {
      capture: {
        role,
        path: absolute,
        present: false,
        bytes: null,
        sha256: null,
        format: null,
        file: null,
        error,
      },
      missing: { role, path: absolute, error },
    };
  }

  const size = statSync(absolute).size;
  if (size === 0) {
    const error = `${role} capture missing: ${absolute} (empty file)`;
    return {
      capture: {
        role,
        path: absolute,
        present: false,
        bytes: 0,
        sha256: null,
        format: null,
        file: null,
        error,
      },
      missing: { role, path: absolute, error },
    };
  }

  try {
    const bytes = readFileSync(absolute);
    const audio = decodeAudioFile(absolute);
    return {
      capture: {
        role,
        path: absolute,
        present: true,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        format: {
          sampleRate: audio.facts.sampleRate,
          channels: audio.facts.channels,
          durationSeconds: Number(audio.facts.durationSeconds.toFixed(3)),
        },
        file: null,
        error: null,
      },
      missing: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = captureError(role, absolute, reason);
    return {
      capture: {
        role,
        path: absolute,
        present: false,
        bytes: size,
        sha256: null,
        format: null,
        file: null,
        error: message,
      },
      missing: { role, path: absolute, error: message },
    };
  }
}

function emptyCaptures(): Record<CaptureRole, ReauditionCapture> {
  return Object.fromEntries(
    CAPTURE_ROLES.map((role) => [
      role,
      {
        role,
        path: null,
        present: false,
        bytes: null,
        sha256: null,
        format: null,
        file: null,
        error: `${role} capture missing: no path supplied`,
      } satisfies ReauditionCapture,
    ]),
  ) as Record<CaptureRole, ReauditionCapture>;
}

function normalizeTranscript(
  transcript: string | readonly ContentTurn[],
): { turns: ContentTurn[]; error: string | null } {
  try {
    return { turns: contentTurns(transcript), error: null };
  } catch (error) {
    return {
      turns: [],
      error: `transcript invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizeBaseline(baseline: ContentBaseline | undefined): ContentBaseline {
  return {
    locale: baseline?.locale?.trim() ?? "",
    text: baseline?.text?.trim() ?? "",
  };
}

function countersFor(
  turns: ContentTurn[],
  judgement: ContentJudgement | null,
  locale: string,
): ReauditionCounters {
  const agent = turns.filter((turn) => turn.speaker === "agent");
  const caller = turns.filter((turn) => turn.speaker === "caller");
  const leakTexts = judgement?.leaks.map((leak) => leak.text) ?? [];
  const agentTurns: AgentTurn[] = turns.flatMap((turn, index) =>
    turn.speaker === "agent" ? [{ sessionId: null, turn: index, text: turn.text }] : [],
  );
  return {
    agentTurns: agent.length,
    callerTurns: caller.length,
    agentWords: agent.reduce((sum, turn) => sum + words(turn.text), 0),
    callerWords: caller.reduce((sum, turn) => sum + words(turn.text), 0),
    naturalness: judgement?.scores.naturalness ?? null,
    codeSwitching: judgement?.scores.codeSwitching ?? null,
    englishLeaks: judgement ? judgement.leaks.length : null,
    englishLeakWords: judgement
      ? leakTexts.reduce((sum, text) => sum + words(text), 0)
      : null,
    leakTexts,
    englishLeakCounter: countEnglishLeak(agentTurns, locale),
    answeredQuestions: {
      status: "not-implemented",
      count: null,
      ticket: 77,
      reason:
        "the already-answered counter (ticket 77) has not landed; the gap is named rather than recorded as zero",
    },
    gating: "report-only",
  };
}

function contentBlockers(input: {
  judgement: ContentJudgement | null;
  locale: string;
  baseline: ContentBaseline;
}): string[] {
  const blockers: string[] = [];
  const { judgement, locale, baseline } = input;

  if (!locale) blockers.push("locale missing: the target Locale is not stated");
  if (!baseline.locale) blockers.push("baseline missing: the baseline Locale is not stated");
  if (!baseline.text) blockers.push("baseline missing: the baseline text is not stated");
  if (!judgement) {
    blockers.push("content judgement missing: the transcript has not been scored");
    return blockers;
  }
  if (judgement.locale !== locale) {
    blockers.push(
      `content judgement locale mismatch: judged ${judgement.locale}, pack is ${locale || "unstated"}`,
    );
  }
  if (
    judgement.baseline.locale !== baseline.locale ||
    judgement.baseline.text.trim() !== baseline.text
  ) {
    blockers.push("content judgement baseline mismatch: the judgement scored a different baseline");
  }
  return blockers;
}

function verdictFor(input: {
  status: ReauditionStatus;
  locale: string;
  voice: string;
  missing: MissingCapture[];
  blockers: string[];
  judgement: ContentJudgement | null;
  counters: ReauditionCounters;
  evidencePaths: string[];
  now: Date;
}): ReauditionVerdict {
  const { status, locale, voice, missing, blockers, judgement, counters, evidencePaths, now } = input;
  const decidedAt = dateOnly(now);
  const subject = `${voice} (${locale || "locale unstated"})`;

  if (status !== "complete" || missing.length > 0 || blockers.length > 0 || !judgement) {
    const reasons =
      blockers.length > 0
        ? blockers
        : missing.map((entry) => entry.error).concat("no content judgement was recorded");
    const pending = status === "pending-live-call";
    const sentence = pending
      ? `No real non-English call has been assembled for ${subject}: the pack is pending-live-call, so the locale-rendering decision is unresolved. A missing capture makes the pack incomplete, never a pass.`
      : `The pack for ${subject} is incomplete, so the locale-rendering decision is unresolved. A missing capture makes the pack incomplete, never a pass.`;
    return {
      decision: "unresolved",
      justifiesRenderingLayer: null,
      sentence,
      basis: reasons,
      evidencePaths,
      decidedAt,
      machineOnly: true,
      nativeReviewRequired: true,
    };
  }

  const leaks = counters.leakTexts;
  const scoreLine = `machine judge: naturalness ${judgement.scores.naturalness}/${judgement.machineScoreCeiling}, code-switching ${judgement.scores.codeSwitching}/${judgement.machineScoreCeiling}, ${counters.englishLeaks} English leak${counters.englishLeaks === 1 ? "" : "s"}`;
  const basis = [
    `subject: ${subject}`,
    scoreLine,
    ...judgement.reasons.map((reason) => `judge reason: ${reason}`),
    `counters: ${counters.agentTurns} agent turns, ${counters.callerTurns} caller turns, ${counters.agentWords} agent words; report-only`,
    `native review: ${judgement.nativeVerdict}; a named reviewer still owns the five-out-of-five`,
    ...evidencePaths.map((path) => `evidence: ${path}`),
  ];

  if (judgement.flagged) {
    const detail = leaks.length > 0 ? `English leak${leaks.length === 1 ? "" : "s"}: ${leaks.join("; ")}` : "the machine judge scored the content below the no-defect bar";
    return {
      decision: "accept",
      justifiesRenderingLayer: true,
      sentence: `Content did not hold up for ${subject}: ${detail}. The per-locale rendering layer is justified to fix quality, so the locale-rendering decision stands (accept).`,
      basis,
      evidencePaths,
      decidedAt,
      machineOnly: true,
      nativeReviewRequired: true,
    };
  }

  return {
    decision: "withdraw",
    justifiesRenderingLayer: false,
    sentence: `Content held up for ${subject}: the machine judge found no defect (naturalness ${judgement.scores.naturalness}/${judgement.machineScoreCeiling}, code-switching ${judgement.scores.codeSwitching}/${judgement.machineScoreCeiling}, no English leaks). The per-locale rendering layer is not justified to fix quality on this evidence, so the decision is withdrawn (it may still be needed for latency and the English-only guardrails).`,
    basis,
    evidencePaths,
    decidedAt,
    machineOnly: true,
    nativeReviewRequired: true,
  };
}

function operatorFor(input: {
  voice: string;
  locale: string;
  baseline: ContentBaseline;
  outDir: string;
  sessionId?: string | null;
  root?: string;
}): ReauditionPack["operator"] {
  const { voice, locale, baseline, outDir, sessionId, root = process.cwd() } = input;
  // Commands start with `cd voni`, so their paths are relative to voni even
  // though the pack's evidence paths are relative to the repo root.
  const voniDir = resolve(root, "voni");
  const dir = evidencePath(outDir, voniDir);
  const session = sessionId?.trim() ? sessionId.trim() : "sess_<session>";
  const baselineText = baseline.text || "<English baseline>";
  // `../docs/...` is correct from voni; evidencePath would refuse it as
  // outside its root, so the command path is made relative explicitly.
  const adr = relative(voniDir, resolve(root, "docs/adr/0008-english-is-one-rendering-not-the-source.md"));
  const steps = [
    `Start the dev server: cd voni && npm run dev.`,
    `Open http://localhost:3000/?delivercapture=1, choose the ${voice} voice (${locale}), have a real conversation in ${locale}, then hang up. The delivered WAV lands in voni/.captures/.`,
    `Read the session id from the call (or the platform dashboard) and keep the platform recording: npm run qa:voice-session -- --session ${session} --evidence-out ${dir}/platform.json --keep-audio ${dir}/platform.`,
    `Render the reference line in the same voice: npm run voice:reference -- --voice ${voice} --out-dir ${dir}/reference.`,
    `Assemble the pack with the three captures and the transcript: npm run voice:reaudition -- --voice ${voice} --locale ${locale} --baseline-text ${JSON.stringify(baselineText)} --transcript ${dir}/platform.json --reference <the printed reference.wav> --platform <the printed agent channel.wav> --delivered <the printed delivered-*.wav> --session ${session} --out ${dir} --adr ${adr}.`,
  ];
  const commands = [
    `cd voni && npm run dev`,
    `cd voni && npm run voice:reference -- --voice ${voice} --out-dir ${dir}/reference`,
    `cd voni && npm run qa:voice-session -- --session ${session} --evidence-out ${dir}/platform.json --keep-audio ${dir}/platform`,
    `cd voni && npm run voice:reaudition -- --voice ${voice} --locale ${locale} --baseline-text ${JSON.stringify(baselineText)} --transcript ${dir}/platform.json --reference <reference.wav> --platform <agent-channel.wav> --delivered <delivered.wav> --session ${session} --out ${dir} --adr ${adr}`,
  ];
  const reproduce = `cd voni && npm run voice:reaudition -- --voice ${voice} --locale ${locale} --pending --out ${dir}`;
  return { steps, commands, reproduce };
}

function summaryReadme(pack: ReauditionPack): string {
  const captureRows = CAPTURE_ROLES.map((role) => {
    const capture = pack.captures[role];
    return `| ${role} | ${capture.present ? "present" : "missing"} | ${capture.path ?? "—"} | ${capture.sha256 ?? "—"} |`;
  });
  const missing = pack.completeness.missing.map((entry) => `- ${entry.error}`).join("\n");
  const operator = pack.operator
    ? [
        "## Operator commands",
        "",
        "```sh",
        ...pack.operator.commands,
        "```",
        "",
        "### Steps",
        "",
        ...pack.operator.steps.map((step) => `1. ${step}`),
      ].join("\n")
    : "";

  return [
    `# Re-audition pack — ${pack.subject.voice} (${pack.subject.locale})`,
    "",
    `- Status: **${pack.status}**`,
    `- Verdict: **${pack.verdict.decision}** (${pack.verdict.decidedAt})`,
    `- Captures: ${CAPTURE_ROLES.filter((role) => pack.captures[role].present).length}/3`,
    `- Evidence: ${pack.verdict.evidencePaths.join(", ") || "—"}`,
    "",
    `> ${pack.verdict.sentence}`,
    "",
    "## Captures",
    "",
    "| role | state | source | sha256 |",
    "| --- | --- | --- | --- |",
    ...captureRows,
    "",
    ...(missing ? ["## Missing", "", missing, ""] : []),
    "## Transcript",
    "",
    `- Turns: ${pack.transcript.turns.length} (${pack.transcript.agentTurns} agent, ${pack.transcript.callerTurns} caller)`,
    `- Words: ${pack.transcript.agentWords} agent, ${pack.transcript.callerWords} caller`,
    `- sha256: ${pack.transcript.sha256}`,
    "",
    "## Counters (report-only)",
    "",
    `- English leaks (judge): ${pack.counters.englishLeaks ?? "not scored"}`,
    `- English-leak counter (deterministic, report-only): ${pack.counters.englishLeakCounter.status} (${pack.counters.englishLeakCounter.count}/${pack.counters.englishLeakCounter.turns} agent turns)`,
    `- Naturalness: ${pack.counters.naturalness ?? "not scored"} / 4`,
    `- Code-switching: ${pack.counters.codeSwitching ?? "not scored"} / 4`,
    `- Already-answered: ${pack.counters.answeredQuestions.reason}`,
    "",
    "## Content verdict",
    "",
    `- Judge: ${pack.content ? `${pack.content.verdict} (${pack.content.judgeVersion})` : "not run"}`,
    `- Native review: ${pack.content?.nativeVerdict ?? "not-reviewed"}`,
    `- Basis:`,
    ...pack.verdict.basis.map((line) => `  - ${line}`),
    "",
    ...(operator ? [operator, ""] : []),
  ].join("\n");
}

export function assembleReauditionPack(input: ReauditionRequest): ReauditionAssembly {
  const now = input.now?.() ?? new Date();
  const root = input.root ?? process.cwd();
  const locale = input.locale.trim();
  const baseline = normalizeBaseline(input.baseline);
  const { turns, error: transcriptError } = normalizeTranscript(input.transcript);
  const missing: MissingCapture[] = [];
  const captures = emptyCaptures();

  for (const role of CAPTURE_ROLES) {
    const read = readCapture(role, input.captures[role]);
    captures[role] = read.capture;
    if (read.missing) missing.push(read.missing);
  }

  const blockers: string[] = [
    ...missing.map((entry) => entry.error),
    ...(transcriptError ? [transcriptError] : []),
    ...(turns.length === 0 ? ["transcript missing: no turns supplied"] : []),
    ...(turns.length > 0 && !turns.some((turn) => turn.speaker === "agent")
      ? ["transcript missing: no agent turn to score"]
      : []),
    ...contentBlockers({ judgement: input.judgement, locale, baseline }),
  ];

  const complete = missing.length === 0 && blockers.length === 0;
  const pending = input.pending === true;
  const status: ReauditionStatus = pending
    ? "pending-live-call"
    : complete
      ? "complete"
      : "incomplete";

  const packDir = resolve(input.outDir);
  mkdirSync(packDir, { recursive: true });

  if (complete) {
    mkdirSync(join(packDir, "captures"), { recursive: true });
    for (const role of CAPTURE_ROLES) {
      const source = captures[role].path;
      if (!source) continue;
      const target = join(packDir, "captures", `${role}.wav`);
      if (resolve(source) !== resolve(target)) copyFileSync(source, target);
      captures[role].file = target;
    }
  }

  // A judgement for another Locale or baseline is not evidence for this pack.
  // Keep it out of `content` and the counters; the blocker above names why.
  const content =
    input.judgement &&
    input.judgement.locale === locale &&
    input.judgement.baseline.locale === baseline.locale &&
    input.judgement.baseline.text.trim() === baseline.text
      ? input.judgement
      : null;
  const counters = countersFor(turns, content, locale);
  const packPath = join(packDir, "pack.json");
  const readmePath = join(packDir, "README.md");
  const transcriptText = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
  const evidencePaths = [
    packPath,
    ...CAPTURE_ROLES.map((role) => captures[role].file ?? captures[role].path).filter(
      (path): path is string => Boolean(path),
    ),
    ...(transcriptText ? [packPath] : []),
  ]
    .filter((path, index, all) => all.indexOf(path) === index)
    .map((path) => evidencePath(path, root));

  const verdict = verdictFor({
    status,
    locale,
    voice: input.voice,
    missing,
    blockers,
    judgement: content,
    counters,
    evidencePaths,
    now,
  });

  const pack: ReauditionPack = {
    schemaVersion: REAUDITION_SCHEMA_VERSION,
    kind: REAUDITION_KIND,
    status,
    recordedAt: now.toISOString(),
    subject: {
      voice: input.voice,
      locale,
      sessionId: input.sessionId?.trim() || null,
    },
    baseline,
    transcript: {
      turns,
      sha256: sha256(Buffer.from(transcriptText, "utf8")),
      agentTurns: counters.agentTurns,
      callerTurns: counters.callerTurns,
      agentWords: counters.agentWords,
      callerWords: counters.callerWords,
    },
    captures,
    counters,
    content,
    completeness: {
      complete,
      missing,
      blockers,
    },
    verdict,
    operator: complete
      ? null
      : operatorFor({
          voice: input.voice,
          locale,
          baseline,
          outDir: packDir,
          sessionId: input.sessionId,
          root,
        }),
  };

  writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(readmePath, summaryReadme(pack), { mode: 0o600 });
  return { pack, packDir, packPath, readmePath };
}

/** Human summary printed by the CLI; the JSON pack is the machine artifact. */
export function formatReauditionSummary(pack: ReauditionPack): string {
  const present = CAPTURE_ROLES.filter((role) => pack.captures[role].present).length;
  const lines = [
    `Re-audition pack — ${pack.subject.voice} (${pack.subject.locale})`,
    `  Status: ${pack.status}`,
    `  Captures: ${present}/3`,
    `  Verdict: ${pack.verdict.decision} (${pack.verdict.decidedAt})`,
    `  ${pack.verdict.sentence}`,
  ];
  if (pack.completeness.blockers.length > 0) {
    lines.push("  blockers:");
    for (const blocker of pack.completeness.blockers) lines.push(`    - ${blocker}`);
  }
  if (pack.operator) {
    lines.push(`  reproduce: ${pack.operator.reproduce}`);
  }
  return lines.join("\n");
}

export function formatDecisionRecordSection(pack: ReauditionPack): string {
  const captureLines = CAPTURE_ROLES.map((role) => {
    const capture = pack.captures[role];
    const state = capture.present ? "present" : "missing";
    return `${role} ${state} (${capture.file ?? capture.path ?? "no path"})`;
  });
  const content = pack.content
    ? `${pack.content.verdict}: naturalness ${pack.content.scores.naturalness}/${pack.content.machineScoreCeiling}, code-switching ${pack.content.scores.codeSwitching}/${pack.content.machineScoreCeiling}, ${pack.counters.englishLeaks} English leak${pack.counters.englishLeaks === 1 ? "" : "s"}`
    : "not run";
  const verdictLabel = pack.verdict.decision;
  const lines = [
    REAUDITION_GATE_MARKER,
    "",
    `**Verdict: ${verdictLabel}** — ${pack.verdict.decidedAt}. ${pack.verdict.sentence}`,
    "",
    `- Subject: \`${pack.subject.voice}\` (\`${pack.subject.locale}\`), session ${pack.subject.sessionId ? `\`${pack.subject.sessionId}\`` : "unrecorded"}.`,
    `- Pack: \`${pack.verdict.evidencePaths[0] ?? "unrecorded"}\`.`,
    `- Captures: ${captureLines.join("; ")}.`,
    `- Transcript: ${pack.transcript.turns.length} turns (${pack.transcript.agentTurns} agent, ${pack.transcript.callerTurns} caller).`,
    `- Counters (report-only): judge English leaks ${pack.counters.englishLeaks ?? "not scored"}; deterministic English-leak counter ${pack.counters.englishLeakCounter.status} (${pack.counters.englishLeakCounter.count}/${pack.counters.englishLeakCounter.turns} agent turns); already-answered counter ${pack.counters.answeredQuestions.status} (ticket ${pack.counters.answeredQuestions.ticket}).`,
    `- Content judge: ${content}.`,
    `- Basis: ${pack.verdict.basis.join("; ")}.`,
    `- Native review: ${pack.content?.nativeVerdict ?? "not-reviewed"}; the machine judge caps at ${pack.content?.machineScoreCeiling ?? 4}/4, so a named native reviewer still owns the five-out-of-five sign-off.`,
  ];
  if (pack.operator) {
    lines.push(`- Operator: \`${pack.operator.reproduce}\``);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replace the gate section in the decision record, and only change the status
 * when a complete pack produced a decision. An unresolved pack leaves the
 * record `proposed` — the gate is not resolved by a mechanism.
 */
export function applyReauditionToAdr(markdown: string, pack: ReauditionPack): string {
  const markerAt = markdown.indexOf(REAUDITION_GATE_MARKER);
  let withoutSection = markdown;
  if (markerAt >= 0) {
    const after = markdown.slice(markerAt + REAUDITION_GATE_MARKER.length);
    const nextSection = after.search(/^## /m);
    withoutSection = `${markdown.slice(0, markerAt)}${nextSection >= 0 ? after.slice(nextSection) : ""}`;
  }

  const section = formatDecisionRecordSection(pack);
  let next = `${withoutSection.trimEnd()}\n\n${section}`;
  if (pack.verdict.decision === "accept") {
    next = next.replace("**Status: proposed.**", "**Status: accepted.**");
  } else if (pack.verdict.decision === "withdraw") {
    next = next.replace("**Status: proposed.**", "**Status: withdrawn.**");
  }
  return next;
}
