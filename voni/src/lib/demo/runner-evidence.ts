/**
 * Structured, PII-safe runner evidence for the scoreboard artifact (retro #2).
 *
 * Before this, a reader had to re-parse the redacted runner transcript (or the
 * truncated Call-trace excerpt) to answer "which scenario failed, what were the
 * per-turn gaps/cuts, did the aside land, how long until hang-up". That text
 * is lossy and redacted; this module keeps the numbers and decisions in typed
 * fields instead. No caller words are copied here: transcripts stay redacted
 * in `artifact.transcripts`, and the aside is described by timing/flags only.
 *
 * Purely additive: existing artifact fields and gates are untouched, and the
 * scoreboard schema version stays put because every field is optional for a
 * reader (an older artifact simply has no `runnerEvidence`).
 */
import {
  parseEvalSummary,
  parseGoodbyeDrainOutput,
  parseOverheardAsideOutput,
  overheardFromTraceExcerpt,
  traceTurnForVisitorSpeech,
  type EvalRunnerSummary,
  type RunnerPlayout,
} from "./scoreboard";
import type { EvalEvent } from "./eval-events";
import { latencySplit, type LatencySplit } from "./latency-split";
import type { DemoAgentVariant, DemoTurnWindows } from "./stored-agents";

/**
 * One turn's latency split, joined to the Call trace by the runner's per-call
 * turn id. Timings and identifiers only: this is evidence, never a gate input.
 */
export type RunnerEvidenceLatency = LatencySplit & {
  /** The runner's stable per-call turn id (`turn-1`, …) the marks were joined on. */
  turnId: string;
};

/** One VONI reply in a merged Call trace, reduced to observable facts. */
export type RunnerEvidenceTurn = {
  /** 1-based VONI reply in this session's merged excerpt (same numbering every gate uses). */
  turnIndex: number;
  /** Visitor end-of-speech → first agent audio, from the trace's own `gap Nms`. */
  gapMs: number | null;
  /** Call-relative ms of the `CUT at` marker; null when the reply was not cut. */
  cutMs: number | null;
  /** Caller speech was heard on this turn (a measured gap or an overlapping HEARD row). */
  heard: boolean;
  /** First reply after a cut: the answer or the resume being judged. */
  resume: boolean;
  /** An Overheard-aside HEARD row overlapped this reply. */
  aside: boolean;
  /**
   * Client-clock latency split for this turn. Absent when the turn has no
   * marks (or no anchor): a missing sample is never a zero-filled one.
   */
  latency?: RunnerEvidenceLatency;
};

/** One session's aside evidence, without the caller's words. */
export type RunnerEvidenceAside = {
  sessionId: string;
  scenario: string | null;
  /** Call-relative ms the caller's aside started. */
  startMs: number | null;
  /** Call-relative ms it ended; null when the runner could not measure it. */
  endMs: number | null;
  /** Call-relative ms the server cut the agent reply under the aside. */
  cutMs: number | null;
  replyId: string | null;
  /** 1-based VONI turn the aside overlapped; null when no turn merged. */
  traceTurn: number | null;
  /** The caption/trace marked it Overheard. */
  markedOverheard: boolean | null;
  /** The call ledger counted the words. */
  inLedger: boolean | null;
  /** answered | resumed-from | heard-only | lost, when derived from the trace. */
  handling: string | null;
};

/** One measured closing-line drain, with the call it belongs to. */
export type RunnerEvidenceHangUp = {
  sessionId: string | null;
  /** Session close minus the goodbye's audio end (negative means chopped). */
  delayMs: number;
  coverage: number | null;
  inboxNamed: boolean | null;
  narratedEnding: boolean | null;
  /** 1-based VONI turn of the closing line, when the runner knew it. */
  goodbyeTurn: number | null;
  scenario: string | null;
};

/** One scenario's verdict plus its wall-clock playout (report-only). */
export type RunnerEvidenceScenario = {
  name: string;
  /** Scenario runs that passed (out of `runs`). */
  passed: number;
  runs: number;
  /** Total live-call wall clock for this scenario; null when none ran. */
  wallClockMs: number | null;
};

/** One merged call, turn rows plus its aside/hang-up when it produced one. */
export type RunnerEvidenceSession = {
  id: string;
  turns: RunnerEvidenceTurn[];
  /**
   * Gaps only (the shape a compact reader wants): turn index, reply gap and
   * cut time per measured turn. `turns` is the same data with the flags.
   */
  gaps: { turnIndex: number; gapMs: number | null; cutMs: number | null }[];
  aside?: RunnerEvidenceAside;
  hangUp?: RunnerEvidenceHangUp;
};

