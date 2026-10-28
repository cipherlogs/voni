/**
 * Demo scoreboard: locked golden script (ticket 02) on the ticket-01
 * plumbing. The seven beats below are fixed order, fixed visitor wording,
 * and fixed timing windows, so gap/cut milliseconds stay comparable across
 * runs. Wording reuses the existing eval fragments (LONG_ASK, reachInvite,
 * goodbyeCut, TAG=Lime 42) and the e2e specs they mirror; nothing here
 * retunes pipeline thresholds or gains — the windows quote them.
 *
 * The harness measures the greeting-cut reply gap (ticket 03), the
 * filler-ignored beat (ticket 04) and the real-cut-answered beat
 * (ticket 05): per-beat gap samples plus a reply-gap gate, resume-tail
 * timing plus a filler-resume gate, and cut-to-answer timing plus a
 * barge-in-cut gate — all can FAIL. Every other beat's drain
 * milliseconds are still placeholders, probe counts start at zero, and
 * the remaining gates report PASS/INFO (no FAIL until gating lands in
 * later tickets). What this module guarantees
 * is trustworthy plumbing — one JSON artifact per run with redacted
 * transcripts plus their hash, and empty human-rating slots.
 */
import { createHash } from "node:crypto";
import { getVoice, VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";
import { BARGE_IN_JUDGE_MS, judgeOverlap, type OverlapVerdict } from "../voice/barge-in";
import { NO_WORDS_RESUME_MS, RESUME_WAIT_MS, unheardRest } from "../voice/session";
import { DEMO_VOICE_IDS } from "./voni-agent";

/** The locked golden script: seven beats in fixed order (spec story 11). */
export const GOLDEN_BEATS = [
  "greeting-cut",
  "filler-ignored",
  "real-cut-answered",
  "overheard-aside",
  "silence-check-in",
  "email-invite",
  "goodbye-drain",
] as const;

export type GoldenBeat = (typeof GOLDEN_BEATS)[number];

/** The golden call is one 90-second property-inquiry Demo call. */
export const GOLDEN_VERTICAL = "property-inquiry";
export const GOLDEN_SCRIPT_BUDGET_S = 90;

/**
 * One beat's timing window: the fixed bound the beat's metric must land in
 * for runs to stay comparable. `ms` windows quote the pipeline's own bars
 * (stop-over 1.5s, resume tail 2.5s, 15s check-in, 1.5s hang-up); `count`
 * windows pin exact-once behaviour (overheard recall 1/1, tag said once).
 */
export type BeatWindow = {
  metric: string;
  unit: "ms" | "count";
  min: number;
  max: number;
};

export type GoldenBeatSpec = {
  beat: GoldenBeat;
  /** Fixed visitor wording (or fixed silence) that opens the beat. */
  visitor: string;
  /** Pass predicate: what the composed call must audibly do. */
  expect: string;
  window: BeatWindow;
  /** Prior art this beat's wording is taken from. */
  source: string;
};

/**
 * The locked script. Fixed order, fixed wording, fixed windows — a new
 * voice deploys as a registry entry plus a matrix run, never a script edit.
 */
export const GOLDEN_SCRIPT: GoldenBeatSpec[] = [
  {
    beat: "greeting-cut",
    visitor: '"Wait, stop." spoken 1s into Voni\'s greeting',
    expect: "the greeting audio cuts; the cut lands inside the window",
    window: { metric: "cut-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS greeting-cut",
  },
  {
    beat: "filler-ignored",
    visitor: '"Okaay so" (likewise "mm-hmm" / "yeah") over Voni\'s long dental-clinic answer',
    expect: "the floor never yields; if the filler briefly cuts, Voni resumes with the exact unheard tail",
    window: { metric: "resume-tail-latency", unit: "ms", min: 0, max: 2500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS filler-over (LONG_ASK dental clinic)",
  },
  {
    beat: "real-cut-answered",
    visitor: '"Wait, stop." over the long dental-clinic answer, then the real point ("price?")',
    expect: "the cut lands and the real point is answered, never resumed past",
    window: { metric: "cut-to-answer-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS stop-over (story 4: answered within 1500ms)",
  },
  {
    beat: "overheard-aside",
    visitor: '"We\'re a bakery, actually." while Voni holds the floor',
    expect: "the aside is marked Overheard speech and counted in the call ledger, never lost",
    window: { metric: "asides-recalled", unit: "count", min: 1, max: 1 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS over-talk (story 7)",
  },
  {
    beat: "silence-check-in",
    visitor: "(silence) 15s with no visitor speech on a free floor",
    expect: 'exactly one check-in ("Still with me? Take your time."), never over a caller who starts talking',
    window: { metric: "check-in-at-silence", unit: "ms", min: 15000, max: 18000 },
    source: "src/lib/demo/voni-agent.ts SILENCE_CHECK_IN_MS + tests/e2e/demo-races.spec.ts 15s test",
  },
  {
    beat: "email-invite",
    visitor:
      '"We run a small property agency in Lisbon." / "Most of our inquiries come by phone and email, and we miss a lot after hours." / "Sure, let\'s try something."',
    expect: 'the invite is said once with the exact Test tag "Lime 42" as one whole number — never digit by digit, never invented',
    window: { metric: "tag-mentions", unit: "count", min: 1, max: 1 },
    source:
      "scripts/eval-demo-agent.mts reachInvite + EMAIL_SCENARIOS invite-tag (TAG=Lime 42) + tests/e2e/demo-email-test.spec.ts",
  },
  {
    beat: "goodbye-drain",
    visitor: '"I want you to hang up."',
    expect: "the goodbye names hi@voni.cc, plays in full (>=80% of its speaking time), then End call closes the session",
    window: { metric: "hang-up-after-goodbye-audio", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts hang-up-fast + goodbyeCut + tests/e2e/demo-call-quality.spec.ts goodbye drain",
  },
];

export const SCOREBOARD_SCHEMA_VERSION = 3;

export type BeatTiming = {
  /** Reply gap: visitor end-of-speech → first agent audio (p50 across runs; null until measured). */
  gapMs: number | null;
  /** Every measured reply gap for this beat, one per run (empty until measured). */
  gapSamples: number[];
  /** Barge-in cut latency (real-cut gate sets it; null until measured). */
  cutMs: number | null;
  /** Filler-resume tail: cut → resume first audio (ticket 04; null when never cut). */
  resumeMs: number | null;
  /** Goodbye drain: goodbye end → session end. Placeholder until the drain ticket. */
  drainMs: number | null;
  status: "PASS" | "INFO" | "FAIL";
  note: string;
};

export type GateStatus = "PASS" | "INFO" | "FAIL";

export type ScoreboardGate = {
  name: string;
  status: GateStatus;
  detail: string;
};

/**
 * Reply-gap budgets (spec stories 2–4): the Demo call feels laggy past
 * these, so the scoreboard fails. The greeting-cut beat shares the same
 * budget — cutting the greeting must answer just as fast as any turn.
 */
export const REPLY_GAP_P50_BUDGET_MS = 1500;
export const REPLY_GAP_P95_BUDGET_MS = 2500;

/** One measured reply gap, attributed to the beat that produced it (null = call-level, unattributed). */
export type ReplyGapSample = {
  beat: GoldenBeat | null;
  /** Visitor end-of-speech → first agent audio, in milliseconds. */
  gapMs: number;
  /** 1-based VONI reply turn in the merged Call trace (null when unattributed). */
  turnIndex: number | null;
  sessionId?: string;
};

export type ReplyGapSummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  worst: ReplyGapSample;
};

/**
 * Visitor end-of-speech → first agent audio. Null when either mark is
 * missing. Same subtraction the call-trace merger prints as `gap Nms`
 * (scripts/call-trace.mts), so the gate judges the merger's own numbers.
 */
export function replyGapMs(
  userSpeechEndedAtMs: number | null | undefined,
  agentReplyStartedAtMs: number | null | undefined,
): number | null {
  if (typeof userSpeechEndedAtMs !== "number" || typeof agentReplyStartedAtMs !== "number") return null;
  return agentReplyStartedAtMs - userSpeechEndedAtMs;
}

/** Nearest-rank percentile; same math as the session-evidence exporter. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export type TraceGap = {
  gapMs: number;
  /** 1-based VONI reply turn in the merged Call trace excerpt. */
  turnIndex: number;
};

/**
 * Reuse the call-trace merger's per-turn `gap Nms` numbers: every VONI
 * reply line carries one. Cut turns (`CUT at …`) are skipped — an
 * interrupted reply measures cut latency (the cut ticket's metric), not
 * the reply gap. Turn numbers count every VONI reply line, so a failing
 * gate can point at the exact Call trace turn.
 */
export function parseTraceGaps(excerpt: string[]): TraceGap[] {
  const gaps: TraceGap[] = [];
  let turn = 0;
  for (const line of excerpt) {
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    if (line.includes("CUT at")) continue;
    const match = /gap (\d+)ms/.exec(line);
    if (match) gaps.push({ gapMs: Number(match[1]), turnIndex: turn });
  }
  return gaps;
}

export function summarizeReplyGaps(samples: ReplyGapSample[]): ReplyGapSummary | null {
  if (samples.length === 0) return null;
  const p50Ms = percentile(samples.map((s) => s.gapMs), 50) ?? 0;
  const p95Ms = percentile(samples.map((s) => s.gapMs), 95) ?? 0;
  let worst = samples[0];
  for (const sample of samples) {
    if (sample.gapMs > worst.gapMs) worst = sample;
  }
  return { count: samples.length, p50Ms, p95Ms, maxMs: worst.gapMs, worst };
}

function traceRef(sample: ReplyGapSample): string {
  const where =
    sample.turnIndex !== null && sample.turnIndex !== undefined
      ? `call trace turn ${sample.turnIndex}${sample.sessionId ? ` (${sample.sessionId})` : ""}`
      : sample.sessionId
        ? `call trace ${sample.sessionId}`
        : "call trace";
  return `${sample.beat ?? "overall"} gap ${sample.gapMs}ms at ${where}`;
}

/**
 * Enforced Reply-gap gate (spec stories 2–4): FAIL when any beat's — or
 * the whole call's — p50 exceeds 1500ms or p95 exceeds 2500ms, pointing at
 * the failing Call trace turn. The greeting-cut beat is evaluated against
 * the same budget, never a looser one. No samples means INFO, never FAIL:
 * an unevidenced run records plumbing, it does not cry laggy.
 */
export function replyGapGate(samples: ReplyGapSample[], traceSessionId?: string): ScoreboardGate {
  if (samples.length === 0) {
    return {
      name: "reply-gap",
      status: "INFO",
      detail: "no measured gaps yet: score a golden call with --trace-session or --gap beat=ms",
    };
  }
  const withSession = traceSessionId
    ? samples.map((s) => (s.sessionId ? s : { ...s, sessionId: traceSessionId }))
    : samples;
  const overall = summarizeReplyGaps(withSession);
  if (!overall) {
    return { name: "reply-gap", status: "INFO", detail: "no measured gaps yet" };
  }
  const scopes: { scope: string; summary: ReplyGapSummary }[] = [{ scope: "overall", summary: overall }];
  for (const beat of GOLDEN_BEATS) {
    const beatSummary = summarizeReplyGaps(withSession.filter((s) => s.beat === beat));
    if (beatSummary) scopes.push({ scope: beat, summary: beatSummary });
  }
  type Breach = { scope: string; metric: "p50" | "p95"; value: number; budget: number };
  const breaches: Breach[] = [];
  for (const { scope, summary } of scopes) {
    if (summary.p50Ms > REPLY_GAP_P50_BUDGET_MS) {
      breaches.push({ scope, metric: "p50", value: summary.p50Ms, budget: REPLY_GAP_P50_BUDGET_MS });
    }
    if (summary.p95Ms > REPLY_GAP_P95_BUDGET_MS) {
      breaches.push({ scope, metric: "p95", value: summary.p95Ms, budget: REPLY_GAP_P95_BUDGET_MS });
    }
  }
  if (breaches.length > 0) {
    breaches.sort((a, b) => b.value - b.budget - (a.value - a.budget));
    const first = breaches[0];
    const scope = first.scope === "overall" ? "overall" : `beat ${first.scope}`;
    return {
      name: "reply-gap",
      status: "FAIL",
      detail:
        `${first.metric} ${first.value}ms > ${first.budget}ms budget (${scope}; ` +
        `overall p50 ${overall.p50Ms}ms / p95 ${overall.p95Ms}ms, n=${overall.count}; ` +
        `worst ${traceRef(overall.worst)})`,
    };
  }
  return {
    name: "reply-gap",
    status: "PASS",
    detail:
      `p50 ${overall.p50Ms}ms / p95 ${overall.p95Ms}ms within ` +
      `${REPLY_GAP_P50_BUDGET_MS}/${REPLY_GAP_P95_BUDGET_MS}ms budgets (n=${overall.count})`,
  };
}

/**
 * Meaning-based end-of-turn must stay on: ANY turn_detection object —
 * even one holding only an interruption delay — switches off adaptive
 * end-of-turn (ADR-0003), measured 3.6–4.7s gaps with an object versus
 * 1.3–2.5s with none or null. Stored demo agents ship turn_detection:
 * null; the single sensitive-field exception keeps its narrow scoped
 * override only. FAIL points at the object or at the merged trace's
 * CONFIG line.
 */
export function meaningBasedEndOfTurnGate(
  agentInput: { turn_detection?: unknown } | null | undefined,
  traceExcerpt: string[] = [],
): ScoreboardGate {
  const sent =
    agentInput !== null &&
    agentInput !== undefined &&
    "turn_detection" in agentInput &&
    agentInput.turn_detection !== null &&
    agentInput.turn_detection !== undefined;
  if (sent) {
    return {
      name: "end-of-turn",
      status: "FAIL",
      detail: `turn_detection object sent (${JSON.stringify(agentInput.turn_detection)?.slice(0, 120)}): disables adaptive end-of-turn (ADR-0003); stored demo agents must send turn_detection: null`,
    };
  }
  const configLine = traceExcerpt.find((line) => line.includes("turn_detection"));
  if (configLine) {
    return {
      name: "end-of-turn",
      status: "FAIL",
      detail: `call trace shows a turn_detection CONFIG line (${configLine.trim().slice(0, 160)}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
    };
  }
  return {
    name: "end-of-turn",
    status: "PASS",
    detail: "meaning-based end-of-turn preserved: no turn_detection object sent (turn_detection null)",
  };
}

export type ScoreboardArtifact = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  /** Gate voice, resolved through the shared voice registry. */
  voice: string;
  runs: number;
  /** The locked golden script this run scores against (fixed order/wording/windows). */
  goldenScript: {
    vertical: typeof GOLDEN_VERTICAL;
    budgetS: typeof GOLDEN_SCRIPT_BUDGET_S;
    beats: GoldenBeatSpec[];
  };
  /** Non-gate demo voices: regression-only, never gating (spec story 14). */
  regressionVoices: string[];
  beats: Record<GoldenBeat, BeatTiming>;
  /** Whole-call Reply gap: p50/p95 across every measured beat sample (nulls until measured). */
  replyGap: { p50Ms: number | null; p95Ms: number | null; samples: number };
  overheard: { recalled: number; total: number | null };
  doubleTalk: { overlapMs: number[]; maxMs: number | null };
  deadAir: { gapsMs: number[]; maxMs: number | null };
  probes: { jump: number; overload: number; clip: number; underrun: number; inputDrop: number };
  transcripts: { sha256: string; redacted: string[] };
  humanRatings: { timbre: number | null; accent: number | null };
  gates: ScoreboardGate[];
  evalRunner: {
    scenario: string;
    passed: boolean | null;
    exitCode: number | null;
    durationMs: number;
    rawSha256: string;
  };
  /** Merged Call trace excerpt for a finished real-call session (via --trace-session). */
  callTrace?: {
    sessionId: string;
    excerptSha256: string;
    excerpt: string[];
  } | null;
};

/**
 * The locked gate default: the first demo voice, resolved through the
 * registry at use time. Named once here so neither the orchestrator, the
 * scenarios, nor the assertions carry a voice literal.
 */
export const DEFAULT_GATE_VOICE: string = DEMO_VOICE_IDS[0];

/**
 * The gate voice is a parameter resolved through the shared voice registry,
 * never hard-coded in the orchestrator: deploying a new voice is a registry
 * change plus a regression run, not a harness change.
 */
export function resolveGateVoice(voiceId: string): string {
  const known = getVoice(voiceId);
  if (!known || !(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) {
    throw new Error(
      `unknown gate voice "${voiceId}": pick one of ${DEMO_VOICE_IDS.join(", ")}`,
    );
  }
  return known.id;
}

export type VoicePlayback = {
  /** Gate voice id, as resolved through the registry. */
  id: string;
  /** Server-side output level every agent ships (loudest, deterministic). */
  outputVolume: number;
  /** Client-side per-voice gain matching the voice to the reference level. */
  playbackGain: number;
};

/** Gate voice playback: server output volume plus per-voice gain, both from the registry. */
export function gateVoicePlayback(voiceId: string): VoicePlayback {
  const id = resolveGateVoice(voiceId);
  return { id, outputVolume: VOICE_OUTPUT_VOLUME, playbackGain: voicePlaybackGain(id) };
}

/**
 * Non-gate demo voices run regression-only (no clip, no pop, no invented
 * test tag): adding voices never breaks existing ones (spec story 14).
 */
export function regressionVoices(gateVoice: string): string[] {
  resolveGateVoice(gateVoice);
  return (DEMO_VOICE_IDS as readonly string[]).filter((voice) => voice !== gateVoice);
}

/** Dry-run listing: every beat with its window, plus the resolved gate and regression set. */
export function formatGoldenScript(gateVoice: string): string {
  const playback = gateVoicePlayback(gateVoice);
  const lines = GOLDEN_SCRIPT.map(
    (beat, index) =>
      `${index + 1}. ${beat.beat} — visitor: ${beat.visitor} — window: ${beat.window.metric} ${beat.window.min}–${beat.window.max} ${beat.window.unit} — expect: ${beat.expect}`,
  );
  const regression = regressionVoices(gateVoice)
    .map((voice) => `${voice} (gain ${voicePlaybackGain(voice)})`)
    .join(", ");
  return [
    `golden script (${GOLDEN_VERTICAL}, ~${GOLDEN_SCRIPT_BUDGET_S}s, gate ${playback.id} vol=${playback.outputVolume} gain=${playback.playbackGain})`,
    ...lines,
    `regression voices: ${regression}`,
  ].join("\n");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Redact PII the way the session-evidence exporter does before persisting. */
export function redactTranscript(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[credential]");
}

export function redactLines(stdout: string, limit = 200): string[] {
  return stdout
    .split("\n")
    .map((line) => redactTranscript(line).trim())
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Ticket 04: filler-ignored + resume-tail gate.
 *
 * Back-channels never derail the Demo call: filler, back-channel speech and
 * the agent's own echo must never steal the floor. The source of truth is
 * the overlap judge (`judgeOverlap` in ../voice/barge-in): filler/echo
 * resolve to "ignore" synchronously, commands and end-call requests to
 * "yield", and anything ambiguous goes to the Jev judge with a short
 * timeout and fail-closed heuristics (an undecided or timed-out judgment
 * yields, so the caller is answered instead of talked over).
 *
 * When a filler does briefly cut the agent, the recovery must be human: the
 * agent resumes exactly the unheard rest of the cut line (same
 * `unheardRest` the session uses) within the resume-tail budget, and never
 * answers over the resumption.
 *
 * Thresholds quoted, not retuned (spec: the harness proves the baseline):
 * - overlap judge budget BARGE_IN_JUDGE_MS (400ms) decides yield vs resume;
 * - the session waits RESUME_WAIT_MS (500ms) for the server's own reply to
 *   the barge-in, then falls back after NO_WORDS_RESUME_MS (800ms) with no
 *   caller words — both well inside the resume-tail budget below.
 */

/** A brief filler cut recovers with the exact unheard tail inside this budget (spec story 6). */
export const FILLER_RESUME_TAIL_BUDGET_MS = 2500;

/**
 * Resolved overlap outcome the pipeline reported for the filler beat:
 * the synchronous judge verdict, or "keep" once the Jev judge decided an
 * ambiguous overlap was not real and the agent resumed.
 */
export type FillerVerdict = OverlapVerdict | "keep";

/** Observed evidence for the filler-ignored beat: what the caller said, what the floor did. */
export type FillerResumeEvidence = {
  /** The overlapping visitor speech ("Okaay so", "mm-hmm", "yeah", agent echo). */
  visitorText: string;
  /** The agent line it overlapped (source for the echo check and the resume tail). */
  agentText: string;
  /** What the pipeline decided: ignore/keep resumes, yield (or undecided judge) steals the floor. */
  verdict: FillerVerdict;
  /** Visitor-speech-start → agent-audio-stop; null when the filler never cut. */
  cutMs: number | null;
  /** Cut → resume first audio; null when never cut, or when cut and never resumed. */
  resumeMs: number | null;
  /** What the agent said as the resume ("" when never cut). */
  resumedText: string;
  /** Agent words heard before the cut (the resume re-says the cut word, then the rest). */
  heardText: string;
  /** The server answered over the resumption instead of letting it play. */
  answeredOver: boolean;
  /** Call trace turn the failure points at (spec: every failure names its turn). */
  traceTurn?: string;
};

/**
 * Gate the filler-ignored beat. PASS keeps the floor (or recovers it
 * humanly); every FAIL names the cut milliseconds, the judge verdict and
 * the Call trace turn so the failure points at a turn, not a vibe.
 */
export function evaluateFillerResumeGate(evidence: FillerResumeEvidence): ScoreboardGate {
  const name = "filler-resume";
  const trace = evidence.traceTurn ?? "(no trace turn)";
  const expected = judgeOverlap(evidence.visitorText, evidence.agentText);
  const cut = evidence.cutMs === null ? "never cut" : `${evidence.cutMs}ms`;
  const fail = (detail: string): ScoreboardGate => ({
    name,
    status: "FAIL",
    detail: `${detail} (cut: ${cut}; judge verdict: ${evidence.verdict}, expected: ${expected}; trace: ${trace})`,
  });
  // Not filler at all: steering, end-call and real content yield per the
  // judge. Blessing a yield here would hide a threshold regression, and the
  // real-cut ticket owns the yield path.
  if (expected === "yield") {
    return fail(`not filler per the overlap judge: "${evidence.visitorText}" yields`);
  }
  // Fail-closed: a stolen floor, or an ambiguous overlap still held for the
  // judge, counts as derailed — the caller must be answered, not resumed.
  if (evidence.verdict === "yield" || evidence.verdict === "judge") {
    return fail(`floor stolen by back-channel "${evidence.visitorText}": fail-closed yield`);
  }
  // Ambiguous overlap resumes only on an explicit Jev keep.
  if (expected === "judge" && evidence.verdict !== "keep") {
    return fail(`ambiguous overlap "${evidence.visitorText}" resumed without a Jev keep`);
  }
  if (evidence.cutMs === null) {
    if (evidence.resumeMs !== null || evidence.answeredOver) {
      return fail("inconsistent evidence: never cut but a resume was reported");
    }
    return {
      name,
      status: "PASS",
      detail: `filler "${evidence.visitorText}" ignored (judge verdict: ${evidence.verdict}, expected: ${expected}); floor held, never cut; trace: ${trace}`,
    };
  }
  if (evidence.resumeMs === null) {
    return fail("brief cut never resumed: the exact unheard tail never played");
  }
  if (evidence.resumeMs > FILLER_RESUME_TAIL_BUDGET_MS) {
    return fail(
      `resume tail too slow: ${evidence.resumeMs}ms exceeds the ${FILLER_RESUME_TAIL_BUDGET_MS}ms budget (judge ${BARGE_IN_JUDGE_MS}ms + server-wait ${RESUME_WAIT_MS}ms + no-words ${NO_WORDS_RESUME_MS}ms)`,
    );
  }
  if (evidence.answeredOver) {
    return fail("answered over the resumption instead of resuming the exact tail");
  }
  const tail = unheardRest(evidence.agentText, evidence.heardText);
  if (evidence.resumedText.trim() !== tail.trim()) {
    return fail(`resume tail inexact: said "${evidence.resumedText}" instead of "${tail}"`);
  }
  return {
    name,
    status: "PASS",
    detail: `filler "${evidence.visitorText}" cut at ${evidence.cutMs}ms (judge verdict: ${evidence.verdict}), resumed the exact tail in ${evidence.resumeMs}ms (budget ${FILLER_RESUME_TAIL_BUDGET_MS}ms); trace: ${trace}`,
  };
}

/**
 * Ticket 05: real-cut answered gate (spec story 4).
 *
 * A real Barge-in with a point always wins the floor fast and gets answered,
 * never resumed-over. The server owns the cut (ADR-0003): the session stops
 * the agent, then the overlap judge decides yield versus resume. This gate
 * reuses that same judge, so "real" here means exactly what the pipeline
 * yields on: steering, command, and end-call requests always yield, and
 * multi-word content goes to Jev, which fail-closes to yield (only a real
 * Jev "keep" resumes). Filler, back-channels, and echo never yield.
 */

/** A real cut lands within the stop-over 1.5s bar (spec story 4). */
export const REAL_CUT_MAX_MS = 1500;

/** Eval scenarios whose output carries real-cut evidence. */
export const REAL_CUT_SCENARIOS = ["stop-over", "hang-up-over", "hang-up-fast"] as const;

/**
 * Externally observable real-cut evidence: cut latency from caller speech
 * start to the server cut, the judge verdict from the session events, whether
 * the agent answered the point, whether old material was resumed instead, and
 * the Call trace turn that shows it. `ended` covers end-call requests, whose
 * yield is the goodbye plus hang-up rather than a measured cut.
 */
export type RealCutEvidence = {
  cutMs: number | null;
  verdict: string | null;
  verdictSource: string | null;
  answered: boolean;
  resumed: boolean;
  ended: boolean;
  traceTurn: string | null;
};

/**
 * Whether caller speech over the agent is real enough to yield, using the
 * shared overlap judge (barge-in.ts) and its thresholds — never a copy of
 * them. Command ("stop", "hold on") and end-call ("hang up") requests always
 * yield; content ("tell me the price please") goes to the judge; filler
 * ("mm-hmm", "Okaay so") and echo never do.
 */
export function isRealCutExpected(visitorText: string, agentText = ""): boolean {
  return judgeOverlap(visitorText, agentText) !== "ignore";
}

/** Failure detail always reports cut ms plus judge verdict with the trace turn. */
function realCutDetail(evidence: RealCutEvidence, reason: string): string {
  const cut = evidence.cutMs === null ? "never cut" : `cut ${evidence.cutMs}ms`;
  const verdict = evidence.verdict ?? "unreported";
  const source = evidence.verdictSource ? `/${evidence.verdictSource}` : "";
  const trace = evidence.traceTurn ?? "no trace turn";
  return `${cut} (verdict ${verdict}${source}; trace: ${trace}) — ${reason}`;
}

/**
 * The real-cut gate: PASS only when a real cut yields fast and is answered
 * on point with no resume of old material. Every FAIL names the cut
 * milliseconds, the judge verdict, and the Call trace turn.
 */
export function evaluateRealCut(evidence: RealCutEvidence): ScoreboardGate {
  if (evidence.resumed) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "resumed with old material instead of answering"),
    };
  }
  if (evidence.cutMs === null && !evidence.ended) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "never cut"),
    };
  }
  if (evidence.cutMs !== null && evidence.cutMs > REAL_CUT_MAX_MS) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(
        evidence,
        `cut too late: ${evidence.cutMs}ms exceeds ${REAL_CUT_MAX_MS}ms`,
      ),
    };
  }
  if (!evidence.answered && !evidence.ended) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "the point was never answered"),
    };
  }
  const cut = evidence.cutMs === null ? "yielded; session ended with no resume" : `answered in ${evidence.cutMs}ms`;
  return {
    name: "barge-in-cut",
    status: "PASS",
    detail: `real cut ${cut} (verdict ${evidence.verdict ?? "unreported"})`,
  };
}

/**
 * Parse real-cut evidence from the eval runner's stdout. Returns null when
 * the output carries no real-cut scenario summary, so unrelated scenarios
 * leave the gate ungated.
 */
export function extractRealCutEvidence(stdout: string): RealCutEvidence | null {
  const summary = stdout.match(/^(stop-over|hang-up-over|hang-up-fast): (\d+)\/(\d+)/m);
  if (!summary) return null;
  const scenario = summary[1];
  const passed = Number(summary[2]) > 0;
  const cut = stdout.match(/cut (\d+)ms after the caller started/);
  const verdict = stdout.match(/\["(yield|ignore|keep|judge)"(,|\])/)?.[1] ?? null;
  const resumed = /resumed instead of ending|Pick up where you left off/.test(stdout);
  const ended = scenario.startsWith("hang-up") && passed && !resumed;
  return {
    cutMs: cut ? Number(cut[1]) : null,
    verdict,
    verdictSource: null,
    answered: passed && !resumed,
    resumed,
    ended,
    traceTurn: null,
  };
}

/** Stamp evaluated real-cut evidence onto the artifact beat and gate. */
export function applyRealCutGate(
  artifact: ScoreboardArtifact,
  evidence: RealCutEvidence,
): ScoreboardArtifact {
  const gate = evaluateRealCut(evidence);
  const prior = artifact.beats["real-cut-answered"];
  return {
    ...artifact,
    beats: {
      ...artifact.beats,
      "real-cut-answered": {
        gapMs: prior.gapMs,
        gapSamples: prior.gapSamples,
        cutMs: evidence.cutMs,
        resumeMs: prior.resumeMs,
        drainMs: null,
        status: gate.status === "PASS" ? "PASS" : "FAIL",
        note: gate.detail,
      } satisfies BeatTiming,
    },
    gates: artifact.gates.map((g) => (g.name === "barge-in-cut" ? gate : g)),
  };
}

/** Skeleton gates: reported but never failed without measured evidence. */
function skeletonGates(
  exitCode: number | null,
  replySamples: ReplyGapSample[],
  traceSessionId: string | null,
  agentInput: { turn_detection?: unknown } | null | undefined,
  traceExcerpt: string[],
  fillerGate: ScoreboardGate | null = null,
): ScoreboardGate[] {
  const plumbing: ScoreboardGate =
    exitCode === null || exitCode === 0
      ? { name: "plumbing", status: "PASS", detail: "eval runner finished" }
      : {
          name: "plumbing",
          status: "INFO",
          detail: `eval runner exited ${exitCode} (skeleton: recorded, not failed)`,
        };
  const replyGate =
    replySamples.length > 0
      ? replyGapGate(replySamples, traceSessionId ?? undefined)
      : { name: "reply-gap", status: "INFO" as const, detail: "skeleton: gating lands in the reply-gap ticket" };
  const endOfTurn =
    agentInput === undefined
      ? { name: "end-of-turn", status: "INFO" as const, detail: "skeleton: agent body not checked" }
      : meaningBasedEndOfTurnGate(agentInput, traceExcerpt);
  const filler: ScoreboardGate =
    fillerGate ?? { name: "filler-resume", status: "INFO", detail: "skeleton: gating lands in the filler ticket" };
  return [
    plumbing,
    replyGate,
    endOfTurn,
    {
      name: "barge-in-cut",
      status: "INFO",
      detail: "no real-cut evidence (run --scenario stop-over or pass --cut-ms/--cut-verdict/--cut-answered)",
    },
    filler,
    { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    { name: "double-talk", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "dead-air", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "timbre-probes", status: "INFO", detail: "skeleton: gating lands in the timbre ticket" },
    { name: "accent-human", status: "INFO", detail: "skeleton: awaiting human 1-5 ratings" },
  ];
}

export function buildSkeletonArtifact(input: {
  voice: string;
  scenario: string;
  runnerStdout: string;
  exitCode: number | null;
  durationMs: number;
  runs: number;
  /** Measured reply gaps per beat (visitor end-of-speech → first agent audio). Absent = unmeasured. */
  gaps?: Partial<Record<GoldenBeat, number[]>>;
  /**
   * Gaps merged from a Call trace excerpt (scripts/call-trace.mts `gap Nms`
   * numbers). The first merged turn answers the greeting cut — golden runs
   * open with the visitor cutting the greeting — so it attributes to the
   * greeting-cut beat unless explicit greeting-cut gaps were passed. Later
   * turns stay call-level: only the golden order is fixed, never the turn
   * count (resumes and tool turns interleave).
   */
  traceGaps?: TraceGap[];
  /** Session the gaps were merged from (trace pointer for a failing gate). */
  traceSessionId?: string | null;
  /** Stored agent body input for the end-of-turn check (undefined = not checked). */
  agentInput?: { turn_detection?: unknown } | null;
  /** Merged Call trace excerpt lines (scanned for turn_detection CONFIG lines). */
  traceExcerpt?: string[];
  /** Observed filler-beat evidence: when present, the filler-resume gate evaluates instead of staying INFO. */
  fillerResume?: FillerResumeEvidence | null;
}): ScoreboardArtifact {
  const fillerGate = input.fillerResume ? evaluateFillerResumeGate(input.fillerResume) : null;
  const samples: ReplyGapSample[] = [];
  const finiteGaps = (beat: GoldenBeat): number[] => (input.gaps?.[beat] ?? []).filter((n) => Number.isFinite(n));
  const explicitGreetingCut = finiteGaps("greeting-cut").length > 0;
  // The first merged trace turn answers the greeting cut (see traceGaps
  // above); it joins the greeting-cut beat unless measured explicitly.
  const traceFirstToGreetingCut =
    !explicitGreetingCut && (input.traceGaps ?? []).length > 0 ? [(input.traceGaps as TraceGap[])[0].gapMs] : [];
  for (const beat of GOLDEN_BEATS) {
    const fromTrace = beat === "greeting-cut" ? traceFirstToGreetingCut : [];
    for (const gapMs of [...fromTrace, ...finiteGaps(beat)]) {
      samples.push({ beat, gapMs, turnIndex: null, sessionId: input.traceSessionId ?? undefined });
    }
  }
  for (const traceGap of (input.traceGaps ?? []).slice(explicitGreetingCut ? 0 : 1)) {
    samples.push({
      beat: null,
      gapMs: traceGap.gapMs,
      turnIndex: traceGap.turnIndex,
      sessionId: input.traceSessionId ?? undefined,
    });
  }
  const overall = summarizeReplyGaps(samples);
  const beats = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => {
      const beatSamples = finiteGaps(beat).concat(beat === "greeting-cut" ? traceFirstToGreetingCut : []);
      const measured = beatSamples.length > 0;
      const beatSummary = summarizeReplyGaps(
        beatSamples.map((gapMs) => ({ beat, gapMs, turnIndex: null as number | null })),
      );
      const breaches =
        (beatSummary?.p50Ms ?? 0) > REPLY_GAP_P50_BUDGET_MS ||
        (beatSummary?.p95Ms ?? 0) > REPLY_GAP_P95_BUDGET_MS;
      return [
        beat,
        {
          gapMs: beatSummary?.p50Ms ?? null,
          gapSamples: beatSamples,
          cutMs: null,
          resumeMs: null,
          drainMs: null,
          status: "PASS",
          note: measured
            ? `reply gap p50 ${beatSummary?.p50Ms}ms / p95 ${beatSummary?.p95Ms}ms over ${beatSamples.length} run${beatSamples.length === 1 ? "" : "s"}${breaches ? " (over budget: see reply-gap gate)" : ""}`
            : "skeleton: placeholder until per-beat timing lands",
        } satisfies BeatTiming,
      ];
    }),
  ) as Record<GoldenBeat, BeatTiming>;
  if (fillerGate && input.fillerResume) {
    const prior = beats["filler-ignored"];
    beats["filler-ignored"] = {
      gapMs: prior.gapMs,
      gapSamples: prior.gapSamples,
      cutMs: input.fillerResume.cutMs,
      resumeMs: input.fillerResume.resumeMs,
      drainMs: null,
      status: fillerGate.status === "FAIL" ? "FAIL" : "PASS",
      note: fillerGate.detail,
    };
  }
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    voice: input.voice,
    runs: input.runs,
    goldenScript: {
      vertical: GOLDEN_VERTICAL,
      budgetS: GOLDEN_SCRIPT_BUDGET_S,
      beats: GOLDEN_SCRIPT,
    },
    regressionVoices: regressionVoices(input.voice),
    beats,
    replyGap: { p50Ms: overall?.p50Ms ?? null, p95Ms: overall?.p95Ms ?? null, samples: overall?.count ?? 0 },
    overheard: { recalled: 0, total: null },
    doubleTalk: { overlapMs: [], maxMs: null },
    deadAir: { gapsMs: [], maxMs: null },
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings: { timbre: null, accent: null },
    gates: skeletonGates(input.exitCode, samples, input.traceSessionId ?? null, input.agentInput, input.traceExcerpt ?? [], fillerGate),
    evalRunner: {
      scenario: input.scenario,
      passed: input.exitCode === null ? null : input.exitCode === 0,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      rawSha256: sha256Hex(input.runnerStdout),
    },
  };
}

/** Console pass/fail table: one row per gate. */
export function formatGateTable(artifact: ScoreboardArtifact): string {
  const rows = artifact.gates.map(
    (gate) => `${gate.status.padEnd(6)} ${gate.name.padEnd(16)} ${gate.detail}`,
  );
  return [
    `demo scoreboard (${artifact.voice}, ${artifact.runs} run${artifact.runs === 1 ? "" : "s"})`,
    ...rows,
  ].join("\n");
}
