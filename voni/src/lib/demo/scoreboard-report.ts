/**
 * Compact scoreboard inspector (retro #2/#9).
 *
 * `npm run scoreboard:inspect -- --artifact <path> [--session <id>]
 * [--events <path>] [--json]` answers the triage questions without dumping a
 * 30k-line transcript: run identity, scenario verdicts, gates and sub-scores,
 * per-session turn gaps/cuts (heard/resume/aside flags) with each turn's
 * latency split and band, an ordinary vs post-cut summary (median/p95 per wait,
 * `perceived` report-only), the adoption inputs for the turn-window experiment
 * (compact gate tally, fragment risk at caller turn ends, incomplete-clause
 * continuations, interrupted-turn count, end-of-turn labelling) as evidence
 * only, drain/aside/hang-up numbers, playout, and only the last failures.
 * `--json` prints the same structure for a machine.
 *
 * Everything here is pure: the CLI reads files, this module turns an artifact
 * (plus an optional event stream) into a report and formats it. Evidence the
 * artifact does not carry is reported as unknown/absent, never invented:
 * artifacts written before `runnerEvidence` still show their merged Call trace
 * rows via the same turn parser.
 */
import {
  ARTIFACT_LATENCY_GAPS,
  ARTIFACT_LATENCY_LABELS,
  EMAIL_INVITE_TAG,
  isArtifactAbsence,
  percentile,
  judgeSubjectRun,
  subjectOfArtifact,
  type ArtifactLatencyGap,
  type ArtifactPipeline,
  type RunVerdict,
  type RunnerPlayout,
  type ScoreboardArtifact,
} from "./scoreboard";
import { deriveRunEligibility, pipelineOfArtifact } from "./artifact-reader";
import type { SubjectRecord } from "./subject";
import { formatSubject } from "./subject";
import type { EvalEventSummary } from "./eval-events";
import type { LatencyBand } from "./latency-split";
import {
  turnRowsFromTraceExcerpt,
  type RunnerEvidenceAside,
  type RunnerEvidenceHangUp,
  type RunnerEvidenceLatency,
  type RunnerEvidenceScenario,
  type RunnerEvidenceTurn,
} from "./runner-evidence";
import type { DemoAgentVariant, DemoTurnWindows } from "./stored-agents";
import { formatTurnWindows } from "./turn-windows";
import { englishLeakForArtifact, type EnglishLeakCount } from "./english-leak";
import {
  ANSWERED_QUESTION_ENGLISH_FP,
  answeredQuestionForArtifact,
  formatAnswerCategory,
  type AnsweredQuestionCount,
} from "./answered-question";

/**
 * One A/B gap row. Both engines print the same five rows in the same order;
 * the value or the named absence says which engine could produce it, so a
 * cascade and a managed artifact are compared like with like.
 */
export type InspectGapRow = {
  row: ArtifactLatencyGap;
  label: string;
  /** The measured milliseconds, or null when the row is a named N/A. */
  ms: number | null;
  /** Why the row is absent, or null when it was measured. */
  absent: string | null;
};

export type InspectGaps = {
  pipeline: ArtifactPipeline;
  rows: InspectGapRow[];
};

export type InspectRunIdentity = {
  voice: string;
  /** What this run measured: agent, Locale and transport (voice-parity 72). */
  subject: SubjectRecord;
  /** The engine that produced the run; an absent discriminator means managed. */
  pipeline: ArtifactPipeline;
  runId: string;
  recordedAt: string;
  schemaVersion: number;
  code: { head: string; dirty: boolean } | null;
  /** stored | inline | unknown (old artifact without runnerEvidence). */
  transport: string;
  agentId: string | null;
  agentFingerprint: string | null;
  llmModel: string | null;
  /** production | turn-window; null when the artifact predates the experiment. */
  variant: DemoAgentVariant | null;
  /** The variant's row key (`<voice>:exp`), null for production or an old artifact. */
  variantKey: string | null;
  /** The windows the variant body carried, or null when there were none. */
  turnWindows: DemoTurnWindows | null;
};

export type InspectScenario = RunnerEvidenceScenario;
export type InspectTurn = RunnerEvidenceTurn;
export type InspectSession = { id: string; turns: InspectTurn[] };

/** One duration's sample count plus nearest-rank median and p95 (null = no samples). */
export type InspectDurationStats = {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
};

/**
 * One interaction band's split summary. The three measured waits live
 * together; the caller-felt `perceivedMs` is a sibling (report-only) so no
 * reader can mistake it for a measured pipeline duration.
 */
export type InspectLatencyBand = {
  band: LatencyBand;
  /** Turns in this band whose split was measured. */
  count: number;
  measured: {
    endpointing: InspectDurationStats;
    generation: InspectDurationStats;
    delivery: InspectDurationStats;
  };
  /** Report-only: the three waits plus the playout pre-roll; never a gate input. */
  perceived: InspectDurationStats & { reportOnly: true };
};

/** Per-band split summary; both bands are always present, empty means unmeasured. */
export type InspectLatency = {
  bands: InspectLatencyBand[];
};

export type InspectDrain = {
  goodbyeCoverage: number | null;
  hangUpDelayMs: number | null;
  narratedEnding: boolean;
  inboxNamed: boolean | null;
  missingGoodbye: boolean;
};

/**
 * The run's end-of-turn pacing. Absent experiment evidence reads as production
 * (whichever way its gate row went), never as an experiment and never as a
 * verdict.
 */
export type InspectEndOfTurn = {
  mode: "production" | "experimental";
  variant: string | null;
  variantKey: string | null;
  turnWindows: DemoTurnWindows | null;
  /**
   * The production body's served turn setting (null = the Turn preset).
   * Undefined when no served body was read: the report never invents one.
   */
  productionTurnDetection: unknown;
};

