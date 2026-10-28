/**
 * Demo scoreboard: locked golden script (ticket 02) on the ticket-01
 * plumbing. The seven beats below are fixed order, fixed visitor wording,
 * and fixed timing windows, so gap/cut milliseconds stay comparable across
 * runs. Wording reuses the existing eval fragments (LONG_ASK, reachInvite,
 * goodbyeCut, TAG=Lime 42) and the e2e specs they mirror; nothing here
 * retunes pipeline thresholds or gains — the windows quote them.
 *
 * The harness measures nothing yet: per-beat gap/cut/drain milliseconds are
 * placeholders, probe counts start at zero, and every gate reports PASS/INFO
 * (no FAIL until gating lands in later tickets). What this module guarantees
 * is trustworthy plumbing — one JSON artifact per run with redacted
 * transcripts plus their hash, and empty human-rating slots.
 */
import { createHash } from "node:crypto";
import { getVoice, VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";
import { judgeOverlap } from "../voice/barge-in";
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

export const SCOREBOARD_SCHEMA_VERSION = 2;

export type BeatTiming = {
  /** Reply gap: visitor end-of-speech → first agent audio. Placeholder until ticket 02. */
  gapMs: number | null;
  /** Barge-in cut latency. Placeholder until the cut ticket. */
  cutMs: number | null;
  /** Goodbye drain: goodbye end → session end. Placeholder until the drain ticket. */
  drainMs: number | null;
  status: "PASS" | "INFO";
  note: string;
};

export type GateStatus = "PASS" | "INFO" | "FAIL";

export type ScoreboardGate = {
  name: string;
  status: GateStatus;
  detail: string;
};

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
  overheard: {
    recalled: number;
    total: number;
    byBeat: Record<GoldenBeat, { recalled: number; total: number }>;
    asides: OverheardAside[];
  };
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
 * Overheard speech: visitor words spoken while Voni holds the floor.
 * Marked in the live caption ("· overheard") and counted in the call
 * ledger (session transcripts) even when never answered — nothing said
 * while Voni speaks may vanish (spec story 7).
 */
export type OverheardKind = "steering" | "filler" | "content";

export type OverheardHandling = "answered" | "resumed-from" | "heard-only" | "lost";

export type OverheardAside = {
  /** Golden beat the aside belongs to (usually overheard-aside). */
  beat: GoldenBeat;
  /** Visitor words spoken while Voni held the floor. */
  text: string;
  /** What Voni was saying when the aside landed (overlap context). */
  agentText?: string;
  /** Live caption marked it Overheard speech (voice-call overheard row). */
  markedOverheard: boolean;
  /** Counted in the call ledger (session transcript / trace HEARD row). */
  inLedger: boolean;
  /** How the turn resolved: answered, resumed-from, heard-only, or lost. */
  handling: OverheardHandling;
  /** Call-trace pointer, e.g. `sess_abc :: 12.34s HEARD "..."`. */
  tracePointer: string;
};

export type OverheardFailure = { aside: OverheardAside; reason: string };

export type OverheardEvaluation = {
  recalled: number;
  total: number;
  byBeat: Record<GoldenBeat, { recalled: number; total: number }>;
  failures: OverheardFailure[];
  gate: ScoreboardGate;
};

/**
 * Kind reuses the overlap intelligence: `yield` (steering, command,
 * end-call) must be answered; `ignore` (filler, back-channel, echo) must
 * never derail the turn; `judge` (real content) must at least be heard.
 */
export function classifyOverheard(text: string, agentText = ""): OverheardKind {
  const verdict = judgeOverlap(text, agentText);
  if (verdict === "yield") return "steering";
  if (verdict === "ignore") return "filler";
  return "content";
}

/** Null when recalled; otherwise the human-readable reason it was lost. */
export function overheardRecallReason(aside: OverheardAside): string | null {
  if (!aside.text.trim()) return "empty aside text (nothing to recall)";
  if (!aside.markedOverheard) return "not marked Overheard speech in the caption";
  if (!aside.inLedger) return "missing from the call ledger";
  if (!aside.tracePointer.trim()) return "missing trace pointer";
  if (aside.handling === "lost") return "lost: never answered nor resumed-from";
  const kind = classifyOverheard(aside.text, aside.agentText ?? "");
  if (kind === "steering") {
    return aside.handling === "answered"
      ? null
      : `steering not answered (handling=${aside.handling})`;
  }
  if (kind === "filler") {
    return aside.handling === "answered"
      ? "filler derailed the turn (answered instead of resumed-from)"
      : null;
  }
  return null;
}

/**
 * Score every aside during agent speech. Steering must be answered;
 * filler must be resumed-from (or simply heard without cutting) and never
 * answered; content must be at least marked and ledger-counted. Reports
 * recalled/total overall plus per-beat counts with trace pointers.
 */
export function evaluateOverheardRecall(asides: OverheardAside[]): OverheardEvaluation {
  const byBeat = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [beat, { recalled: 0, total: 0 }]),
  ) as Record<GoldenBeat, { recalled: number; total: number }>;
  const failures: OverheardFailure[] = [];
  let recalled = 0;
  for (const aside of asides) {
    const slot = byBeat[aside.beat] ?? (byBeat[aside.beat] = { recalled: 0, total: 0 });
    slot.total += 1;
    const reason = overheardRecallReason(aside);
    if (reason === null) {
      recalled += 1;
      slot.recalled += 1;
    } else {
      failures.push({ aside, reason });
    }
  }
  const total = asides.length;
  const gate: ScoreboardGate =
    total === 0
      ? {
          name: "overheard-recall",
          status: "FAIL",
          detail: "no overheard asides observed (expected ≥1 on overheard-aside)",
        }
      : failures.length === 0
        ? {
            name: "overheard-recall",
            status: "PASS",
            detail: `${recalled}/${total} asides recalled (marked + ledger-counted with trace pointers)`,
          }
        : {
            name: "overheard-recall",
            status: "FAIL",
            detail: `${failures.length}/${total} asides lost: ${failures
              .slice(0, 3)
              .map((f) => `${f.reason} [${f.aside.tracePointer}]`)
              .join("; ")}`,
          };
  return { recalled, total, byBeat, failures, gate };
}