/**
 * The artifact's structured runner evidence. `transport` is "unknown" on an
 * artifact whose runner printed no identity (older runner, replay file).
 */
export type RunnerEvidence = {
  transport: string;
  agentId: string | null;
  agentFingerprint: string | null;
  llmModel: string | null;
  /**
   * Which stored body produced the evidence. Absent on artifacts written
   * before the turn-window experiment, so a reader must treat absence as
   * unknown rather than assume production.
   */
  variant?: DemoAgentVariant | null;
  /** The variant's own `demo_agents.voice_id` (`<voice>:exp`), null for production. */
  variantKey?: string | null;
  /** The windows the variant body was built from; null for production. */
  turnWindows?: DemoTurnWindows | null;
  scenarios: RunnerEvidenceScenario[];
  sessions: RunnerEvidenceSession[];
  playout: RunnerPlayout[];
  asides: RunnerEvidenceAside[];
  hangUps: RunnerEvidenceHangUp[];
};

type TraceRow =
  | { kind: "voni"; ms: number; gapMs: number | null; cutMs: number | null; ttfaMs: number | null }
  | { kind: "heard"; ms: number; endMs: number | null }
  | { kind: "other"; ms: number };

const TRACE_ROW = /^\s*(\d+(?:\.\d+)?)s\s+(VONI|HEARD|TOOL|CLIENT|CONFIG|SYSTEM)\b(.*)$/;
const HEARD_WINDOW = /\((\d+(?:\.\d+)?)s\s*[–-]\s*(\d+(?:\.\d+)?)s\)/;

function traceRows(excerpt: string[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const line of excerpt) {
    const match = TRACE_ROW.exec(line);
    if (!match) continue;
    const ms = Math.round(Number(match[1]) * 1000);
    const kind = match[2];
    const rest = match[3] ?? "";
    if (kind === "VONI") {
      const gap = /gap (\d+)ms/.exec(rest);
      const cut = /CUT at (\d+(?:\.\d+)?)s/.exec(rest);
      // The server's own reply-start → first-audio wait: the anchor's server
      // instant is this reply's start plus this number.
      const ttfa = /ttfa (\d+)ms/.exec(rest);
      rows.push({
        kind: "voni",
        ms,
        gapMs: gap ? Number(gap[1]) : null,
        cutMs: cut ? Math.round(Number(cut[1]) * 1000) : null,
        ttfaMs: ttfa ? Number(ttfa[1]) : null,
      });
    } else if (kind === "HEARD") {
      const window = HEARD_WINDOW.exec(rest);
      rows.push({
        kind: "heard",
        ms,
        // A HEARD row whose end never printed has no end mark. Falling back to
        // the speech start would turn the whole utterance into endpointing.
        endMs: window ? Math.round(Number(window[2]) * 1000) : null,
      });
    } else {
      rows.push({ kind: "other", ms });
    }
  }
  return rows;
}

/**
 * One CONFIG row for the Call trace. It names the agent whose turn detection
 * the server changed, so a variant window line can never be read as
 * production pacing (or the other way round). `agentId` is the session's
 * bound agent; null means the inline debug body.
 */
export function configTraceLine(
  atLabel: string,
  turnDetection: unknown,
  agentId: string | null,
): string {
  return `${atLabel}  CONFIG  turn_detection ${JSON.stringify(turnDetection)}  agent=${agentId ?? "inline"}`;
}

/**
 * Reduce a merged Call trace excerpt to per-turn facts. Flags are honest:
 * `cutMs` is the trace's own CUT timestamp (not a re-derived latency), `heard`
 * needs a measured gap or an overlapping HEARD window, `resume` is the first
 * reply after a cut, and `aside` only comes from the trace's overlap proof.
 * Nothing is guessed from line order alone.
 */
