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
import { TAG_WORDS, containsTag, countTags } from "./test-tag";
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

export type ScoreboardLoudness = {
  /** Shared gain reference every voice is matched to (anna). */
  referenceLufs: number;
  /** Post-gain integrated loudness, or null when the voice is unmeasured. */
  matchedLufs: number | null;
  /** Client-side per-voice gain from the registry. */
  gain: number;
  /** Server-side output level from the registry. */
  outputVolume: number;
  ok: boolean;
  detail: string;
};

/** One blind ballot: timbre and accent judged 1-5 on the shared golden recording. */
export type HumanRating = {
  rater: string;
  timbre: number;
  accent: number;
};

/**
 * Blind human slots for timbre and accent (spec story 16): every ballot
 * judges the same golden recording, independently, by at least two raters.
 * `timbre`/`accent` are the running means once ballots exist, null before.
 * Human likeness stays reviewable: the gate never FAILs on taste, it only
 * records whether enough independent ears have judged.
 */
export type HumanRatings = {
  timbre: number | null;
  accent: number | null;
  recordingSha256: string | null;
  ratings: HumanRating[];
};

/** At least two independent listeners per golden recording (spec testing decisions). */
export const HUMAN_RATERS_REQUIRED = 2;

export function emptyHumanRatings(recordingSha256: string | null): HumanRatings {
  return { timbre: null, accent: null, recordingSha256, ratings: [] };
}

