/**
 * Compact scoreboard inspector (retro #2/#9).
 *
 * `npm run scoreboard:inspect -- --artifact <path> [--session <id>]
 * [--events <path>] [--json]` answers the triage questions without dumping a
 * 30k-line transcript: run identity, scenario verdicts, gates and sub-scores,
 * per-session turn gaps/cuts (heard/resume/aside flags), drain/aside/hang-up
 * numbers, playout, and only the last failures. `--json` prints the same
 * structure for a machine.
 *
 * Everything here is pure: the CLI reads files, this module turns an artifact
 * (plus an optional event stream) into a report and formats it. Evidence the
 * artifact does not carry is reported as unknown/absent, never invented:
 * artifacts written before `runnerEvidence` still show their merged Call trace
 * rows via the same turn parser.
 */
import {
  type RunnerPlayout,
  type ScoreboardArtifact,
} from "./scoreboard";
import type { EvalEventSummary } from "./eval-events";
import {
  turnRowsFromTraceExcerpt,
  type RunnerEvidenceAside,
  type RunnerEvidenceHangUp,
  type RunnerEvidenceScenario,
  type RunnerEvidenceTurn,
} from "./runner-evidence";
import type { DemoAgentVariant, DemoTurnWindows } from "./stored-agents";

export type InspectRunIdentity = {
  voice: string;
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

export type InspectDrain = {
  goodbyeCoverage: number | null;
  hangUpDelayMs: number | null;
  narratedEnding: boolean;
  inboxNamed: boolean | null;
  missingGoodbye: boolean;
};

export type InspectReport = {
  run: InspectRunIdentity;
  scenarios: InspectScenario[];
  gates: { name: string; status: string }[];
  subScores: { name: string; status: string }[];
  sessions: InspectSession[];
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
  return {
    run: {
      voice: artifact.voice,
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
    scenarios: evidence?.scenarios ?? [],
    gates: artifact.gates.map((gate) => ({ name: gate.name, status: gate.status })),
    subScores: artifact.subScores.map((sub) => ({ name: sub.name, status: sub.status })),
    sessions: filtered,
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

function formatWindows(windows: DemoTurnWindows): string {
  const parts: string[] = [];
  if (windows.min_silence !== undefined) parts.push(`min ${windows.min_silence}`);
  if (windows.max_silence !== undefined) parts.push(`max ${windows.max_silence}`);
  if (windows.interruption_delay !== undefined) {
    parts.push(`interruption_delay ${windows.interruption_delay}`);
  }
  return parts.join(" / ");
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
    `  agent        ${run.agentId ?? "unknown"}  (llm ${run.llmModel ?? "unknown"})`,
  ];
  if (run.agentFingerprint) lines.push(`  fingerprint  ${run.agentFingerprint.slice(0, 12)}`);
  if (run.variant) {
    const windows = run.turnWindows ? `  windows ${formatWindows(run.turnWindows)}` : "";
    lines.push(
      `  variant      ${run.variant}${run.variantKey ? `  ${run.variantKey}` : ""}${windows}`,
    );
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
    for (const turn of session.turns) lines.push(formatTurn(turn));
  }

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