export function turnRowsFromTraceExcerpt(
  excerpt: string[],
  sessionId?: string | null,
): RunnerEvidenceTurn[] {
  const rows = traceRows(excerpt);
  const voni = rows.filter((row): row is Extract<TraceRow, { kind: "voni" }> => row.kind === "voni");
  const heard = rows.filter((row): row is Extract<TraceRow, { kind: "heard" }> => row.kind === "heard");
  const turnRows: RunnerEvidenceTurn[] = [];
  let firstCutTurn: number | null = null;
  voni.forEach((row, index) => {
    // "Heard" needs evidence, not line order: a measured reply gap, or caller
    // speech overlapping a cut reply. Free-floor speech after a reply belongs
    // to the next turn's gap and never marks this one.
    const heardOnTurn =
      row.gapMs !== null ||
      (row.cutMs !== null &&
        heard.some((span) => span.ms <= row.cutMs! && span.endMs !== null && span.endMs >= row.ms));
    const turnIndex = index + 1;
    if (row.cutMs !== null && firstCutTurn === null) firstCutTurn = turnIndex;
    turnRows.push({
      turnIndex,
      gapMs: row.gapMs,
      cutMs: row.cutMs,
      heard: heardOnTurn,
      // The first reply after the first cut is the answer/resume being judged,
      // even when that reply was itself cut again.
      resume: firstCutTurn !== null && turnIndex === firstCutTurn + 1,
      aside: false,
    });
  });
  // Trace-derived asides carry their VONI turn in the pointer the gate prints.
  if (sessionId) {
    for (const aside of traceAsides(excerpt, sessionId)) {
      if (aside.traceTurn === null) continue;
      const turn = turnRows.find((row) => row.turnIndex === aside.traceTurn);
      if (turn) turn.aside = true;
    }
  }
  return turnRows;
}

/** One caller turn as the merged Call trace saw it, in trace milliseconds. */
type TraceCallerTurn = {
  /** 1-based caller turn in this call (the runner's `turn-N` order). */
  ordinal: number;
  speechStartedMs: number;
  /** The trace's own gap subtraction, or its HEARD window end. */
  speechEndedMs: number | null;
  /** 1-based VONI reply this caller turn was answered by; null when none merged. */
  replyTurnIndex: number | null;
  replyStartMs: number | null;
  /** The answered reply's own speech end → reply start wait; null when unanswered. */
  gapMs: number | null;
  ttfaMs: number | null;
  /** The interrupted reply's end, when the previous reply was cut under speech. */
  previousReplyEndedMs: number | null;
};

/**
 * Pair each HEARD row (one caller turn) with the first VONI reply after it.
 * Ordinals follow HEARD order, so a caller turn whose reply never merged does
 * not shift the turn the following marks belong to. A reply only answers the
 * caller when the trace printed its gap (a user_speech reply): a greeting or
 * tool-result reply that follows the HEARD row is agent-initiated, so it is
 * never claimed as the caller's answer.
 */
function callerTurnsFromTrace(excerpt: string[]): TraceCallerTurn[] {
  const rows = traceRows(excerpt);
  type Reply = { turnIndex: number; ms: number; gapMs: number | null; ttfaMs: number | null; cutMs: number | null };
  const replies = new Map<number, Reply>();
  let voniCount = 0;
  rows.forEach((row, index) => {
    if (row.kind !== "voni") return;
    voniCount += 1;
    replies.set(index, {
      turnIndex: voniCount,
      ms: row.ms,
      gapMs: row.gapMs,
      ttfaMs: row.ttfaMs,
      cutMs: row.cutMs,
    });
  });

  const callerTurns: TraceCallerTurn[] = [];
  let previousReply: Reply | null = null;
  rows.forEach((row, index) => {
    if (row.kind === "voni") {
      previousReply = replies.get(index) ?? previousReply;
      return;
    }
    if (row.kind !== "heard") return;
    const replyIndex = rows.findIndex((candidate, at) => at > index && candidate.kind === "voni");
    const next = replyIndex >= 0 ? replies.get(replyIndex) ?? null : null;
    const reply = next?.gapMs != null ? next : null;
    callerTurns.push({
      ordinal: callerTurns.length + 1,
      speechStartedMs: row.ms,
      // The trace prints `gap Nms` as reply start minus caller end; reuse the
      // same subtraction so the split cannot disagree with the printed gap.
      speechEndedMs: reply?.gapMs != null ? reply.ms - reply.gapMs : row.endMs,
      replyTurnIndex: reply?.turnIndex ?? null,
      replyStartMs: reply?.ms ?? null,
      gapMs: reply?.gapMs ?? null,
      ttfaMs: reply?.ttfaMs ?? null,
      // Only an interrupted previous reply has a printed end; a reply that was
      // not cut carries no end mark, and the band then reads ordinary.
      previousReplyEndedMs: previousReply?.cutMs ?? null,
    });
  });
  return callerTurns;
}