/** Compact gate tally; the full rows stay in `gates`, so nothing is hidden. */
export type InspectGateTally = {
  total: number;
  pass: number;
  info: number;
  fail: number;
  failing: string[];
};

export type InspectFragmentKind = "tag" | "email" | "number";

/** One caller turn whose transcript ends inside the tag, the address or a number. */
export type InspectFragmentFinding = {
  kind: InspectFragmentKind;
  sessionId: string | null;
  /** 1-based caller turn in that session's Call trace; null when only the ledger had the words. */
  turn: number | null;
};

export type InspectFragmentRisk = {
  status: "clear" | "risk" | "unmeasured";
  findings: InspectFragmentFinding[];
};

/** One caller turn that stopped mid-clause and the next turn that continued it. */
export type InspectIncompleteFinding = {
  sessionId: string | null;
  turn: number | null;
  nextTurn: number | null;
};

export type InspectIncompleteClause = {
  status: "clear" | "risk" | "unmeasured";
  findings: InspectIncompleteFinding[];
};

/**
 * Adoption inputs, read from the same artifact as the gates. They are evidence
 * for a human to judge: this module never derives a pass/fail/safe verdict from
 * them and never feeds a gate.
 */
export type InspectAdoption = {
  gates: InspectGateTally;
  fragmentRisk: InspectFragmentRisk;
  incompleteClause: InspectIncompleteClause;
  /** Distinct Call-trace turns cut mid-reply; null when the artifact has no turn evidence. */
  interruptedTurns: number | null;
  endOfTurn: InspectEndOfTurn;
};

/**
 * The run's verdict (M13, ticket 116): green only for a clean run whose every
 * required gate PASSes. A contaminated run is `ineligible`, marked for re-run,
 * and never counted toward the kill criterion, whatever its numbers say.
 */
export type InspectVerdict = RunVerdict & {
  readonly eligible: boolean;
  readonly disposition: "counts" | "rerun";
};

export type InspectReport = {
  run: InspectRunIdentity;
  /** The clean-run verdict over this artifact's own facts (never a number). */
  verdict: InspectVerdict;
  scenarios: InspectScenario[];
  gates: { name: string; status: string }[];
  subScores: { name: string; status: string }[];
  sessions: InspectSession[];
  latency: InspectLatency;
  /** The A/B gap rows (M13): five rows, identical shape on both engines. */
  gaps: InspectGaps;
  adoption: InspectAdoption;
  /**
   * The report-only English-leak counter (voice-parity 76): agent turns that
   * leaked English words in a non-English call, their rate, and — on English —
   * the measured false-positive baseline. Evidence only: no gate reads it.
   */
  englishLeak: EnglishLeakCount;
  /**
   * The report-only already-answered counter (voice-parity 77): agent turns
   * that asked for a value the caller had already supplied, their rate, and —
   * on English — the run's own flagged-request baseline beside the measured
   * English false-positive rate. Evidence only: no gate reads it.
   */
  answeredQuestion: AnsweredQuestionCount;
  drain: InspectDrain;
  overTalkAside: RunnerEvidenceAside | null;
  hangUps: RunnerEvidenceHangUp[];
  playout: RunnerPlayout[];
  failures: string[];
  /** Present only with `--events <path>`. */
  events?: EvalEventSummary;
};

function agentFromTrace(artifact: ScoreboardArtifact): string | null {
  const lines = [
    ...(artifact.callTrace?.excerpt ?? []),
    ...(artifact.callTrace?.sessions ?? []).flatMap((session) => session.excerpt),
  ];
  for (const line of lines) {
    const match = /agent=([^ ]+)/.exec(line);
    if (!match) continue;
    if (match[1] !== "inline") return match[1];
  }
  return null;
}

function traceAsAside(artifact: ScoreboardArtifact): RunnerEvidenceAside | null {
  const aside = artifact.overheard.asides[0];
  if (!aside) return null;
  const session = /(sess_[A-Za-z0-9_-]+)/.exec(aside.tracePointer)?.[1] ?? null;
  const turn = /call trace turn (\d+)/.exec(aside.tracePointer)?.[1];
  return {
    sessionId: session ?? "unknown",
    scenario: aside.beat,
    startMs: null,
    endMs: null,
    cutMs: null,
    replyId: null,
    traceTurn: turn ? Number(turn) : null,
    markedOverheard: aside.markedOverheard,
    inLedger: aside.inLedger,
    handling: aside.handling,
  };
}

function hangUpsFromTranscript(artifact: ScoreboardArtifact): RunnerEvidenceHangUp[] {
  const text = artifact.transcripts.redacted.join("\n");
  const rows: RunnerEvidenceHangUp[] = [];
  for (const match of text.matchAll(
    /hung up (-?\d+(?:\.\d+)?)ms after the goodbye finished playing(?: \(session (\S+)\))?/g,
  )) {
    rows.push({
      sessionId: match[2] ?? null,
      delayMs: Math.round(Number(match[1])),
      coverage: null,
      inboxNamed: null,
      narratedEnding: null,
      goodbyeTurn: null,
      scenario: null,
    });
  }
  return rows;
}

function failureLines(artifact: ScoreboardArtifact): string[] {
  const lines: string[] = [];
  for (const gate of artifact.gates.filter((row) => row.status === "FAIL")) {
    lines.push(`FAIL ${gate.name}: ${gate.detail}`);
  }
  const scenarioFailures = artifact.transcripts.redacted
    .filter((line) => line.trimStart().startsWith("✗"))
    .map((line) => line.trim());
  lines.push(...scenarioFailures.slice(-3));
  return lines.slice(-5);
}

const MEASURED_LATENCY_FIELDS = [
  "endpointingMs",
  "generationMs",
  "deliveryMs",
  "perceivedMs",
] as const;