/**
 * Derive overheard asides from a Call-trace excerpt (HEARD/VONI per-turn
 * rows plus CLIENT barge-in verdicts, merged by `call:trace`). Every HEARD
 * row is ledger-counted; it is marked Overheard when Voni audio (a VONI
 * row) holds the floor in the excerpt. Handling comes from the CLIENT
 * barge-in verdict that follows it: `yield` → answered, `ignore`/`keep` →
 * resumed-from, otherwise heard-only (marked + counted even when never
 * answered). Pure and offline: no network, no transport.
 */
export function overheardFromTraceExcerpt(
  excerpt: string[],
  sessionId: string,
  beat: GoldenBeat = "overheard-aside",
): OverheardAside[] {
  // Every HEARD row handed in for the overheard beat is overheard by
  // construction: the golden script speaks it while Voni holds the floor,
  // and the live caption marks exactly that case (speakingRef.current →
  // `overheard: true`, covered by the voice-call overheard-row test). The
  // merged trace proves the ledger count; caption marking is asserted by
  // the caption path, not re-derived from trace timestamps here.
  void excerpt;
  const verdictFor = (index: number): OverheardHandling => {
    for (let i = index + 1; i < excerpt.length; i += 1) {
      const line = excerpt[i];
      if (/\bHEARD\b/.test(line)) break;
      const verdict = line.match(/barge-in\s+(yield|ignore|keep)\b/);
      if (verdict) {
        return verdict[1] === "yield" ? "answered" : "resumed-from";
      }
    }
    return "heard-only";
  };
  const asides: OverheardAside[] = [];
  excerpt.forEach((line, index) => {
    const heard = line.match(/\bHEARD\b\s+"([^"]+)"/);
    if (!heard) return;
    asides.push({
      beat,
      text: heard[1],
      markedOverheard: true,
      inLedger: true,
      handling: verdictFor(index),
      tracePointer: `${sessionId} :: ${line.trim().slice(0, 160)}`,
    });
  });
  return asides;
}

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

