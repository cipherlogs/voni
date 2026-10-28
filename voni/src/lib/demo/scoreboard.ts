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
  /** Reply gap: visitor end-of-speech → first agent audio. Placeholder until ticket 02. */
  gapMs: number | null;
  /** Barge-in cut latency. Placeholder until the cut ticket. */
  cutMs: number | null;
  /** Goodbye drain: goodbye end → session end. Filled by the drain gate (ticket 09). */
  drainMs: number | null;
  status: GateStatus;
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
  overheard: { recalled: number; total: number | null };
  doubleTalk: { overlapMs: number[]; maxMs: number | null };
  /**
   * End-call drain evidence (ticket 09): how much of the closing line played
   * and how long after its audio ended the session closed. Nulls mean the
   * goodbye was never measured — the gate reports INFO, never a false FAIL.
   */
  endCallDrain: {
    /** Played speaking time / expected speaking time (eval bye-audio bar: >= 0.8). */
    goodbyeCoverage: number | null;
    /** Session end minus goodbye audio end; negative means hung up early. */
    hangUpDelayMs: number | null;
    /** The model spoke again after end_call instead of letting the line close. */
    narratedEnding: boolean;
  };
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

/**
 * Double-talk bar (spec story 8): zero audible overlap longer than 400ms
 * after any cut. Cuts fade what is sounding over DOUBLE_TALK_FADE_OUT_S and
 * flush the rest (session FADE_OUT_S; playout jitter pre-roll 500ms with edge
 * fades in the worklet), so anything still audible past 400ms is a real
 * talk-over, not the fade itself.
 */
export const DOUBLE_TALK_MAX_OVERLAP_MS = 400;
/** Barge-in fade: what is sounding ramps to silence over this, never a hard stop. */
export const DOUBLE_TALK_FADE_OUT_S = 0.04;

/**
 * End-call drain handshake (spec story 10, ADR-0005 holdUntilReplyDone): the
 * end_call result waits for the goodbye reply to finish, then the session
 * hangs up only after END_CALL_SETTLE_POLLS consecutive settled polls AND
 * END_CALL_AUDIO_GRACE_MS since the last audio arrived, bounded by
 * END_CALL_DRAIN_TIMEOUT_MS. The goodbye must play in full (>=
 * GOODBYE_AUDIO_COVERAGE_MIN of its speaking time, per eval bye-audio) and
 * the model must not narrate the ending.
 */
export const END_CALL_POLL_MS = 250;
export const END_CALL_SETTLE_POLLS = 3;
export const END_CALL_AUDIO_GRACE_MS = 500;
export const END_CALL_DRAIN_TIMEOUT_MS = 10000;
/** The goodbye's audio must arrive in full: >= 80% of its words' speaking time. */
export const GOODBYE_AUDIO_COVERAGE_MIN = 0.8;
/** Hang-up after goodbye audio end: the golden goodbye-drain window (0-1500ms). */
export const HANG_UP_AFTER_GOODBYE_MAX_MS = 1500;

export type DoubleTalkInput = {
  /** Audible overlap per cut, ms (fade 0.04s already accounted for by the 400ms bar). */
  overlapMs: number[];
  /** Trace pointer for failures, e.g. "sess_abc / greeting-cut". */
  traceRef?: string;
};

/** Double-talk gate: external behavior (audible overlap), never internals. */
export function evaluateDoubleTalk(input: DoubleTalkInput): ScoreboardGate {
  const trace = input.traceRef ? ` — trace: ${input.traceRef}` : "";
  if (input.overlapMs.length === 0) {
    return { name: "double-talk", status: "INFO", detail: "no cuts measured" };
  }
  const max = Math.max(...input.overlapMs);
  const cuts = input.overlapMs.join(", ");
  if (max > DOUBLE_TALK_MAX_OVERLAP_MS) {
    return {
      name: "double-talk",
      status: "FAIL",
      detail:
        `audible overlap ${max}ms > ${DOUBLE_TALK_MAX_OVERLAP_MS}ms after cut ` +
        `(cuts: ${cuts}ms; fade ${DOUBLE_TALK_FADE_OUT_S}s + flush)${trace}`,
    };
  }
  return {
    name: "double-talk",
    status: "PASS",
    detail:
      `max overlap ${max}ms ≤ ${DOUBLE_TALK_MAX_OVERLAP_MS}ms across ` +
      `${input.overlapMs.length} cut${input.overlapMs.length === 1 ? "" : "s"} ` +
      `(fade ${DOUBLE_TALK_FADE_OUT_S}s + flush)`,
  };
}

export type EndCallDrainInput = {
  /** Played / expected goodbye speaking time; null when never measured. */
  goodbyeCoverage: number | null;
  /** Session end minus goodbye audio end; null when never measured. */
  hangUpDelayMs: number | null;
  /** The model spoke again after end_call instead of letting the line close. */
  narratedEnding: boolean;
  /** Trace pointer for failures, e.g. "sess_xyz / goodbye-drain". */
  traceRef?: string;
};

