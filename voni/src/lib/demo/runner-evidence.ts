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
  scenarios: RunnerEvidenceScenario[];
  sessions: RunnerEvidenceSession[];
  playout: RunnerPlayout[];
  asides: RunnerEvidenceAside[];
  hangUps: RunnerEvidenceHangUp[];
};

type TraceRow =
  | { kind: "voni"; ms: number; gapMs: number | null; cutMs: number | null }
  | { kind: "heard"; ms: number; endMs: number }
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
      rows.push({
        kind: "voni",
        ms,
        gapMs: gap ? Number(gap[1]) : null,
        cutMs: cut ? Math.round(Number(cut[1]) * 1000) : null,
      });
    } else if (kind === "HEARD") {
      const window = HEARD_WINDOW.exec(rest);
      rows.push({
        kind: "heard",
        ms,
        endMs: window ? Math.round(Number(window[2]) * 1000) : ms,
      });
    } else {
      rows.push({ kind: "other", ms });
    }
  }
  return rows;
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
      (row.cutMs !== null && heard.some((span) => span.ms <= row.cutMs! && span.endMs >= row.ms));
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