function mean1(values: number[]): number {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

/**
 * File one blind ballot. Every ballot must score the same golden recording
 * (raters never judge different cuts), rate both axes as ints 1-5, and vote
 * once: a second ballot from the same rater is a protocol violation, not a
 * second opinion.
 */
export function addHumanRating(
  current: HumanRatings,
  rating: HumanRating,
  recordingSha256: string,
): HumanRatings {
  if (!rating.rater || rating.rater.trim().length === 0) {
    throw new Error("human rating needs a rater name (one ballot per independent listener)");
  }
  for (const axis of ["timbre", "accent"] as const) {
    const value = rating[axis];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${axis} rating must be an int 1-5, got ${value}`);
    }
  }
  if (!recordingSha256) throw new Error("human rating needs the golden recording it judges");
  if (current.recordingSha256 !== null && current.recordingSha256 !== recordingSha256) {
    throw new Error("human ratings must all judge the same recording (blind, one shared cut)");
  }
  if (current.ratings.some((existing) => existing.rater === rating.rater)) {
    throw new Error(`"${rating.rater}" already rated this recording (one ballot per rater)`);
  }
  const ratings = [...current.ratings, rating];
  return {
    recordingSha256: current.recordingSha256 ?? recordingSha256,
    ratings,
    timbre: mean1(ratings.map((ballot) => ballot.timbre)),
    accent: mean1(ratings.map((ballot) => ballot.accent)),
  };
}

/**
 * The accent human gate: INFO until at least two independent ballots on the
 * shared recording exist, PASS after. Auto timbre checks must pass before
 * human ratings count — ears judge likeness, never cover for defects.
 * Reviewable by design: taste never FAILs a run, it only completes the record.
 */
export function evaluateHumanGate(autoPassed: boolean, human: HumanRatings): ScoreboardGate {
  if (!autoPassed) {
    return {
      name: "accent-human",
      status: "INFO",
      detail: "auto timbre checks must pass before human rating counts (defects first, likeness second)",
    };
  }
  if (human.ratings.length < HUMAN_RATERS_REQUIRED) {
    return {
      name: "accent-human",
      status: "INFO",
      detail: `awaiting human 1-5 ratings (${human.ratings.length}/${HUMAN_RATERS_REQUIRED} independent raters on the same golden recording)`,
    };
  }
  return {
    name: "accent-human",
    status: "PASS",
    detail: `timbre ${human.timbre} / accent ${human.accent} across ${human.ratings.length} independent raters on the same golden recording`,
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
  deadAir: { gapsMs: number[]; maxMs: number | null };
  probes: TimbreProbes;
  /** Shared gain reference the gate voice is matched to, with its post-gain level. */
  loudness: ScoreboardLoudness;
  transcripts: { sha256: string; redacted: string[] };
  humanRatings: HumanRatings;
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

// ── Ticket 10: timbre auto gate + loudness sanity ──────────────────────────

/** Integrated loudness every demo voice is gain-matched to (anna, per voices.ts). */
export const TIMBRE_REFERENCE_LUFS = -23.1;
/** Matched loudness must land within this of the reference to count as sane. */
export const TIMBRE_LUFS_TOLERANCE_DB = 1.5;

/**
 * Native integrated loudness per voice, measured from `public/voices/*.mp3`
 * (see the VOICE_PLAYBACK_GAIN comment in lib/agents/voices.ts). The table is
 * restated here so the gate checks the gain it actually runs with, not the
 * comment it was derived from. A voice with no entry here is unmeasured:
 * its probes still gate, its loudness is reported, not failed.
 */
export const NATIVE_VOICE_LUFS: Record<string, number> = {
  anna: -23.1,
  lola: -22.5,
  rafael: -23.8,
  juergen: -28.8,
  estelle: -30.3,
  giovanni: -34.9,
};

/**
 * Playout pop threshold (public/playout-processor.js POP_JUMP = 0.3 of full
 * scale) in int16 steps, so the offline session-evidence PCM analysis
 * (qa-voice-session analyzePcm largestAdjacentStep) flags the same clicks
 * the on-device probe would have posted.
 */
export const POP_JUMP_INT16 = Math.round(0.3 * 32767);

export type TimbreProbes = {
  jump: number;
  overload: number;
  clip: number;
  underrun: number;
  inputDrop: number;
};

export type AgentChannelEvidence = {
  peakDbfs: number | null;
  clippedSampleRatio: number | null;
  largestAdjacentStep: number | null;
};

/** Post-gain integrated loudness, or null when the voice has no native measurement. */
export function matchedLoudnessLufs(voiceId: string): number | null {
  const native = NATIVE_VOICE_LUFS[voiceId];
  if (native === undefined) return null;
  return Number((native + 20 * Math.log10(voicePlaybackGain(voiceId))).toFixed(2));
}

export type LoudnessCheck = {
  ok: boolean;
  matchedLufs: number | null;
  detail: string;
};

/** Pure loudness math: native level plus linear gain against the reference. */
export function checkLoudness(input: { nativeLufs: number; gain: number }): LoudnessCheck {
  const matchedLufs = Number((input.nativeLufs + 20 * Math.log10(input.gain)).toFixed(2));
  const ok = Math.abs(matchedLufs - TIMBRE_REFERENCE_LUFS) <= TIMBRE_LUFS_TOLERANCE_DB;
  return {
    ok,
    matchedLufs,
    detail: ok
      ? `matched ${matchedLufs} LUFS vs reference ${TIMBRE_REFERENCE_LUFS} LUFS (native ${input.nativeLufs}, gain ${input.gain})`
      : `matched ${matchedLufs} LUFS misses reference ${TIMBRE_REFERENCE_LUFS} LUFS by more than ${TIMBRE_LUFS_TOLERANCE_DB} dB (native ${input.nativeLufs}, gain ${input.gain})`,
  };
}

/** Registry-backed loudness sanity for one voice (unmeasured, never failed). */
export function checkLoudnessSanity(voiceId: string): LoudnessCheck & { unmeasured?: boolean } {
  const native = NATIVE_VOICE_LUFS[voiceId];
  if (native === undefined) {
    return {
      ok: false,
      unmeasured: true,
      matchedLufs: null,
      detail: `no native loudness measurement for "${voiceId}": probes still gate, loudness is reported not failed`,
    };
  }
  return checkLoudness({ nativeLufs: native, gain: voicePlaybackGain(voiceId) });
}

/** Every probe count must be zero across the golden run; the detail names the offender. */
export function checkTimbreProbes(probes: TimbreProbes): { ok: boolean; detail: string } {
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    if (probes[kind] > 0) {
      return {
        ok: false,
        detail: `${kind} ${probes[kind]} > 0 across the golden run (must be zero: no clip, pop, playout jump, underrun, or input-drop)`,
      };
    }
  }
  return { ok: true, detail: "jump/overload/clip/underrun/input-drop all zero" };
}

/**
 * Offline PCM check against the same defects the live probes watch:
 * clipped samples (analyzePcm clippedSampleRatio, the gain softLimit's
 * backstop) and playout-scale adjacent-sample jumps. Missing evidence
 * (dry run, decoder unavailable) passes open, never fails closed.
 */
export function checkEvidenceTimbre(channel: AgentChannelEvidence | null): {
  ok: boolean;
  detail: string;
} {
  if (channel === null) return { ok: true, detail: "no agent-channel evidence (dry run or decoder unavailable)" };
  const clipped = channel.clippedSampleRatio ?? 0;
  if (clipped > 0) {
    return {
      ok: false,
      detail: `clip ${clipped} of agent-channel samples at full scale (softLimit backstop missed)`,
    };
  }
  const step = channel.largestAdjacentStep ?? 0;
  if (step > POP_JUMP_INT16) {
    return {
      ok: false,
      detail: `jump of ${step} int16 steps exceeds the playout pop threshold ${POP_JUMP_INT16}`,
    };
  }
  return {
    ok: true,
    detail: `peak ${channel.peakDbfs} dBFS, no clipped samples, max adjacent step ${step}`,
  };
}

/**
 * The timbre auto gate: probe counts, session-evidence PCM, and loudness
 * sanity all have to agree. Any defect FAILs with the offender named;
 * unmeasured loudness is reported in the detail, never failed.
 */
export function evaluateTimbreGate(input: {
  probes: TimbreProbes;
  voiceId: string;
  agentChannel: AgentChannelEvidence | null;
}): ScoreboardGate {
  const probes = checkTimbreProbes(input.probes);
  if (!probes.ok) return { name: "timbre-probes", status: "FAIL", detail: probes.detail };
  const evidence = checkEvidenceTimbre(input.agentChannel);
  if (!evidence.ok) return { name: "timbre-probes", status: "FAIL", detail: evidence.detail };
  const loudness = checkLoudnessSanity(input.voiceId);
  if (!loudness.ok && !loudness.unmeasured) {
    return { name: "timbre-probes", status: "FAIL", detail: loudness.detail };
  }
  return {
    name: "timbre-probes",
    status: "PASS",
    detail: `${probes.detail}; ${loudness.detail}; ${evidence.detail}`,
  };
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

/** Gates with live timbre + human evaluation: only the naturalness rows stay skeleton. */
function buildGates(input: {
  exitCode: number | null;
  voice: string;
  probes: TimbreProbes;
  agentChannel: AgentChannelEvidence | null;
  humanRatings: HumanRatings;
}): ScoreboardGate[] {
  const plumbing: ScoreboardGate =
    input.exitCode === null || input.exitCode === 0
      ? { name: "plumbing", status: "PASS", detail: "eval runner finished" }
      : {
          name: "plumbing",
          status: "INFO",
          detail: `eval runner exited ${input.exitCode} (skeleton: recorded, not failed)`,
        };
  const timbre = evaluateTimbreGate({
    probes: input.probes,
    voiceId: input.voice,
    agentChannel: input.agentChannel,
  });
  return [
    plumbing,
    { name: "reply-gap", status: "INFO", detail: "skeleton: gating lands in the reply-gap ticket" },
    { name: "barge-in-cut", status: "INFO", detail: "skeleton: gating lands in the cut ticket" },
    { name: "overheard-recall", status: "INFO", detail: "skeleton: gating lands in the overheard ticket" },
    { name: "double-talk", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    { name: "dead-air", status: "INFO", detail: "skeleton: gating lands in the naturalness ticket" },
    timbre,
    evaluateHumanGate(timbre.status === "PASS", input.humanRatings),
  ];
}

export function buildSkeletonArtifact(input: {
  voice: string;
  scenario: string;
  runnerStdout: string;
  exitCode: number | null;
  durationMs: number;
  runs: number;
  /** Session onAudioProbe counts; zeroed in dry runs. */
  probes?: TimbreProbes;
  /** qa-voice-session agent-channel PCM analysis; absent in dry runs. */
  agentChannel?: AgentChannelEvidence | null;
  /** Blind ballots filed with --rate/--recording; empty until judged. */
  humanRatings?: HumanRatings;
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
  const probes: TimbreProbes = input.probes ?? { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 };
  const agentChannel = input.agentChannel ?? null;
  const humanRatings = input.humanRatings ?? emptyHumanRatings(null);
  const playback = gateVoicePlayback(input.voice);
  const loudnessCheck = checkLoudnessSanity(input.voice);
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
    deadAir: { gapsMs: [], maxMs: null },
    probes,
    loudness: {
      referenceLufs: TIMBRE_REFERENCE_LUFS,
      matchedLufs: loudnessCheck.matchedLufs,
      gain: playback.playbackGain,
      outputVolume: playback.outputVolume,
      ok: loudnessCheck.ok,
      detail: loudnessCheck.detail,
    },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings,
    gates: buildGates({
      exitCode: input.exitCode,
      voice: input.voice,
      probes,
      agentChannel,
      humanRatings,
    }),
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

// ── Ticket 10: voice regression matrix ──────────────────────────────────────
//
// Non-gate voices run regression-only (spec story 14): no clip, no pop, no
// invented test tag. Deploying a new voice is a registry entry plus a full
// matrix run — never a harness change, never a golden-script edit.

/** Tag discipline for one voice: the call tag said once exactly, whole, and only. */
export type TagDiscipline = {
  saidOnceExactly: boolean;
  digitSpelled: boolean;
  /** Distinct invented tags heard (folded "word digits"), at most five. */
  invented: string[];
};

const foldTagText = (text: string): string =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** The tag-word list the expected tag comes from (its call's language). */
function tagWordList(expectedTag: string): string[] {
  const word = foldTagText(expectedTag).split(" ")[0];
  return (
    Object.values(TAG_WORDS).find((list) => list.some((w) => w.toLowerCase() === word)) ?? TAG_WORDS.en
  ).map((w) => w.toLowerCase());
}

const DIGIT_WORDS = "zero|one|two|three|four|five|six|seven|eight|nine|forty";

/**
 * Tag discipline over redacted transcript lines, reusing the shared email-test
 * vocabulary (test-tag.ts containsTag/countTags/TAG_WORDS): fuzzy matching
 * ("lime42", "Lime-42") forgives typing, so only genuinely distinct tags count
 * as invented, while a digit-by-digit saying ("Lime four two", "Lime 4 2")
 * fails even though the inbox would still match it.
 */
export function analyzeTagMentions(lines: string[], expectedTag = "Lime 42"): TagDiscipline {
  const joined = lines.join("\n");
  const folded = foldTagText(joined);
  const [word, digits] = foldTagText(expectedTag).split(" ");
  // The email matcher's lone-digit joiner, restated for invented-tag mining.
  const typed = folded.replace(/(^|[^0-9])(\d)[\s-]+(\d)(?![0-9])/g, "$1$2$3");
  const occurrences = [
    ...typed.matchAll(new RegExp(`(?:^|[^a-z0-9])${word}[\\s\\-_.:#]*${digits}(?!\\d)`, "g")),
  ].length;
  const distinctCount = countTags(joined, expectedTag);
  const digitSpelled = new RegExp(
    `(^|[^a-z0-9])${word}\\s+(\\d[\\s-]+\\d|(?:${DIGIT_WORDS})[\\s-]+(?:${DIGIT_WORDS}|two))(?!\\d)`,
  ).test(folded);
  const list = tagWordList(expectedTag);
  const seen = new Set(
    [...typed.matchAll(new RegExp(`(?:^|[^a-z0-9])(${list.join("|")})[\\s\\-_.:#]*(\\d{2})(?!\\d)`, "g"))].map(
      (m) => `${m[1]} ${m[2]}`,
    ),
  );
  seen.delete(`${word} ${digits}`);
  return {
    saidOnceExactly: containsTag(joined, expectedTag) && occurrences === 1 && distinctCount === 1,
    digitSpelled,
    invented: [...seen].slice(0, 5),
  };
}

export type RegressionVoiceResult = {
  voice: string;
  isGate: boolean;
  status: "PASS" | "FAIL";
  detail: string;
  probes: TimbreProbes;
  tag: TagDiscipline;
};

/**
 * One voice's regression verdict: probes zero, no invented tag, the call tag
 * said once as one whole number. Same bar for gate and non-gate voices —
 * regression-only means the matrix never gates the pipeline, not that it
 * looks away.
 */
export function checkRegressionVoice(input: {
  voice: string;
  isGate: boolean;
  probes: TimbreProbes;
  tag: TagDiscipline;
}): RegressionVoiceResult {
  const scope = input.isGate ? "gate" : "regression";
  const fail = (detail: string): RegressionVoiceResult => ({
    voice: input.voice,
    isGate: input.isGate,
    status: "FAIL",
    detail: `${scope} ${input.voice}: ${detail}`,
    probes: input.probes,
    tag: input.tag,
  });
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    if (input.probes[kind] > 0) {
      return fail(`${kind} ${input.probes[kind]} > 0 (must be zero: no clip, pop, jump, underrun, or input-drop)`);
    }
  }
  if (input.tag.invented.length > 0) {
    return fail(`invented test tag ${input.tag.invented.join(", ")} (say only the call tag)`);
  }
  if (input.tag.digitSpelled) {
    return fail("test tag spelled digit by digit (say the number as one whole number)");
  }
  if (!input.tag.saidOnceExactly) {
    return fail("test tag not said exactly once (say the call tag once, never invented)");
  }
  return {
    voice: input.voice,
    isGate: input.isGate,
    status: "PASS",
    detail: `${scope} ${input.voice}: probes zero; test tag said once exactly`,
    probes: input.probes,
    tag: input.tag,
  };
}

/**
 * Matrix voice set: a registry parameter, never literals. Empty means every
 * demo voice; anything else is validated through the voice registry, so a
 * newly registered voice joins the matrix by naming it.
 */
export function resolveMatrixVoices(csv: string): string[] {
  if (!csv.trim()) return [...DEMO_VOICE_IDS];
  const voices: string[] = [];
  for (const raw of csv.split(",")) {
    const voice = raw.trim();
    if (!voice) continue;
    resolveGateVoice(voice);
    if (!voices.includes(voice)) voices.push(voice);
  }
  return voices.length > 0 ? voices : [...DEMO_VOICE_IDS];
}

export type RegressionVoiceInput = {
  voice: string;
  probes: TimbreProbes;
  tagLines: string[];
  expectedTag?: string;
};

export type RegressionMatrix = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  gateVoice: string;
  expectedTag: string;
  voices: string[];
  results: RegressionVoiceResult[];
  gates: ScoreboardGate[];
};

/** Full matrix verdict: one regression row per voice plus the overall row. */
export function buildRegressionMatrix(input: {
  gateVoice: string;
  entries: RegressionVoiceInput[];
  expectedTag?: string;
}): RegressionMatrix {
  const gateVoice = resolveGateVoice(input.gateVoice);
  const expectedTag = input.expectedTag ?? "Lime 42";
  const results = input.entries.map((entry) => {
    resolveGateVoice(entry.voice);
    return checkRegressionVoice({
      voice: entry.voice,
      isGate: entry.voice === gateVoice,
      probes: entry.probes,
      tag: analyzeTagMentions(entry.tagLines, entry.expectedTag ?? expectedTag),
    });
  });
  const clean = results.filter((result) => result.status === "PASS").length;
  const gates: ScoreboardGate[] = results.map((result) => ({
    name: `regression:${result.voice}`,
    status: result.status,
    detail: result.detail,
  }));
  gates.push({
    name: "matrix",
    status: clean === results.length ? "PASS" : "FAIL",
    detail: `${clean}/${results.length} voices regression-clean (gate ${gateVoice}; no clip, pop, jump, underrun, input-drop, or invented tag)`,
  });
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    gateVoice,
    expectedTag,
    voices: results.map((result) => result.voice),
    results,
    gates,
  };
}

/** Console table: one row per voice plus the overall summary. */
export function formatMatrixTable(matrix: RegressionMatrix): string {
  const clean = matrix.results.filter((result) => result.status === "PASS").length;
  const rows = matrix.results.map(
    (result) => `${result.status.padEnd(6)} ${result.voice.padEnd(12)} ${result.detail}`,
  );
  return [
    `demo voice matrix (gate ${matrix.gateVoice}, ${matrix.results.length} voices, ${clean}/${matrix.results.length} clean)`,
    ...rows,
  ].join("\n");
}