/** End-call drain gate: the full closing plays before the session closes. */
export function evaluateEndCallDrain(input: EndCallDrainInput): ScoreboardGate {
  const trace = input.traceRef ? ` — trace: ${input.traceRef}` : "";
  if (input.narratedEnding) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `model narrated the ending after end_call (goodbye never closed the call)${trace}`,
    };
  }
  if (input.goodbyeCoverage !== null && input.goodbyeCoverage < GOODBYE_AUDIO_COVERAGE_MIN) {
    const pct = Math.round(input.goodbyeCoverage * 100);
    const bar = Math.round(GOODBYE_AUDIO_COVERAGE_MIN * 100);
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `goodbye audio ${pct}% < ${bar}% of its speaking time (chopped)${trace}`,
    };
  }
  if (input.hangUpDelayMs !== null && input.hangUpDelayMs < 0) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail:
        `hung up ${-input.hangUpDelayMs}ms before goodbye audio ended ` +
        `(delay ${input.hangUpDelayMs}ms: chopped)${trace}`,
    };
  }
  if (input.hangUpDelayMs !== null && input.hangUpDelayMs > HANG_UP_AFTER_GOODBYE_MAX_MS) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail:
        `hang-up ${input.hangUpDelayMs}ms after goodbye audio ` +
        `> ${HANG_UP_AFTER_GOODBYE_MAX_MS}ms bar (line held)${trace}`,
    };
  }
  if (input.goodbyeCoverage === null && input.hangUpDelayMs === null) {
    return { name: "end-call-drain", status: "INFO", detail: "no goodbye measured" };
  }
  const coverage = input.goodbyeCoverage === null ? "unmeasured" : `${Math.round(input.goodbyeCoverage * 100)}%`;
  const delay = input.hangUpDelayMs === null ? "unmeasured" : `${input.hangUpDelayMs}ms`;
  return {
    name: "end-call-drain",
    status: "PASS",
    detail:
      `goodbye ${coverage} ≥ ${Math.round(GOODBYE_AUDIO_COVERAGE_MIN * 100)}%, ` +
      `hang-up ${delay} after goodbye audio ` +
      `(drain ${END_CALL_POLL_MS}ms×${END_CALL_SETTLE_POLLS} + ${END_CALL_AUDIO_GRACE_MS}ms grace)`,
  };
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

/** Gates: double-talk and end-call-drain evaluate measured evidence (ticket 09);
 * the rest stay skeleton INFO until their tickets land. No evidence is INFO,
 * never a false FAIL — a FAIL always names durations plus a trace pointer. */
function skeletonGates(
  exitCode: number | null,
  input: {
    doubleTalk: DoubleTalkInput;
    endCallDrain: EndCallDrainInput;
  },
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
    { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    evaluateDoubleTalk(input.doubleTalk),
    {
      name: "dead-air",
      status: "INFO",
      detail: "skeleton: gating lands in the naturalness ticket",
    },
    evaluateEndCallDrain(input.endCallDrain),
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
  /** Measured audible overlap per cut; empty/omitted means unmeasured (INFO). */
  doubleTalkOverlapMs?: number[];
  /** Measured goodbye drain evidence; omitted means unmeasured (INFO). */
  endCallDrain?: { goodbyeCoverage: number | null; hangUpDelayMs: number | null; narratedEnding: boolean };
  /** Trace pointer attached to failure details, e.g. a sess_ id. */
  traceRef?: string;
}): ScoreboardArtifact {
  const doubleTalkOverlapMs = input.doubleTalkOverlapMs ?? [];
  const drain = input.endCallDrain ?? { goodbyeCoverage: null, hangUpDelayMs: null, narratedEnding: false };
  const gates = skeletonGates(input.exitCode, {
    doubleTalk: { overlapMs: doubleTalkOverlapMs, traceRef: input.traceRef },
    endCallDrain: { ...drain, traceRef: input.traceRef },
  });
  const goodbyeDrainGate = gates.find((g) => g.name === "end-call-drain")!;
  const beats = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [
      beat,
      beat === "goodbye-drain"
        ? {
            gapMs: null,
            cutMs: null,
            drainMs: drain.hangUpDelayMs,
            status: goodbyeDrainGate.status,
            note:
              drain.hangUpDelayMs === null && drain.goodbyeCoverage === null
                ? "skeleton: placeholder until per-beat timing lands"
                : goodbyeDrainGate.detail,
          }
        : {
            gapMs: null,
            cutMs: null,
            drainMs: null,
            status: "PASS",
            note: "skeleton: placeholder until per-beat timing lands",
          },
    ]),
  ) as Record<GoldenBeat, BeatTiming>;
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
    doubleTalk: {
      overlapMs: doubleTalkOverlapMs,
      maxMs: doubleTalkOverlapMs.length > 0 ? Math.max(...doubleTalkOverlapMs) : null,
    },
    endCallDrain: { ...drain },
    deadAir: { gapsMs: [], maxMs: null },
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings: { timbre: null, accent: null },
    gates,
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