/** One caller turn's three client receipts, rebuilt from the event stream. */
type MarkTurn = {
  turnId: string;
  /** 1-based caller turn in this call (the runner's `turn-N` order). */
  ordinal: number;
  userFinalAtMs: number | null;
  replyStartAtMs: number | null;
  firstAudioAtMs: number | null;
};

function markTurnsForSession(
  events: EvalEvent[],
  sessionId: string,
): { turns: MarkTurn[]; anchor: { turnId: string; clientAtMs: number } | null } {
  const turns: MarkTurn[] = [];
  const byTurnId = new Map<string, MarkTurn>();
  const byReplyId = new Map<string, MarkTurn>();
  let anchor: { turnId: string; clientAtMs: number } | null = null;

  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const atMs = Number.isFinite(event.atMs) ? event.atMs : null;
    if (atMs === null) continue;
    if (event.type === "turn.user_final") {
      const turnId = typeof event.turnId === "string" ? event.turnId : null;
      if (!turnId) continue;
      const turn: MarkTurn = {
        turnId,
        ordinal: turns.length + 1,
        userFinalAtMs: atMs,
        replyStartAtMs: null,
        firstAudioAtMs: null,
      };
      turns.push(turn);
      byTurnId.set(turnId, turn);
    } else if (event.type === "turn.reply_start") {
      const turnId = typeof event.turnId === "string" ? event.turnId : null;
      const turn = turnId ? byTurnId.get(turnId) : undefined;
      if (!turn) continue;
      turn.replyStartAtMs = atMs;
      if (typeof event.replyId === "string") byReplyId.set(event.replyId, turn);
    } else if (event.type === "reply.first_audio") {
      const turnId = typeof event.turnId === "string" ? event.turnId : null;
      const replyId = typeof event.replyId === "string" ? event.replyId : null;
      const turn =
        (turnId ? byTurnId.get(turnId) : undefined) ?? (replyId ? byReplyId.get(replyId) : undefined);
      if (turn && turn.firstAudioAtMs === null) turn.firstAudioAtMs = atMs;
      if (event.anchor === true && turn) anchor = { turnId: turn.turnId, clientAtMs: atMs };
    }
  }
  return { turns, anchor };
}

/**
 * Attach the per-turn split to the trace turn rows. The one anchor is a client
 * receipt paired with the trace's own reply start + time-to-first-audio, so
 * every client mark is read on the Call trace clock once per call. A turn with
 * no marks, no anchor or no merged reply keeps no `latency` field at all.
 *
 * Mark turns are walked against the trace's caller turns in order, but a client
 * turn whose final transcript arrives before the server's end of speech cannot
 * be that caller turn's final: the server folded it into another utterance, so
 * it consumes no trace turn and the next mark turn keeps its place instead of
 * shifting every later turn onto the wrong reply.
 */
function attachLatencySplits(
  turns: RunnerEvidenceTurn[],
  excerpt: string[],
  events: EvalEvent[],
  sessionId: string,
): void {
  const marks = markTurnsForSession(events, sessionId);
  if (!marks.anchor) return;
  const callerTurns = callerTurnsFromTrace(excerpt);
  const anchorTurn = marks.turns.find((turn) => turn.turnId === marks.anchor!.turnId);
  const anchorTrace = anchorTurn ? callerTurns[anchorTurn.ordinal - 1] : undefined;
  if (!anchorTrace || anchorTrace.replyStartMs === null || anchorTrace.ttfaMs === null) return;
  const serverAtMs = anchorTrace.replyStartMs + anchorTrace.ttfaMs;
  const offsetMs = serverAtMs - marks.anchor.clientAtMs;

  let cursor = 0;
  for (const markTurn of marks.turns) {
    const traceTurn = callerTurns[cursor];
    if (!traceTurn) break;
    const finalOnTraceMs = markTurn.userFinalAtMs === null ? null : markTurn.userFinalAtMs + offsetMs;
    if (finalOnTraceMs !== null && traceTurn.speechEndedMs !== null && finalOnTraceMs < traceTurn.speechEndedMs) {
      // A client-only fragment the server never heard as its own turn.
      continue;
    }
    cursor += 1;
    if (traceTurn.replyTurnIndex === null) continue;
    const split = latencySplit({
      turn: {
        user_speech_started_at_ms: traceTurn.speechStartedMs,
        user_speech_ended_at_ms: traceTurn.speechEndedMs,
        gapMs: traceTurn.gapMs,
      },
      marks: {
        userFinalAtMs: markTurn.userFinalAtMs,
        replyStartAtMs: markTurn.replyStartAtMs,
        firstAudioAtMs: markTurn.firstAudioAtMs,
      },
      anchor: { clientAtMs: marks.anchor.clientAtMs, serverAtMs },
      ...(traceTurn.previousReplyEndedMs !== null
        ? { previousReply: { endedAtMs: traceTurn.previousReplyEndedMs } }
        : {}),
    });
    if (!split) continue;
    const row = turns.find((turn) => turn.turnIndex === traceTurn.replyTurnIndex);
    if (row) row.latency = { turnId: markTurn.turnId, ...split };
  }
}