/** Skeleton gates: reported but never failed until gating lands per ticket. */
function skeletonGates(
  exitCode: number | null,
  overheardGate: ScoreboardGate | null = null,
): ScoreboardGate[] {
  const plumbing: ScoreboardGate =
    exitCode === null || exitCode === 0
      ? { name: "plumbing", status: "PASS", detail: "eval runner finished" }
      : {
          name: "plumbing",
          status: "INFO",
          detail: `eval runner exited ${exitCode} (skeleton: recorded, not failed)`,
        };
  return [
    plumbing,
    { name: "reply-gap", status: "INFO", detail: "skeleton: gating lands in the reply-gap ticket" },
    { name: "barge-in-cut", status: "INFO", detail: "skeleton: gating lands in the cut ticket" },
    overheardGate ??
      { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    { name: "double-talk", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "dead-air", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "timbre-probes", status: "INFO", detail: "skeleton: gating lands in the timbre ticket" },
    { name: "accent-human", status: "INFO", detail: "skeleton: awaiting human 1-5 ratings" },
  ];
}

function emptyOverheardByBeat(): Record<GoldenBeat, { recalled: number; total: number }> {
  return Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [beat, { recalled: 0, total: 0 }]),
  ) as Record<GoldenBeat, { recalled: number; total: number }>;
}

export function buildSkeletonArtifact(input: {
  voice: string;
  scenario: string;
  runnerStdout: string;
  exitCode: number | null;
  durationMs: number;
  runs: number;
  /** Overheard asides observed while Voni held the floor; omit to keep the skeleton INFO gate. */
  overheardAsides?: OverheardAside[];
}): ScoreboardArtifact {
  const beats = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [
      beat,
      {
        gapMs: null,
        cutMs: null,
        drainMs: null,
        status: "PASS",
        note: "skeleton: placeholder until per-beat timing lands",
      } satisfies BeatTiming,
    ]),
  ) as Record<GoldenBeat, BeatTiming>;
  const evaluation =
    input.overheardAsides === undefined
      ? null
      : evaluateOverheardRecall(input.overheardAsides);
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
    overheard: evaluation
      ? { recalled: evaluation.recalled, total: evaluation.total, byBeat: evaluation.byBeat, asides: input.overheardAsides! }
      : { recalled: 0, total: 0, byBeat: emptyOverheardByBeat(), asides: [] },
    doubleTalk: { overlapMs: [], maxMs: null },
    deadAir: { gapsMs: [], maxMs: null },
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings: { timbre: null, accent: null },
    gates: skeletonGates(input.exitCode, evaluation?.gate ?? null),
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

/** Console per-beat overheard recall counts with trace pointers. */
export function formatOverheardReport(artifact: ScoreboardArtifact): string {
  const lines = [
    `overheard recall ${artifact.overheard.recalled}/${artifact.overheard.total}`,
  ];
  for (const beat of GOLDEN_BEATS) {
    const slot = artifact.overheard.byBeat[beat];
    if (!slot || slot.total === 0) {
      lines.push(`  ${beat}: ${slot?.recalled ?? 0}/${slot?.total ?? 0}`);
      continue;
    }
    lines.push(`  ${beat}: ${slot.recalled}/${slot.total}`);
    for (const aside of artifact.overheard.asides.filter((a) => a.beat === beat)) {
      const kind = classifyOverheard(aside.text, aside.agentText ?? "");
      lines.push(
        `    - "${aside.text}" (${kind} ${aside.handling}) [${aside.tracePointer}]`,
      );
    }
  }
  return lines.join("\n");
}