/**
 * A split counts only when every duration arrived and the band is known.
 * Artifacts written before the split have no field; a truncated or malformed
 * one is treated the same way, never as a zero-filled sample.
 */
function isMeasuredLatency(value: RunnerEvidenceLatency | undefined): value is RunnerEvidenceLatency {
  if (!value || typeof value !== "object") return false;
  if (value.band !== "ordinary" && value.band !== "post-cut") return false;
  return MEASURED_LATENCY_FIELDS.every(
    (field) => typeof value[field] === "number" && Number.isFinite(value[field]),
  );
}

function durationStats(values: number[]): InspectDurationStats {
  // Nearest-rank, the same math as the reply-gap gate's p50/p95.
  return {
    count: values.length,
    medianMs: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
}

/**
 * Summarize measured splits per interaction band. Both bands are always
 * emitted so an artifact without the split reads as unmeasured, never absent
 * and never zero. `--session` narrows the scope before this runs.
 */
function latencyBands(sessions: InspectSession[]): InspectLatency {
  const splits = sessions.flatMap((session) =>
    session.turns.map((turn) => turn.latency).filter(isMeasuredLatency),
  );
  const bands: LatencyBand[] = ["ordinary", "post-cut"];
  return {
    bands: bands.map((band) => {
      const rows = splits.filter((split) => split.band === band);
      return {
        band,
        count: rows.length,
        measured: {
          endpointing: durationStats(rows.map((row) => row.endpointingMs)),
          generation: durationStats(rows.map((row) => row.generationMs)),
          delivery: durationStats(rows.map((row) => row.deliveryMs)),
        },
        perceived: {
          ...durationStats(rows.map((row) => row.perceivedMs)),
          reportOnly: true as const,
        },
      };
    }),
  };
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One caller transcript from the artifact's Call trace (or its redacted ledger). */
type CallerTranscript = {
  sessionId: string | null;
  /** 1-based caller turn in that Call trace; null for a ledger line with no merged turn. */
  turn: number | null;
  text: string;
};

const TRACE_HEARD = /^\s*\d+(?:\.\d+)?s\s+HEARD\s+"(.*)"\s+\(/;

/**
 * Caller turns as the merged Call trace printed them. A clip truncated by the
 * trace's own character cap (`…`) is skipped: its end is the cap, not a turn.
 */
function callerTurnsFromExcerpt(excerpt: string[], sessionId: string): CallerTranscript[] {
  const turns: CallerTranscript[] = [];
  for (const line of excerpt) {
    const match = TRACE_HEARD.exec(line);
    if (!match) continue;
    const text = match[1] ?? "";
    if (text.endsWith("…")) continue;
    turns.push({ sessionId, turn: turns.length + 1, text });
  }
  return turns;
}

/**
 * Caller transcript evidence from the artifact itself: the Call trace's HEARD
 * rows when merged (so a turn and session can be named), else the redacted
 * runner ledger (`heard: "…"`), which carries no turn. Never the raw runner
 * stdout, never an invented turn.
 */
function traceExcerpts(
  artifact: ScoreboardArtifact,
  sessionId: string | null | undefined,
): { sessionId: string; excerpt: string[] }[] {
  const trace = artifact.callTrace;
  if (!trace) return [];
  const excerpts =
    trace.sessions && trace.sessions.length > 0
      ? trace.sessions.map((session) => ({
          sessionId: session.sessionId,
          excerpt: session.excerpt,
        }))
      : [{ sessionId: trace.sessionId, excerpt: trace.excerpt }];
  return excerpts.filter((session) => !sessionId || session.sessionId === sessionId);
}

function callerTranscripts(
  artifact: ScoreboardArtifact,
  sessionId: string | null | undefined,
): CallerTranscript[] {
  const traceRows = traceExcerpts(artifact, sessionId).flatMap((session) =>
    callerTurnsFromExcerpt(session.excerpt, session.sessionId),
  );
  if (traceRows.length > 0) return traceRows;
  // With `--session` the ledger cannot be attributed to a call, so it is skipped.
  if (sessionId) return [];
  const rows: CallerTranscript[] = [];
  for (const line of artifact.transcripts?.redacted ?? []) {
    const heard = /^\s*heard:\s*(.*)$/i.exec(line);
    if (!heard) continue;
    for (const quoted of (heard[1] ?? "").matchAll(/"([^"]*)"/g)) {
      rows.push({ sessionId: null, turn: null, text: quoted[1] ?? "" });
    }
  }
  return rows;
}

/**
 * Whether the caller's words end inside the Test tag ("Lime 4" for "Lime 42",
 * including spoken digits). A whole tag, however spoken, is not a fragment.
 */
function tagFragment(text: string, tag: string): boolean {
  const [word = "", digits = ""] = tag.toLowerCase().split(" ");
  if (!word) return false;
  const w = escapeRegex(word);
  const sep = "\\s*(?:-\\s*|\\s)?";
  const digitChars = digits.split("");
  const trailing = "(?:\\s|[^a-z0-9])*$";
  const digitPattern = digitChars.map(escapeRegex).join(sep);
  const spokenPattern = digitChars
    .map((digit) => escapeRegex(DIGIT_WORDS[Number(digit)] ?? digit))
    .join("\\s+");
  if (new RegExp(`(?:^|[^a-z0-9])${w}${sep}${digitPattern}${trailing}`, "i").test(text)) return false;
  if (new RegExp(`(?:^|[^a-z0-9])${w}\\s+${spokenPattern}${trailing}`, "i").test(text)) return false;
  if (new RegExp(`(?:^|[^a-z0-9])${w}${trailing}`, "i").test(text)) return true;
  if (digitChars.length === 0) return false;
  const firstDigit = escapeRegex(digitChars[0] ?? "");
  const firstSpoken = escapeRegex(DIGIT_WORDS[Number(digitChars[0])] ?? digitChars[0] ?? "");
  return (
    new RegExp(`(?:^|[^a-z0-9])${w}${sep}${firstDigit}${trailing}`, "i").test(text) ||
    new RegExp(`(?:^|[^a-z0-9])${w}\\s+${firstSpoken}${trailing}`, "i").test(text)
  );
}

/**
 * Whether the caller's words end inside a spoken or written address: after
 * "at"/"@", after "dot", or on a single trailing domain letter. A redacted
 * whole address (`[email]`) and a fully spelled one ("dot p t") are whole.
 */
function emailFragment(text: string): boolean {
  const trimmed = text.trim().replace(/[.!?,;:"]+$/g, "");
  if (/\[email\]$/i.test(trimmed)) return false;
  return /(?:\b(?:at|@)\s*[a-z0-9-]*|\b(?:dot|\.)\s*[a-z]{0,1})\s*$/i.test(trimmed);
}

/**
 * Whether the caller's words end on a bare single digit (or a spoken digit).
 * A two-or-more-digit number reads as a whole number, never a fragment; for
 * longer numbers the artifact redacts them to `[phone]`.
 */
function numberFragment(text: string): boolean {
  const match = /(?:^|[^a-z0-9])([a-z0-9]+)\s*$/i.exec(text.trim());
  if (!match) return false;
  const token = (match[1] ?? "").toLowerCase();
  if (/^\d+$/.test(token)) return token.length === 1;
  return DIGIT_WORDS.includes(token) || token === "oh";
}

function fragmentKind(text: string, tag: string): InspectFragmentKind | null {
  if (tagFragment(text, tag)) return "tag";
  if (emailFragment(text)) return "email";
  if (numberFragment(text)) return "number";
  return null;
}

function fragmentRisk(transcripts: CallerTranscript[], tag: string): InspectFragmentRisk {
  if (transcripts.length === 0) return { status: "unmeasured", findings: [] };
  const findings: InspectFragmentFinding[] = [];
  for (const transcript of transcripts) {
    const kind = fragmentKind(transcript.text, tag);
    if (kind) findings.push({ kind, sessionId: transcript.sessionId, turn: transcript.turn });
  }
  return { status: findings.length > 0 ? "risk" : "clear", findings };
}

/**
 * Words that leave a clause hanging, and words a next caller turn starts with
 * when it picks that clause up. Heuristic evidence for a human reader, never a
 * gate: a turn must both stop on a dangling word (or punctuation) and be
 * followed, in the same call, by a turn that starts as a continuation.
 */
const INCOMPLETE_ENDINGS = new Set([
  "and", "but", "or", "so", "because", "like", "um", "uh", "the", "a", "an",
  "to", "of", "for", "with", "at", "in", "on", "about", "if", "when", "then",
  "just", "really", "very", "gonna", "wanna",
]);

const CONTINUATION_STARTS = new Set([
  "and", "but", "or", "so", "because", "also", "plus", "then", "well", "yeah",
  "yes", "no", "okay", "right", "the", "a", "an", "my", "our", "your", "their",
  "it", "that", "this", "i", "we", "you", "is", "are", "was", "were", "just", "like",
]);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function endsIncomplete(text: string): boolean {
  if (/[,;:—–-]\s*$/.test(text.trim())) return true;
  const tokens = wordsOf(text);
  const last = tokens[tokens.length - 1];
  return last !== undefined && INCOMPLETE_ENDINGS.has(last);
}

function startsContinuation(text: string): boolean {
  const [first] = wordsOf(text);
  return first !== undefined && CONTINUATION_STARTS.has(first);
}

function incompleteClause(transcripts: CallerTranscript[]): InspectIncompleteClause {
  if (transcripts.length === 0) return { status: "unmeasured", findings: [] };
  const findings: InspectIncompleteFinding[] = [];
  for (let index = 0; index + 1 < transcripts.length; index += 1) {
    const turn = transcripts[index]!;
    const next = transcripts[index + 1]!;
    // A continuation is only evidence inside the same call (or the ledger's own order).
    if (turn.sessionId !== next.sessionId) continue;
    if (!endsIncomplete(turn.text) || !startsContinuation(next.text)) continue;
    findings.push({ sessionId: turn.sessionId, turn: turn.turn, nextTurn: next.turn });
  }
  return { status: findings.length > 0 ? "risk" : "clear", findings };
}

/**
 * Distinct Call-trace turns cut mid-reply. Turn evidence comes from the
 * artifact's merged turn rows; when a session has no turn rows, its trace's
 * own `CUT at` rows are counted. No turn and no trace means unmeasured, never
 * a zero.
 */
function interruptedTurnCount(
  sessions: InspectSession[],
  artifact: ScoreboardArtifact,
  sessionId: string | null | undefined,
): number | null {
  const turns = sessions.flatMap((session) => session.turns);
  if (turns.length > 0) return turns.filter((turn) => turn.cutMs !== null).length;
  const excerpts = traceExcerpts(artifact, sessionId);
  if (excerpts.length === 0) return null;
  return excerpts.reduce(
    (count, session) => count + session.excerpt.filter((line) => /\bCUT at\b/.test(line)).length,
    0,
  );
}

function gateTally(gates: { name: string; status: string }[]): InspectGateTally {
  const count = (status: string) => gates.filter((gate) => gate.status === status).length;
  return {
    total: gates.length,
    pass: count("PASS"),
    info: count("INFO"),
    fail: count("FAIL"),
    failing: gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.name),
  };
}

/**
 * End-of-turn labelling: the artifact's own experiment evidence when the run
 * bound the variant, else production adaptive pacing. Never a production pass
 * for an experiment run (that lives on the end-of-turn gate row).
 */
function endOfTurnInput(artifact: ScoreboardArtifact): InspectEndOfTurn {
  const experiment = artifact.endOfTurn;
  if (!experiment || experiment.experimental !== true) {
    return {
      mode: "production",
      variant: null,
      variantKey: null,
      turnWindows: null,
      productionTurnDetection:
        artifact.agentBody?.measured === true
          ? (artifact.agentBody.turnDetection ?? null)
          : undefined,
    };
  }
  return {
    mode: "experimental",
    variant: experiment.variant,
    variantKey: experiment.variantKey,
    turnWindows: experiment.turnWindows,
    productionTurnDetection: experiment.productionTurnDetection,
  };
}

/**
 * The five A/B gap rows, in one order for both engines. A row the artifact does
 * not carry is a named N/A in the report, never a zero and never another row's
 * number (ticket 113/114).
 */
function inspectGaps(artifact: ScoreboardArtifact): InspectGaps {
  const pipeline = pipelineOfArtifact(artifact, "artifact");
  return {
    pipeline,
    rows: ARTIFACT_LATENCY_GAPS.map((row) => {
      const value = artifact.latency?.[row];
      if (typeof value === "number" && Number.isFinite(value)) {
        return { row, label: ARTIFACT_LATENCY_LABELS[row], ms: value, absent: null };
      }
      const absent = isArtifactAbsence(value)
        ? value.absent
        : "N/A — the artifact records no value for this gap";
      return { row, label: ARTIFACT_LATENCY_LABELS[row], ms: null, absent };
    }),
  };
}

/**
 * Turn one artifact into the compact report. Throws on something that is not a
 * scoreboard artifact; an unreadable file is the CLI's error, not a report.
 */
export function buildInspectReport(
  artifact: ScoreboardArtifact,
  opts: { sessionId?: string | null; events?: EvalEventSummary | null } = {},
): InspectReport {
  if (artifact === null || typeof artifact !== "object") {
    throw new Error("not a scoreboard artifact object");
  }
  if (
    typeof artifact.voice !== "string" ||
    typeof artifact.runId !== "string" ||
    typeof artifact.recordedAt !== "string" ||
    typeof artifact.schemaVersion !== "number" ||
    !Array.isArray(artifact.gates) ||
    !Array.isArray(artifact.subScores)
  ) {
    throw new Error("missing voice/runId/recordedAt/schemaVersion/gates/subScores");
  }
  const evidence = artifact.runnerEvidence ?? null;
  const sessions: InspectSession[] = evidence
    ? evidence.sessions.map((session) => ({ id: session.id, turns: session.turns }))
    : (artifact.callTrace
        ? artifact.callTrace.sessions && artifact.callTrace.sessions.length > 0
          ? artifact.callTrace.sessions
          : [
              {
                sessionId: artifact.callTrace.sessionId,
                excerpt: artifact.callTrace.excerpt,
              },
            ]
        : []
      ).map((session) => ({
        id: session.sessionId,
        turns: turnRowsFromTraceExcerpt(session.excerpt, session.sessionId),
      }));
  const filtered = opts.sessionId ? sessions.filter((session) => session.id === opts.sessionId) : sessions;
  const hangUps = evidence?.hangUps ?? hangUpsFromTranscript(artifact);
  const gates = artifact.gates.map((gate) => ({ name: gate.name, status: gate.status }));
  const transcripts = callerTranscripts(artifact, opts.sessionId);
  const fragmentTag = artifact.emailInvite?.tag ?? EMAIL_INVITE_TAG;
  const subject = subjectOfArtifact(artifact);
  // Eligibility is derived from the run's own facts, not read off its flag: a
  // recorded `eligible: true` cannot green a contaminated run (M13).
  const eligibility = deriveRunEligibility({ artifact });
  const judged = judgeSubjectRun({
    gates: artifact.gates,
    eligibility: { eligible: eligibility.eligible, reasons: eligibility.reasons },
  });
  const verdict: InspectVerdict = {
    ...judged,
    eligible: eligibility.eligible,
    disposition: eligibility.disposition,
  };
  return {
    run: {
      voice: artifact.voice,
      subject,
      pipeline: pipelineOfArtifact(artifact, "artifact"),
      runId: artifact.runId,
      recordedAt: artifact.recordedAt,
      schemaVersion: artifact.schemaVersion,
      code: artifact.codeFingerprint
        ? { head: artifact.codeFingerprint.head, dirty: artifact.codeFingerprint.dirty }
        : null,
      transport: evidence?.transport ?? "unknown",
      agentId: evidence?.agentId ?? agentFromTrace(artifact),
      agentFingerprint: evidence?.agentFingerprint ?? null,
      llmModel: evidence?.llmModel ?? null,
      variant: evidence?.variant ?? null,
      variantKey: evidence?.variantKey ?? null,
      turnWindows: evidence?.turnWindows ?? null,
    },
    verdict,
    scenarios: evidence?.scenarios ?? [],
    gates,
    subScores: artifact.subScores.map((sub) => ({ name: sub.name, status: sub.status })),
    sessions: filtered,
    latency: latencyBands(filtered),
    gaps: inspectGaps(artifact),
    adoption: {
      gates: gateTally(gates),
      fragmentRisk: fragmentRisk(transcripts, fragmentTag),
      incompleteClause: incompleteClause(transcripts),
      interruptedTurns: interruptedTurnCount(filtered, artifact, opts.sessionId),
      endOfTurn: endOfTurnInput(artifact),
    },
    // The artifact's own count is canonical (it is what the run recorded);
    // `--session` narrows the transcript, so that scope re-reads it.
    englishLeak:
      artifact.englishLeak && !opts.sessionId
        ? artifact.englishLeak
        : englishLeakForArtifact(artifact, {
            locale: subject.locale,
            sessionId: opts.sessionId ?? null,
          }),
    // Same rule as the English-leak counter: the artifact's own count is
    // canonical, and `--session` narrows the transcript so that scope re-reads.
    answeredQuestion:
      artifact.answeredQuestion && !opts.sessionId
        ? artifact.answeredQuestion
        : answeredQuestionForArtifact(artifact, {
            locale: subject.locale,
            sessionId: opts.sessionId ?? null,
          }),
    drain: {
      goodbyeCoverage: artifact.endCallDrain.goodbyeCoverage,
      hangUpDelayMs: artifact.endCallDrain.hangUpDelayMs,
      narratedEnding: artifact.endCallDrain.narratedEnding,
      inboxNamed: artifact.endCallDrain.inboxNamed,
      missingGoodbye: artifact.endCallDrain.missingGoodbye === true,
    },
    overTalkAside: evidence?.asides[0] ?? traceAsAside(artifact),
    hangUps: opts.sessionId ? hangUps.filter((row) => row.sessionId === opts.sessionId) : hangUps,
    playout: evidence?.playout ?? artifact.evalRunner.timings.scenarioRuns,
    failures: failureLines(artifact),
    ...(opts.events ? { events: opts.events } : {}),
  };
}

function formatTurn(turn: InspectTurn): string {
  const gap = turn.gapMs === null ? "   —" : `${String(turn.gapMs).padStart(4)}`;
  const cut = turn.cutMs === null ? "     —" : `${String(turn.cutMs).padStart(6)}`;
  const flag = (on: boolean) => (on ? "✓" : "·");
  return (
    `    turn ${String(turn.turnIndex).padStart(2)}  gap ${gap}ms  cutAt ${cut}ms` +
    `  heard ${flag(turn.heard)}  resume ${flag(turn.resume)}  aside ${flag(turn.aside)}`
  );
}

const ms = (value: number) => `${Math.round(value)}ms`;

/** One turn's split, always printed: an absent or partial split says unmeasured. */
function formatTurnSplit(latency: RunnerEvidenceLatency | undefined): string {
  if (!isMeasuredLatency(latency)) return "      split  unmeasured";
  return (
    `      split  ${latency.band}  endpointing ${ms(latency.endpointingMs)}` +
    `  generation ${ms(latency.generationMs)}  delivery ${ms(latency.deliveryMs)}` +
    `  perceived ${ms(latency.perceivedMs)} (report-only)`
  );
}

function formatStats(label: string, stats: InspectDurationStats): string {
  const value =
    stats.medianMs === null || stats.p95Ms === null
      ? "unmeasured"
      : `count ${stats.count}  median ${ms(stats.medianMs)}  p95 ${ms(stats.p95Ms)}`;
  return `    ${label.padEnd(12)} ${value}`;
}

/**
 * The ordinary vs post-cut summary. `perceived` is labelled report-only and
 * printed as its own row, beside the measured waits rather than among them.
 */
function formatLatency(latency: InspectLatency): string[] {
  const lines = ["latency split (perceived is report-only, never gated)"];
  for (const band of latency.bands) {
    if (band.count === 0) {
      lines.push(`  ${band.band.padEnd(9)} unmeasured (no turn carried a split)`);
      continue;
    }
    lines.push(`  ${band.band} (n=${band.count})`);
    lines.push(formatStats("endpointing", band.measured.endpointing));
    lines.push(formatStats("generation", band.measured.generation));
    lines.push(formatStats("delivery", band.measured.delivery));
    lines.push(`${formatStats("perceived", band.perceived)}  (report-only)`);
  }
  return lines;
}

/**
 * The A/B gap rows. One row per gap on both engines: a measured ms, or the
 * named N/A the artifact carries. The label column is fixed so the two engines'
 * outputs line up when compared side by side.
 */
function formatGaps(gaps: InspectGaps): string[] {
  const lines = [`gaps (pipeline ${gaps.pipeline})`];
  for (const row of gaps.rows) {
    const value = row.ms === null ? row.absent ?? "unmeasured" : `${Math.round(row.ms)}ms`;
    lines.push(`  ${row.label.padEnd(18)} ${value}`);
  }
  return lines;
}

function formatFragmentFinding(finding: InspectFragmentFinding): string {
  const where =
    finding.turn !== null
      ? `${finding.sessionId ?? "unknown session"} caller turn ${finding.turn}`
      : "an unnamed caller turn";
  return `${finding.kind} at ${where}`;
}

/**
 * The adoption inputs, compact and evidence-only. Gate rows stay above; the
 * split stays in the band summary (reused, never reprinted). Nothing here
 * claims a verdict.
 */
function formatAdoption(adoption: InspectAdoption): string[] {
  const gates = adoption.gates;
  const lines = [
    "adoption inputs (evidence only, never a verdict)",
    `  gates        ${gates.total}: ${gates.pass} PASS, ${gates.info} INFO, ${gates.fail} FAIL — every gate row is listed above`,
    "  split        latency split above (per-band; perceived is report-only)",
  ];
  const risk = adoption.fragmentRisk;
  if (risk.status === "risk") {
    lines.push(`  fragment     risk: ${risk.findings.map(formatFragmentFinding).join("; ")}`);
  } else if (risk.status === "clear") {
    lines.push("  fragment     clear: no caller turn ended inside the tag, email or a number");
  } else {
    lines.push("  fragment     unmeasured: no caller transcript evidence");
  }
  const incomplete = adoption.incompleteClause;
  if (incomplete.status === "risk") {
    const findings = incomplete.findings.map((finding) =>
      finding.turn !== null
        ? `${finding.sessionId ?? "unknown session"} caller turn ${finding.turn} → ${finding.nextTurn}`
        : "an unnamed caller turn continues",
    );
    lines.push(`  incomplete   risk: ${findings.join("; ")}`);
  } else if (incomplete.status === "clear") {
    lines.push("  incomplete   clear: no turn ended on a clause the next turn continues");
  } else {
    lines.push("  incomplete   unmeasured: no caller transcript evidence");
  }
  const interrupted = adoption.interruptedTurns;
  if (interrupted === null) {
    lines.push("  interrupted  unmeasured: no Call-trace turn evidence");
  } else {
    lines.push(`  interrupted  ${interrupted} turn${interrupted === 1 ? "" : "s"} cut`);
  }
  const endOfTurn = adoption.endOfTurn;
  if (endOfTurn.mode === "experimental") {
    const bits = [endOfTurn.variant];
    if (endOfTurn.variantKey) bits.push(endOfTurn.variantKey);
    bits.push(formatTurnWindows(endOfTurn.turnWindows));
    lines.push(
      `  end-of-turn  experimental ${bits[0]} (${bits.slice(1).join("; ")}) — evidence, not a production pass`,
    );
  } else {
    lines.push("  end-of-turn  production (no experiment evidence; see the end-of-turn gate row)");
  }
  return lines;
}

/**
 * The report-only English-leak counter, compact and clearly not a verdict.
 * A non-English call shows the leaking turns and their rate; English shows the
 * measured false-positive baseline instead, because the counter never applies
 * to the language it detects. The promotion line always says report-only until
 * a new record lands.
 */
function formatEnglishLeak(leak: EnglishLeakCount): string[] {
  const rate = (value: number) => value.toFixed(2);
  const lines = ["english-leak (report-only, never gated)", `  locale       ${leak.locale}`];
  if (leak.status === "not-applicable") {
    const why =
      leak.locale === "en"
        ? "a Locale-scoped counter is not applied to English"
        : "the Locale is undetermined, and English is not assumed";
    lines.push(`  applicable   no: ${why}`);
  } else if (leak.status === "unmeasured") {
    lines.push("  turns        unmeasured: no agent turn in the transcript");
  } else {
    lines.push(
      `  turns        ${leak.count} of ${leak.turns} agent turns leak (${rate(leak.rate ?? 0)})`,
    );
    for (const finding of leak.findings) {
      const where =
        finding.turn !== null
          ? `${finding.sessionId ?? "unknown session"} turn ${finding.turn}`
          : "an unnamed agent turn";
      lines.push(`  leak         ${where}: ${finding.words.join(", ")}`);
    }
  }
  if (leak.englishBaseline) {
    const baseline = leak.englishBaseline;
    const scoped = `${rate(baseline.scopedRate ?? 0)} (${baseline.scopedFlagged}/${baseline.turns})`;
    const unscoped = `${rate(baseline.unscopedRate ?? 0)} (${baseline.unscopedFlagged}/${baseline.turns})`;
    lines.push(`  baseline     FP ${scoped} locale-scoped; unscoped scan ${unscoped}`);
  }
  lines.push(
    `  promotion    ${leak.promotion.gating ? "GATING" : "report-only (never gated)"}` +
      `${leak.promotion.decidedAt ? ` since ${leak.promotion.decidedAt}` : ""}` +
      " — the record is appended, never edited",
  );
  return lines;
}

/**
 * The report-only already-answered counter, compact and clearly not a verdict.
 * A subject shows the repeated requests and their rate against the requests it
 * made; English shows the run's own flagged-request baseline beside the
 * measured English false-positive rate the promotion decision cites. The
 * promotion line always says report-only until a new record lands.
 */
function formatAnsweredQuestion(count: AnsweredQuestionCount): string[] {
  const rate = (value: number | null) => (value === null ? "—" : value.toFixed(2));
  const lines = [
    "answered-question (report-only, never gated)",
    `  locale       ${count.locale}`,
  ];
  if (count.status === "not-applicable") {
    lines.push(
      "  applicable   no: the Locale is undetermined, and no cue lexicon is assumed",
    );
  } else if (count.status === "unmeasured") {
    lines.push("  turns        unmeasured: no agent turn in the transcript");
  } else {
    lines.push(
      `  requests     ${count.count} of ${count.requests} requests repeat an answer (${rate(count.rate)})`,
    );
    for (const finding of count.findings) {
      const where =
        finding.turn !== null
          ? `${finding.sessionId ?? "unknown session"} turn ${finding.turn}`
          : "an unnamed agent turn";
      const categories = finding.categories.map(formatAnswerCategory).join(", ");
      lines.push(
        `  repeated     ${where}: ${categories} already answered at turn ${finding.answeredAt.turn} (${finding.answeredAt.value})`,
      );
    }
  }
  const fp = ANSWERED_QUESTION_ENGLISH_FP;
  lines.push(
    `  english-fp   ${rate(fp.falsePositiveRate)} over ${fp.cases} labelled cases ` +
      `(${fp.falsePositives} false positives of ${fp.flagged} flagged, ${fp.missed} missed)`,
  );
  if (count.englishBaseline) {
    const baseline = count.englishBaseline;
    lines.push(
      `  baseline     this run ${baseline.flagged} of ${baseline.requests} requests flagged (${rate(baseline.rate)})`,
    );
  }
  lines.push(
    `  promotion    ${count.promotion.gating ? "GATING" : "report-only (never gated)"}` +
      `${count.promotion.decidedAt ? ` since ${count.promotion.decidedAt}` : ""}` +
      " — the record is appended, never edited",
  );
  return lines;
}

function formatDrain(drain: InspectDrain): string {
  const coverage =
    drain.goodbyeCoverage === null ? "unmeasured" : drain.goodbyeCoverage.toFixed(2);
  const hangUp = drain.hangUpDelayMs === null ? "unmeasured" : `${drain.hangUpDelayMs}ms`;
  const inbox = drain.inboxNamed === null ? "unmeasured" : drain.inboxNamed ? "named" : "missing";
  return (
    `end-call drain: coverage ${coverage}, hang-up ${hangUp}, inbox ${inbox}` +
    `${drain.narratedEnding ? ", narrated ending" : ""}${drain.missingGoodbye ? ", no goodbye audio" : ""}`
  );
}

function formatAside(aside: RunnerEvidenceAside | null): string | null {
  if (!aside) return null;
  const bits = [`session ${aside.sessionId}`];
  if (aside.scenario) bits.push(`scenario ${aside.scenario}`);
  if (aside.traceTurn !== null) bits.push(`turn ${aside.traceTurn}`);
  if (aside.cutMs !== null) bits.push(`cut ${aside.cutMs}ms`);
  if (aside.markedOverheard !== null) bits.push(aside.markedOverheard ? "marked" : "unmarked");
  if (aside.inLedger !== null) bits.push(aside.inLedger ? "ledgered" : "not ledgered");
  if (aside.handling) bits.push(aside.handling);
  return `over-talk aside: ${bits.join(", ")}`;
}

/** The one verdict line: green only for a clean run, never for a contaminated one. */
function formatVerdict(verdict: InspectVerdict): string {
  if (verdict.kind === "ineligible") {
    return "INELIGIBLE — marked for re-run (does not count toward the kill criterion)";
  }
  if (verdict.kind === "red") {
    return `red — required gate(s) not PASS: ${verdict.failedGates.join(", ")}`;
  }
  return "green — clean run, every required gate PASS";
}

/** Console formatter: compact by default, never a transcript dump. */
export function formatInspectReport(report: InspectReport): string {
  const { run } = report;
  const code = run.code ? `${run.code.head.slice(0, 12)}${run.code.dirty ? "+dirty" : ""}` : "unknown";
  const lines: string[] = [
    `demo scoreboard inspect (${run.voice})`,
    `  run          ${run.runId}  (${run.recordedAt})`,
    `  schema       ${run.schemaVersion}`,
    `  code         ${code}`,
    `  transport    ${run.transport}`,
    `  subject      ${formatSubject(run.subject)}`,
    `  pipeline     ${run.pipeline}`,
    `  verdict      ${formatVerdict(report.verdict)}`,
    `  agent        ${run.agentId ?? "unknown"}  (llm ${run.llmModel ?? "unknown"})`,
  ];
  if (run.agentFingerprint) lines.push(`  fingerprint  ${run.agentFingerprint.slice(0, 12)}`);
  if (run.variant) {
    const windows = run.turnWindows
      ? `  windows ${formatTurnWindows(run.turnWindows, { labels: "short", separator: " / ", empty: "" })}`
      : "";
    lines.push(
      `  variant      ${run.variant}${run.variantKey ? `  ${run.variantKey}` : ""}${windows}`,
    );
  }
  if (report.verdict.kind === "ineligible") {
    for (const reason of report.verdict.reasons) lines.push(`  refusal      ${reason}`);
  }

  if (report.scenarios.length > 0) {
    lines.push("", `scenarios (${report.scenarios.length})`);
    for (const scenario of report.scenarios) {
      const verdict = scenario.passed === scenario.runs ? "PASS" : "FAIL";
      const wall = scenario.wallClockMs === null ? "" : `  ${scenario.wallClockMs}ms`;
      lines.push(`  ${verdict.padEnd(4)} ${scenario.name.padEnd(18)} ${scenario.passed}/${scenario.runs}${wall}`);
    }
  }

  lines.push("", `gates (${report.gates.length})`);
  for (const gate of report.gates) lines.push(`  ${gate.status.padEnd(6)} ${gate.name}`);
  lines.push("", `sub-scores (${report.subScores.length})`);
  for (const sub of report.subScores) {
    lines.push(`  ${sub.status.padEnd(4)} ${sub.name}`);
  }

  lines.push("", `call-trace sessions (${report.sessions.length})`);
  if (report.sessions.length === 0) lines.push("  no Call trace sessions recorded");
  for (const session of report.sessions) {
    lines.push(`  ${session.id} (${session.turns.length} turn${session.turns.length === 1 ? "" : "s"})`);
    for (const turn of session.turns) {
      lines.push(formatTurn(turn));
      lines.push(formatTurnSplit(turn.latency));
    }
  }

  lines.push("", ...formatLatency(report.latency));
  lines.push("", ...formatGaps(report.gaps));
  lines.push("", ...formatAdoption(report.adoption));
  lines.push("", ...formatEnglishLeak(report.englishLeak));
  lines.push("", ...formatAnsweredQuestion(report.answeredQuestion));
  lines.push("", formatDrain(report.drain));
  const aside = formatAside(report.overTalkAside);
  if (aside) lines.push(aside);
  if (report.hangUps.length > 0) {
    lines.push("hang-ups:");
    for (const hangUp of report.hangUps) {
      lines.push(
        `  ${hangUp.sessionId ?? "unknown session"}  ${hangUp.delayMs}ms` +
          `${hangUp.coverage !== null ? `  coverage ${hangUp.coverage.toFixed(2)}` : ""}`,
      );
    }
  }
  if (report.playout.length > 0) {
    lines.push("playout (never gated):");
    for (const row of report.playout) {
      lines.push(`  ${row.scenario} #${row.run}  ${row.wallClockMs}ms`);
    }
  }

  lines.push("", `failures (${report.failures.length})`);
  if (report.failures.length === 0) lines.push("  none");
  else for (const failure of report.failures) lines.push(`  ${failure}`);

  if (report.events) {
    lines.push("", `events (${report.events.total} lines)`);
    const counts = Object.entries(report.events.counts)
      .map(([type, count]) => `${type} ${count}`)
      .join(", ");
    lines.push(`  counts: ${counts || "none"}`);
    for (const event of report.events.timeline) {
      lines.push(`  +${String(event.atMs).padStart(6)}ms  ${event.type.padEnd(14)} ${event.detail}`);
    }
  }
  return lines.join("\n");
}