function turnFromPointer(pointer: string): number | null {
  const match = /call trace turn (\d+)/.exec(pointer);
  return match ? Number(match[1]) : null;
}

function traceAsides(excerpt: string[], sessionId: string): RunnerEvidenceAside[] {
  return overheardFromTraceExcerpt(excerpt, sessionId).map((aside) => ({
    sessionId,
    scenario: null,
    startMs: null,
    endMs: null,
    cutMs: null,
    replyId: null,
    traceTurn: turnFromPointer(aside.tracePointer),
    markedOverheard: aside.markedOverheard,
    inLedger: aside.inLedger,
    handling: aside.handling,
  }));
}

/** Every measured hang-up line in the runner output, worst last is not assumed. */
function hangUpsFromStdout(stdout: string): RunnerEvidenceHangUp[] {
  const drain = parseGoodbyeDrainOutput(stdout);
  const hangUps: RunnerEvidenceHangUp[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /hung up (-?\d+(?:\.\d+)?)ms after the goodbye finished playing(?: \(session (\S+)\))?/,
    );
    if (!match) continue;
    const sessionId = match[2] ?? null;
    const belongsToDrain = drain !== null && (drain.sessionId === null || drain.sessionId === sessionId);
    hangUps.push({
      sessionId,
      delayMs: Math.round(Number(match[1])),
      coverage: belongsToDrain ? drain.coverage : null,
      inboxNamed: belongsToDrain ? drain.inboxNamed : null,
      narratedEnding: belongsToDrain ? drain.narratedEnding : null,
      goodbyeTurn: belongsToDrain ? drain.turn : null,
      scenario: belongsToDrain ? drain.scenario : null,
    });
  }
  return hangUps;
}

function scenarioWallClock(playout: RunnerPlayout[], name: string): number | null {
  const rows = playout.filter((row) => row.scenario === name);
  return rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.wallClockMs, 0);
}

/** Only the two known variants are evidence; anything else is unknown, never assumed. */
function summaryVariant(summary: EvalRunnerSummary | null): DemoAgentVariant | null {
  const value = summary?.variant;
  return value === "production" || value === "turn-window" ? value : null;
}

