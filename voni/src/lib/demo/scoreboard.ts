/**
 * Demo scoreboard: locked golden script (ticket 02) on the ticket-01
 * plumbing, plus the dead-air gate (ticket 07). The seven beats below are
 * fixed order, fixed visitor wording, and fixed timing windows, so gap/cut
 * milliseconds stay comparable across runs. Wording reuses the existing eval
 * fragments (LONG_ASK, reachInvite, goodbyeCut, TAG=Lime 42) and the e2e
 * specs they mirror; nothing here retunes pipeline thresholds or gains —
 * the windows quote them.
 *
 * The harness measures nothing itself yet: per-beat gap/cut/drain
 * milliseconds are placeholders, probe counts start at zero, and every gate
 * except dead-air reports PASS/INFO (no FAIL until gating lands per ticket).
 * Dead air gates on measured evidence supplied by the operator
 * (--dead-air-gaps / --longest-silence-ms / --check-in-at-ms): without
 * evidence the gate stays INFO, never PASS, so an unmeasured run cannot
 * claim a quiet call. What this module guarantees is trustworthy plumbing —
 * one JSON artifact per run with redacted transcripts plus their hash, and
 * empty human-rating slots.
 */
import { createHash } from "node:crypto";
import { getVoice, VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";
import { DEMO_VOICE_IDS, SILENCE_CHECK_IN_MS } from "./voni-agent";

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

/**
 * Silence never reads as a dropped Demo call (spec story 9, ticket 07).
 *
 * Bars quote the pipeline, never the other way round: the floor fires one
 * check-in after 15s on a free floor (lib/voice/floor.ts afterMs 15s,
 * components/voice-call.tsx, e2e demo-races "Still with me?"), and the
 * golden script budgets the silence-check-in beat inside the talk clock
 * (TALK_BASE_S 240, WALL_CAP_S 720) with final-only visitor captions timed
 * at CAPTION_MS_PER_CHAR 58.
 */

/** Uncovered silence longer than this reads as a dropped call. */
export const DEAD_AIR_MAX_MS = 2000;

/** Silence that must draw exactly one check-in, never over caller speech. */
export const SILENCE_CHECK_IN_TARGET_MS = SILENCE_CHECK_IN_MS;

export type DeadAirCheckIn = {
  /** Silence elapsed when the check-in went out (audible timing). */
  atSilenceMs: number;
  /** The check-in overlapped caller speech (a cut the floor should have yielded). */
  overCaller: boolean;
  /** Call-trace pointer (turn/excerpt line) for failure triage. */
  trace?: string;
};

export type DeadAirEvidence = {
  /** Uncovered silences: no filler, no check-in (audible dead air). */
  gapsMs: number[];
  /** Longest silence stretch observed, covered or not; null when unmeasured. */
  longestSilenceMs: number | null;
  /** Check-ins the run produced (empty when none went out). */
  checkIns: DeadAirCheckIn[];
  /** Run-level trace pointer (e.g. the call-trace session id). */
  trace?: string;
};

/**
 * The dead-air gate: zero uncovered silence over 2s, and a 15s silence
 * draws exactly one check-in that never talks over the caller. The golden
 * script holds a single 15s silence beat, so exactly-once is per run.
 * Failure details carry the offending durations plus trace pointers into
 * deadAir.gapsMs and the Call trace excerpt.
 */
export function evaluateDeadAir(evidence: DeadAirEvidence): ScoreboardGate {
  const gaps = evidence.gapsMs ?? [];
  const checkIns = evidence.checkIns ?? [];
  const longest = evidence.longestSilenceMs ?? null;
  const traceSuffix = evidence.trace ? `, trace ${evidence.trace}` : "";
  const reasons: string[] = [];

  const bad = gaps.filter((g) => g > DEAD_AIR_MAX_MS);
  if (bad.length > 0) {
    reasons.push(
      `dead air ${bad.map((g) => `${g}ms`).join(", ")} exceeds ${DEAD_AIR_MAX_MS}ms without filler/check-in (see deadAir.gapsMs, silence-check-in beat${traceSuffix})`,
    );
  }

  const silenceReachedCheckIn =
    (longest ?? 0) >= SILENCE_CHECK_IN_TARGET_MS ||
    gaps.some((g) => g >= SILENCE_CHECK_IN_TARGET_MS) ||
    checkIns.some((c) => c.atSilenceMs >= SILENCE_CHECK_IN_TARGET_MS);
  if (silenceReachedCheckIn && checkIns.length !== 1) {
    reasons.push(
      `15s silence drew ${checkIns.length} check-ins, want exactly one (silence-check-in beat${traceSuffix})`,
    );
  }

  const early = checkIns.filter((c) => c.atSilenceMs < SILENCE_CHECK_IN_TARGET_MS);
  if (early.length > 0) {
    reasons.push(
      `check-in at ${early.map((c) => `${c.atSilenceMs}ms`).join(", ")}, before ${SILENCE_CHECK_IN_TARGET_MS}ms of silence — the floor fires once after 15s on a free floor (silence-check-in beat${traceSuffix})`,
    );
  }

  const overlapping = checkIns.filter((c) => c.overCaller);
  if (overlapping.length > 0) {
    const where = overlapping
      .map((c) => `${c.atSilenceMs}ms${c.trace ? ` (${c.trace})` : ""}`)
      .join(", ");
    reasons.push(
      `check-in over caller speech at ${where} silence — never talk over the visitor (silence-check-in beat${traceSuffix})`,
    );
  }

  if (reasons.length > 0) {
    return { name: "dead-air", status: "FAIL", detail: reasons.join("; ") };
  }
  if (silenceReachedCheckIn) {
    return {
      name: "dead-air",
      status: "PASS",
      detail: `no dead air over ${DEAD_AIR_MAX_MS}ms; 15s silence drew exactly one check-in at ${checkIns[0].atSilenceMs}ms, never over the caller`,
    };
  }
  const max = gaps.length > 0 ? Math.max(...gaps) : 0;
  return {
    name: "dead-air",
    status: "PASS",
    detail: `no dead air over ${DEAD_AIR_MAX_MS}ms across ${gaps.length} gaps (max ${max}ms); no 15s silence stretch`,
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
  overheard: { recalled: number; total: number | null };
  doubleTalk: { overlapMs: number[]; maxMs: number | null };
  deadAir: {
    gapsMs: number[];
    maxMs: number | null;
    checkIns: DeadAirCheckIn[];
    longestSilenceMs: number | null;
  };
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

/** Skeleton gates: reported but never failed until gating lands per ticket. */
function skeletonGates(exitCode: number | null, deadAir?: DeadAirEvidence | null): ScoreboardGate[] {
  const plumbing: ScoreboardGate =
    exitCode === null || exitCode === 0
      ? { name: "plumbing", status: "PASS", detail: "eval runner finished" }
      : {
          name: "plumbing",
          status: "INFO",
          detail: `eval runner exited ${exitCode} (skeleton: recorded, not failed)`,
        };
  const deadAirGate: ScoreboardGate = deadAir
    ? evaluateDeadAir(deadAir)
    : {
        name: "dead-air",
        status: "INFO",
        detail: "unmeasured: supply --dead-air-gaps/--longest-silence-ms/--check-in-at-ms to gate",
      };
  return [
    plumbing,
    { name: "reply-gap", status: "INFO", detail: "skeleton: gating lands in the reply-gap ticket" },
    { name: "barge-in-cut", status: "INFO", detail: "skeleton: gating lands in the cut ticket" },
    { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    { name: "double-talk", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    deadAirGate,
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
  /** Measured dead-air evidence; omitted means unmeasured (gate stays INFO). */
  deadAir?: DeadAirEvidence | null;
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
  const deadAirGaps = input.deadAir?.gapsMs ?? [];
  const deadAirCheckIns = input.deadAir?.checkIns ?? [];
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
    overheard: { recalled: 0, total: null },
    doubleTalk: { overlapMs: [], maxMs: null },
    deadAir: {
      gapsMs: deadAirGaps,
      maxMs: deadAirGaps.length > 0 ? Math.max(...deadAirGaps) : null,
      checkIns: deadAirCheckIns,
      longestSilenceMs: input.deadAir?.longestSilenceMs ?? null,
    },
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings: { timbre: null, accent: null },
    gates: skeletonGates(input.exitCode, input.deadAir),
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