/** Keep only the three window fields, and only when they are finite numbers. */
function summaryTurnWindows(summary: EvalRunnerSummary | null): DemoTurnWindows | null {
  const raw = summary?.turnWindows;
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const windows: DemoTurnWindows = {};
  if (Number.isFinite(raw.min_silence)) windows.min_silence = Number(raw.min_silence);
  if (Number.isFinite(raw.max_silence)) windows.max_silence = Number(raw.max_silence);
  if (Number.isFinite(raw.interruption_delay)) {
    windows.interruption_delay = Number(raw.interruption_delay);
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

function scenariosFromSummary(summary: EvalRunnerSummary | null, playout: RunnerPlayout[]): RunnerEvidenceScenario[] {
  return (summary?.scenarios ?? []).map((row) => ({
    name: row.name,
    passed: row.passed,
    runs: row.runs,
    wallClockMs: scenarioWallClock(playout, row.name),
  }));
}

/**
 * Build the artifact's runnerEvidence from what the run printed plus the
 * already-merged Call trace excerpts. Returns null when there is nothing to
 * report (dry run, no summary, no markers, no trace), so an unmeasured run
 * never gets an empty-but-present evidence object.
 */
export function buildRunnerEvidence(input: {
  runnerStdout: string;
  /** Call traces merged for this artifact, one per session. */
  excerpts?: { sessionId: string; excerpt: string[] }[];
  /** Overrides the summary's transport when supplied (tests/replays). */
  transport?: string | null;
  /** Fallback scenario verdicts when stdout carries no EVAL SUMMARY. */
  scenarios?: { name: string; passed: number; runs: number }[];
  /** Overrides the summary's playout rows when supplied. */
  playout?: RunnerPlayout[];
  /**
   * The runner's opt-in per-turn client receipt marks. Absent (no `--events`)
   * means no split is attached; a marked turn with no trace match stays absent.
   */
  marks?: EvalEvent[];
}): RunnerEvidence | null {
  const summary = parseEvalSummary(input.runnerStdout);
  const markers =
    parseOverheardAsideOutput(input.runnerStdout) !== null ||
    parseGoodbyeDrainOutput(input.runnerStdout) !== null ||
    /hung up -?\d+(?:\.\d+)?ms after the goodbye/.test(input.runnerStdout);
  const excerpts = (input.excerpts ?? []).filter((trace) => trace.excerpt.length > 0);
  if (!summary && !markers && excerpts.length === 0) return null;

  const playout = input.playout ?? summary?.playout ?? [];
  const scenarios = scenariosFromSummary(summary, playout);
  const scenarioRows =
    scenarios.length > 0
      ? scenarios
      : (input.scenarios ?? []).map((row) => ({
          ...row,
          wallClockMs: scenarioWallClock(playout, row.name),
        }));

  const markerAside = parseOverheardAsideOutput(input.runnerStdout);
  const asides: RunnerEvidenceAside[] = [];
  const sessions: RunnerEvidenceSession[] = [];
  const traceSessions = [...excerpts.map((trace) => trace.sessionId), ...(summary?.traceSessions ?? [])];
  const sessionIds = [...new Set(traceSessions)];
  if (markerAside && !sessionIds.includes(markerAside.sessionId)) sessionIds.push(markerAside.sessionId);

  for (const id of sessionIds) {
    const excerpt = excerpts.find((trace) => trace.sessionId === id)?.excerpt ?? [];
    const turns = turnRowsFromTraceExcerpt(excerpt, id);
    if (excerpt.length > 0 && input.marks && input.marks.length > 0) {
      attachLatencySplits(turns, excerpt, input.marks, id);
    }
    const traceAside = excerpt.length > 0 ? traceAsides(excerpt, id)[0] : undefined;
    const sessionAside: RunnerEvidenceAside | undefined =
      markerAside?.sessionId === id
        ? {
            sessionId: id,
            scenario: markerAside.scenario,
            startMs: markerAside.startMs,
            endMs: markerAside.endMs,
            cutMs: markerAside.cutMs,
            replyId: markerAside.replyId,
            traceTurn: traceAside?.traceTurn ?? turnFromVisitorSpeech(excerpt, markerAside.text),
            markedOverheard: traceAside?.markedOverheard ?? true,
            inLedger: traceAside?.inLedger ?? null,
            handling: traceAside?.handling ?? null,
          }
        : traceAside
          ? { ...traceAside, sessionId: id }
          : undefined;
    sessions.push({
      id,
      turns,
      gaps: turns.map((turn) => ({ turnIndex: turn.turnIndex, gapMs: turn.gapMs, cutMs: turn.cutMs })),
      ...(sessionAside ? { aside: sessionAside } : {}),
    });
  }

  const hangUps = hangUpsFromStdout(input.runnerStdout);
  for (const session of sessions) {
    const hangUp = hangUps.find((row) => row.sessionId === session.id);
    if (hangUp) session.hangUp = hangUp;
  }

  for (const session of sessions) if (session.aside) asides.push(session.aside);
  if (markerAside && !asides.some((aside) => aside.sessionId === markerAside.sessionId)) {
    asides.push({
      sessionId: markerAside.sessionId,
      scenario: markerAside.scenario,
      startMs: markerAside.startMs,
      endMs: markerAside.endMs,
      cutMs: markerAside.cutMs,
      replyId: markerAside.replyId,
      traceTurn: null,
      markedOverheard: true,
      inLedger: null,
      handling: null,
    });
  }

  return {
    transport: input.transport ?? summary?.transport ?? "unknown",
    agentId: summary?.agentId ?? null,
    agentFingerprint: summary?.agentFingerprint ?? null,
    llmModel: summary?.llmModel ?? null,
    variant: summaryVariant(summary),
    variantKey: summary?.variantKey ?? null,
    turnWindows: summaryTurnWindows(summary),
    scenarios: scenarioRows,
    sessions,
    playout,
    asides,
    hangUps,
  };
}

function turnFromVisitorSpeech(excerpt: string[], text: string): number | null {
  return excerpt.length > 0 ? traceTurnForVisitorSpeech(excerpt, text) : null;
}
